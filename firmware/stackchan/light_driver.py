"""Low-level light transport compatibility for StackChan UIFlow SDKs."""


class LegacyRGB565Driver:
    """Write complete RGB frames for the legacy IOE-backed SDK driver."""

    LED_COUNT = 12
    STRIP_COUNT = 2
    LEDS_PER_STRIP = 6
    LED_RAM_REGISTER = 0x30
    LED_LATCH_REGISTER = 0x24
    LED_CONFIG_VALUE = 12 | 64

    def __init__(self, board):
        self.board = board
        self.rgb = getattr(board, "rgb", None)
        self.ioe = getattr(self.rgb, "ioe1", None)
        self.i2c = getattr(self.ioe, "i2c", None)
        self.address = getattr(self.ioe, "addr", None)
        self.available = (
            self.ioe is not None
            and callable(getattr(self.ioe, "_write_reg8", None))
            and callable(getattr(self.i2c, "writeto_mem", None))
            and self.address is not None
            and not callable(getattr(self.ioe, "write_neopixels", None))
        )

    def write_frame(self, logical_colors):
        """Transmit one complete logical 2x6 RGB888 frame as RGB565."""
        if not self.available:
            raise RuntimeError("Legacy StackChan RGB driver is unavailable")

        physical_colors = self._physical_order(logical_colors)
        rgb565_colors = [self._to_rgb565(color) for color in physical_colors]
        payload = bytearray(self.LED_COUNT * 2)
        for index, color in enumerate(rgb565_colors):
            payload[index * 2] = color & 0xFF
            payload[index * 2 + 1] = (color >> 8) & 0xFF

        self.i2c.writeto_mem(self.address, self.LED_RAM_REGISTER, bytes(payload))
        self.i2c.writeto_mem(
            self.address,
            self.LED_LATCH_REGISTER,
            bytes((self.LED_CONFIG_VALUE,)),
        )
        self._sync_rgb_cache(physical_colors)

    def _sync_rgb_cache(self, physical_colors):
        cache = getattr(self.rgb, "_colors", None)
        if cache is None:
            return
        rgb_values = [self._to_rgb_tuple(color) for color in physical_colors]
        try:
            cache[:] = rgb_values
        except Exception:
            self.rgb._colors = rgb_values

    @classmethod
    def _physical_order(cls, logical_colors):
        if len(logical_colors) != cls.STRIP_COUNT:
            raise ValueError("RGB frame must contain two strips")
        if any(len(strip) != cls.LEDS_PER_STRIP for strip in logical_colors):
            raise ValueError("RGB strips must contain six LEDs")

        physical = [0] * cls.LED_COUNT
        for index in range(cls.LEDS_PER_STRIP):
            physical[index] = logical_colors[0][index]
            physical[cls.LED_COUNT - 1 - index] = logical_colors[1][index]
        return physical

    @staticmethod
    def _to_rgb565(color):
        red = (color >> 16) & 0xFF
        green = (color >> 8) & 0xFF
        blue = color & 0xFF
        return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)

    @staticmethod
    def _to_rgb_tuple(color):
        return ((color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF)
