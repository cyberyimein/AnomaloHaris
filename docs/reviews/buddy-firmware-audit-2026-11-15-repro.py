"""Offline evidence for the 0.4.7 design review, using repository test doubles.

These assertions document defects in the reviewed baseline, not desired behavior.
No device, network, credentials, or filesystem configuration is accessed.
"""

import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "firmware/stackchan"))

import device as device_module
from device import DeviceController
from png_encoder import rgb565_to_png
from test_firmware import FakeBoard, FakeCamera, FakePower
from test_http_transport import load_entrypoint


def make_device(board=None, camera=None):
    clock = [100]
    controller = DeviceController(
        board if board is not None else FakeBoard(),
        camera if camera is not None else FakeCamera(),
        power=FakePower(),
        ticks_ms=lambda: clock[0],
        sleep_ms=lambda milliseconds: None,
    )
    controller.update(wifi_connected=True, service_ready=True)
    return controller, clock


def slow_request_probe():
    class SlowConnection:
        def __init__(self):
            self.elapsed = 0
            self.parts = iter([
                b"GET /v1/status HTTP/1.1\r\n", b"Host: buddy\r\n",
                b"X-One: a\r\n", b"X-Two: b\r\n", b"X-Three: c\r\n", b"\r\n",
            ])

        def settimeout(self, seconds):
            self.timeout = seconds

        def setsockopt(self, *args):
            pass

        def recv(self, size):
            # Each read succeeds before its socket timeout, with no real sleep.
            assert 29 < self.timeout
            self.elapsed += 29
            return next(self.parts)

    entrypoint = load_entrypoint()
    connection = SlowConnection()
    entrypoint.configure_connection(connection)
    entrypoint.read_request(connection)
    assert connection.elapsed == 174
    return connection.elapsed


def read_side_effect_probe():
    controller, _ = make_device()
    controller.invoke("manual", "led.set", {"color": 0x200000})
    before = controller.status()["state"]["lighting"]["source"]
    controller.invoke("read-one", "touch.read", {})
    controller.invoke("read-two", "touch.read", {})
    after = controller.status()["state"]["lighting"]["source"]
    assert (before, after) == ("manual", "lifecycle")
    return [before, after]


def fault_probe():
    controller, clock = make_device()
    controller.set_error("persistent physical hardware fault")
    clock[0] += 3100
    controller.update(wifi_connected=True, service_ready=True)
    state = controller.status()["state"]
    assert state["mode"] == "ready" and state["lastError"] is None
    return {"mode": state["mode"], "lastError": state["lastError"]}


def extension_schema_probe():
    controller, _ = make_device()
    calls = []
    controller.register_capability({
        "name": "extension.level",
        "inputSchema": {
            "type": "object",
            "properties": {"level": {"type": "integer", "maximum": 1}},
            "required": ["level"],
            "additionalProperties": False,
        },
    }, lambda args: calls.append(args) or {"ok": True})
    controller.invoke("invalid-level", "extension.level", {
        "level": 99, "unexpected": True,
    })
    assert calls == [{"level": 99, "unexpected": True}]
    return False


def capture_probe():
    captures = []
    camera = FakeCamera()
    camera.on_snapshot = lambda: captures.append(True)
    controller, clock = make_device(camera=camera)
    controller.invoke("move-only", "head.move", {"pan": 10})
    move_captures = len(captures)
    controller.invoke("observe", "head.observe", {"direction": "center"})
    observe_captures = len(captures)
    assert move_captures == 0 and observe_captures == 1

    frame_tick = clock[0]
    original_encoder = device_module.rgb565_to_png

    def delayed_encode(*args):
        clock[0] += 1000
        return original_encoder(*args)

    with patch.object(device_module, "rgb565_to_png", delayed_encode):
        image = controller._capture()
    assert image["capturedAtMs"] == frame_tick + 1000
    qvga = rgb565_to_png(bytes(320 * 240 * 2), 320, 240)
    return {
        "head_move_camera_calls": move_captures,
        "head_observe_camera_calls": observe_captures,
        "timestamp_delay_after_frame_ms": image["capturedAtMs"] - frame_tick,
        "qvga_png_bytes": len(qvga),
        "qvga_base64_bytes": len(base64.b64encode(qvga)),
    }


def unconfirmed_motion_probe():
    class NoMotionBoard(FakeBoard):
        def set_servo_angle(self, *args):
            pass

    controller, _ = make_device(board=NoMotionBoard())
    result = controller.invoke("no-motion", "head.move", {
        "pan": 30, "tilt": 60,
    })["result"]
    measured = controller.status()["state"]["head"]
    assert result["ok"] is True and measured == {"pan": 0, "tilt": 45}
    return {"result": result, "measured": measured}


def lost_shutdown_reply_probe():
    controller, clock = make_device()
    entrypoint = load_entrypoint()
    entrypoint.build_device = lambda: controller
    entrypoint.configure_wifi = lambda: SimpleNamespace(isconnected=lambda: True)
    entrypoint.try_connect_wifi = lambda wifi: True
    entrypoint.M5.update = lambda: None
    entrypoint.config.BUDDY_DEVICE_TOKEN = "offline-fake-token"
    entrypoint.config.HTTP_PORT = 8080
    entrypoint.time = SimpleNamespace(
        ticks_ms=lambda: clock[0],
        ticks_add=lambda left, right: left + right,
        ticks_diff=lambda left, right: left - right,
    )
    invocation = json.dumps({
        "requestId": "lost-shutdown-reply",
        "capability": "device.shutdown",
        "args": {},
    }).encode()
    entrypoint.read_request = lambda connection: (
        "POST", "/v1/invoke",
        {"authorization": "Bearer offline-fake-token"}, invocation,
    )

    class EndLoop(Exception):
        pass

    class BrokenConnection:
        def settimeout(self, value):
            pass

        def setsockopt(self, *args):
            pass

        def sendall(self, data):
            raise OSError("peer closed")

        def close(self):
            clock[0] += 60000

    class Listener:
        accepted = False

        def setsockopt(self, *args):
            pass

        def bind(self, *args):
            pass

        def listen(self, *args):
            pass

        def settimeout(self, *args):
            pass

        def accept(self):
            if self.accepted:
                raise EndLoop()
            self.accepted = True
            return BrokenConnection(), ("127.0.0.1", 0)

    with patch.object(entrypoint.socket, "socket", return_value=Listener()):
        try:
            entrypoint.serve_forever()
        except EndLoop:
            pass
    power_off_called = ("powerOff",) in controller.power.events
    assert controller.shutdown_requested
    assert not controller.shutdown_poweroff_armed and not power_off_called
    return {
        "requested": controller.shutdown_requested,
        "armed": controller.shutdown_poweroff_armed,
        "powerOffCalled": power_off_called,
    }


if __name__ == "__main__":
    print(json.dumps({
        "request_without_total_deadline_virtual_seconds": slow_request_probe(),
        "touch_read_changes_manual_lighting": read_side_effect_probe(),
        "persistent_fault_after_3100ms": fault_probe(),
        "extension_schema_rejects_out_of_bounds": extension_schema_probe(),
        "camera": capture_probe(),
        "move_reports_success_without_motion": unconfirmed_motion_probe(),
        "shutdown_after_lost_response": lost_shutdown_reply_probe(),
    }, indent=2))
