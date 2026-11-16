"""Bearer-authenticated JSON API implemented without a web framework."""

import binascii

from device_service import transfer_call

try:
    import ujson as json
except ImportError:
    import json


class BuddyHttpApi:
    def __init__(self, device, token, ip_provider=None, uptime_provider=None,
                 wifi_provider=None, service_callback=None, runtime_provider=None):
        if not token:
            raise ValueError("BUDDY_DEVICE_TOKEN is required")
        self.device = device
        self.token = token
        self.ip_provider = ip_provider or (lambda: None)
        self.uptime_provider = uptime_provider or (lambda: None)
        self.wifi_provider = wifi_provider or (lambda: True)
        self.service_callback = service_callback
        self.runtime_provider = runtime_provider

    def handle(self, method, path, headers, body):
        supplied = headers.get("authorization", "")
        if supplied != "Bearer " + self.token:
            return 401, self._json({"error": {"code": "unauthorized", "message": "Invalid bearer token"}})

        if method == "GET" and path == "/v1/status":
            payload = self.device.status(
                ip=self.ip_provider(),
                wifi_connected=self.wifi_provider(),
                uptime_ms=self.uptime_provider(),
            )
            if self.runtime_provider is not None:
                payload["state"]["runtime"] = self.runtime_provider()
            return 200, self._json(payload)

        if method == "GET" and path == "/v1/debug/snapshot":
            from debug_snapshot import build_debug_snapshot
            payload = build_debug_snapshot(
                self.device,
                ip=self.ip_provider(),
                wifi_connected=self.wifi_provider(),
                uptime_ms=self.uptime_provider(),
            )
            if self.runtime_provider is not None:
                payload["status"]["state"]["runtime"] = self.runtime_provider()
            return 200, self._json(payload)

        if method == "POST" and path == "/v1/invoke":
            try:
                request = json.loads(body.decode("utf-8"))
                if not isinstance(request, dict):
                    raise ValueError("Request body must be a JSON object")
                if set(request) != {"requestId", "capability", "args"}:
                    raise ValueError("Request must contain requestId, capability, and args")
                payload = self.device.invoke(
                    request["requestId"], request["capability"], request["args"]
                )
                return 200, self._json(payload)
            except Exception as error:
                return 400, self._json({
                    "error": {"code": "invalid_invocation", "message": str(error)}
                })

        return 404, self._json({"error": {"code": "not_found", "message": "Unknown route"}})

    def _json(self, payload):
        def encode():
            if self.service_callback is not None:
                self.service_callback()
            body = _encode_json_payload(payload)
            if self.service_callback is not None:
                self.service_callback()
            return body
        return transfer_call(self.device, encode)


def _encode_json_payload(payload):
    fast_body = _fast_rgb565_json(payload)
    if fast_body is not None:
        return fast_body
    return json.dumps(payload).encode("utf-8")


def _fast_rgb565_json(payload):
    """Serialize raw RGB565 data directly after validating its base64 bytes."""
    if not isinstance(payload, dict):
        return None
    result = payload.get("result")
    if not isinstance(result, dict):
        return None
    image = result.get("image")
    if not isinstance(image, dict):
        return None
    if image.get("mimeType") != "application/x-rgb565":
        return None
    if image.get("encoding") != "rgb565-be":
        return None

    width = image.get("width")
    height = image.get("height")
    data = image.get("data")
    if (not isinstance(width, int) or isinstance(width, bool) or width < 1 or width > 640
            or not isinstance(height, int) or isinstance(height, bool) or height < 1 or height > 480
            or not isinstance(data, str)):
        return None

    expected_byte_length = width * height * 2
    expected_base64_length = ((expected_byte_length + 2) // 3) * 4
    if len(data) != expected_base64_length:
        return None

    try:
        encoded_data = data.encode("ascii")
        raw_pixels = binascii.a2b_base64(encoded_data)
        canonical_data = binascii.b2a_base64(raw_pixels).strip()
    except (ValueError, TypeError, UnicodeError):
        return None
    if len(raw_pixels) != expected_byte_length or canonical_data != encoded_data:
        return None

    image_metadata = image.copy()
    del image_metadata["data"]
    encoded_image = _append_json_field(
        json.dumps(image_metadata).encode("utf-8"),
        b'"data"',
        b'"' + encoded_data + b'"',
    )

    result_metadata = result.copy()
    del result_metadata["image"]
    encoded_result = _append_json_field(
        json.dumps(result_metadata).encode("utf-8"),
        b'"image"',
        encoded_image,
    )

    payload_metadata = payload.copy()
    del payload_metadata["result"]
    return _append_json_field(
        json.dumps(payload_metadata).encode("utf-8"),
        b'"result"',
        encoded_result,
    )


def _append_json_field(encoded_object, encoded_key, encoded_value):
    closing = encoded_object.rstrip()
    if not closing.endswith(b"}"):
        raise ValueError("JSON object encoder returned an invalid object")
    prefix = closing[:-1]
    separator = b"" if prefix.endswith(b"{") else b","
    return prefix + separator + encoded_key + b":" + encoded_value + b"}"
