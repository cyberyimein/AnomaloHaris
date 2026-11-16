import math
import unittest

from device import DeviceController
from test_firmware import (
    FakeAls,
    FakeBoard,
    FakeCamera,
    FakeCatRenderer,
    FakeDisplay,
    FakeIR,
    FakeImu,
    FakeNfc,
    FakePower,
)


class FakeLights:
    def __init__(self):
        self.calls = []
        self.mode = "booting"
        self.source = "lifecycle"
        self.emotion = None
        self.error = None

    def set_state(self, mode, action="idle", guiding=False):
        self.mode = mode
        self.calls.append(("state", mode, action, guiding))

    def express(self, emotion, intensity=0.5, duration_ms=8000):
        self.calls.append(("express", emotion, intensity, duration_ms))
        self.emotion = emotion
        self.source = "emotion"

    def set_manual(self, color, strip=None, index=None):
        self.source = "manual"
        self.calls.append(("manual", color, strip, index))

    def resume(self):
        self.source = "lifecycle"
        self.emotion = None
        self.calls.append(("resume",))

    def touch(self):
        self.calls.append(("touch",))

    def update(self, now_ms=None):
        self.calls.append(("update", now_ms))

    def snapshot(self):
        return {"source": self.source, "emotion": self.emotion, "lastError": self.error}


class DeviceLightingTests(unittest.TestCase):
    def setUp(self):
        self.now = [100]
        self.lights = FakeLights()
        self.board = FakeBoard()
        self.renderer = FakeCatRenderer()
        self.device = DeviceController(
            self.board, FakeCamera(), ir=FakeIR(), nfc=FakeNfc(), als=FakeAls(),
            imu=FakeImu(), power=FakePower(), light_engine=self.lights,
            ticks_ms=lambda: self.now[0], sleep_ms=lambda _ms: None,
            display=FakeDisplay(), cat_renderer=self.renderer,
        )
        self.device.update(wifi_connected=True, service_ready=True)

    def test_emotion_capabilities_publish_bounded_semantic_inputs(self):
        caps = {cap["name"]: cap for cap in self.device.capabilities()}
        schema = caps["led.express"]["inputSchema"]
        self.assertEqual(set(schema["properties"]["emotion"]["enum"]), {
            "happy", "curious", "thinking", "listening", "speaking", "concerned", "calm"})
        self.assertEqual(schema["properties"]["durationMs"]["maximum"], 60000)
        self.assertIn("led.resume", caps)

    def test_expression_is_a_sideband_that_does_not_flip_cat_or_robot_mode(self):
        frames = len(self.renderer.frames)
        self.device.invoke("light-1", "led.express", {"emotion": "curious"})
        self.assertIn(("express", "curious", 0.5, 8000), self.lights.calls)
        self.assertEqual(self.device.mode, "ready")
        self.assertEqual(len(self.renderer.frames), frames)
        self.assertEqual(self.device.status()["state"]["lighting"]["source"], "emotion")

    def test_emotion_cannot_clear_an_existing_robot_error(self):
        self.device.set_error("sensor unavailable")
        self.device.invoke("light-2", "led.express", {"emotion": "happy"})
        self.assertEqual(self.device.mode, "error")
        self.assertEqual(self.device.last_error, "sensor unavailable")
        self.assertEqual(self.lights.mode, "error")

    def test_sensor_queries_are_sideband_and_do_not_clear_faults_or_manual_lighting(self):
        self.device.set_error("ambient sensor unavailable", component="ambient")
        self.device.invoke("manual", "led.set", {"color": 0xD0A000})
        self.assertTrue(self.device._manual_led_override)
        self.assertFalse(self.device._led_override_armed)
        lights_before = list(self.lights.calls)
        renderer_frames_before = len(self.renderer.frames)

        for capability in (
            "touch.read", "power.read", "infrared.read", "nfc.detect",
            "ambient.read", "imu.read",
        ):
            self.device.invoke("query-" + capability, capability, {})

        state = self.device.status()["state"]
        self.assertEqual(state["mode"], "error")
        self.assertEqual(state["action"], "idle")
        self.assertEqual(state["lastError"], "ambient sensor unavailable")
        self.assertEqual(state["faults"][0]["component"], "ambient")
        self.assertTrue(self.device._manual_led_override)
        self.assertEqual(self.lights.calls, lights_before)
        self.assertEqual(len(self.renderer.frames), renderer_frames_before)

    def test_resume_clears_manual_override_without_entering_acting(self):
        self.device._manual_led_override = True
        self.lights.source = "manual"
        self.device.invoke("light-3", "led.resume", {})
        self.assertFalse(self.device._manual_led_override)
        self.assertEqual(self.device.mode, "ready")
        self.assertEqual(self.device.status()["state"]["lighting"]["source"], "lifecycle")

    def test_consecutive_manual_strip_writes_do_not_insert_lifecycle_colors(self):
        frames = len(self.renderer.frames)
        self.device.invoke("red-strip", "led.set", {"strip": 0, "color": 0x200000})
        self.lights.calls.clear()
        self.device.invoke("green-strip", "led.set", {"strip": 1, "color": 0x002000})
        self.assertEqual(self.lights.calls, [("manual", 0x002000, 1, None)])
        self.assertEqual(self.device.mode, "ready")
        self.assertEqual(len(self.renderer.frames), frames)

    def test_expression_rejects_unknown_nan_and_unbounded_inputs(self):
        invalid = [
            {"emotion": "angry"}, {"emotion": "happy", "intensity": math.nan},
            {"emotion": "happy", "intensity": True},
            {"emotion": "happy", "durationMs": 60001},
            {"emotion": "happy", "durationMs": 999},
            {"emotion": "happy", "extra": 1},
        ]
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.device._led_express(args)

    def test_manual_driver_failure_is_not_reported_as_success(self):
        def fail_manual(*args, **kwargs):
            self.lights.error = "RGB controller unavailable"

        self.lights.set_manual = fail_manual
        with self.assertRaisesRegex(RuntimeError, "RGB controller unavailable"):
            self.device.invoke("manual-error", "led.set", {"color": 0x123456})

    def test_engine_ticks_during_sleep_and_shutdown(self):
        self.device.invoke("sleep", "device.sleep", {})
        self.now[0] += 100
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertIn(("update", self.now[0]), self.lights.calls)
        self.assertEqual(self.lights.mode, "sleeping")
        self.device.request_shutdown()
        self.now[0] += 100
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertIn(("update", self.now[0]), self.lights.calls)
        self.assertEqual(self.lights.mode, "shutting_down")

    def test_touch_notifies_light_engine(self):
        self.board.touch = [2, 0, 0]
        self.device.update(wifi_connected=True, service_ready=True)
        self.now[0] += self.device.TOUCH_PRESS_STABLE_MS
        self.device.update(wifi_connected=True, service_ready=True)
        self.assertIn(("touch",), self.lights.calls)

    def test_status_does_not_block_animations_by_reading_servo_uart(self):
        self.device.initialize_servos()

        def blocking_read(_servo_id):
            raise AssertionError("status must not poll the servo UART")

        self.board.get_servo_angle = blocking_read
        state = self.device.status()["state"]
        self.assertEqual(state["head"], {"pan": 0, "tilt": 45})
        self.assertEqual(state["headObservedAtMs"], 100)
        state["head"]["pan"] = 99
        self.assertEqual(self.device.status()["state"]["head"]["pan"], 0)

    def test_completed_movement_refreshes_the_observed_pose_cache(self):
        self.device.invoke("move", "head.move", {"pan": 20, "tilt": 50})
        self.board.get_servo_angle = lambda _id: (_ for _ in ()).throw(AssertionError("unexpected UART read"))
        self.assertEqual(self.device.status()["state"]["head"], {"pan": 20, "tilt": 50})


if __name__ == "__main__":
    unittest.main()
