import unittest

from light_driver import LegacyRGB565Driver


class FakeI2C:
    def __init__(self):
        self.writes = []
        self.fail_memaddr = None

    def writeto_mem(self, address, memaddr, payload):
        self.writes.append((address, memaddr, bytes(payload)))
        if memaddr == self.fail_memaddr:
            raise OSError("I2C write failed at 0x{:02x}".format(memaddr))


class LegacyIOE:
    def __init__(self):
        self.i2c = FakeI2C()
        self.addr = 0x42
        self.reg_writes = []

    def _write_reg8(self, register, value):
        self.reg_writes.append((register, value))


class LegacyRGB:
    def __init__(self):
        self.ioe1 = LegacyIOE()
        self._colors = [0] * 12
        self.set_color_calls = []

    def set_color(self, *args):
        self.set_color_calls.append(args)
        return False

    def refresh(self):
        return False


class LegacyBoard:
    def __init__(self):
        self.rgb = LegacyRGB()
        self.sdk_set_calls = []

    def set_rgb_color(self, *args):
        self.sdk_set_calls.append(args)
        return False


def rgb565(color):
    red = (color >> 16) & 0xFF
    green = (color >> 8) & 0xFF
    blue = color & 0xFF
    return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)


def rgb_tuple(color):
    return ((color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF)


def little_endian_frame(colors):
    payload = bytearray()
    for color in colors:
        packed = rgb565(color)
        payload.append(packed & 0xFF)
        payload.append((packed >> 8) & 0xFF)
    return bytes(payload)


class LegacyRGB565DriverTests(unittest.TestCase):
    def test_legacy_ioe_driver_writes_one_physical_rgb565_frame_and_latches(self):
        board = LegacyBoard()
        driver = LegacyRGB565Driver(board)
        logical = [
            [0xFF0000, 0x00FF00, 0x0000FF, 0xFFFFFF, 0x808080, 0x123456],
            [0x010203, 0x102030, 0x405060, 0x708090, 0xA0B0C0, 0xFEDCBA],
        ]

        driver.write_frame(logical)

        physical = logical[0][:] + list(reversed(logical[1]))
        self.assertEqual(
            board.rgb.ioe1.i2c.writes,
            [
                (0x42, 0x30, little_endian_frame(physical)),
                (0x42, 0x24, bytes((76,))),
            ],
        )
        self.assertEqual(board.rgb._colors, [rgb_tuple(color) for color in physical])
        self.assertEqual(board.rgb.ioe1.reg_writes, [])
        self.assertEqual(board.rgb.set_color_calls, [])
        self.assertEqual(board.sdk_set_calls, [])

    def test_legacy_driver_propagates_i2c_failure_without_committing_sdk_cache(self):
        board = LegacyBoard()
        board.rgb._colors = [0x1234] * 12
        board.rgb.ioe1.i2c.fail_memaddr = 0x24
        driver = LegacyRGB565Driver(board)

        with self.assertRaisesRegex(OSError, "0x24"):
            driver.write_frame([[0xFFFFFF] * 6, [0x000000] * 6])

        self.assertEqual(board.rgb._colors, [0x1234] * 12)
        self.assertEqual(len(board.rgb.ioe1.i2c.writes), 2)

    def test_driver_is_not_selected_for_new_sdk_with_neopixel_writer(self):
        class NewIOE(LegacyIOE):
            def write_neopixels(self, colors):
                pass

        class NewBoard(LegacyBoard):
            def __init__(self):
                self.rgb = LegacyRGB()
                self.rgb.ioe1 = NewIOE()
                self.sdk_set_calls = []

        driver = LegacyRGB565Driver(NewBoard())
        self.assertFalse(driver.available)


if __name__ == "__main__":
    unittest.main()
