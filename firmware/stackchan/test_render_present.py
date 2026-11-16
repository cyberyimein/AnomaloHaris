import unittest
from pathlib import Path

from cat_renderer import CatRenderer
from device import DeviceController, draw_startup_feedback


class FakeDisplay:
    def __init__(self, present_result=True, draw_result=True):
        self.events = []
        self.present_result = present_result
        self.draw_result = draw_result

    def width(self):
        return 320

    def height(self):
        return 240

    def drawRawBuf(self, buffer, x, y, width, height, length, swap):
        self.events.append(("drawRawBuf", x, y, width, height))
        return self.draw_result

    def fillRect(self, x, y, width, height, color):
        self.events.append(("fillRect", x, y, width, height, color))
        return True

    def fillScreen(self, color):
        self.events.append(("fillScreen", color))

    def fillCircle(self, x, y, radius, color):
        self.events.append(("fillCircle", x, y, radius, color))

    def drawLine(self, x0, y0, x1, y1, color):
        self.events.append(("drawLine", x0, y0, x1, y1, color))

    def setTextColor(self, foreground, background):
        self.events.append(("setTextColor", foreground, background))

    def setCursor(self, x, y):
        self.events.append(("setCursor", x, y))

    def setTextSize(self, size):
        self.text_size = size
        self.events.append(("setTextSize", size))

    def textWidth(self, text):
        return len(text) * 8 * self.text_size

    def print(self, text):
        self.events.append(("print", text))

    def present(self):
        self.events.append(("present",))
        if isinstance(self.present_result, Exception):
            raise self.present_result
        return self.present_result


class RenderPresentTests(unittest.TestCase):
    def setUp(self):
        self.now = [1000]
        self.display = FakeDisplay()
        self.renderer = CatRenderer(
            self.display,
            asset_dir=str(Path(__file__).parent / "assets" / "cats"),
            now_ms=lambda: self.now[0],
        )

    def test_render_clears_only_header_and_footer_then_presents_once(self):
        self.assertTrue(self.renderer.render("shutting_down"))

        clears = [event for event in self.display.events if event[0] == "fillRect"]
        self.assertEqual(clears, [
            ("fillRect", 0, 0, 320, 36, 0x000000),
            ("fillRect", 0, 212, 320, 28, 0x000000),
        ])
        self.assertEqual(self.display.events[-1], ("present",))
        self.assertEqual(self.display.events.count(("present",)), 1)

    def test_render_label_is_truncated_to_fit_fixed_8_by_8_font(self):
        self.assertTrue(self.renderer.render(
            "acting", action="AN_EXTREMELY_LONG_CAPABILITY_ACTION"
        ))

        labels = [event[1] for event in self.display.events if event[0] == "print"]
        self.assertLessEqual(len(labels[0]), 18)
        self.assertLessEqual(self.display.textWidth(labels[0]), 288)

    def test_animation_tick_presents_new_pixels_without_clearing_status_bands(self):
        self.assertTrue(self.renderer.render("ready"))
        initial_clear_count = len([
            event for event in self.display.events if event[0] == "fillRect"
        ])
        initial_present_count = self.display.events.count(("present",))
        self.now[0] += 2400

        self.assertTrue(self.renderer.tick(self.now[0]))

        self.assertEqual(len([
            event for event in self.display.events if event[0] == "fillRect"
        ]), initial_clear_count)
        self.assertEqual(self.display.events.count(("present",)), initial_present_count + 1)
        self.assertEqual(self.display.events[-1], ("present",))

    def test_failed_present_is_not_reported_as_a_rendered_frame(self):
        self.display.present_result = False

        self.assertFalse(self.renderer.render("shutting_down"))

        self.assertIsNone(self.renderer.last_frame)
        self.assertIn("present", self.renderer.last_error)

    def test_present_exception_fails_frame_and_raw_draw_failure_never_presents(self):
        self.display.present_result = RuntimeError("frame transfer failed")
        self.assertFalse(self.renderer.render("ready"))
        self.assertIn("frame transfer failed", self.renderer.last_error)

        failed_display = FakeDisplay(draw_result=False)
        renderer = CatRenderer(
            failed_display,
            asset_dir=str(Path(__file__).parent / "assets" / "cats"),
            now_ms=lambda: self.now[0],
        )
        self.assertFalse(renderer.render("ready"))
        self.assertEqual(failed_display.events.count(("present",)), 0)

    def test_device_native_fallback_presents_after_complete_state_draw(self):
        device = DeviceController(None, None, display=self.display)

        self.assertEqual(self.display.events[-1], ("present",))
        self.assertEqual(self.display.events.count(("present",)), 1)
        self.assertEqual(device.status()["state"]["mode"], "booting")

    def test_startup_native_fallback_presents_once(self):
        draw_startup_feedback(self.display)

        self.assertEqual(self.display.events[-1], ("present",))
        self.assertEqual(self.display.events.count(("present",)), 1)


if __name__ == "__main__":
    unittest.main()
