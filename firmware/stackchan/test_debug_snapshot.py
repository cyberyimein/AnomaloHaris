import json
import unittest
from unittest.mock import patch

from http_api import BuddyHttpApi


class DebugSnapshotTests(unittest.TestCase):
    def test_status_reports_scheduler_metrics_and_services_json_boundaries(self):
        calls = []

        class Device:
            def status(self, **kwargs):
                return {"state": {"mode": "ready"}}

        api = BuddyHttpApi(
            Device(), "test-token", service_callback=lambda: calls.append(True),
            runtime_provider=lambda: {"maxServiceGapMs": 42, "serviceCount": 5},
        )
        status, body = api.handle(
            "GET", "/v1/status", {"authorization": "Bearer test-token"}, b"",
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["state"]["runtime"]["maxServiceGapMs"], 42)
        self.assertEqual(len(calls), 2)

    def test_json_boundary_services_do_not_flush_pending_lcd_work(self):
        active = [False]
        observed = []

        class Device:
            def status(self, **kwargs):
                return {"state": {"mode": "ready"}}

            def set_transfer_active(self, enabled):
                previous = active[0]
                active[0] = enabled
                return previous

        api = BuddyHttpApi(Device(), "token", service_callback=lambda: observed.append(active[0]))
        api.handle("GET", "/v1/status", {"authorization": "Bearer token"}, b"")
        self.assertEqual(observed, [True, True])
        self.assertFalse(active[0])

    def test_encoding_progress_does_not_relabel_the_captured_screen_frame(self):
        from types import SimpleNamespace
        from debug_snapshot import build_debug_snapshot

        renderer = SimpleNamespace(last_frame="idle_0", _family="idle", _frame_index=0)

        class Device:
            cat_renderer = renderer
            display = object()
            _last_brightness = 128

            def status(self, **kwargs):
                return {"state": {"mode": "ready"}}

            def service(self):
                renderer.last_frame = "idle_1"
                renderer._frame_index = 1

        def encode(display, progress=None):
            progress()
            return {"available": True, "source": "submitted_framebuffer"}

        with patch("debug_snapshot.capture_display", side_effect=encode):
            result = build_debug_snapshot(Device())
        self.assertEqual(result["display"]["renderer"]["frame"], "idle_0")
        self.assertEqual(result["display"]["renderer"]["frameIndex"], 0)

    def test_lighting_keeps_pattern_source_separate_from_driver_readback(self):
        from debug_snapshot import _lighting_snapshot

        class Engine:
            def snapshot(self):
                return {"source": "emotion", "pattern": "emotion_happy", "strips": [[[1, 2, 3]] * 6] * 2}

        class Board:
            def get_rgb_color(self, strip, index):
                return [4, 5, 6]

        class Device:
            board = Board()
            light_engine = Engine()
            _manual_led_override = False

        result = _lighting_snapshot(Device())
        self.assertEqual(result["source"], "emotion")
        self.assertEqual(result["strips"][0][0], [1, 2, 3])
        self.assertEqual(result["driverStrips"][0][0], [4, 5, 6])
    def test_snapshot_requires_device_authentication(self):
        api = BuddyHttpApi(object(), "private-device-token")
        status, body = api.handle("GET", "/v1/debug/snapshot", {}, b"")
        self.assertEqual(status, 401)

    def test_lighting_snapshot_reads_both_six_led_strips(self):
        from debug_snapshot import _lighting_snapshot

        class Board:
            def get_rgb_color(self, strip, index):
                return [strip, index, 32]

        class Device:
            board = Board()
            _manual_led_override = True

        result = _lighting_snapshot(Device())
        self.assertTrue(result["manualOverride"])
        self.assertEqual(result["strips"], [
            [[strip, index, 32] for index in range(6)] for strip in range(2)])
        self.assertEqual(result["source"], "board_driver")

    def test_snapshot_combines_live_state_and_screen_without_invoking_actions(self):
        class Device:
            display = object()
            cat_renderer = None
            _last_brightness = 128
            _manual_led_override = False
            _touch_zones = [1, 0, 0]

            def status(self, **kwargs):
                return {"deviceId": "test", "state": {"mode": "ready", **kwargs}}

            def _touch_values(self):
                return [3, 0, 0]

        api = BuddyHttpApi(Device(), "secret", uptime_provider=lambda: 42)
        with patch("debug_snapshot.capture_display", return_value={
                "available": True, "source": "display_readback", "image": {"data": "png"}}):
            status, body = api.handle("GET", "/v1/debug/snapshot",
                                      {"authorization": "Bearer secret"}, b"")
        self.assertEqual(status, 200)
        snapshot = json.loads(body)
        self.assertEqual(snapshot["status"]["state"]["uptime_ms"], 42)
        self.assertEqual(snapshot["display"]["source"], "display_readback")
        self.assertEqual(snapshot["touch"]["levels"], [3, 0, 0])
        self.assertNotIn("secret", body.decode())


if __name__ == "__main__":
    unittest.main()
