import unittest
from pathlib import Path

from cat_renderer import CatRenderer


class FakeDisplay:
    def __init__(self):
        self.draws = []
        self.printed = []

    def width(self):
        return 320

    def height(self):
        return 240

    def drawRawBuf(self, buffer, x, y, width, height, size, transparent):
        self.draws.append((x, y, width, height, size, transparent, len(buffer)))
        return True

    def setTextColor(self, foreground, background):
        self.text_colors = foreground, background

    def setCursor(self, x, y):
        self.cursor = x, y

    def setTextSize(self, size):
        self.text_size = size

    def print(self, text):
        self.printed.append(text)


class CatShutdownTests(unittest.TestCase):
    def setUp(self):
        self.display = FakeDisplay()
        self.now = [100]
        self.renderer = CatRenderer(
            self.display,
            asset_dir=str(Path(__file__).parent / "assets" / "cats"),
            now_ms=lambda: self.now[0],
        )

    def test_shutdown_uses_sleep_expression_and_powering_off_label(self):
        self.assertTrue(self.renderer.render("shutting_down"))

        self.assertTrue(self.renderer.last_frame.endswith("sleep_0.rgb565"))
        self.assertEqual(self.display.printed[0].strip(), "SHUTTING DOWN")
        self.assertNotIn("ERROR", [text.strip() for text in self.display.printed])

    def test_shutdown_expression_is_static(self):
        self.renderer.render("shutting_down")
        initial_draw_count = len(self.display.draws)
        self.now[0] += 60_000

        self.assertFalse(self.renderer.tick(self.now[0]))
        self.assertEqual(len(self.display.draws), initial_draw_count)


if __name__ == "__main__":
    unittest.main()
