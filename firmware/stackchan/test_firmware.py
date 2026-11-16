import base64
import builtins
import json
import struct
import unittest
import zlib
from unittest.mock import patch

from device import DeviceController, draw_startup_feedback, poll_power_button
from http_api import BuddyHttpApi
import png_encoder
from png_encoder import rgb565_to_png


class FakeBoard:
    SERVO_ID_X = 1
    SERVO_ID_Y = 2

    def __init__(self):
        self.moves = []
        self.colors = []
        self.torque = []
        self.events = []
        self.power_enabled = False
        self.pan = 0
        self.tilt = 45
        self.touch = [0, 0, 0]
        self.invalid_feedback = False

    def set_servo_power(self, enable=True):
        self.power_enabled = enable
        self.events.append(("power", enable))

    def set_servo_torque(self, servo_id, enable=True):
        self.torque.append((servo_id, enable))
        self.events.append(("torque", servo_id, enable))

    def set_servo_angle(self, servo_id, angle, duration, speed):
        self.moves.append((servo_id, angle, duration, speed))
        self.events.append(("move", servo_id, angle, duration, speed))
        if servo_id == self.SERVO_ID_X:
            self.pan = angle
        else:
            self.tilt = angle

    def get_servo_angle(self, servo_id):
        self.events.append(("read", servo_id))
        if self.invalid_feedback:
            return None
        return self.pan if servo_id == self.SERVO_ID_X else self.tilt

    def set_rgb_color(self, *args):
        self.colors.append(args)
        self.events.append(("rgb",) + args)

    def get_touch(self, index=None):
        return list(self.touch) if index is None else self.touch[index]

    def get_battery_voltage(self):
        return 4.1

    def get_battery_current(self):
        return 0.2

    def get_battery_power(self):
        return 0.82


class FakeImage:
    def __init__(self, width, height, pixels):
        self._width = width
        self._height = height
        self._pixels = bytearray(pixels)

    def width(self):
        return self._width

    def height(self):
        return self._height

    def bytearray(self):
        return self._pixels


class FakeCamera:
    on_snapshot = None

    def snapshot(self):
        if self.on_snapshot is not None:
            self.on_snapshot()
        return FakeImage(1, 1, b"\xf8\x00")


class FakeWidgets:
    def __init__(self):
        self.brightness = []

    def setBrightness(self, value):
        self.brightness.append(value)


class FakePower:
    def __init__(self):
        self.events = []

    def setLed(self, brightness):
        self.events.append(("led", brightness))

    def powerOff(self):
        self.events.append(("powerOff",))


class FakePowerButton:
    def __init__(self):
        self.pressed = False
        self.held_long_enough = False

    def isPressed(self):
        return self.pressed

    def pressedFor(self, duration_ms):
        self.last_duration = duration_ms
        return self.held_long_enough


class FakeCatRenderer:
    def __init__(self):
        self.frames = []
        self.ticks = []

    def render(self, mode, action="idle", touched=False, message=None):
        self.frames.append({
            "mode": mode,
            "action": action,
            "touched": touched,
            "message": message,
        })
        return True

    def tick(self, now_ms=None):
        self.ticks.append(now_ms)
        return False


class FailingTorqueBoard(FakeBoard):
    def set_servo_torque(self, servo_id, enable=True):
        super().set_servo_torque(servo_id, enable)
        if servo_id == self.SERVO_ID_Y and enable:
            raise RuntimeError("tilt torque failure")


class FakeIR:
    def rx_cb(self, callback):
        self.callback = callback

    def tx(self, address, data):
        self.sent = (address, data)


class FakeCard:
    uid_str = "04AABBCC"
    type_name = "Mifare"
    user_memory = 144


class FakeNfc:
    def detect(self):
        return FakeCard()


class FakeSpeaker:
    def tone(self, frequency, duration):
        self.last_tone = (frequency, duration)


class FakeDisplay:
    def __init__(self):
        self.drawn = []

    def width(self):
        return 320

    def height(self):
        return 240

    def fillScreen(self, color):
        self.drawn.append(("fillScreen", color))

    def fillCircle(self, x, y, radius, color):
        self.drawn.append(("fillCircle", x, y, radius, color))

    def drawLine(self, x0, y0, x1, y1, color):
        self.drawn.append(("drawLine", x0, y0, x1, y1, color))

    def clear(self, color):
        self.clear_color = color

    def setTextColor(self, foreground, background):
        self.text_colors = (foreground, background)

    def setCursor(self, x, y):
        self.cursor = (x, y)

    def setTextSize(self, size):
        self.text_size = size

    def print(self, text, color=None):
        self.text = text
        self.drawn.append(("print", text))


class FakeAls:
    def getLightSensorData(self):
        return 74


class FakeImu:
    def getAccel(self):
        return (0.1, 0.2, 0.9)

    def getGyro(self):
        return (1.0, 2.0, 3.0)


class DeviceControllerTests(unittest.TestCase):
    def setUp(self):
        self.board = FakeBoard()
        self.camera = FakeCamera()
        self.ir = FakeIR()
        self.nfc = FakeNfc()
        self.speaker = FakeSpeaker()
        self.display = FakeDisplay()
        self.widgets = FakeWidgets()
        self.als = FakeAls()
        self.imu = FakeImu()
        self.cat_renderer = FakeCatRenderer()
        self.delays = []
        self.device = DeviceController(
            self.board,
            self.camera,
            ir=self.ir,
            nfc=self.nfc,
            speaker=self.speaker,
            display=self.display,
            display_brightness=self.widgets.setBrightness,
            als=self.als,
            imu=self.imu,
            device_id="stackchan-test",
            sleep_ms=self._record_sleep,
        )

    def _record_sleep(self, duration_ms):
        self.delays.append(duration_ms)
        self.board.events.append(("sleep", duration_ms))

    def make_ready(self):
        self.device.update(wifi_connected=True, service_ready=True)

    def test_default_clock_helpers_do_not_import_time_on_hot_path(self):
        original_import = builtins.__import__

        def reject_time_import(name, *args, **kwargs):
            if name in ("time", "utime"):
                raise AssertionError("clock helper imported time dynamically")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=reject_time_import):
            DeviceController._default_sleep(0)
            ticks = DeviceController._default_ticks()
            difference = DeviceController._default_ticks_diff(17, 12)

        self.assertIsInstance(ticks, int)
        self.assertEqual(difference, 5)

    def test_injected_clock_functions_remain_supported(self):
        now = [123]
        device = DeviceController(
            FakeBoard(), FakeCamera(),
            ticks_ms=lambda: now[0],
            ticks_diff=lambda later, earlier: later - earlier,
            sleep_ms=lambda _duration_ms: None,
            inactivity_sleep_ms=0,
        )

        self.assertEqual(device.ticks_ms(), 123)
        self.assertEqual(device.ticks_diff(140, 123), 17)

    def test_lifecycle_starts_booting_and_advertises_sleep_wake(self):
        state = self.device.status()["state"]
        definitions = {item["name"]: item for item in self.device.capabilities()}

        self.assertEqual(state["mode"], "booting")
        self.assertEqual(state["action"], "idle")
        for name in ("device.sleep", "device.wake"):
            self.assertEqual(definitions[name]["inputSchema"], {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            })

        self.device.update(wifi_connected=False, service_ready=False)
        self.assertEqual(self.device.status()["state"]["mode"], "connecting")
        self.make_ready()
        self.assertEqual(self.device.status()["state"]["mode"], "ready")

    def test_startup_feedback_draws_before_optional_hardware_initialization(self):
        display = FakeDisplay()
        widgets = FakeWidgets()

        draw_startup_feedback(display, widgets.setBrightness)

        self.assertEqual(widgets.brightness, [128])
        self.assertIn(("print", "BOOTING"), display.drawn)
        self.assertTrue(any(event[0] == "fillCircle" for event in display.drawn))

    def test_startup_draws_cat_frame_before_native_fallback(self):
        display = FakeDisplay()
        widgets = FakeWidgets()
        renderer = FakeCatRenderer()

        drawn_by_cat = draw_startup_feedback(display, widgets.setBrightness, renderer)

        self.assertTrue(drawn_by_cat)
        self.assertEqual(widgets.brightness, [128])
        self.assertEqual(renderer.frames[0]["mode"], "booting")
        self.assertIn(("fillScreen", 0x000000), display.drawn)
        self.assertFalse(any(event[0] == "fillCircle" for event in display.drawn))
        self.assertFalse(any(event == ("print", "BOOTING") for event in display.drawn))

    def test_camera_action_exposes_acting_mode_and_returns_to_ready(self):
        self.make_ready()
        observed = []
        self.camera.on_snapshot = lambda: observed.append(self.device.status()["state"])

        self.device.invoke("r1", "camera.capture", {})

        self.assertEqual(observed[0]["mode"], "acting")
        self.assertEqual(observed[0]["action"], "camera.capture")
        self.assertEqual(self.device.status()["state"]["mode"], "ready")
        self.assertIn(("print", "SENSING"), self.display.drawn)
        self.assertIn(("print", "READY"), self.display.drawn)

    def test_sleep_is_idempotent_blocks_actions_and_wake_does_not_move_head(self):
        self.make_ready()
        self.device.initialize_servos()
        self.device.invoke("r1", "display.text", {"text": "Room ready"})
        previous_moves = list(self.board.moves)

        self.device.invoke("r2", "device.sleep", {})
        self.device.invoke("r3", "device.sleep", {})
        self.assertEqual(self.device.status()["state"]["mode"], "sleeping")
        self.assertFalse(self.board.power_enabled)
        self.assertEqual(self.board.torque[-2:], [(1, False), (2, False)])
        self.assertEqual(self.widgets.brightness[-1], 12)
        self.assertIn(("print", "SLEEPING"), self.display.drawn)
        self.assertIn(("print", "WAKE BY API OR TOUCH"), self.display.drawn)
        with self.assertRaisesRegex(RuntimeError, "device.wake"):
            self.device.invoke("r4", "head.home", {})
        self.assertEqual(self.device.status()["state"]["mode"], "sleeping")
        with self.assertRaisesRegex(ValueError, "additional property"):
            self.device.invoke("r4b", "device.wake", {"unexpected": True})
        self.assertEqual(self.device.status()["state"]["mode"], "sleeping")

        self.device.invoke("r5", "device.wake", {})
        self.device.invoke("r6", "device.wake", {})
        self.assertEqual(self.device.status()["state"]["mode"], "ready")
        self.assertFalse(self.board.power_enabled)
        self.assertEqual(self.board.moves, previous_moves)
        self.assertEqual(self.widgets.brightness[-1], 128)
        self.assertIn(("print", "Room ready"), self.display.drawn)

    def test_error_state_is_visible_and_explicit_wake_recovers_without_moving(self):
        self.make_ready()
        self.device.set_error("Camera unavailable", component="camera")
        previous_moves = list(self.board.moves)

        self.assertEqual(self.device.status()["state"]["mode"], "error")
        self.assertEqual(self.device.status()["state"]["faults"], [{
            "component": "camera", "message": "Camera unavailable", "sinceMs": self.device.ticks_ms(),
        }])
        self.assertIn(("print", "ERROR"), self.display.drawn)
        self.assertIn(("print", "Camera unavailable"), self.display.drawn)

        self.device.invoke("r1", "device.wake", {})

        self.assertEqual(self.device.status()["state"]["mode"], "error")
        self.assertEqual(self.device.status()["state"]["lastError"], "Camera unavailable")
        self.assertEqual(self.device.status()["state"]["lastInvocationError"], None)
        self.assertEqual(self.board.moves, previous_moves)

        self.device.clear_error("camera")
        self.assertEqual(self.device.status()["state"]["mode"], "ready")
        self.assertEqual(self.device.status()["state"]["faults"], [])

    def test_shutdown_without_response_arm_uses_bounded_fallback(self):
        now = [100]
        power = FakePower()
        device = DeviceController(
            self.board, self.camera, power=power, ticks_ms=lambda: now[0],
            sleep_ms=lambda _ms: None,
        )
        device.request_shutdown()

        now[0] = 2599
        device.update()
        self.assertNotIn(("powerOff",), power.events)

        now[0] = 2600
        device.update()
        self.assertEqual(power.events[-1], ("powerOff",))
        device.update()
        self.assertEqual(power.events.count(("powerOff",)), 1)

    def test_persistent_component_fault_does_not_expire_after_three_seconds(self):
        now = [100]
        device = DeviceController(
            self.board, self.camera, ticks_ms=lambda: now[0],
            sleep_ms=lambda _ms: None,
        )
        device.update(wifi_connected=True, service_ready=True)
        device.set_error("Camera unavailable", component="camera")

        now[0] = 5000
        device.update(wifi_connected=True, service_ready=True)

        self.assertEqual(device.mode, "error")
        self.assertEqual(device.status()["state"]["faults"][0]["component"], "camera")

    def test_invalid_arguments_do_not_change_hardware_mode_or_activity(self):
        self.make_ready()
        last_activity = self.device._last_activity_ms

        with self.assertRaises(ValueError):
            self.device.invoke("invalid-pan", "head.move", {"pan": 120})

        state = self.device.status()["state"]
        self.assertEqual(state["mode"], "ready")
        self.assertEqual(state["action"], "idle")
        self.assertEqual(state["faults"], [])
        self.assertIn("maximum", state["lastInvocationError"])
        self.assertEqual(self.device._last_activity_ms, last_activity)

        validation_error = state["lastInvocationError"]
        self.device.invoke("passive-read", "touch.read", {})
        self.assertEqual(
            self.device.status()["state"]["lastInvocationError"], validation_error
        )
        self.assertEqual(self.device._last_activity_ms, last_activity)

    def test_led_index_without_strip_is_rejected_before_handler_without_fault(self):
        self.make_ready()
        called = []

        def reject_led_args(args):
            called.append(args)
            raise ValueError("index requires strip")

        self.device._handlers["led.set"] = reject_led_args

        with self.assertRaises(ValueError):
            self.device.invoke("invalid-led-index", "led.set", {
                "color": 123, "index": 0,
            })

        state = self.device.status()["state"]
        self.assertEqual(called, [])
        self.assertEqual(state["mode"], "ready")
        self.assertEqual(state["faults"], [])
        self.assertIsNone(state["lastError"])
        self.assertIn("at least one", state["lastInvocationError"])

    def test_handler_value_errors_do_not_become_persistent_component_faults(self):
        self.make_ready()

        def reject_led_request(_args):
            raise ValueError("manual LED arguments are inconsistent")

        self.device._handlers["led.set"] = reject_led_request

        with self.assertRaisesRegex(ValueError, "inconsistent"):
            self.device.invoke("handler-invalid-led", "led.set", {"color": 123})

        state = self.device.status()["state"]
        self.assertEqual(state["mode"], "ready")
        self.assertEqual(state["faults"], [])
        self.assertIsNone(state["lastError"])
        self.assertIn("inconsistent", state["lastInvocationError"])

        def reject_module_request(_args):
            raise ValueError("module validation failed")

        self.device.register_capability(
            {"name": "module.validation", "inputSchema": {"type": "object"}},
            reject_module_request,
        )
        with self.assertRaisesRegex(ValueError, "module validation"):
            self.device.invoke("handler-invalid-module", "module.validation", {})

        state = self.device.status()["state"]
        self.assertEqual(state["mode"], "ready")
        self.assertEqual(state["action"], "idle")
        self.assertEqual(state["faults"], [])
        self.assertIsNone(state["lastError"])

    def test_registered_module_schema_is_validated_before_handler_or_mode_change(self):
        called = []
        self.device.register_capability({
            "name": "module.test",
            "inputSchema": {
                "type": "object",
                "properties": {"value": {"type": "integer", "minimum": 0, "maximum": 4}},
                "required": ["value"],
                "additionalProperties": False,
            },
        }, lambda args: called.append(args))
        self.make_ready()

        with self.assertRaises(ValueError):
            self.device.invoke("module-invalid", "module.test", {"value": 5})

        self.assertEqual(called, [])
        self.assertEqual(self.device.mode, "ready")
        self.assertEqual(self.device.action, "idle")
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.device.register_capability({
                "name": "module.unsupported",
                "inputSchema": {"type": "string", "pattern": "^x$"},
            }, lambda _args: None)

    def test_faults_are_cleared_by_verified_successful_component_action(self):
        self.make_ready()
        self.device.set_error("Servo feedback unavailable", component="servo")

        result = self.device.invoke("recover-servo", "head.move", {"pan": 5})

        self.assertTrue(result["result"]["ok"])
        self.assertEqual(self.device.status()["state"]["faults"], [])
        self.assertEqual(self.device.mode, "ready")

    def test_shutdown_is_advertised_only_when_poweroff_api_is_available(self):
        names = {item["name"] for item in self.device.capabilities()}
        self.assertNotIn("device.shutdown", names)

        powered_device = DeviceController(
            FakeBoard(), FakeCamera(), power=FakePower(), sleep_ms=lambda _ms: None,
        )
        powered_names = {item["name"] for item in powered_device.capabilities()}
        self.assertIn("device.shutdown", powered_names)

    def test_shutdown_waits_for_response_arm_and_settle_delay(self):
        now = [100]
        power = FakePower()
        renderer = FakeCatRenderer()
        device = DeviceController(
            self.board, self.camera, power=power, display=self.display,
            ticks_ms=lambda: now[0], sleep_ms=lambda _ms: None,
            cat_renderer=renderer,
        )
        api = BuddyHttpApi(device, "local-secret")
        body = json.dumps({
            "requestId": "shutdown-1",
            "capability": "device.shutdown",
            "args": {},
        }).encode()

        status, response = api.handle(
            "POST", "/v1/invoke", {"authorization": "Bearer local-secret"}, body
        )

        payload = json.loads(response)
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["mode"], "shutting_down")
        self.assertEqual(device.status()["state"]["mode"], "shutting_down")
        self.assertEqual(renderer.frames[-1]["mode"], "shutting_down")
        self.assertIn(("led", 0), power.events)
        self.assertIn((0,), self.board.colors)
        self.assertNotIn(("powerOff",), power.events)

        # The HTTP loop arms immediately after successfully writing the response.
        device.arm_shutdown_poweroff()
        now[0] = 599
        device.update()
        self.assertNotIn(("powerOff",), power.events)
        now[0] = 600
        device.update()
        self.assertEqual(power.events[-1], ("powerOff",))

    def test_shutdown_is_allowed_from_sleep_and_rejects_invalid_args(self):
        power = FakePower()
        device = DeviceController(
            self.board, self.camera, power=power, sleep_ms=lambda _ms: None,
        )
        device.invoke("r1", "device.sleep", {})

        result = device.invoke("r2", "device.shutdown", {})

        self.assertEqual(result["result"]["mode"], "shutting_down")
        self.assertFalse(self.board.power_enabled)
        self.assertNotIn(("powerOff",), power.events)

        other = DeviceController(
            FakeBoard(), FakeCamera(), power=FakePower(), sleep_ms=lambda _ms: None,
        )
        with self.assertRaisesRegex(ValueError, "additional property"):
            other.invoke("r3", "device.shutdown", {"unexpected": True})
        self.assertFalse(other.shutdown_requested)
        self.assertNotIn(("powerOff",), other.power.events)

    def test_power_button_long_press_requests_shutdown_once_per_press(self):
        now = [0]
        power = FakePower()
        device = DeviceController(
            FakeBoard(), FakeCamera(), power=power, sleep_ms=lambda _ms: None,
            ticks_ms=lambda: now[0],
        )
        button = FakePowerButton()
        latched = False

        latched = poll_power_button(button, device, latched)
        self.assertFalse(latched)
        button.pressed = True
        button.held_long_enough = True
        latched = poll_power_button(button, device, latched)
        self.assertTrue(latched)
        self.assertTrue(device.shutdown_requested)
        self.assertTrue(device.shutdown_poweroff_armed)
        self.assertEqual(button.last_duration, 2000)
        request_count = len([event for event in power.events if event == ("led", 0)])

        latched = poll_power_button(button, device, latched)
        self.assertTrue(latched)
        self.assertEqual(
            len([event for event in power.events if event == ("led", 0)]),
            request_count,
        )
        now[0] = 499
        device.update()
        self.assertNotIn(("powerOff",), power.events)
        now[0] = 500
        device.update()
        self.assertEqual(power.events[-1], ("powerOff",))
        self.assertEqual(device.status()["state"]["mode"], "shutting_down")
        self.assertTrue(device.shutdown_requested)
        button.pressed = False
        latched = poll_power_button(button, device, latched)
        self.assertFalse(latched)

    def test_touch_wakes_sleeping_device_without_powering_servos(self):
        now = [0]
        self.device.ticks_ms = lambda: now[0]
        self.make_ready()
        self.device.invoke("r1", "device.sleep", {})
        previous_moves = list(self.board.moves)
        self.board.touch = [0, 2, 0]

        self.device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(self.device.status()["state"]["mode"], "sleeping")
        now[0] = 120
        self.device.update(wifi_connected=True, service_ready=True)

        self.assertEqual(self.device.status()["state"]["mode"], "ready")
        self.assertFalse(self.board.power_enabled)
        self.assertEqual(self.board.moves, previous_moves)

    def test_touch_must_release_before_a_new_touch_wakes_sleep(self):
        now = [0]
        self.device.ticks_ms = lambda: now[0]
        self.make_ready()
        self.board.touch = [2, 0, 0]
        self.device.invoke("r1", "device.sleep", {})

        self.device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(self.device.status()["state"]["mode"], "sleeping")

        self.board.touch = [0, 0, 0]
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 200
        self.device.update(wifi_connected=True, service_ready=True)
        self.board.touch = [2, 0, 0]
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 320
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(self.device.status()["state"]["mode"], "ready")

    def test_short_touch_glitch_does_not_create_a_gesture(self):
        now = [0]
        self.device.ticks_ms = lambda: now[0]
        self.make_ready()
        self.board.touch = [2, 0, 0]
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 119
        self.board.touch = [0, 0, 0]
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 319
        self.device.update(wifi_connected=True, service_ready=True)

        self.assertIsNone(self.device.last_interaction)

    def test_held_touch_emits_once_and_requires_stable_release_to_rearm(self):
        now = [0]
        self.device.ticks_ms = lambda: now[0]
        self.make_ready()
        self.board.touch = [0, 2, 0]
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 120
        self.device.update(wifi_connected=True, service_ready=True)
        first_interaction = self.device.last_interaction
        self.assertEqual(first_interaction["zones"], [0, 1, 0])

        now[0] = 500
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertIs(self.device.last_interaction, first_interaction)

        self.board.touch = [0, 0, 0]
        now[0] = 600
        self.device.update(wifi_connected=True, service_ready=True)
        self.board.touch = [0, 3, 0]
        now[0] = 750
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 870
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertIs(self.device.last_interaction, first_interaction)

        self.board.touch = [0, 0, 0]
        now[0] = 900
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 1100
        self.device.update(wifi_connected=True, service_ready=True)
        self.board.touch = [2, 0, 0]
        now[0] = 1101
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 1221
        self.device.update(wifi_connected=True, service_ready=True)

        self.assertEqual(self.device.last_interaction["zones"], [1, 0, 0])

    def test_touch_read_returns_raw_sensor_values_without_debounce(self):
        self.make_ready()
        self.board.touch = [3, 0, 2]
        result = self.device.invoke("raw-touch", "touch.read", {})["result"]
        self.assertEqual(result["zones"], [3, 0, 2])

    def test_sustained_low_touch_output_does_not_create_a_gesture_or_wake(self):
        now = [0]
        self.device.ticks_ms = lambda: now[0]
        self.make_ready()
        self.board.touch = [1, 0, 0]
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 1000
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertIsNone(self.device.last_interaction)

        self.board.touch = [0, 0, 0]
        self.device.invoke("sleep-low", "device.sleep", {})
        self.board.touch = [1, 0, 0]
        now[0] = 1200
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 1600
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(self.device.status()["state"]["mode"], "sleeping")

    def test_sustained_low_touch_output_does_not_reset_inactivity_deadline(self):
        now = [0]
        device = DeviceController(
            self.board, self.camera, ticks_ms=lambda: now[0],
            inactivity_sleep_ms=1000,
        )
        device.update(wifi_connected=True, service_ready=True)
        self.board.touch = [0, 0, 1]
        now[0] = 100
        device.update(wifi_connected=True, service_ready=True)
        now[0] = 220
        device.update(wifi_connected=True, service_ready=True)
        now[0] = 1200
        device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(device.status()["state"]["mode"], "sleeping")

    def test_boolean_touch_fake_remains_supported_after_debounce(self):
        now = [0]
        self.device.ticks_ms = lambda: now[0]
        self.make_ready()
        self.board.touch = [True, False, False]
        self.device.update(wifi_connected=True, service_ready=True)
        now[0] = 120
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(self.device.last_interaction["zones"], [1, 0, 0])

    def test_status_poll_and_idle_touch_read_do_not_reset_sleep_deadline(self):
        now = [0]
        device = DeviceController(
            self.board,
            self.camera,
            sleep_ms=lambda _ms: None,
            ticks_ms=lambda: now[0],
            inactivity_sleep_ms=300000,
        )
        device.update(wifi_connected=True, service_ready=True)
        now[0] = 299999
        device.status()
        device.invoke("r1", "touch.read", {})
        now[0] = 300000

        device.update(wifi_connected=True, service_ready=True)

        self.assertEqual(device.status()["state"]["mode"], "sleeping")

    def test_inactivity_timeout_is_wrap_safe_and_can_be_disabled(self):
        period = 1 << 30
        now = [(1 << 30) - 100]
        diff = lambda current, previous: ((current - previous + period // 2) % period) - period // 2
        device = DeviceController(
            self.board, self.camera, display=self.display,
            display_brightness=self.widgets.setBrightness,
            sleep_ms=lambda _ms: None,
            ticks_ms=lambda: now[0],
            ticks_diff=diff,
            inactivity_sleep_ms=300000,
        )
        device.update(wifi_connected=True, service_ready=True)
        now[0] = (now[0] + 299999) % period
        device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(device.status()["state"]["mode"], "ready")

        now[0] = (now[0] + 1) % period
        device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(device.status()["state"]["mode"], "sleeping")

        awake_device = DeviceController(
            self.board, self.camera, sleep_ms=lambda _ms: None,
            ticks_ms=lambda: now[0], ticks_diff=diff, inactivity_sleep_ms=0,
        )
        awake_device.update(wifi_connected=True, service_ready=True)
        now[0] = (now[0] + period // 2 - 1) % period
        awake_device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(awake_device.status()["state"]["mode"], "ready")

    def test_status_advertises_modules_and_observation_dependencies(self):
        status = self.device.status(ip="192.168.1.20")
        names = {item["name"]: item for item in status["capabilities"]}

        self.assertEqual(status["deviceId"], "stackchan-test")
        self.assertEqual(status["state"]["ip"], "192.168.1.20")
        self.assertEqual(
            names["head.observe"]["requires"], ["head.move", "camera.capture"]
        )
        self.assertIn("infrared.send", names)
        self.assertIn("nfc.detect", names)
        self.assertIn("ambient.read", names)
        self.assertIn("imu.read", names)
        self.assertIn("display.text", names)

    def test_head_release_and_hold_are_advertised_without_pose_arguments(self):
        state = self.device.status()["state"]
        definitions = {item["name"]: item for item in self.device.capabilities()}
        empty_schema = {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        }

        self.assertFalse(state["guiding"])
        self.assertIsNone(state["lastInteraction"])
        self.assertEqual(definitions["head.release"]["inputSchema"], empty_schema)
        self.assertEqual(definitions["head.hold"]["inputSchema"], empty_schema)

    def test_release_reads_feedback_without_writing_a_new_servo_target(self):
        self.board.pan = 12
        self.board.tilt = 38

        result = self.device.invoke("r1", "head.release", {})

        self.assertTrue(result["result"]["ok"])
        self.assertTrue(self.device.status()["state"]["guiding"])
        self.assertTrue(self.board.power_enabled)
        self.assertEqual(self.board.moves, [])
        self.assertEqual(self.board.torque[-2:], [(1, False), (2, False)])
        self.assertLess(self.board.events.index(("torque", 1, False)), self.board.events.index(("read", 1)))

    def test_hold_syncs_new_hand_pose_before_enabling_torque(self):
        self.device.invoke("r1", "head.release", {})
        self.board.pan = 23
        self.board.tilt = 31
        start = len(self.board.events)

        result = self.device.invoke("r2", "head.hold", {})

        events = self.board.events[start:]
        self.assertTrue(result["result"]["ok"])
        self.assertFalse(self.device.status()["state"]["guiding"])
        servo_events = [event for event in events if event[0] in ("read", "move", "torque")]
        self.assertEqual(servo_events[:4], [
            ("read", 1), ("read", 2),
            ("move", 1, 23, 100, 0), ("move", 2, 31, 100, 0),
        ])
        self.assertEqual(servo_events[4:6], [("torque", 1, True), ("torque", 2, True)])

    def test_commanded_move_resynchronizes_guided_pose_before_torque_and_motion(self):
        self.device.invoke("r1", "head.release", {})
        self.board.pan = 15
        self.board.tilt = 40
        start = len(self.board.events)

        self.device.invoke("r2", "head.move", {"pan": 30})

        events = self.board.events[start:]
        sync_pan = events.index(("move", 1, 15, 100, 0))
        sync_tilt = events.index(("move", 2, 40, 100, 0))
        torque_on = events.index(("torque", 1, True))
        requested_move = events.index(("move", 1, 30, 800, 20))
        self.assertLess(events.index(("read", 1)), sync_pan)
        self.assertLess(sync_pan, torque_on)
        self.assertLess(sync_tilt, torque_on)
        self.assertLess(torque_on, requested_move)
        self.assertFalse(self.device.status()["state"]["guiding"])

    def test_guiding_reports_measured_hand_motion_without_commanding_servos(self):
        now = [0]
        board = FakeBoard()
        device = DeviceController(
            board, FakeCamera(), ticks_ms=lambda: now[0], sleep_ms=lambda _ms: None,
            inactivity_sleep_ms=500,
        )
        device.update(wifi_connected=True, service_ready=True)
        device.invoke("r1", "head.release", {})
        start = len(board.moves)
        now[0] = 100
        board.pan = 20
        board.tilt = 50

        device.update(wifi_connected=True, service_ready=True)

        state = device.status()["state"]
        self.assertEqual(state["lastInteraction"], {
            "type": "head.moved_by_hand", "pan": 20, "tilt": 50, "atMs": 100,
        })
        self.assertEqual(state["head"], {"pan": 20, "tilt": 50})
        self.assertTrue(state["guiding"])
        self.assertEqual(len(board.moves), start)
        now[0] = 599
        device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(device.status()["state"]["mode"], "ready")

    def test_invalid_guiding_feedback_is_reported_without_a_fabricated_pose(self):
        self.device.invoke("r1", "head.release", {})
        start = len(self.board.moves)
        self.board.invalid_feedback = True
        self.device.ticks_ms = lambda: 100
        self.device._guiding_last_poll_ms = 0

        self.device.update(wifi_connected=True, service_ready=True)

        state = self.device.status()["state"]
        self.assertEqual(state["lastInteraction"]["type"], "head.feedback_warning")
        self.assertIn("feedback", state["lastInteraction"]["reason"])
        self.assertIsNone(state["head"])
        self.assertEqual(len(self.board.moves), start)
        self.assertTrue(state["guiding"])

    def test_touch_edges_update_interaction_light_and_cat_without_repeating(self):
        now = [100]
        board = FakeBoard()
        renderer = FakeCatRenderer()
        device = DeviceController(
            board, FakeCamera(), display=FakeDisplay(), cat_renderer=renderer,
            ticks_ms=lambda: now[0], sleep_ms=lambda _ms: None,
            inactivity_sleep_ms=1000,
        )
        device.update(wifi_connected=True, service_ready=True)
        board.touch = [0, 2, 0]

        device.update(wifi_connected=True, service_ready=True)
        now[0] = 220
        device.update(wifi_connected=True, service_ready=True)

        state = device.status()["state"]
        self.assertEqual(state["lastInteraction"], {
            "type": "touch", "zones": [0, 1, 0], "atMs": 220,
        })
        lighting = state["lighting"]
        self.assertEqual(lighting["source"], "touch")
        self.assertTrue(any(color[2] > color[0] for strip in lighting["strips"] for color in strip))
        self.assertTrue(any(frame["touched"] for frame in renderer.frames))
        frame_count = len(renderer.frames)
        device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(len(renderer.frames), frame_count)
        self.assertTrue(renderer.ticks)

    def test_touch_edge_wakes_sleeping_device_and_records_zone(self):
        self.device.ticks_ms = lambda: 100
        self.make_ready()
        self.device.invoke("r1", "device.sleep", {})
        self.board.touch = [2, 0, 3]

        self.device.update(wifi_connected=True, service_ready=True)
        self.device.ticks_ms = lambda: 220
        self.device.update(wifi_connected=True, service_ready=True)

        self.assertEqual(self.device.status()["state"]["mode"], "ready")
        self.assertEqual(self.device.status()["state"]["lastInteraction"], {
            "type": "touch", "zones": [1, 0, 1], "atMs": self.device.ticks_ms(),
        })

    def test_manual_led_override_survives_led_action_then_resets_on_next_mode(self):
        self.make_ready()
        self.device.invoke("r1", "led.set", {"color": 0x123456})
        start = len(self.board.colors)

        self.device.update(wifi_connected=True, service_ready=True)

        self.assertEqual(len(self.board.colors), start)
        self.device.invoke("r2", "device.sleep", {})
        self.assertNotEqual(self.board.colors[-1], (0x123456,))

    def test_cat_renderer_draws_transitions_and_ticks_without_blocking(self):
        renderer = FakeCatRenderer()
        device = DeviceController(
            self.board, self.camera, display=self.display,
            cat_renderer=renderer, sleep_ms=lambda _ms: None,
        )
        device.update(wifi_connected=True, service_ready=True)
        self.assertTrue(any(frame["mode"] == "ready" for frame in renderer.frames))
        tick_count = len(renderer.ticks)

        device.update(wifi_connected=True, service_ready=True)

        self.assertGreater(len(renderer.ticks), tick_count)

    def test_startup_initialization_reads_and_syncs_head_without_moving_it(self):
        position = self.device.initialize_servos()

        self.assertEqual(position, {"pan": 0, "tilt": 45})
        self.assertEqual(self.board.moves, [(1, 0, 100, 0), (2, 45, 100, 0)])
        self.assertEqual(self.board.torque[-2:], [(1, True), (2, True)])
        self.assertEqual(self.device.status()["state"]["head"], position)
        self.assertEqual(self.delays, [1000])
        servo_events = [event for event in self.board.events
                        if event[0] in ("power", "sleep", "torque", "read", "move")]
        self.assertEqual(
            servo_events[:10],
            [
                ("power", True),
                ("sleep", 1000),
                ("torque", 1, False),
                ("torque", 2, False),
                ("read", 1),
                ("read", 2),
                ("move", 1, 0, 100, 0),
                ("move", 2, 45, 100, 0),
                ("torque", 1, True),
                ("torque", 2, True),
            ],
        )

    def test_head_move_rejects_angles_outside_safe_ranges(self):
        with self.assertRaises(ValueError):
            self.device.invoke("r1", "head.move", {"pan": 120})
        with self.assertRaises(ValueError):
            self.device.invoke("r2", "head.move", {"tilt": 90})
        self.assertEqual(self.board.moves, [])
        self.assertFalse(self.board.power_enabled)

    def test_home_can_recover_a_pose_inside_documented_servo_limits(self):
        self.board.pan = 110
        self.board.tilt = 0

        result = self.device.invoke("r1", "head.home", {})

        self.assertTrue(result["result"]["ok"])
        self.assertEqual(self.board.moves[:2], [(1, 110, 100, 0), (2, 0, 100, 0)])
        self.assertEqual(self.board.moves[-2:], [(1, 0, 800, 20), (2, 45, 800, 20)])

    def test_head_movement_stops_when_feedback_is_outside_driver_limits(self):
        self.board.pan = 140

        with self.assertRaises(RuntimeError):
            self.device.invoke("r1", "head.home", {})

        self.assertFalse(self.board.power_enabled)
        self.assertEqual(self.board.moves, [])

    def test_partial_servo_initialization_is_deenergized(self):
        board = FailingTorqueBoard()
        device = DeviceController(board, FakeCamera(), sleep_ms=lambda _ms: None)

        with self.assertRaisesRegex(RuntimeError, "tilt torque failure"):
            device.invoke("r1", "head.home", {})

        self.assertFalse(board.power_enabled)
        self.assertEqual(board.torque[-2:], [(1, False), (2, False)])

    def test_head_move_and_home_use_documented_servo_ids(self):
        result = self.device.invoke(
            "r1", "head.move", {"pan": -40, "tilt": 55, "speed": 20}
        )
        self.assertTrue(result["result"]["ok"])
        self.assertTrue(self.board.power_enabled)
        self.assertEqual(self.board.torque[-2:], [(1, True), (2, True)])
        self.assertEqual(self.board.moves[-2:], [(1, -40, 800, 20), (2, 55, 800, 20)])
        self.assertEqual(self.delays, [1000, 800])

        self.device.invoke("r2", "head.home", {})
        self.assertEqual(self.board.moves[-2:], [(1, 0, 800, 20), (2, 45, 800, 20)])
        self.assertEqual(self.delays, [1000, 800, 800])

    def test_head_move_rejects_motion_that_never_reaches_feedback_target(self):
        now = [0]
        board = FakeBoard()
        original_set = board.set_servo_angle

        def drop_motion(servo_id, angle, duration, speed):
            original_set(servo_id, angle, duration, speed)
            if servo_id == board.SERVO_ID_X:
                board.pan = 0
            else:
                board.tilt = 45

        board.set_servo_angle = drop_motion
        device = DeviceController(
            board, FakeCamera(), sleep_ms=lambda duration: now.__setitem__(0, now[0] + duration),
            ticks_ms=lambda: now[0], inactivity_sleep_ms=0,
        )

        with self.assertRaisesRegex(RuntimeError, "within 3 degrees"):
            device.invoke("stalled-move", "head.move", {"pan": 20, "moveTimeMs": 250})

        self.assertEqual(device.status()["state"]["faults"][0]["component"], "servo")
        self.assertFalse(board.power_enabled)

    def test_head_move_rejects_missing_post_move_feedback(self):
        now = [0]
        board = FakeBoard()
        get_angle = board.get_servo_angle
        moved = [False]
        original_set = board.set_servo_angle

        def set_motion(servo_id, angle, duration, speed):
            original_set(servo_id, angle, duration, speed)
            moved[0] = True

        def lose_feedback(servo_id):
            if moved[0]:
                return None
            return get_angle(servo_id)

        board.set_servo_angle = set_motion
        board.get_servo_angle = lose_feedback
        device = DeviceController(
            board, FakeCamera(), sleep_ms=lambda duration: now.__setitem__(0, now[0] + duration),
            ticks_ms=lambda: now[0], inactivity_sleep_ms=0,
        )

        with self.assertRaisesRegex(RuntimeError, "feedback"):
            device.invoke("lost-feedback", "head.move", {"pan": 20, "moveTimeMs": 250})

        self.assertEqual(device.status()["state"]["faults"][0]["component"], "servo")
        self.assertFalse(board.power_enabled)

    def test_head_move_accepts_feedback_within_three_degree_tolerance(self):
        board = FakeBoard()
        get_angle = board.get_servo_angle

        def slightly_offset_feedback(servo_id):
            return get_angle(servo_id) - 3

        board.get_servo_angle = slightly_offset_feedback
        device = DeviceController(board, FakeCamera(), sleep_ms=lambda _ms: None)

        result = device.invoke("within-tolerance", "head.move", {"pan": 10})["result"]

        self.assertTrue(result["feedbackVerified"])
        self.assertEqual(result["target"]["pan"], 10)
        self.assertEqual(result["pan"], 7)

    def test_hold_and_release_verify_torque_when_board_exposes_readback(self):
        board = FakeBoard()
        torque_enabled = [False]
        original_set_torque = board.set_servo_torque

        class FakeScscl:
            def read_torque_enable(self, _servo_id):
                return int(torque_enabled[0])

        def set_torque(servo_id, enabled=True):
            original_set_torque(servo_id, enabled)
            torque_enabled[0] = enabled

        board.set_servo_torque = set_torque
        board.servo = FakeScscl()
        device = DeviceController(board, FakeCamera(), sleep_ms=lambda _ms: None)

        released = device.invoke("readback-release", "head.release", {})["result"]
        held = device.invoke("readback-hold", "head.hold", {})["result"]

        self.assertEqual(released["torqueStatus"], "confirmed")
        self.assertEqual(held["torqueStatus"], "confirmed")

    def test_torque_readback_uses_byte_width_before_sdk_word_wrapper(self):
        board = FakeBoard()
        torque_by_id = {board.SERVO_ID_X: True, board.SERVO_ID_Y: True}
        read_events = []
        original_set_torque = board.set_servo_torque

        class FakeScscl:
            def read_byte(self, servo_id, register):
                read_events.append(("byte", servo_id, register))
                return int(torque_by_id[servo_id])

            def read_torque_enable(self, servo_id):
                read_events.append(("word-wrapper", servo_id))
                return 256 if torque_by_id[servo_id] else 0

        def set_torque(servo_id, enabled=True):
            original_set_torque(servo_id, enabled)
            torque_by_id[servo_id] = enabled

        board.servo = FakeScscl()
        board.set_servo_torque = set_torque
        device = DeviceController(board, FakeCamera(), sleep_ms=lambda _ms: None)

        released = device.invoke("byte-release", "head.release", {})["result"]
        held = device.invoke("byte-hold", "head.hold", {})["result"]

        self.assertEqual(released["torqueStatus"], "confirmed")
        self.assertEqual(held["torqueStatus"], "confirmed")
        self.assertIn(("byte", board.SERVO_ID_X, 40), read_events)
        self.assertIn(("byte", board.SERVO_ID_Y, 40), read_events)
        self.assertFalse(any(event[0] == "word-wrapper" for event in read_events))

    def test_release_skips_goal_write_and_hold_uses_measured_pose(self):
        class RawServo:
            def __init__(self, board):
                self.board = board
                self.positions = []
                self.reads = []

            def write_pos(self, servo_id, position, duration_ms, speed):
                self.positions.append((servo_id, position, duration_ms, speed))
                self.board.torque_state[servo_id] = True
                return 1

            def read_byte(self, servo_id, register):
                self.reads.append((servo_id, register))
                return int(self.board.torque_state[servo_id])

            def read_torque_enable(self, servo_id):
                return 256 if self.board.torque_state[servo_id] else 0

        class StackChanBoard(FakeBoard):
            def __init__(self):
                super().__init__()
                self.torque_state = {self.SERVO_ID_X: False, self.SERVO_ID_Y: False}
                self._servo_zero_runtime = {self.SERVO_ID_X: 485, self.SERVO_ID_Y: 636}
                self.servo = RawServo(self)
                self.high_level_set_count = 0
                self.angle_to_pos = lambda angle, zero: zero if angle == 0 else 780

            def set_servo_torque(self, servo_id, enable=True):
                super().set_servo_torque(servo_id, enable)
                self.torque_state[servo_id] = enable

            def set_servo_angle(self, servo_id, angle, duration, speed):
                self.high_level_set_count += 1
                super().set_servo_angle(servo_id, angle, duration, speed)
                # Match the observed SDK behavior: the high-level setter enables torque.
                self.torque_state[servo_id] = True

        board = StackChanBoard()
        device = DeviceController(board, FakeCamera(), sleep_ms=lambda _ms: None)

        released = device.invoke("raw-release", "head.release", {})["result"]
        self.assertEqual(released["torqueStatus"], "confirmed")
        self.assertFalse(board.torque_state[board.SERVO_ID_X])
        self.assertFalse(board.torque_state[board.SERVO_ID_Y])
        self.assertEqual(board.high_level_set_count, 0)
        self.assertEqual(board.servo.positions, [])

        held = device.invoke("raw-hold", "head.hold", {})["result"]
        self.assertEqual(held["torqueStatus"], "confirmed")
        self.assertTrue(board.torque_state[board.SERVO_ID_X])
        self.assertTrue(board.torque_state[board.SERVO_ID_Y])
        self.assertEqual(board.servo.positions, [
            (board.SERVO_ID_X, 485, 100, 0),
            (board.SERVO_ID_Y, 780, 100, 0),
        ])

    def test_raw_pose_sync_rejects_pwm_mode_before_write_and_deenergizes(self):
        class RawServo:
            def __init__(self):
                self.positions = []
                self.mode_reads = []

            def read_mode(self, servo_id):
                self.mode_reads.append(servo_id)
                return 1

            def write_pos(self, servo_id, position, duration_ms, speed):
                self.positions.append((servo_id, position, duration_ms, speed))
                return 1

            def read_byte(self, _servo_id, _register):
                return 0

        board = FakeBoard()
        board.servo = RawServo()
        board._servo_zero_runtime = {board.SERVO_ID_X: 485, board.SERVO_ID_Y: 636}
        board.angle_to_pos = lambda angle, zero: zero if angle == 0 else 780
        device = DeviceController(board, FakeCamera(), sleep_ms=lambda _ms: None)

        with self.assertRaisesRegex(RuntimeError, "position mode"):
            device.initialize_servos()

        self.assertEqual(board.servo.mode_reads, [board.SERVO_ID_X])
        self.assertEqual(board.servo.positions, [])
        self.assertFalse(board.power_enabled)
        self.assertEqual(board.torque[-2:], [(1, False), (2, False)])

    def test_invalid_torque_readback_is_a_servo_fault(self):
        board = FakeBoard()

        class FakeScscl:
            def read_torque_enable(self, _servo_id):
                return -1

        board.servo = FakeScscl()
        device = DeviceController(board, FakeCamera(), sleep_ms=lambda _ms: None)

        with self.assertRaisesRegex(RuntimeError, "torque feedback"):
            device.invoke("bad-torque-readback", "head.release", {})

        self.assertEqual(device.status()["state"]["faults"][0]["component"], "servo")

    def test_initialization_torque_mismatch_deenergizes_the_servo_rail(self):
        board = FakeBoard()

        class FakeScscl:
            def read_torque_enable(self, _servo_id):
                return 0

        board.servo = FakeScscl()
        device = DeviceController(board, FakeCamera(), sleep_ms=lambda _ms: None)

        with self.assertRaisesRegex(RuntimeError, "torque feedback"):
            device.initialize_servos()

        self.assertFalse(board.power_enabled)
        self.assertEqual(board.torque[-2:], [(1, False), (2, False)])

    def test_hold_and_release_report_torque_as_unconfirmed_without_readback(self):
        released = self.device.invoke("release", "head.release", {})["result"]
        held = self.device.invoke("hold", "head.hold", {})["result"]

        self.assertEqual(released["torqueStatus"], "unconfirmed")
        self.assertEqual(held["torqueStatus"], "unconfirmed")

    def test_cooperative_wait_pumps_service_and_aborts_after_shutdown(self):
        now = [0]
        device = DeviceController(
            self.board, self.camera, power=FakePower(),
            sleep_ms=lambda duration: now.__setitem__(0, now[0] + duration),
            ticks_ms=lambda: now[0], inactivity_sleep_ms=0,
        )
        device.set_error("previous camera issue", component="camera")
        calls = []

        def service():
            calls.append(now[0])
            if len(calls) == 2:
                device.request_shutdown()

        device.set_service_callback(service)

        with self.assertRaisesRegex(RuntimeError, "shutting down"):
            device.invoke("cancelled-move", "head.move", {"pan": 30})

        self.assertEqual(calls, [25, 50])
        self.assertEqual(self.board.moves, [])
        self.assertEqual(device.mode, "shutting_down")
        self.assertEqual(device.status()["state"]["faults"], [{
            "component": "camera", "message": "previous camera issue", "sinceMs": 0,
        }])

    def test_cooperative_wait_counts_time_spent_in_service_callback(self):
        now = [0]
        sleep_durations = []
        callback_count = [0]
        device = DeviceController(
            self.board, self.camera,
            sleep_ms=lambda duration: (
                sleep_durations.append(duration), now.__setitem__(0, now[0] + duration)
            ),
            ticks_ms=lambda: now[0],
        )

        def slow_service():
            callback_count[0] += 1
            if callback_count[0] == 1:
                now[0] += 40

        device.set_service_callback(slow_service)
        device._cooperative_wait(100)

        self.assertEqual(now[0], 100)
        self.assertEqual(sum(sleep_durations), 60)
        self.assertLessEqual(max(sleep_durations), 25)

    def test_transfer_mode_defers_thinking_render_until_servo_command_is_sent(self):
        events = []
        now = [0]
        movement_started_at = [None]
        board = FakeBoard()
        original_set_angle = board.set_servo_angle

        def tracked_set_angle(servo_id, angle, duration, speed):
            if duration == 800:
                events.append(("motion-command", servo_id, angle))
                if movement_started_at[0] is None:
                    movement_started_at[0] = now[0]
            original_set_angle(servo_id, angle, duration, speed)

        class TrackingRenderer(FakeCatRenderer):
            def render(self, mode, action="idle", touched=False, message=None):
                events.append(("render", mode, action))
                if mode == "acting":
                    now[0] += 250
                return super().render(mode, action, touched, message)

        board.set_servo_angle = tracked_set_angle
        renderer = TrackingRenderer()
        device = DeviceController(
            board, FakeCamera(), cat_renderer=renderer,
            sleep_ms=lambda duration: now.__setitem__(0, now[0] + duration),
            ticks_ms=lambda: now[0],
        )
        device.set_service_callback(
            lambda: device.update(wifi_connected=True, service_ready=True)
        )
        device.update(wifi_connected=True, service_ready=True)
        events.clear()

        device.invoke("ordered-move", "head.move", {"pan": 25})

        command_positions = [
            index for index, event in enumerate(events)
            if event[0] == "motion-command"
        ]
        thinking_positions = [
            index for index, event in enumerate(events)
            if event[0] == "render" and event[1] == "acting"
        ]
        self.assertTrue(command_positions)
        self.assertTrue(thinking_positions)
        self.assertLess(max(command_positions), min(thinking_positions))
        self.assertEqual(now[0] - movement_started_at[0], 800)

    def test_transfer_suppresses_lcd_ticks_but_touch_sampling_and_leds_continue(self):
        now = [0]
        board = FakeBoard()
        renderer = FakeCatRenderer()
        device = DeviceController(
            board, FakeCamera(), cat_renderer=renderer,
            ticks_ms=lambda: now[0], sleep_ms=lambda _ms: None,
        )
        device.update(wifi_connected=True, service_ready=True)
        frames_before = len(renderer.frames)
        ticks_before = len(renderer.ticks)
        colors_before = len(board.colors)

        self.assertFalse(device.set_transfer_active(True))
        board.touch = [2, 0, 0]
        now[0] = 100
        device.update(wifi_connected=True, service_ready=True)
        now[0] = 220
        device.update(wifi_connected=True, service_ready=True)

        self.assertEqual(len(renderer.frames), frames_before)
        self.assertEqual(len(renderer.ticks), ticks_before)
        self.assertGreater(len(board.colors), colors_before)
        self.assertEqual(device.status()["state"]["lastInteraction"]["type"], "touch")
        self.assertTrue(device.set_transfer_active(False))

        device.update(wifi_connected=True, service_ready=True)

        self.assertGreater(len(renderer.frames), frames_before)

    def test_transfer_pending_ready_render_coalesces_into_the_next_acting_state(self):
        class TrackingRenderer(FakeCatRenderer):
            pass

        renderer = TrackingRenderer()
        device = DeviceController(
            FakeBoard(), FakeCamera(), cat_renderer=renderer,
            sleep_ms=lambda _ms: None, ticks_ms=lambda: 0,
        )
        device.set_service_callback(
            lambda: device.update(wifi_connected=True, service_ready=True)
        )
        frames_before = len(renderer.frames)

        self.assertFalse(device.set_transfer_active(True))
        device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(len(renderer.frames), frames_before)
        self.assertTrue(device.set_transfer_active(False))

        device.invoke("coalesced-capture", "camera.capture", {})

        new_modes = [frame["mode"] for frame in renderer.frames[frames_before:]]
        self.assertEqual(new_modes[0], "acting")
        self.assertNotIn("ready", new_modes)

        device.update(wifi_connected=True, service_ready=True)
        self.assertEqual(renderer.frames[-1]["mode"], "ready")

    def test_capture_returns_owned_raw_rgb565_with_capture_time(self):
        now = [321]
        device = DeviceController(
            self.board, self.camera, display=self.display, ticks_ms=lambda: now[0],
            sleep_ms=lambda _ms: None,
        )

        image = device.invoke("raw-capture", "camera.capture", {})["result"]["image"]

        self.assertEqual(image["mimeType"], "application/x-rgb565")
        self.assertEqual(image["encoding"], "rgb565-be")
        self.assertEqual(base64.b64decode(image["data"]), b"\xf8\x00")
        self.assertEqual(image["width"], 1)
        self.assertEqual(image["height"], 1)
        self.assertEqual(image["capturedAtMs"], 321)
        self.assertNotIn("receivedAtMs", image)

    def test_capture_keeps_adapter_capture_timestamp_and_pumps_service_around_snapshot(self):
        now = [321]
        camera = FakeCamera()
        frame = FakeImage(1, 1, b"\xf8\x00")
        frame.captured_at_ms = 123
        camera.snapshot = lambda: frame
        callbacks = []
        device = DeviceController(
            self.board, camera, ticks_ms=lambda: now[0], sleep_ms=lambda _ms: None,
        )
        device.set_service_callback(lambda: callbacks.append(now[0]))

        image = device.invoke("adapter-time", "camera.capture", {})["result"]["image"]

        self.assertEqual(image["capturedAtMs"], 123)
        self.assertEqual(callbacks, [321, 321])

    def test_observe_turns_settles_then_returns_raw_frame(self):
        result = self.device.invoke("r1", "head.observe", {"direction": "left"})

        self.assertEqual(self.board.moves[-2:], [(1, -45, 800, 20), (2, 45, 800, 20)])
        self.assertEqual(self.delays, [1000, 800, 250])
        self.assertEqual(result["result"]["image"]["mimeType"], "application/x-rgb565")
        self.assertEqual(result["result"]["image"]["encoding"], "rgb565-be")
        self.assertEqual(base64.b64decode(result["result"]["image"]["data"]), b"\xf8\x00")

    def test_strip_fill_writes_each_logical_led_explicitly(self):
        self.device.invoke("strip-test", "led.set", {"strip": 1, "color": 0x123456})
        self.assertEqual(
            self.board.colors[-6:],
            [(1, index, 0x123456) for index in range(6)],
        )

    def test_other_onboard_capabilities_use_supported_stackchan_drivers(self):
        self.board.touch = [0, 1, 0]
        self.device.invoke("r1", "led.set", {"color": 0x123456})
        self.assertEqual(self.board.colors[-1], (0x123456,))
        self.assertEqual(self.device.invoke("r2", "touch.read", {})["result"]["zones"], [0, 1, 0])
        self.assertEqual(self.device.invoke("r3", "power.read", {})["result"]["voltage"], 4.1)

        self.device.invoke("r4", "infrared.send", {"address": 1, "data": 42})
        self.assertEqual(self.ir.sent, (1, 42))
        self.ir.callback(7, 2, 0)
        self.assertEqual(self.device.invoke("r5", "infrared.read", {})["result"]["data"], 7)
        self.assertEqual(self.device.invoke("r6", "nfc.detect", {})["result"]["uid"], "04AABBCC")
        self.device.invoke("r7", "speaker.tone", {"frequency": 880, "durationMs": 100})
        self.assertEqual(self.speaker.last_tone, (880, 100))
        self.device.invoke("r8", "display.text", {"text": "Room clear", "color": 0xFFFFFF})
        self.assertEqual(self.display.text, "Room clear")
        self.assertEqual(self.device.invoke("r9", "ambient.read", {})["result"]["value"], 74)
        self.assertEqual(self.device.invoke("r10", "imu.read", {})["result"]["acceleration"], [0.1, 0.2, 0.9])

    def test_new_module_capability_can_be_registered_with_dependencies(self):
        self.device.register_capability(
            {
                "name": "infrared.learn",
                "description": "Learn an infrared code.",
                "inputSchema": {"type": "object"},
                "requires": ["infrared.read"],
            },
            lambda args: {"learned": args.get("name")},
        )

        names = {item["name"]: item for item in self.device.status()["capabilities"]}
        result = self.device.invoke("r11", "infrared.learn", {"name": "lamp"})
        self.assertEqual(names["infrared.learn"]["requires"], ["infrared.read"])
        self.assertEqual(result["result"]["learned"], "lamp")


class PngEncoderTests(unittest.TestCase):
    def test_rgb565_pixel_encodes_as_a_valid_rgb_png(self):
        png = rgb565_to_png(b"\xf8\x00", 1, 1)
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")

        offset = 8
        image_data = None
        while offset < len(png):
            length = struct.unpack(">I", png[offset:offset + 4])[0]
            chunk_type = png[offset + 4:offset + 8]
            chunk = png[offset + 4:offset + 8 + length]
            checksum = struct.unpack(">I", png[offset + 8 + length:offset + 12 + length])[0]
            self.assertEqual(zlib.crc32(chunk) & 0xFFFFFFFF, checksum)
            if chunk_type == b"IHDR":
                self.assertEqual(struct.unpack(">II", png[offset + 8:offset + 16]), (1, 1))
            if chunk_type == b"IDAT":
                image_data = png[offset + 8:offset + 8 + length]
            offset += length + 12

        self.assertEqual(zlib.decompress(image_data), b"\x00\xff\x00\x00")

    def test_invalid_rgb565_buffer_is_rejected(self):
        with self.assertRaises(ValueError):
            rgb565_to_png(b"\x00", 1, 1)

    def test_qvga_frame_encodes_with_supported_dimensions(self):
        png = rgb565_to_png(b"\x00\x00" * (320 * 240), 320, 240)
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", png[16:24]), (320, 240))
        self.assertLess(len(png), 300_000)

    def test_qvga_frame_encodes_identically_without_native_crc32(self):
        pixels = b"\x00\x00" * (320 * 240)
        expected = rgb565_to_png(pixels, 320, 240)

        with patch.object(png_encoder.binascii, "crc32", None):
            fallback = rgb565_to_png(pixels, 320, 240)

        self.assertEqual(fallback, expected)


class HttpApiTests(unittest.TestCase):
    def setUp(self):
        self.device = DeviceController(FakeBoard(), FakeCamera(), device_id="stackchan-test")
        self.api = BuddyHttpApi(self.device, "local-secret")

    def test_routes_require_bearer_token_and_return_the_contract(self):
        response = self.api.handle("GET", "/v1/status", {}, b"")
        self.assertEqual(response[0], 401)

        headers = {"authorization": "Bearer local-secret"}
        response = self.api.handle("GET", "/v1/status", headers, b"")
        self.assertEqual(response[0], 200)
        self.assertEqual(json.loads(response[1])["deviceId"], "stackchan-test")

        body = json.dumps({"requestId": "r1", "capability": "head.home", "args": {}}).encode()
        response = self.api.handle("POST", "/v1/invoke", headers, body)
        payload = json.loads(response[1])
        self.assertEqual(response[0], 200)
        self.assertEqual(payload["requestId"], "r1")
        self.assertTrue(payload["result"]["ok"])

    def test_unknown_paths_and_invalid_invocations_have_errors(self):
        headers = {"authorization": "Bearer local-secret"}
        self.assertEqual(self.api.handle("GET", "/missing", headers, b"")[0], 404)
        body = b'{"requestId":"r1","capability":"unknown","args":{}}'
        self.assertEqual(self.api.handle("POST", "/v1/invoke", headers, body)[0], 400)


if __name__ == "__main__":
    unittest.main()
