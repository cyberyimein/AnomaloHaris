import base64
import copy
import json
import unittest
from unittest.mock import patch

import http_api
from http_api import BuddyHttpApi


class FakeDevice:
    def __init__(self, response_payload):
        self.response_payload = response_payload
        self.transfer_active = False
        self.transfer_transitions = []
        self.invoke_calls = []

    def invoke(self, request_id, capability, args):
        self.invoke_calls.append((request_id, capability, args))
        return self.response_payload

    def set_transfer_active(self, enabled):
        previous = self.transfer_active
        self.transfer_active = enabled
        self.transfer_transitions.append(enabled)
        return previous


class BuddyHttpImageJsonTests(unittest.TestCase):
    def _invoke(self, payload, service_callback=None):
        device = FakeDevice(payload)
        api = BuddyHttpApi(device, "device-secret", service_callback=service_callback)
        request = json.dumps({
            "requestId": "request-1",
            "capability": "camera.capture",
            "args": {},
        }).encode("utf-8")
        status, body = api.handle(
            "POST",
            "/v1/invoke",
            {"authorization": "Bearer device-secret"},
            request,
        )
        return device, status, body

    @staticmethod
    def _raw_image(width=320, height=240):
        pixels = bytes([0x12, 0x34]) * (width * height)
        return {
            "mimeType": "application/x-rgb565",
            "encoding": "rgb565-be",
            "data": base64.b64encode(pixels).decode("ascii"),
            "width": width,
            "height": height,
            "capturedAtMs": 12345,
            "note": 'quoted "metadata" stays JSON-safe',
        }

    def test_fast_raw_image_json_preserves_payload_and_transfer_scope(self):
        image = self._raw_image()
        payload = {
            "requestId": "request-1",
            "result": {
                "image": image,
                "accepted": True,
                "extra": {"caption": 'A "curious" buddy'},
            },
            "extraTopLevel": "keep me",
        }
        original_payload = copy.deepcopy(payload)
        callback_states = []
        device = FakeDevice(payload)
        api = BuddyHttpApi(
            device,
            "device-secret",
            service_callback=lambda: callback_states.append(device.transfer_active),
        )
        request = json.dumps({
            "requestId": "request-1",
            "capability": "camera.capture",
            "args": {},
        }).encode("utf-8")
        dumped_objects = []
        normal_dumps = json.dumps

        def track_dump(value, *args, **kwargs):
            dumped_objects.append(value)
            return normal_dumps(value, *args, **kwargs)

        with patch.object(http_api.json, "dumps", side_effect=track_dump):
            status, body = api.handle(
                "POST",
                "/v1/invoke",
                {"authorization": "Bearer device-secret"},
                request,
            )

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode("utf-8")), original_payload)
        self.assertEqual(payload, original_payload)
        self.assertEqual(device.invoke_calls, [("request-1", "camera.capture", {})])
        self.assertEqual(device.transfer_transitions, [True, False])
        self.assertFalse(device.transfer_active)
        self.assertEqual(callback_states, [True, True])

        # The long data field must be spliced after serializing only small objects.
        self.assertEqual(len(dumped_objects), 3)
        self.assertTrue(all("data" not in item for item in dumped_objects))
        self.assertTrue(all(item is not payload for item in dumped_objects))

    def test_fast_path_handles_empty_result_and_payload_objects(self):
        payload = {"result": {"image": self._raw_image(1, 1)}}
        device = FakeDevice(payload)
        api = BuddyHttpApi(device, "device-secret")
        request = json.dumps({
            "requestId": "request-1",
            "capability": "camera.capture",
            "args": {},
        }).encode("utf-8")
        dumped_objects = []
        normal_dumps = json.dumps

        def track_dump(value, *args, **kwargs):
            dumped_objects.append(value)
            return normal_dumps(value, *args, **kwargs)

        with patch.object(http_api.json, "dumps", side_effect=track_dump):
            status, body = api.handle(
                "POST",
                "/v1/invoke",
                {"authorization": "Bearer device-secret"},
                request,
            )

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode("utf-8")), payload)
        self.assertEqual(len(dumped_objects), 3)
        self.assertEqual(dumped_objects[1], {})
        self.assertEqual(dumped_objects[2], {})

    def test_malformed_rgb565_data_uses_safe_standard_json_fallback(self):
        payload = {
            "requestId": "request-1",
            "result": {
                "image": {
                    "mimeType": "application/x-rgb565",
                    "encoding": "rgb565-be",
                    "data": 'AA==","injected":true,"x":"',
                    "width": 1,
                    "height": 1,
                    "capturedAtMs": 123,
                },
            },
        }
        dumped_objects = []
        normal_dumps = json.dumps
        device = FakeDevice(payload)
        api = BuddyHttpApi(device, "device-secret")
        request = json.dumps({
            "requestId": "request-1",
            "capability": "camera.capture",
            "args": {},
        }).encode("utf-8")

        def track_dump(value, *args, **kwargs):
            dumped_objects.append(value)
            return normal_dumps(value, *args, **kwargs)

        with patch.object(http_api.json, "dumps", side_effect=track_dump):
            status, body = api.handle(
                "POST",
                "/v1/invoke",
                {"authorization": "Bearer device-secret"},
                request,
            )

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode("utf-8")), payload)
        self.assertEqual(dumped_objects, [payload])
        self.assertEqual(device.transfer_transitions, [True, False])

    def test_non_rgb565_images_and_results_without_images_use_original_encoder(self):
        wrong_encoding_image = self._raw_image(1, 1)
        wrong_encoding_image["encoding"] = "rgb565-le"
        wrong_width_image = self._raw_image(1, 1)
        wrong_width_image["width"] = 641
        wrong_length_image = self._raw_image(1, 1)
        wrong_length_image["data"] = "AA=="
        payloads = [
            {"requestId": "request-1", "result": {
                "image": {"mimeType": "image/png", "data": "aGVsbG8=", "width": 1, "height": 1},
                "accepted": True,
            }},
            {"requestId": "request-1", "result": {"image": wrong_encoding_image}},
            {"requestId": "request-1", "result": {"image": wrong_width_image}},
            {"requestId": "request-1", "result": {"image": wrong_length_image}},
            {"requestId": "request-1", "result": {"accepted": True}},
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                dumped_objects = []
                normal_dumps = json.dumps
                device = FakeDevice(payload)
                api = BuddyHttpApi(device, "device-secret")
                request = json.dumps({
                    "requestId": "request-1",
                    "capability": "camera.capture",
                    "args": {},
                }).encode("utf-8")

                def track_dump(value, *args, **kwargs):
                    dumped_objects.append(value)
                    return normal_dumps(value, *args, **kwargs)

                with patch.object(http_api.json, "dumps", side_effect=track_dump):
                    status, body = api.handle(
                        "POST",
                        "/v1/invoke",
                        {"authorization": "Bearer device-secret"},
                        request,
                    )

                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body.decode("utf-8")), payload)
                self.assertEqual(dumped_objects, [payload])


if __name__ == "__main__":
    unittest.main()
