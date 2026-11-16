import unittest

from lazy_camera import OwnedCameraAdapter


class FakeImage:
    def __init__(self, pixels, width=2, height=1):
        self.pixels = pixels
        self._width = width
        self._height = height

    def width(self):
        return self._width

    def height(self):
        return self._height

    def bytearray(self):
        return self.pixels


class FakeCameraModule:
    RGB565 = "rgb565"
    QVGA = "qvga"

    def __init__(self, frame=None):
        self.frame = frame or FakeImage(bytearray(b"original"))
        self.events = []

    def init(self, **kwargs):
        self.events.append(("init", kwargs))

    def snapshot(self):
        self.events.append(("snapshot",))
        return self.frame

    def deinit(self):
        self.events.append(("deinit",))


class FailingCameraModule(FakeCameraModule):
    def snapshot(self):
        self.events.append(("snapshot",))
        raise RuntimeError("capture failed")


class CameraWithoutDeinit:
    RGB565 = "rgb565"
    QVGA = "qvga"

    def init(self, **kwargs):
        raise AssertionError("must reject module before initialization")

    def snapshot(self):
        raise AssertionError("must reject module before capture")


class OwnedCameraAdapterTests(unittest.TestCase):
    def test_camera_disables_horizontal_mirror_before_snapshot(self):
        class MirrorCamera(FakeCameraModule):
            def set_hmirror(self, enabled):
                self.events.append(("hmirror", enabled))

        module = MirrorCamera()
        OwnedCameraAdapter(module).snapshot()
        self.assertEqual(module.events[1:3], [("hmirror", False), ("snapshot",)])

    def test_capture_timestamp_is_recorded_before_camera_teardown(self):
        clock = [100]

        class SlowTeardown(FakeCameraModule):
            def deinit(self):
                clock[0] += 900
                super().deinit()

        image = OwnedCameraAdapter(SlowTeardown(), now_ms=lambda: clock[0]).snapshot()
        self.assertEqual(image.captured_at_ms, 100)
        self.assertEqual(clock[0], 1000)

    def test_camera_is_lazy_and_capture_returns_owned_pixels_after_deinit(self):
        module = FakeCameraModule()
        adapter = OwnedCameraAdapter(module)

        self.assertEqual(module.events, [])
        image = adapter.snapshot()

        self.assertEqual(module.events, [
            ("init", {"pixformat": module.RGB565, "framesize": module.QVGA}),
            ("snapshot",),
            ("deinit",),
        ])
        self.assertEqual((image.width(), image.height()), (2, 1))
        self.assertEqual(image.bytearray(), b"original")
        self.assertIsNot(image.bytearray(), module.frame.bytearray())

        module.frame.pixels[:] = b"modified"
        self.assertEqual(image.bytearray(), b"original")

    def test_camera_is_deinitialized_when_capture_fails(self):
        module = FailingCameraModule()
        adapter = OwnedCameraAdapter(module)

        with self.assertRaisesRegex(RuntimeError, "capture failed"):
            adapter.snapshot()

        self.assertEqual(module.events, [
            ("init", {"pixformat": module.RGB565, "framesize": module.QVGA}),
            ("snapshot",),
            ("deinit",),
        ])

    def test_module_without_deinit_is_rejected_before_use(self):
        with self.assertRaisesRegex(ValueError, "deinit"):
            OwnedCameraAdapter(CameraWithoutDeinit())


if __name__ == "__main__":
    unittest.main()
