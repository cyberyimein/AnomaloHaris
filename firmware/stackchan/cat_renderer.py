"""Non-blocking renderer for the original StackChan cat sprite frames."""

try:
    import time
except ImportError:
    import utime as time


class CatRenderer:
    IMAGE_WIDTH = 160
    IMAGE_HEIGHT = 160
    HEADER_HEIGHT = 36
    FOOTER_HEIGHT = 28
    HEADER_MAX_CHARS = 18
    FOOTER_MAX_CHARS = 36

    _FRAMES = {
        "idle": ("idle_0.png", "idle_1.png"),
        "think": ("think_0.png", "think_1.png"),
        "touch": ("touch_0.png", "touch_1.png"),
        "sleep": ("sleep_0.png",),
        "error": ("error_0.png",),
    }
    _FRAME_DURATIONS_MS = {
        "idle": (2400, 180),
        "think": (600, 600),
        "touch": (220, 220),
        "sleep": (),
        "error": (),
    }
    _STATUS_LABELS = {
        "booting": "BOOTING",
        "connecting": "CONNECTING",
        "ready": "READY",
        "acting": "ACTING",
        "sleeping": "SLEEPING",
        "shutting_down": "SHUTTING DOWN",
        "error": "ERROR",
    }
    _IDLE_ACTIONS = (None, "", "idle", "device.wake", "device.sleep")

    def __init__(self, display, asset_dir="assets/cats", now_ms=None):
        self.display = display
        self.asset_dir = asset_dir.rstrip("/")
        self._now_ms = now_ms or self._default_now_ms
        self._ticks_diff = getattr(time, "ticks_diff", None)
        self.last_frame = None
        self.last_error = None
        self._frame_buffers = {}
        self._family = None
        self._frame_index = 0
        self._last_drawn_at = None
        self._mode = "booting"
        self._action = "idle"
        self._message = None
        self._render_key = None

    def render(self, mode, action="idle", touched=False, message=None):
        """Draw a changed device state and skip identical repeated updates."""
        key = (mode, action, bool(touched), message)
        if key == self._render_key and self.last_frame and self.last_error is None:
            return True

        self._mode = mode
        self._action = action
        self._message = message
        self._family = self._family_for(mode, action, touched)
        self._frame_index = 0
        self._last_drawn_at = self._now_ms()
        self._render_key = key
        return self._draw_current_frame(draw_status=True)

    def tick(self, now_ms=None):
        """Advance an animated expression without sleeping or blocking."""
        if self._family is None:
            return False

        durations = self._FRAME_DURATIONS_MS[self._family]
        if not durations:
            return False

        now = self._now_ms() if now_ms is None else now_ms
        duration = durations[self._frame_index]
        if self._elapsed_ms(now, self._last_drawn_at) < duration:
            return False

        self._frame_index = (self._frame_index + 1) % len(self._FRAMES[self._family])
        self._last_drawn_at = now
        return self._draw_current_frame(draw_status=False)

    def _family_for(self, mode, action, touched):
        if mode in ("sleeping", "shutting_down"):
            return "sleep"
        if mode == "error":
            return "error"
        if touched:
            return "touch"
        if mode in ("booting", "connecting", "acting"):
            return "think"
        if mode == "ready":
            if action not in self._IDLE_ACTIONS:
                return "think"
            return "idle"
        return "error"

    def _draw_current_frame(self, draw_status):
        self.last_frame = None
        self.last_error = None
        filename = self._FRAMES[self._family][self._frame_index]
        frame_path = self.asset_dir + "/" + filename.replace(".png", ".rgb565")

        try:
            if self.display is None:
                raise RuntimeError("display is unavailable")

            present = getattr(self.display, "present", None)
            draw_png = getattr(self.display, "drawPng", None)
            if callable(draw_png) and not callable(present):
                png_path = self.asset_dir + "/" + filename
                x, y = self._image_position()
                draw_result = draw_png(png_path, x, y)
                self._check_draw_result(draw_result, "drawPng")
                if draw_status:
                    self._clear_status_areas()
                    self._draw_status()
                self.last_frame = png_path
                return True

            if not hasattr(self.display, "drawRawBuf"):
                raise RuntimeError("display.drawRawBuf is unavailable")

            frame_buffer = self._load_frame_buffer(filename, frame_path)
            x, y = self._image_position()
            draw_result = self.display.drawRawBuf(
                frame_buffer,
                x,
                y,
                self.IMAGE_WIDTH,
                self.IMAGE_HEIGHT,
                len(frame_buffer),
                False,
            )
            if draw_result is False:
                raise RuntimeError("display.drawRawBuf reported failure")
            if draw_status:
                self._clear_status_areas()
                self._draw_status()
            self._present()
            self.last_frame = frame_path
            return True
        except Exception as error:
            self.last_error = str(error)
            return False

    def _load_frame_buffer(self, filename, path):
        frame_buffer = self._frame_buffers.get(filename)
        if frame_buffer is None:
            frame_file = open(path, "rb")
            try:
                frame_buffer = bytearray(frame_file.read())
            finally:
                frame_file.close()

            expected_size = self.IMAGE_WIDTH * self.IMAGE_HEIGHT * 2
            if len(frame_buffer) != expected_size:
                raise ValueError("invalid RGB565 frame size: " + filename)
            self._frame_buffers[filename] = frame_buffer
        return frame_buffer

    def _image_position(self):
        width = self._display_dimension("width", 320)
        height = self._display_dimension("height", 240)
        return (
            (width - self.IMAGE_WIDTH) // 2,
            (height - self.IMAGE_HEIGHT) // 2,
        )

    def _display_dimension(self, name, fallback):
        if self.display is None:
            return fallback
        dimension = getattr(self.display, name, None)
        if dimension is None:
            return fallback
        try:
            return int(dimension() if callable(dimension) else dimension)
        except Exception:
            return fallback

    def _draw_status(self):
        if not (hasattr(self.display, "setTextColor") and
                hasattr(self.display, "setCursor") and
                hasattr(self.display, "setTextSize") and
                hasattr(self.display, "print")):
            return

        label = self._STATUS_LABELS.get(self._mode, "ERROR")
        if self._mode == "acting" and self._action not in self._IDLE_ACTIONS:
            label = self._action.upper()

        self._check_draw_result(
            self.display.setTextColor(0xD9F4FF, 0x000000), "setTextColor"
        )
        self._check_draw_result(self.display.setCursor(14, 12), "setCursor")
        self._check_draw_result(self.display.setTextSize(2), "setTextSize")
        header = self._fit_text(label, self.HEADER_MAX_CHARS)
        self._check_draw_result(self.display.print(header), "print header")

        message = self._message
        if self._mode == "sleeping":
            message = "WAKE BY API OR TOUCH"
        self._check_draw_result(
            self.display.setTextColor(0x6AA6BD, 0x000000), "setTextColor"
        )
        image_x, image_y = self._image_position()
        image_bottom = image_y + self.IMAGE_HEIGHT
        footer_y = max(image_bottom + 4, self._display_dimension("height", 240) - 24)
        self._check_draw_result(
            self.display.setCursor(14, max(0, footer_y)), "setCursor"
        )
        self._check_draw_result(self.display.setTextSize(1), "setTextSize")
        footer = self._fit_text(str(message or ""), self.FOOTER_MAX_CHARS)
        self._check_draw_result(self.display.print(footer), "print footer")

    def _clear_status_areas(self):
        fill_rect = getattr(self.display, "fillRect", None)
        if not callable(fill_rect):
            return

        width = self._display_dimension("width", 320)
        height = self._display_dimension("height", 240)
        _image_x, image_y = self._image_position()
        header_height = min(self.HEADER_HEIGHT, max(0, image_y))
        image_bottom = image_y + self.IMAGE_HEIGHT
        footer_y = max(height - self.FOOTER_HEIGHT, image_bottom + 4)
        footer_height = max(0, height - footer_y)

        if header_height:
            self._check_draw_result(
                fill_rect(0, 0, width, header_height, 0x000000),
                "fillRect header",
            )
        if footer_height:
            self._check_draw_result(
                fill_rect(0, footer_y, width, footer_height, 0x000000),
                "fillRect footer",
            )

    def _fit_text(self, value, max_chars):
        text = self._ascii(str(value))[:max_chars]
        available_width = max(0, self._display_dimension("width", 320) - 28)
        text_width = getattr(self.display, "textWidth", None)
        if callable(text_width):
            while text:
                try:
                    if text_width(text) <= available_width:
                        break
                except Exception:
                    break
                text = text[:-1]
        return text

    def _present(self):
        present = getattr(self.display, "present", None)
        if not callable(present):
            return
        self._check_draw_result(present(), "present")

    @staticmethod
    def _check_draw_result(result, operation):
        if result is False:
            raise RuntimeError("display.{} reported failure".format(operation))

    @staticmethod
    def _ascii(value):
        return "".join(character if ord(character) < 128 else "?" for character in value)

    def _elapsed_ms(self, current, previous):
        if self._ticks_diff is not None:
            return self._ticks_diff(current, previous)
        return current - previous

    @staticmethod
    def _default_now_ms():
        ticks_ms = getattr(time, "ticks_ms", None)
        if ticks_ms is not None:
            return ticks_ms()
        return int(time.time() * 1000)
