import struct
import unittest
from pathlib import Path

from cat_renderer import CatRenderer


class FakeDisplay:
    def __init__(self, fail_draw=False, draw_result=None, width=320, height=240):
        self.calls = []
        self.fail_draw = fail_draw
        self.draw_result = draw_result
        self._width = width
        self._height = height

    def drawRawBuf(self, buffer, x, y, width, height, length, swap):
        self.calls.append(("drawRawBuf", buffer, x, y, width, height, length, swap))
        if self.fail_draw:
            raise RuntimeError("native RGB565 draw failed")
        return self.draw_result

    def fillScreen(self, color):
        self.calls.append(("fillScreen", color))

    def width(self):
        return self._width

    def height(self):
        return self._height

    def setTextColor(self, foreground, background):
        self.calls.append(("setTextColor", foreground, background))

    def setCursor(self, x, y):
        self.calls.append(("setCursor", x, y))

    def setTextSize(self, size):
        self.calls.append(("setTextSize", size))

    def print(self, text):
        self.calls.append(("print", text))


class CatRendererTests(unittest.TestCase):
    def setUp(self):
        self.display = FakeDisplay()
        self.clock = [1000]
        self.renderer = CatRenderer(
            self.display,
            asset_dir=str(Path(__file__).parent / "assets" / "cats"),
            now_ms=lambda: self.clock[0],
        )

    def raw_draws(self):
        return [call for call in self.display.calls if call[0] == "drawRawBuf"]

    def test_lifecycle_states_select_the_original_frame_families(self):
        cases = [
            ("booting", "idle", False, "think_0.png"),
            ("connecting", "idle", False, "think_0.png"),
            ("ready", "idle", False, "idle_0.png"),
            ("acting", "camera.capture", False, "think_0.png"),
            ("sleeping", "idle", False, "sleep_0.png"),
            ("error", "idle", False, "error_0.png"),
            ("ready", "idle", True, "touch_0.png"),
        ]

        for mode, action, touched, expected in cases:
            with self.subTest(mode=mode, action=action, touched=touched):
                self.assertTrue(self.renderer.render(mode, action, touched))
                self.assertEqual(Path(self.renderer.last_frame).name, expected.replace(".png", ".rgb565"))

    def test_ready_action_uses_thinking_frame(self):
        self.renderer.render("ready", action="head.observe")
        self.assertEqual(Path(self.renderer.last_frame).name, "think_0.rgb565")

    def test_draws_cached_rgb565_at_the_center_of_the_real_display(self):
        self.renderer.render("ready")

        draw_call = self.raw_draws()[0]
        self.assertEqual(draw_call[2:8], (80, 40, 160, 160, 160 * 160 * 2, False))
        self.assertEqual(len(draw_call[1]), 160 * 160 * 2)
        self.assertTrue(Path(self.renderer.last_frame).is_file())

    def test_frame_center_uses_actual_display_dimensions(self):
        display = FakeDisplay(width=400, height=280)
        renderer = CatRenderer(
            display,
            asset_dir=str(Path(__file__).parent / "assets" / "cats"),
            now_ms=lambda: self.clock[0],
        )
        renderer.render("ready")

        self.assertEqual(self.raw_draws_for(display)[0][2:4], (120, 60))

    @staticmethod
    def raw_draws_for(display):
        return [call for call in display.calls if call[0] == "drawRawBuf"]

    def test_repeated_state_does_not_redraw_or_clear_the_screen(self):
        self.renderer.render("ready")
        self.renderer.render("ready")

        self.assertEqual(len(self.raw_draws()), 1)
        self.assertFalse(any(call[0] == "fillScreen" for call in self.display.calls))

    def test_animation_changes_only_the_cat_rectangle_without_shifting_it(self):
        self.renderer.render("connecting")
        initial = self.raw_draws()[0][2:4]
        self.display.calls.clear()
        self.clock[0] += 600
        self.assertTrue(self.renderer.tick())

        self.assertEqual(self.raw_draws()[0][2:4], initial)
        self.assertFalse(any(call[0] in ("fillScreen", "fillRect") for call in self.display.calls))

    def test_animation_tick_is_nonblocking_and_changes_idle_frame(self):
        self.renderer.render("ready")
        self.assertEqual(Path(self.renderer.last_frame).name, "idle_0.rgb565")
        self.display.calls.clear()

        self.clock[0] += 2399
        self.assertFalse(self.renderer.tick())
        self.assertEqual(self.display.calls, [])

        self.clock[0] += 1
        self.assertTrue(self.renderer.tick())
        self.assertEqual(Path(self.renderer.last_frame).name, "idle_1.rgb565")

    def test_animation_tick_wraps_back_to_first_frame(self):
        self.renderer.render("connecting")
        self.clock[0] += 600
        self.assertTrue(self.renderer.tick())
        self.assertEqual(Path(self.renderer.last_frame).name, "think_1.rgb565")
        self.clock[0] += 600
        self.assertTrue(self.renderer.tick())
        self.assertEqual(Path(self.renderer.last_frame).name, "think_0.rgb565")

    def test_static_sleep_and_error_frames_do_not_animate(self):
        self.renderer.render("sleeping")
        self.clock[0] += 10000
        self.assertFalse(self.renderer.tick())
        self.assertEqual(Path(self.renderer.last_frame).name, "sleep_0.rgb565")

        self.renderer.render("error")
        self.clock[0] += 10000
        self.assertFalse(self.renderer.tick())
        self.assertEqual(Path(self.renderer.last_frame).name, "error_0.rgb565")

    def test_assets_are_160_by_160_pngs_from_the_logical_sprite_frames(self):
        for filename in (
                "idle_0.png", "idle_1.png", "think_0.png", "think_1.png",
                "touch_0.png", "touch_1.png", "sleep_0.png", "error_0.png"):
            with self.subTest(filename=filename):
                image = (Path(__file__).parent / "assets" / "cats" / filename).read_bytes()
                self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
                self.assertEqual(struct.unpack(">II", image[16:24]), (160, 160))
                rgb565 = (Path(__file__).parent / "assets" / "cats" / filename.replace(".png", ".rgb565")).read_bytes()
                self.assertEqual(len(rgb565), 160 * 160 * 2)

    def test_all_original_frames_keep_the_same_visible_chin_baseline(self):
        root = Path(__file__).parent / "assets" / "cats"
        background = b"\x08\x20"
        for path in sorted(root.glob("*.rgb565")):
            pixels = path.read_bytes()
            visible_rows = [
                y for y in range(160)
                if any(pixels[(y * 160 + x) * 2:(y * 160 + x + 1) * 2] != background
                       for x in range(160))
            ]
            with self.subTest(frame=path.name):
                self.assertEqual(max(visible_rows), 123)

    def test_only_reports_a_frame_after_a_successful_native_draw(self):
        display = FakeDisplay(fail_draw=True)
        renderer = CatRenderer(
            display,
            asset_dir=str(Path(__file__).parent / "assets" / "cats"),
            now_ms=lambda: self.clock[0],
        )

        self.assertFalse(renderer.render("ready"))
        self.assertIsNone(renderer.last_frame)
        self.assertIn("native RGB565 draw failed", renderer.last_error)

    def test_native_false_result_is_not_reported_as_a_draw(self):
        display = FakeDisplay(draw_result=False)
        renderer = CatRenderer(
            display,
            asset_dir=str(Path(__file__).parent / "assets" / "cats"),
            now_ms=lambda: self.clock[0],
        )

        self.assertFalse(renderer.render("ready"))
        self.assertIsNone(renderer.last_frame)
        self.assertIn("reported failure", renderer.last_error)


if __name__ == "__main__":
    unittest.main()
