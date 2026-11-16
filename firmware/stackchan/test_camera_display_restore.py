import unittest
import base64

from device import DeviceController
from test_firmware import FakeBoard, FakeImage


class CameraDisplayRestoreTests(unittest.TestCase):
    def test_display_is_restored_after_camera_closes_before_raw_frame_is_copied(self):
        events = []

        class TrackedImage(FakeImage):
            def bytearray(self):
                events.append("raw_copy")
                return super().bytearray()

        class Camera:
            def snapshot(self):
                events.append("capture_closed")
                return TrackedImage(1, 1, b"\xf8\x00")

        class Display:
            def present(self):
                events.append("display_restored")
                return True

        device = DeviceController(FakeBoard(), Camera(), display=Display())
        events.clear()

        image = device._capture()

        self.assertEqual(events, ["capture_closed", "display_restored", "raw_copy"])
        self.assertEqual(base64.b64decode(image["data"]), b"\xf8\x00")
        self.assertEqual(image["mimeType"], "application/x-rgb565")


if __name__ == "__main__":
    unittest.main()
