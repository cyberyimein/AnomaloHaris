"""Non-blocking lifecycle, touch, and emotion effects for StackChan's LEDs."""

try:
    import time
except ImportError:
    import utime as time

from light_driver import LegacyRGB565Driver


class LightEngine:
    STRIP_COUNT = 2
    LED_COUNT = 6
    FRAME_INTERVAL_MS = 80
    TOUCH_DURATION_MS = 700
    MIN_EMOTION_DURATION_MS = 1000
    MAX_EMOTION_DURATION_MS = 60000

    MODES = (
        "booting", "connecting", "ready", "acting", "sleeping", "error",
        "shutting_down",
    )
    EMOTIONS = (
        "happy", "curious", "thinking", "listening", "speaking",
        "concerned", "calm",
    )
    PRIORITY_MODES = ("sleeping", "error", "shutting_down")

    def __init__(self, board, now_ms=None):
        self.board = board
        self._legacy_driver = LegacyRGB565Driver(board)
        self._now_ms = now_ms or self._default_now_ms
        self._ticks_diff = getattr(time, "ticks_diff", None)
        self.mode = "booting"
        self.action = "idle"
        self.guiding = False
        self._mode_started_ms = self._now_ms()
        self._emotion = None
        self._emotion_intensity = None
        self._emotion_started_ms = None
        self._emotion_duration_ms = None
        self._touch_started_ms = None
        self._suspended = False
        self._last_frame_ms = None
        self._last_presented_at_ms = None
        self._last_colors = [[0] * self.LED_COUNT for _ in range(self.STRIP_COUNT)]
        self._known_colors = [[False] * self.LED_COUNT for _ in range(self.STRIP_COUNT)]
        self._staged_uncommitted = False
        self._has_rendered = False
        self._source = "lifecycle"
        self._pattern = "booting_chase"
        self._intensity = 0.5
        self.last_error = None

    def set_state(self, mode, action="idle", guiding=False):
        """Set the base device state and immediately draw its first frame."""
        if mode not in self.MODES:
            raise ValueError("Unknown light lifecycle mode: " + str(mode))
        if self.mode == "shutting_down" and mode != "shutting_down":
            return False

        changed = (mode != self.mode or action != self.action
                   or bool(guiding) != self.guiding)
        if not changed:
            if not self._has_rendered:
                self.update(self._mode_started_ms, force=True)
            return True

        self.mode = mode
        self.action = action
        self.guiding = bool(guiding)
        self._mode_started_ms = self._now_ms()

        if mode in self.PRIORITY_MODES:
            self._clear_leases()
            self._suspended = False

        self.update(self._mode_started_ms, force=True)
        return True

    def express(self, emotion, intensity=0.5, duration_ms=8000):
        """Temporarily layer one named emotion over the lifecycle animation."""
        if emotion not in self.EMOTIONS:
            raise ValueError("Unknown light emotion: " + str(emotion))
        try:
            intensity = float(intensity)
        except (TypeError, ValueError):
            raise ValueError("intensity must be between 0.1 and 1.0")
        if not 0.1 <= intensity <= 1.0:
            raise ValueError("intensity must be between 0.1 and 1.0")
        duration_ms = self._integer(
            duration_ms,
            "duration_ms",
            self.MIN_EMOTION_DURATION_MS,
            self.MAX_EMOTION_DURATION_MS,
        )
        if self.mode in self.PRIORITY_MODES or self._suspended:
            return False

        self._emotion = emotion
        self._emotion_intensity = intensity
        self._emotion_started_ms = self._now_ms()
        self._emotion_duration_ms = duration_ms
        self.update(self._emotion_started_ms, force=True)
        return True

    def touch(self):
        """Start a short, opposing blue wave across the two strips."""
        if self.mode in self.PRIORITY_MODES or self._suspended:
            return False
        self._touch_started_ms = self._now_ms()
        self.update(self._touch_started_ms, force=True)
        return True

    def suspend(self):
        """Pause lifecycle effects while an external/manual color is selected."""
        if self.mode in self.PRIORITY_MODES:
            return False
        self._suspended = True
        self._source = "manual"
        self._pattern = "manual"
        self._intensity = None
        return True

    def set_manual(self, color, strip=None, index=None):
        """Pause effects and write one color to all LEDs, a strip, or one LED."""
        color = self._integer(color, "color", 0, 0xFFFFFF)
        if index is not None and strip is None:
            raise ValueError("index requires strip")
        if strip is not None:
            strip = self._integer(strip, "strip", 0, self.STRIP_COUNT - 1)
        if index is not None:
            index = self._integer(index, "index", 0, self.LED_COUNT - 1)
        if not self.suspend():
            return False

        colors = [row[:] for row in self._last_colors]
        if strip is None:
            colors = [[color] * self.LED_COUNT for _ in range(self.STRIP_COUNT)]
        elif index is None:
            colors[strip] = [color] * self.LED_COUNT
        else:
            colors[strip][index] = color
        self._source = "manual"
        self._pattern = "manual"
        self._intensity = None
        self._write_colors(colors)
        return True

    def resume(self):
        """Resume the current effect after a manual override."""
        if self.mode == "shutting_down":
            return False
        self._suspended = False
        self._clear_leases()
        self.update(self._now_ms(), force=True)
        return self.last_error is None

    def update(self, now_ms=None, force=False):
        """Advance the current effect without sleeping or blocking."""
        now = self._now_ms() if now_ms is None else now_ms
        if self._suspended and self.mode not in self.PRIORITY_MODES:
            return False
        if not force and self._last_frame_ms is not None:
            if self._elapsed_ms(now, self._last_frame_ms) < self.FRAME_INTERVAL_MS:
                return False

        frame, source, pattern, intensity = self._frame_for(now)
        self._source = source
        self._pattern = pattern
        self._intensity = intensity
        self._last_frame_ms = now
        changed = self._write_colors(frame)
        if changed:
            self._has_rendered = True
            self._last_presented_at_ms = now
        return changed

    def snapshot(self):
        """Return the latest successfully written driver target colors."""
        now = self._now_ms()
        emotion = self._emotion
        remaining = None
        if emotion is not None:
            elapsed = self._elapsed_ms(now, self._emotion_started_ms)
            if elapsed >= self._emotion_duration_ms:
                emotion = None
                if self._source == "emotion":
                    remaining = 0
            else:
                remaining = self._emotion_duration_ms - elapsed
        if self._touch_started_ms is not None:
            touch_elapsed = self._elapsed_ms(now, self._touch_started_ms)
            if touch_elapsed < self.TOUCH_DURATION_MS:
                if self._source == "touch":
                    remaining = self.TOUCH_DURATION_MS - touch_elapsed
            elif self._source == "touch":
                remaining = 0

        return {
            "mode": self.mode,
            "action": self.action,
            "guiding": self.guiding,
            "source": self._source,
            "pattern": self._pattern,
            "emotion": emotion,
            "remainingMs": remaining,
            "intensity": self._intensity,
            "suspended": self._suspended,
            "lastPresentedAtMs": self._last_presented_at_ms,
            "strips": [
                [self._rgb_triplet(color) for color in strip]
                for strip in self._last_colors
            ],
            "lastError": self.last_error,
        }

    def _frame_for(self, now):
        if self.mode == "shutting_down":
            return self._blank_frame(), "lifecycle", "shutdown_black", 0.0
        if self.mode == "error":
            age = self._elapsed_ms(now, self._mode_started_ms)
            return self._fill(0xFF0000, self._pulse(age, 900)), "lifecycle", "error_pulse", 1.0
        if self.mode == "sleeping":
            age = self._elapsed_ms(now, self._mode_started_ms)
            level = self._wave(age, 4200, 0.45, 1.0)
            return self._fill(0x3157A6, level * 0.10), "lifecycle", "sleep_breathe", 0.25

        if self.mode == "acting" and self.action in ("camera.capture", "head.observe"):
            age = self._elapsed_ms(now, self._mode_started_ms)
            frame = self._recording_frame(age)
            return frame, "lifecycle", "camera_recording", 0.5

        if self._touch_is_active(now):
            age = self._elapsed_ms(now, self._touch_started_ms)
            return self._touch_frame(age), "touch", "touch_wave", 0.5

        emotion = self._active_emotion(now)
        if emotion is not None:
            name, intensity, age = emotion
            return self._emotion_frame(name, intensity, age), "emotion", "emotion_" + name, intensity

        if self.guiding:
            age = self._elapsed_ms(now, self._mode_started_ms)
            return self._guiding_frame(age), "lifecycle", "guiding_pair", 0.45

        age = self._elapsed_ms(now, self._mode_started_ms)
        if self.mode == "connecting":
            return self._chase_frame(age, 0xFF9A20, 140), "lifecycle", "connecting_chase", 0.5
        if self.mode == "acting":
            return self._scanner_frame(age, 0x28DCE0, 100), "lifecycle", "acting_scan", 0.5
        if self.mode == "ready":
            level = self._wave(age, 4000, 0.45, 1.0)
            return self._fill(0xD0A000, level * 0.125), "lifecycle", "ready_breathe", 0.25
        return self._chase_frame(age, 0x5179E8, 220), "lifecycle", "booting_chase", 0.5

    def _recording_frame(self, age):
        frame = self._blank_frame()
        phase = age % 1200
        if phase < 850:
            position = (phase // 140) % self.LED_COUNT
            self._trail(frame, 0, position, 0xFF9A20, 0.5)
            self._trail(frame, 1, self.LED_COUNT - 1 - position, 0xFF9A20, 0.5)
        return frame

    def _chase_frame(self, age, color, step_ms):
        frame = self._blank_frame()
        position = (age // step_ms) % self.LED_COUNT
        self._trail(frame, 0, position, color, 0.5)
        self._trail(frame, 1, self.LED_COUNT - 1 - position, color, 0.5)
        return frame

    def _scanner_frame(self, age, color, step_ms):
        frame = self._blank_frame()
        travel = (age // step_ms) % (self.LED_COUNT * 2 - 2)
        position = travel if travel < self.LED_COUNT else self.LED_COUNT * 2 - 2 - travel
        self._trail(frame, 0, position, color, 0.5)
        self._trail(frame, 1, self.LED_COUNT - 1 - position, color, 0.5)
        return frame

    def _guiding_frame(self, age):
        frame = self._blank_frame()
        position = (age // 220) % self.LED_COUNT
        self._trail(frame, 0, position, 0x48CDA8, 0.45)
        self._trail(frame, 1, self.LED_COUNT - 1 - position, 0x8B83E8, 0.45)
        return frame

    def _touch_frame(self, age):
        frame = self._blank_frame()
        position = min(self.LED_COUNT - 1, (age * self.LED_COUNT) // self.TOUCH_DURATION_MS)
        self._trail(frame, 0, position, 0x40A0FF, 0.5)
        self._trail(frame, 1, self.LED_COUNT - 1 - position, 0x40A0FF, 0.5)
        return frame

    def _emotion_frame(self, name, intensity, age):
        level = 0.10 + 0.30 * intensity
        frame = self._blank_frame()

        if name == "happy":
            position = (age // 130) % self.LED_COUNT
            self._trail(frame, 0, position, 0x62F27A, level)
            self._trail(frame, 1, self.LED_COUNT - 1 - position, 0xF2D94E, level)
        elif name == "curious":
            phase = age % 1400
            position = min(self.LED_COUNT - 1, phase // 220)
            if phase < 1100:
                self._pixel(frame, 0, position, 0xA76BFF, level)
                self._pixel(frame, 1, self.LED_COUNT - 1 - position, 0x51B9FF, level)
            else:
                self._pixel(frame, 0, 2, 0xA76BFF, level)
                self._pixel(frame, 1, 3, 0x51B9FF, level)
        elif name == "thinking":
            position = (age // 360) % self.LED_COUNT
            self._trail(frame, 0, position, 0x9875E8, level)
            self._trail(frame, 1, (position + 2) % self.LED_COUNT, 0x63A3F7, level * 0.8)
        elif name == "listening":
            for strip in range(self.STRIP_COUNT):
                expansion = (age // 260 + strip * 2) % 6
                position = expansion if expansion < 3 else 5 - expansion
                self._pixel(frame, strip, position, 0x4FE1D0, level)
                self._pixel(frame, strip, self.LED_COUNT - 1 - position, 0x4FE1D0, level)
        elif name == "speaking":
            position = (age // 100) % self.LED_COUNT
            self._trail(frame, 0, position, 0xF5C94D, level)
            self._trail(frame, 1, (position + 2) % self.LED_COUNT, 0x51E89A, level)
        elif name == "concerned":
            return [
                [self._scale_color(0xFF7547, self._pulse(age + strip * 200, 1500) * level)]
                * self.LED_COUNT
                for strip in range(self.STRIP_COUNT)
            ]
        else:  # calm
            return [
                [self._scale_color(
                    0x4F8FC8,
                    self._wave(age + strip * 1800, 3600, 0.35, 1.0) * level,
                )] * self.LED_COUNT
                for strip in range(self.STRIP_COUNT)
            ]

        return frame

    def _active_emotion(self, now):
        if self._emotion is None:
            return None
        age = self._elapsed_ms(now, self._emotion_started_ms)
        if age >= self._emotion_duration_ms:
            self._clear_emotion()
            return None
        return self._emotion, self._emotion_intensity, age

    def _touch_is_active(self, now):
        if self._touch_started_ms is None:
            return False
        if self._elapsed_ms(now, self._touch_started_ms) >= self.TOUCH_DURATION_MS:
            self._touch_started_ms = None
            return False
        return True

    def _clear_leases(self):
        self._clear_emotion()
        self._touch_started_ms = None

    def _clear_emotion(self):
        self._emotion = None
        self._emotion_intensity = None
        self._emotion_started_ms = None
        self._emotion_duration_ms = None

    def _write_colors(self, colors):
        if self.board is None:
            return False
        if self._legacy_driver.available:
            return self._write_legacy_frame(colors)
        set_color = getattr(self.board, "set_rgb_color", None)
        if not callable(set_color):
            self.last_error = "board.set_rgb_color is unavailable"
            return False

        rgb = getattr(self.board, "rgb", None)
        refresh = getattr(rgb, "refresh", None)
        has_refresh = callable(refresh)
        force_restage = self._staged_uncommitted

        uniform = colors[0][0]
        is_uniform = all(color == uniform for strip in colors for color in strip)
        pending = {}
        write_error = None
        if is_uniform and (force_restage or any(
                not self._known_colors[strip][index]
                or self._last_colors[strip][index] != uniform
                for strip in range(self.STRIP_COUNT)
                for index in range(self.LED_COUNT))):
            try:
                # Some compatible setters return no success flag.
                # The broken legacy SDK uses the full-frame path above.
                set_color(uniform)
            except Exception as error:
                self.last_error = str(error)
                return False
            for strip in range(self.STRIP_COUNT):
                for index in range(self.LED_COUNT):
                    pending[(strip, index)] = uniform

        for strip in range(self.STRIP_COUNT):
            for index in range(self.LED_COUNT):
                color = colors[strip][index]
                if is_uniform:
                    continue
                if (not force_restage and self._known_colors[strip][index]
                        and self._last_colors[strip][index] == color):
                    continue
                try:
                    set_color(strip, index, color)
                except Exception as error:
                    if write_error is None:
                        write_error = str(error)
                    continue
                pending[(strip, index)] = color

        if not pending:
            self.last_error = write_error
            return False

        if has_refresh:
            try:
                refresh_result = refresh()
                if refresh_result is False:
                    raise RuntimeError("board.rgb.refresh returned false")
            except Exception as error:
                self._staged_uncommitted = True
                self._known_colors = [
                    [False] * self.LED_COUNT for _ in range(self.STRIP_COUNT)
                ]
                self.last_error = str(error)
                if write_error is not None:
                    self.last_error = write_error + "; " + self.last_error
                return False
            self._staged_uncommitted = False

        for (strip, index), color in pending.items():
            self._last_colors[strip][index] = color
            self._known_colors[strip][index] = True

        if write_error is not None:
            self.last_error = write_error
        else:
            self.last_error = None
        return True

    def _write_legacy_frame(self, colors):
        changed = self._staged_uncommitted or any(
            not self._known_colors[strip][index]
            or self._last_colors[strip][index] != colors[strip][index]
            for strip in range(self.STRIP_COUNT)
            for index in range(self.LED_COUNT)
        )
        if not changed:
            return False
        try:
            self._legacy_driver.write_frame(colors)
        except Exception as error:
            self.last_error = str(error)
            self._staged_uncommitted = True
            return False
        self._last_colors = [row[:] for row in colors]
        self._known_colors = [[True] * self.LED_COUNT for _ in range(self.STRIP_COUNT)]
        self._staged_uncommitted = False
        self.last_error = None
        return True

    def _fill(self, color, level):
        packed = self._scale_color(color, level)
        return [[packed] * self.LED_COUNT for _ in range(self.STRIP_COUNT)]

    def _blank_frame(self):
        return [[0] * self.LED_COUNT for _ in range(self.STRIP_COUNT)]

    def _pixel(self, frame, strip, index, color, level):
        frame[strip][index] = self._scale_color(color, level)

    def _trail(self, frame, strip, position, color, level):
        self._pixel(frame, strip, position, color, level)
        if position > 0:
            self._pixel(frame, strip, position - 1, color, level * 0.42)
        if position + 1 < self.LED_COUNT:
            self._pixel(frame, strip, position + 1, color, level * 0.18)

    @staticmethod
    def _scale_color(color, level):
        level = max(0.0, min(1.0, level))
        red = int(((color >> 16) & 0xFF) * level)
        green = int(((color >> 8) & 0xFF) * level)
        blue = int((color & 0xFF) * level)
        return (red << 16) | (green << 8) | blue

    @staticmethod
    def _rgb_triplet(color):
        return [(color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF]

    @staticmethod
    def _wave(age, period_ms, minimum, maximum):
        phase = age % period_ms
        half = period_ms // 2
        triangle = phase if phase <= half else period_ms - phase
        fraction = triangle / float(half)
        return minimum + (maximum - minimum) * fraction

    @staticmethod
    def _pulse(age, period_ms):
        phase = age % period_ms
        if phase < 110:
            return 1.0
        if 230 <= phase < 330:
            return 0.75
        return 0.22

    def _elapsed_ms(self, now, start):
        if self._ticks_diff is not None:
            return self._ticks_diff(now, start)
        return now - start

    @staticmethod
    def _integer(value, name, minimum, maximum):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("{} must be an integer".format(name))
        if value < minimum or value > maximum:
            raise ValueError("{} must be between {} and {}".format(name, minimum, maximum))
        return value

    @staticmethod
    def _default_now_ms():
        ticks_ms = getattr(time, "ticks_ms", None)
        if ticks_ms is not None:
            return ticks_ms()
        return int(time.time() * 1000)
