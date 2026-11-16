import base64
import struct
import unittest

from display_debug import SoftwareDisplay, capture_display


class FakeLCD:
    def __init__(self, width=4, height=3, draw_result=None):
        self._width = width
        self._height = height
        self.draw_result = draw_result
        self.draws = []
        self.bmp_payloads = []
        self.last_framebuffer = None
        self.read_calls = 0
        self.read_data_calls = 0

    def width(self):
        return self._width

    def height(self):
        return self._height

    def drawBmp(self, bitmap, x, y):
        if not isinstance(bitmap, bytes):
            raise TypeError("BMP transport must own immutable bytes")
        self.draws.append((bitmap, x, y))
        payload = bytes(bitmap)
        self.bmp_payloads.append(payload)
        self.last_framebuffer = self._decode_bmp_rgb565(payload)
        return self.draw_result

    @staticmethod
    def _decode_bmp_rgb565(bitmap):
        offset = struct.unpack("<I", bitmap[10:14])[0]
        width, height = struct.unpack("<ii", bitmap[18:26])
        bits_per_pixel = struct.unpack("<H", bitmap[28:30])[0]
        compression = struct.unpack("<I", bitmap[30:34])[0]
        if bits_per_pixel != 16 or compression != 3:
            raise ValueError("fake LCD only decodes 16-bit BI_BITFIELDS BMPs")

        stride = ((width * bits_per_pixel + 31) // 32) * 4
        top_down = bytearray(width * height * 2)
        for source_y in range(height):
            target_y = height - 1 - source_y
            source_row = offset + source_y * stride
            target_row = target_y * width * 2
            for x in range(width):
                source_pixel = source_row + x * 2
                target_pixel = target_row + x * 2
                top_down[target_pixel] = bitmap[source_pixel + 1]
                top_down[target_pixel + 1] = bitmap[source_pixel]
        return bytes(top_down)

    def read(self):
        self.read_calls += 1
        return b""

    def readData(self, length=1):
        self.read_data_calls += 1
        raise AssertionError("register reads are not screen captures")


class FakeFontSurface:
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.pixels = bytearray(width * height)

    def fill(self, value):
        self.pixels[:] = bytes((1 if value else 0,)) * len(self.pixels)

    def text(self, value, x, y, color):
        if value:
            self.pixel(x, y, color)

    def pixel(self, x, y, color=None):
        offset = y * self.width + x
        if color is None:
            return self.pixels[offset]
        self.pixels[offset] = 1 if color else 0


class FakeFramebufferFactory:
    def __call__(self, buffer, width, height):
        return FakeFontSurface(width, height)


class DisplayDebugTests(unittest.TestCase):
    def test_snapshot_keeps_frame_metadata_when_progress_presents_a_new_frame(self):
        _, display = self.create_display()
        display.fillScreen(0xFF0000)
        display.present()
        sequence = display.sequence
        captured_tick = display.presented_at_ms
        expected_image = capture_display(display)["image"]["data"]
        calls = []

        def progress():
            if not calls:
                display.fillScreen(0x0000FF)
                display.present()
            calls.append(True)

        result = capture_display(display, progress=progress)
        self.assertTrue(calls)
        self.assertEqual(result["sequence"], sequence)
        self.assertEqual(result["presentedAtMs"], captured_tick)
        self.assertGreater(display.sequence, sequence)
        self.assertEqual(result["image"]["data"], expected_image)

    def test_raw_staging_clips_negative_origin_without_reading_outside_source(self):
        _, display = self.create_display()
        display.drawRawBuf(b"\xf8\x00\x07\xe0\x00\x1f", -1, 0, 3, 1, 6, False)
        self.assertEqual(bytes(display.buffer[:4]), b"\x07\xe0\x00\x1f")

    def test_raw_staging_swaps_rgb565_bytes_when_requested(self):
        _, display = self.create_display()
        display.drawRawBuf(b"\x00\xf8\xe0\x07", 0, 0, 2, 1, 4, True)
        self.assertEqual(bytes(display.buffer[:4]), b"\xf8\x00\x07\xe0")
    def create_display(self, native=None):
        native = native or FakeLCD()
        display = SoftwareDisplay(
            native,
            framebuffer_factory=FakeFramebufferFactory(),
            now_ms=lambda: 1234,
        )
        return native, display

    def test_real_lcd_without_documented_framebuffer_readback_is_unavailable(self):
        native = FakeLCD()

        result = capture_display(native)

        self.assertEqual(result["available"], False)
        self.assertEqual(result["source"], "unavailable")
        self.assertNotIn("image", result)
        self.assertIn("framebuffer readback", result["reason"])
        self.assertEqual(native.read_calls, 0)
        self.assertEqual(native.read_data_calls, 0)

    def test_software_display_is_unavailable_until_a_frame_is_presented(self):
        _, display = self.create_display()

        result = capture_display(display)

        self.assertEqual(result["available"], False)
        self.assertEqual(result["source"], "unavailable")
        self.assertNotIn("image", result)

    def test_fill_screen_and_fill_rect_write_big_endian_rgb565(self):
        _, display = self.create_display()
        display.fillScreen(0xFF0000)
        display.fillRect(1, 1, 2, 1, 0x00FF00)

        self.assertEqual(bytes(display.buffer[:2]), b"\xf8\x00")
        self.assertEqual(bytes(display.buffer[(1 * 4 + 1) * 2:(1 * 4 + 1) * 2 + 2]), b"\x07\xe0")
        self.assertEqual(bytes(display.buffer[(1 * 4 + 2) * 2:(1 * 4 + 2) * 2 + 2]), b"\x07\xe0")
        self.assertEqual(bytes(display.buffer[(1 * 4 + 3) * 2:(1 * 4 + 3) * 2 + 2]), b"\xf8\x00")

    def test_draw_raw_buf_stages_a_clipped_region_before_present(self):
        native, display = self.create_display()
        display.fillScreen(0)
        display.drawRawBuf(b"\xf8\x00\x07\xe0", 1, 1, 2, 1, 4, False)

        self.assertEqual(native.draws, [])
        self.assertEqual(bytes(display.buffer[(1 * 4 + 1) * 2:(1 * 4 + 3) * 2]), b"\xf8\x00\x07\xe0")

    def test_text_state_is_rasterized_into_the_software_framebuffer(self):
        _, display = self.create_display()
        display.fillScreen(0)
        display.setTextColor(0xFFFFFF, 0)
        display.setTextSize(2)
        display.setCursor(1, 1)
        display.print("A")

        pixel = bytes(display.buffer[(1 * 4 + 1) * 2:(1 * 4 + 1) * 2 + 2])
        self.assertEqual(pixel, b"\xff\xff")
        self.assertEqual(display.cursor, (17, 1))

    def test_present_submits_full_lcd_once_and_snapshot_is_labeled_as_submitted(self):
        native, display = self.create_display()
        display.fillScreen(0x123456)

        self.assertTrue(display.present())
        result = capture_display(display)

        self.assertEqual(len(native.draws), 1)
        bitmap, x, y = native.draws[0]
        self.assertEqual((x, y), (0, 0))
        self.assertEqual(native.last_framebuffer, bytes(display.buffer))
        self.assertEqual(len(native.bmp_payloads[0]), 66 + 4 * 3 * 2)
        self.assertEqual(result["available"], True)
        self.assertEqual(result["source"], "submitted_framebuffer")
        self.assertEqual(result["sequence"], 1)
        self.assertEqual(result["presentedAtMs"], 1234)
        self.assertEqual((result["width"], result["height"]), (4, 3))
        self.assertEqual(result["image"]["mimeType"], "image/png")
        image = base64.b64decode(result["image"]["data"])
        self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", image[16:24]), (4, 3))

    def test_bmp_uses_16_bit_bitfields_masks_and_bottom_up_little_endian_pixels(self):
        native, display = self.create_display()
        display.fillScreen(0xFF0000)
        display.fillRect(0, 1, 4, 1, 0x00FF00)
        display.fillRect(0, 2, 4, 1, 0x0000FF)

        self.assertTrue(display.present())
        bitmap = native.bmp_payloads[-1]

        self.assertEqual(bitmap[:2], b"BM")
        self.assertEqual(struct.unpack("<I", bitmap[2:6])[0], len(bitmap))
        self.assertEqual(struct.unpack("<I", bitmap[10:14])[0], 66)
        self.assertEqual(struct.unpack("<I", bitmap[14:18])[0], 40)
        self.assertEqual(struct.unpack("<ii", bitmap[18:26]), (4, 3))
        self.assertEqual(struct.unpack("<HHI", bitmap[26:34]), (1, 16, 3))
        self.assertEqual(struct.unpack("<I", bitmap[34:38])[0], 4 * 3 * 2)
        self.assertEqual(struct.unpack("<III", bitmap[54:66]), (0xF800, 0x07E0, 0x001F))
        self.assertEqual(bitmap[66:74], b"\x1f\x00" * 4)
        self.assertEqual(bitmap[74:82], b"\xe0\x07" * 4)
        self.assertEqual(bitmap[82:90], b"\x00\xf8" * 4)

    def test_bmp_conversion_pads_odd_width_rows_without_shifting_pixels(self):
        native = FakeLCD(width=3, height=2)
        display = SoftwareDisplay(
            native,
            framebuffer_factory=FakeFramebufferFactory(),
            now_ms=lambda: 1234,
        )
        display.fillScreen(0xFF0000)
        display.fillRect(0, 1, 3, 1, 0x00FF00)

        self.assertTrue(display.present())
        bitmap = native.bmp_payloads[-1]
        self.assertEqual(struct.unpack("<I", bitmap[2:6])[0], 66 + 16)
        self.assertEqual(struct.unpack("<I", bitmap[34:38])[0], 16)
        self.assertEqual(bitmap[66:74], b"\xe0\x07" * 3 + b"\0\0")
        self.assertEqual(bitmap[74:82], b"\x00\xf8" * 3 + b"\0\0")

    def test_failed_present_does_not_replace_the_last_successful_frame(self):
        native, display = self.create_display()
        self.assertTrue(display.present())
        first = capture_display(display)

        native.draw_result = False
        display.fillScreen(0xFFFFFF)
        self.assertFalse(display.present())
        second = capture_display(display)

        self.assertEqual(second["sequence"], first["sequence"])
        self.assertEqual(second["image"]["data"], first["image"]["data"])


if __name__ == "__main__":
    unittest.main()
