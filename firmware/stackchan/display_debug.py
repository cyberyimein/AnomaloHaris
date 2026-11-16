"""Mirror pixels submitted to the LCD; this is not a hardware readback API."""

try:
    import binascii
except ImportError:
    import ubinascii as binascii
import struct

from png_encoder import rgb565_to_png


try:
    import micropython
except ImportError:
    class micropython:
        @staticmethod
        def viper(function):
            return function

    ptr8 = lambda buffer: buffer


@micropython.viper
def _convert_rgb565_to_bmp(source, target, width: int, height: int, stride: int):
    src = ptr8(source)
    dst = ptr8(target)
    source_row_bytes = width * 2
    output_y = 0
    while output_y < height:
        source_y = height - 1 - output_y
        source_offset = source_y * source_row_bytes
        target_offset = 66 + output_y * stride
        pixel_offset = 0
        while pixel_offset < source_row_bytes:
            dst[target_offset + pixel_offset] = src[source_offset + pixel_offset + 1]
            dst[target_offset + pixel_offset + 1] = src[source_offset + pixel_offset]
            pixel_offset += 2
        while pixel_offset < stride:
            dst[target_offset + pixel_offset] = 0
            pixel_offset += 1
        output_y += 1


@micropython.viper
def _blit_rgb565(source, target, geometry):
    src = ptr8(source)
    dst = ptr8(target)
    source_offset = int(geometry[0])
    target_offset = int(geometry[1])
    source_stride = int(geometry[2])
    target_stride = int(geometry[3])
    row_bytes = int(geometry[4])
    rows = int(geometry[5])
    swap = int(geometry[6])
    row = 0
    while row < rows:
        column = 0
        while column < row_bytes:
            if swap:
                dst[target_offset + column] = src[source_offset + column + 1]
                dst[target_offset + column + 1] = src[source_offset + column]
            else:
                dst[target_offset + column] = src[source_offset + column]
                dst[target_offset + column + 1] = src[source_offset + column + 1]
            column += 2
        source_offset += source_stride
        target_offset += target_stride
        row += 1


FRAMEBUFFER_READBACK_REASON = (
    "UIFlow2 2.4.7 does not expose a framebuffer readback API; "
    "M5.Lcd.read() on this device returned empty bytes."
)


class SoftwareDisplay:
    """Compose draw operations in RGB565, then submit one full-screen frame."""

    def __init__(self, lcd, framebuffer_factory=None, now_ms=None):
        self.lcd = lcd
        self._width = int(lcd.width())
        self._height = int(lcd.height())
        if self._width < 1 or self._height < 1:
            raise ValueError("display dimensions must be positive")
        if self._width > 32767 or self._height > 32767:
            raise ValueError("BMP dimensions exceed the supported signed range")

        self._framebuffer_factory = framebuffer_factory or self._builtin_framebuffer_factory()
        self._now_ms = now_ms or self._default_now_ms
        self.buffer = bytearray(self._width * self._height * 2)
        self._bmp_row_bytes = ((self._width * 16 + 31) // 32) * 4
        self._bmp_pixel_bytes = self._width * 2
        self._bmp_buffer = self._create_bmp_buffer()
        self._foreground = self._rgb888_to_rgb565(0xFFFFFF)
        self._background = self._rgb888_to_rgb565(0x000000)
        self._cursor_x = 0
        self._cursor_y = 0
        self._text_size = 1
        self.sequence = 0
        self.presented_at_ms = None
        self.last_error = None
        self._last_presented_frame = None
        self._native_bmp = None

    def width(self):
        return self._width

    def height(self):
        return self._height

    def fillScreen(self, color):
        pixel = self._color_bytes(self._rgb888_to_rgb565(color))
        self.buffer[:] = pixel * (self._width * self._height)

    def fillRect(self, x, y, width, height, color):
        self._fill_rect(x, y, width, height, self._rgb888_to_rgb565(color))

    def drawRawBuf(self, pixels, x, y, width, height, length=None, swap=False):
        width = int(width)
        height = int(height)
        x = int(x)
        y = int(y)
        if width < 1 or height < 1:
            return
        raw = pixels
        expected = width * height * 2
        if length is not None and int(length) != expected:
            raise ValueError("RGB565 byte length does not match image dimensions")
        if len(raw) != expected:
            raise ValueError("RGB565 buffer does not match image dimensions")

        source_left = max(0, -x)
        source_top = max(0, -y)
        source_right = min(width, self._width - x)
        source_bottom = min(height, self._height - y)
        if source_left >= source_right or source_top >= source_bottom:
            return

        copied_width = source_right - source_left
        row_bytes = copied_width * 2
        geometry = (
            (source_top * width + source_left) * 2,
            ((y + source_top) * self._width + x + source_left) * 2,
            width * 2, self._width * 2, row_bytes,
            source_bottom - source_top, int(bool(swap)),
        )
        _blit_rgb565(raw, self.buffer, geometry)

    def setCursor(self, x, y):
        self._cursor_x = int(x)
        self._cursor_y = int(y)

    @property
    def cursor(self):
        return self._cursor_x, self._cursor_y

    def setTextColor(self, foreground, background=None):
        self._foreground = self._rgb888_to_rgb565(foreground)
        if background is not None:
            self._background = self._rgb888_to_rgb565(background)

    def setTextSize(self, size):
        self._text_size = max(1, int(size))

    def print(self, text, color=None):
        if color is not None:
            self._foreground = self._rgb888_to_rgb565(color)

        value = self._ascii(str(text))
        start_x = self._cursor_x
        for line in value.split("\n"):
            self._draw_text_line(line, start_x, self._cursor_y)
            self._cursor_x = start_x + len(line) * 8 * self._text_size
            if "\n" in value:
                self._cursor_y += 8 * self._text_size
                start_x = self._cursor_x

    def fillCircle(self, x, y, radius, color):
        center_x = int(x)
        center_y = int(y)
        radius = max(0, int(radius))
        pixel = self._rgb888_to_rgb565(color)
        radius_squared = radius * radius
        for offset_y in range(-radius, radius + 1):
            for offset_x in range(-radius, radius + 1):
                if offset_x * offset_x + offset_y * offset_y <= radius_squared:
                    self._write_pixel(center_x + offset_x, center_y + offset_y, pixel)

    def drawLine(self, x0, y0, x1, y1, color):
        x0 = int(x0)
        y0 = int(y0)
        x1 = int(x1)
        y1 = int(y1)
        pixel = self._rgb888_to_rgb565(color)
        delta_x = abs(x1 - x0)
        step_x = 1 if x0 < x1 else -1
        delta_y = -abs(y1 - y0)
        step_y = 1 if y0 < y1 else -1
        error = delta_x + delta_y
        while True:
            self._write_pixel(x0, y0, pixel)
            if x0 == x1 and y0 == y1:
                break
            doubled_error = 2 * error
            if doubled_error >= delta_y:
                error += delta_y
                x0 += step_x
            if doubled_error <= delta_x:
                error += delta_x
                y0 += step_y

    def present(self):
        self.last_error = None
        try:
            self._prepare_bmp_pixels()
            self._native_bmp = bytes(self._bmp_buffer)
            draw_result = self.lcd.drawBmp(self._native_bmp, 0, 0)
            if draw_result is False:
                raise RuntimeError("LCD rejected the submitted BMP")
        except Exception as error:
            self.last_error = str(error)
            return False

        self.sequence += 1
        self.presented_at_ms = self._now_ms()
        self._last_presented_frame = bytes(self.buffer)
        return True

    def _create_bmp_buffer(self):
        image_size = self._bmp_row_bytes * self._height
        file_size = 66 + image_size
        bitmap = bytearray(file_size)
        bitmap[0:14] = struct.pack("<2sIHHI", b"BM", file_size, 0, 0, 66)
        bitmap[14:54] = struct.pack(
            "<IiiHHIIiiII",
            40,
            self._width,
            self._height,
            1,
            16,
            3,
            image_size,
            0,
            0,
            0,
            0,
        )
        bitmap[54:66] = struct.pack("<III", 0xF800, 0x07E0, 0x001F)
        return bitmap

    def _prepare_bmp_pixels(self):
        _convert_rgb565_to_bmp(
            self.buffer,
            self._bmp_buffer,
            self._width,
            self._height,
            self._bmp_row_bytes,
        )

    def snapshot_buffer(self):
        if self._last_presented_frame is None:
            return None
        return self._last_presented_frame

    def _draw_text_line(self, text, x, y):
        if not text:
            return
        if self._framebuffer_factory is None:
            raise RuntimeError("MicroPython framebuf is unavailable; inject a framebuffer factory")

        width = len(text) * 8
        height = 8
        mask = bytearray((width * height + 7) // 8)
        surface = self._framebuffer_factory(mask, width, height)
        surface.fill(0)
        surface.text(text, 0, 0, 1)
        scale = self._text_size

        left = max(0, x)
        right = min(self._width, x + width * scale)
        if left >= right:
            return
        row = bytearray(width * scale * 2)
        source_left = (left - x) * 2
        source_right = (right - x) * 2
        row_length = (right - left) * 2
        scaled_pixels = range(scale)
        for glyph_y in range(height):
            for glyph_x in range(width):
                color = self._foreground if surface.pixel(glyph_x, glyph_y) else self._background
                offset = glyph_x * scale * 2
                for scaled_x in scaled_pixels:
                    row[offset + scaled_x * 2] = (color >> 8) & 255
                    row[offset + scaled_x * 2 + 1] = color & 255
            visible_row = row if source_left == 0 and source_right == len(row) else row[source_left:source_right]
            for scaled_y in scaled_pixels:
                target_y = y + glyph_y * scale + scaled_y
                if 0 <= target_y < self._height:
                    target = (target_y * self._width + left) * 2
                    self.buffer[target:target + row_length] = visible_row

    def _fill_rect(self, x, y, width, height, color):
        x = int(x)
        y = int(y)
        width = int(width)
        height = int(height)
        left = max(0, x)
        top = max(0, y)
        right = min(self._width, x + width)
        bottom = min(self._height, y + height)
        if left >= right or top >= bottom:
            return

        pixel = self._color_bytes(color)
        row = pixel * (right - left)
        for row_y in range(top, bottom):
            offset = (row_y * self._width + left) * 2
            self.buffer[offset:offset + len(row)] = row

    def _write_pixel(self, x, y, color):
        if 0 <= x < self._width and 0 <= y < self._height:
            offset = (y * self._width + x) * 2
            self.buffer[offset] = (color >> 8) & 255
            self.buffer[offset + 1] = color & 255

    @staticmethod
    def _color_bytes(color):
        return bytes(((color >> 8) & 255, color & 255))

    @staticmethod
    def _rgb888_to_rgb565(color):
        value = int(color)
        red = (value >> 16) & 255
        green = (value >> 8) & 255
        blue = value & 255
        return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)

    def _builtin_framebuffer_factory(self):
        try:
            import framebuf
        except ImportError:
            return None

        mono_hlsb = framebuf.MONO_HLSB

        def create_framebuffer(buffer, width, height):
            return framebuf.FrameBuffer(buffer, width, height, mono_hlsb)

        return create_framebuffer

    @staticmethod
    def _ascii(value):
        return "".join(character if ord(character) < 128 else "?" for character in value)

    @staticmethod
    def _default_now_ms():
        try:
            import time
        except ImportError:
            import utime as time
        ticks_ms = getattr(time, "ticks_ms", None)
        if ticks_ms is not None:
            return ticks_ms()
        return int(time.time() * 1000)


def capture_display(display, progress=None):
    """Capture only bytes that SoftwareDisplay successfully submitted.

    A native M5.Lcd object is never relabeled as a screenshot: UIFlow2 exposes
    drawing APIs but does not provide a framebuffer readback call.
    """
    if not isinstance(display, SoftwareDisplay):
        return {
            "available": False,
            "source": "unavailable",
            "reason": FRAMEBUFFER_READBACK_REASON,
        }

    pixels = display.snapshot_buffer()
    sequence = display.sequence
    presented_at_ms = display.presented_at_ms
    if pixels is None:
        return {
            "available": False,
            "source": "unavailable",
            "reason": "No software framebuffer has been successfully presented yet.",
        }

    try:
        png_data = rgb565_to_png(pixels, display.width(), display.height(), progress=progress)
        encoded = binascii.b2a_base64(png_data).strip().decode("ascii")
    except Exception as error:
        return {
            "available": False,
            "source": "unavailable",
            "reason": "Could not encode the submitted framebuffer: " + str(error),
        }

    return {
        "available": True,
        "source": "submitted_framebuffer",
        "width": display.width(),
        "height": display.height(),
        "sequence": sequence,
        "presentedAtMs": presented_at_ms,
        "image": {
            "mimeType": "image/png",
            "data": encoded,
            "width": display.width(),
            "height": display.height(),
        },
    }
