import types
import unittest
import zlib
from unittest.mock import patch

import png_encoder


class PngProgressTests(unittest.TestCase):
    def test_progress_does_not_change_image_bytes(self):
        pixels = bytes((0xF8, 0)) * (32 * 24)
        expected = png_encoder.rgb565_to_png(pixels, 32, 24)
        calls = []
        actual = png_encoder.rgb565_to_png(
            pixels, 32, 24, progress=lambda: calls.append(True),
        )
        self.assertEqual(actual, expected)
        self.assertTrue(calls)

    def test_python_crc_fallback_services_input_between_blocks(self):
        data = bytes(range(256)) * 128
        calls = []
        with patch.object(png_encoder, "binascii", types.SimpleNamespace()):
            actual = png_encoder._crc32(data, progress=lambda: calls.append(True))
        self.assertEqual(actual, zlib.crc32(data))
        self.assertGreater(len(calls), 1)

    def test_adler_services_input_without_changing_checksum(self):
        data = bytes(range(256)) * 128
        calls = []
        actual = png_encoder._adler32(data, progress=lambda: calls.append(True))
        self.assertEqual(actual, zlib.adler32(data))
        self.assertGreater(len(calls), 1)
