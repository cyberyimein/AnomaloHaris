import unittest

from display_debug import SoftwareDisplay
from test_display_debug import FakeLCD, FakeFramebufferFactory


class DisplayTransferTests(unittest.TestCase):
    def test_full_screen_uses_owned_immutable_transport_and_reuses_working_storage(self):
        lcd = FakeLCD(320, 240)
        display = SoftwareDisplay(lcd, framebuffer_factory=FakeFramebufferFactory())
        display.fillScreen(0x123456)
        working_storage = display._bmp_buffer
        self.assertTrue(display.present())
        self.assertEqual(len(lcd.draws), 1)
        bitmap, x, y = lcd.draws[0]
        self.assertEqual((x, y), (0, 0))
        self.assertEqual(len(lcd.bmp_payloads[0]), 66 + 320 * 240 * 2)
        self.assertEqual(lcd.last_framebuffer, bytes(display.buffer))
        self.assertEqual(display.snapshot_buffer(), bytes(display.buffer))

        display.fillScreen(0xABCDEF)
        self.assertTrue(display.present())
        self.assertEqual(len(lcd.draws), 2)
        self.assertIs(display._bmp_buffer, working_storage)
        self.assertIsNot(lcd.draws[1][0], bitmap)
        self.assertIsInstance(bitmap, bytes)
        self.assertEqual(lcd.last_framebuffer, bytes(display.buffer))


if __name__ == "__main__":
    unittest.main()
