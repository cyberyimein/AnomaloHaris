import importlib.util
import socket
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def load_entrypoint():
    spec = importlib.util.spec_from_file_location("http_transport_subject", Path(__file__).with_name("main.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.dict("sys.modules", {
        "M5": types.ModuleType("M5"),
        "network": types.ModuleType("network"),
        "config": types.ModuleType("config"),
    }):
        spec.loader.exec_module(module)
    return module


class FakeConnection:
    def __init__(self):
        self.writes = []
        self.options = []

    def sendall(self, data):
        self.writes.append(bytes(data))

    def settimeout(self, seconds):
        self.timeout = seconds

    def setsockopt(self, *args):
        self.options.append(args)


class HttpTransportTests(unittest.TestCase):
    def test_small_control_reply_is_sent_in_one_write(self):
        module = load_entrypoint()
        connection = FakeConnection()
        module.send_response(connection, 200, b'{"ok":true}')
        self.assertEqual(len(connection.writes), 1)
        self.assertTrue(connection.writes[0].endswith(b'\r\n\r\n{"ok":true}'))

    def test_image_reply_is_bounded_and_preserves_every_byte(self):
        module = load_entrypoint()
        connection = FakeConnection()
        body = bytes(range(256)) * 100
        module.send_response(connection, 200, body)
        header, actual = b"".join(connection.writes).split(b"\r\n\r\n", 1)
        self.assertEqual(actual, body)
        self.assertIn(b"Content-Length: 25600", header)
        self.assertLessEqual(len(connection.writes), 5)

    def test_control_socket_disables_nagle_when_supported(self):
        module = load_entrypoint()
        connection = FakeConnection()
        module.configure_connection(connection)
        self.assertEqual(connection.timeout, 0)
        self.assertIn((socket.IPPROTO_TCP, socket.TCP_NODELAY, 1), connection.options)


if __name__ == "__main__":
    unittest.main()
