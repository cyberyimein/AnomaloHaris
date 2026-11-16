import unittest
from pathlib import Path

from cat_renderer import CatRenderer


class NativeLcdDisplay:
    def __init__(self, fail_png=False):
        self.events = []
        self.fail_png = fail_png
        self.text_size = 1

    def width(self):
        return 320

    def height(self):
        return 240

    def drawPng(self, path, x, y):
        self.events.append(("drawPng", path, x, y))
        if self.fail_png:
            raise RuntimeError("native PNG draw failed")

    def drawRawBuf(self, *args):
        self.events.append(("drawRawBuf",) + args)
        raise AssertionError("native LCD must not receive raw RGB565 frames")

    def fillScreen(self, color):
        self.events.append(("fillScreen", color))

    def fillRect(self, x, y, width, height, color):
        self.events.append(("fillRect", x, y, width, height, color))

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


class CatNativePngTests(unittest.TestCase):
    def setUp(self):
        self.now = [1000]
        self.display = NativeLcdDisplay()
        self.asset_dir = str(Path(__file__).parent / "assets" / "cats")
        self.renderer = CatRenderer(
            self.display,
            asset_dir=self.asset_dir,
            now_ms=lambda: self.now[0],
        )

    def png_draws(self):
        return [event for event in self.display.events if event[0] == "drawPng"]

    def test_native_lcd_draws_png_and_never_receives_raw_rgb565(self):
        self.assertTrue(self.renderer.render("ready"))

        self.assertEqual(self.png_draws(), [(
            "drawPng", self.asset_dir + "/idle_0.png", 80, 40,
        )])
        self.assertFalse(any(event[0] == "drawRawBuf" for event in self.display.events))
        self.assertEqual(Path(self.renderer.last_frame).name, "idle_0.png")

    def test_state_changes_clear_only_status_bands_and_animation_uses_png(self):
        self.assertTrue(self.renderer.render("connecting", message="wifi joined"))
        clear_rects = [event[1:] for event in self.display.events if event[0] == "fillRect"]
        self.assertEqual(clear_rects, [
            (0, 0, 320, 36, 0x000000),
            (0, 212, 320, 28, 0x000000),
        ])
        self.assertFalse(any(event[0] == "fillScreen" for event in self.display.events))

        self.display.events.clear()
        self.now[0] += 600
        self.assertTrue(self.renderer.tick())

        self.assertEqual(Path(self.renderer.last_frame).name, "think_1.png")
        self.assertEqual(len(self.png_draws()), 1)
        self.assertFalse(any(event[0] in ("drawRawBuf", "fillRect", "fillScreen")
                             for event in self.display.events))

    def test_png_failure_is_reported_without_falling_back_to_raw_draw(self):
        self.display.fail_png = True

        self.assertFalse(self.renderer.render("ready"))

        self.assertIsNone(self.renderer.last_frame)
        self.assertIn("native PNG draw failed", self.renderer.last_error)
        self.assertEqual(len(self.png_draws()), 1)
        self.assertFalse(any(event[0] == "drawRawBuf" for event in self.display.events))
        self.assertFalse(any(event[0] == "fillRect" for event in self.display.events))


if __name__ == "__main__":
    unittest.main()
