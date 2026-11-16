"""A short-lived camera adapter that returns a copy of each captured frame."""

import time


class OwnedImage:
    """Image-like value backed by Python-owned pixel storage."""

    def __init__(self, width, height, pixels, captured_at_ms=None):
        self._width = width
        self._height = height
        self._pixels = pixels
        self.captured_at_ms = captured_at_ms

    def width(self):
        return self._width

    def height(self):
        return self._height

    def bytearray(self):
        return self._pixels


class OwnedCameraAdapter:
    """Initialize only during capture and deinitialize after copying the frame."""

    def __init__(self, camera_module, now_ms=None):
        self.camera = camera_module
        self._now_ms = now_ms or self._default_now_ms
        if not callable(getattr(camera_module, "init", None)):
            raise ValueError("Camera module must provide init()")
        if not callable(getattr(camera_module, "snapshot", None)):
            raise ValueError("Camera module must provide snapshot()")
        if not callable(getattr(camera_module, "deinit", None)):
            raise ValueError("Camera module must provide deinit()")
        if not hasattr(camera_module, "RGB565") or not hasattr(camera_module, "QVGA"):
            raise ValueError("Camera module must provide RGB565 and QVGA modes")

    @staticmethod
    def _default_now_ms():
        ticks = getattr(time, "ticks_ms", None)
        return ticks() if ticks else int(time.monotonic() * 1000)

    def snapshot(self):
        try:
            self.camera.init(
                pixformat=self.camera.RGB565,
                framesize=self.camera.QVGA,
            )
            set_hmirror = getattr(self.camera, "set_hmirror", None)
            if callable(set_hmirror):
                set_hmirror(False)
            frame = self.camera.snapshot()
            width = frame.width()
            height = frame.height()
            pixels = bytearray(frame.bytearray())
            return OwnedImage(width, height, pixels, captured_at_ms=self._now_ms())
        finally:
            self.camera.deinit()
