import base64
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

CLI_MODULE_SPEC = importlib.util.spec_from_file_location(
    "buddy_debug_snapshot",
    Path(__file__).with_name("buddy-debug-snapshot.py"),
)
buddy_debug_snapshot = importlib.util.module_from_spec(CLI_MODULE_SPEC)
sys.modules[CLI_MODULE_SPEC.name] = buddy_debug_snapshot
CLI_MODULE_SPEC.loader.exec_module(buddy_debug_snapshot)
main = buddy_debug_snapshot.main


PNG_BYTES = b"\x89PNG\r\n\x1a\nmock-png-data"
TOKEN = "do-not-print-this-token"


def snapshot_payload(available=True):
    return {
        "status": {"deviceId": "room-buddy", "state": {"mode": "ready"}},
        "display": {
            "available": available,
            "source": "submitted_framebuffer" if available else "unavailable",
            "image": {
                "mimeType": "image/png",
                "data": base64.b64encode(PNG_BYTES).decode("ascii"),
                "width": 320,
                "height": 240,
            },
            "renderer": {"frame": "idle_0.rgb565", "error": None, "family": "idle", "frameIndex": 0},
            "brightness": 128,
        },
        "touch": {"levels": [3, 0, 0], "lastPolledZones": [1, 0, 0]},
        "lighting": {
            "manualOverride": False,
            "strips": [
                [0x112233, 0x223344, 0x334455, 0x445566, 0x556677, 0x667788],
                [0x778899, 0x8899AA, 0x99AABB, 0xAABBCC, 0xBBCCDD, 0xCCDDEE],
            ],
        },
    }


class BuddyDebugSnapshotCliTests(unittest.TestCase):
    def run_cli(self, payload, extra_args=(), env_token=TOKEN):
        output = io.StringIO()
        request_details = {}

        def fake_urlopen(request, timeout):
            request_details["url"] = request.full_url
            request_details["authorization"] = request.get_header("Authorization")
            request_details["timeout"] = timeout
            return io.BytesIO(json.dumps(payload).encode("utf-8"))

        with tempfile.TemporaryDirectory() as output_dir:
            with patch.dict(os.environ, {"BUDDY_DEVICE_TOKEN": env_token}, clear=False):
                with patch("buddy_debug_snapshot.urllib.request.urlopen", side_effect=fake_urlopen):
                    with patch("sys.stdout", output):
                        result = main(["--output", output_dir, *extra_args])

            snapshot_path = Path(output_dir) / "snapshot.json"
            image_path = Path(output_dir) / "screen.png"
            saved_snapshot = snapshot_path.read_text(encoding="utf-8") if snapshot_path.exists() else None
            saved_image = image_path.read_bytes() if image_path.exists() else None
            return result, output.getvalue(), request_details, saved_snapshot, saved_image

    def test_saves_authenticated_snapshot_and_png_without_printing_token(self):
        payload = snapshot_payload()
        result, stdout, request, saved_snapshot, saved_image = self.run_cli(payload)

        self.assertEqual(result, 0)
        self.assertEqual(request["url"], "http://192.168.31.78:8080/v1/debug/snapshot")
        self.assertEqual(request["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(request["timeout"], 90)
        self.assertEqual(json.loads(saved_snapshot), payload)
        self.assertEqual(saved_image, PNG_BYTES)
        self.assertIn("Source: submitted_framebuffer", stdout)
        self.assertIn("Mode: ready", stdout)
        self.assertIn("Touch: levels [3, 0, 0]; last polled zones [1, 0, 0]", stdout)
        self.assertNotIn(TOKEN, stdout)

    def test_unavailable_display_is_reported_without_writing_screen_image(self):
        result, stdout, _request, saved_snapshot, saved_image = self.run_cli(snapshot_payload(available=False))

        self.assertEqual(result, 0)
        self.assertIsNotNone(saved_snapshot)
        self.assertIsNone(saved_image)
        self.assertIn("Display: unavailable", stdout)

    def test_secret_echoed_by_device_is_redacted_from_saved_snapshot_and_summary(self):
        payload = snapshot_payload()
        payload["display"]["renderer"]["error"] = TOKEN
        result, stdout, _request, saved_snapshot, _saved_image = self.run_cli(payload)

        self.assertEqual(result, 0)
        self.assertNotIn(TOKEN, saved_snapshot)
        self.assertIn("[redacted]", saved_snapshot)
        self.assertNotIn(TOKEN, stdout)

    def test_status_and_renderer_errors_are_included_in_summary(self):
        payload = snapshot_payload()
        payload["status"]["state"]["error"] = "servo feedback warning"
        payload["display"]["renderer"]["error"] = "frame render warning"
        result, stdout, _request, _saved_snapshot, _saved_image = self.run_cli(payload)

        self.assertEqual(result, 0)
        self.assertIn("Error: status: servo feedback warning; renderer: frame render warning", stdout)

    def test_config_file_token_is_read_as_literal_without_executing_file(self):
        output = io.StringIO()
        request_details = {}
        payload = snapshot_payload()
        config_token = "config-token-should-stay-secret"

        def fake_urlopen(request, timeout):
            request_details["authorization"] = request.get_header("Authorization")
            return io.BytesIO(json.dumps(payload).encode("utf-8"))

        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.py"
            config_path.write_text(
                f'BUDDY_DEVICE_TOKEN = "{config_token}"\n'
                'raise RuntimeError("config was executed")\n'
            )
            output_dir = Path(temp_dir) / "output"
            with patch.dict(os.environ, {}, clear=True):
                with patch("buddy_debug_snapshot.urllib.request.urlopen", side_effect=fake_urlopen):
                    with patch("sys.stdout", output):
                        result = main(["--config", str(config_path), "--output", str(output_dir)])

        self.assertEqual(result, 0)
        self.assertEqual(request_details["authorization"], f"Bearer {config_token}")
        self.assertNotIn(config_token, output.getvalue())

    def test_http_error_does_not_print_response_body_or_token(self):
        stderr = io.StringIO()
        secret_response = io.BytesIO(f"bad auth {TOKEN}".encode("utf-8"))
        error = HTTPError("http://device", 401, "Unauthorized", {}, secret_response)

        with tempfile.TemporaryDirectory() as output_dir:
            with patch.dict(os.environ, {"BUDDY_DEVICE_TOKEN": TOKEN}, clear=False):
                with patch("buddy_debug_snapshot.urllib.request.urlopen", side_effect=error):
                    with patch("sys.stderr", stderr):
                        result = main(["--output", output_dir])

        self.assertEqual(result, 2)
        self.assertIn("HTTP 401", stderr.getvalue())
        self.assertNotIn(TOKEN, stderr.getvalue())
        self.assertFalse((Path(output_dir) / "snapshot.json").exists())

    def test_missing_token_fails_without_requesting_the_device(self):
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as output_dir:
            with patch.dict(os.environ, {}, clear=True):
                with patch("buddy_debug_snapshot.urllib.request.urlopen") as urlopen:
                    with patch("sys.stderr", stderr):
                        result = main(["--output", output_dir])

        self.assertEqual(result, 2)
        self.assertIn("Set BUDDY_DEVICE_TOKEN", stderr.getvalue())
        urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
