import unittest

from test_http_transport import load_entrypoint


class Clock:
    def __init__(self):
        self.now = 0
        self.pumps = 0

    def ticks(self):
        return self.now

    def pump(self):
        self.pumps += 1


class CooperativeHttpTests(unittest.TestCase):
    def test_slow_header_has_a_total_deadline_and_services_device(self):
        clock = Clock()

        class Connection:
            def recv(self, size):
                clock.now += 90
                return b"X"

        with self.assertRaisesRegex(OSError, "deadline"):
            load_entrypoint().read_request(
                Connection(), pump=clock.pump, now_ms=clock.ticks,
                deadline_ms=250,
            )
        self.assertGreaterEqual(clock.pumps, 2)
        self.assertLessEqual(clock.now, 270)

    def test_temporary_receive_timeout_does_not_abandon_partial_request(self):
        clock = Clock()
        parts = iter([
            b"POST /v1/invoke HTTP/1.1\r\nContent-Length: 2\r\n\r\n",
            OSError(110), b"{", OSError(11), b"}",
        ])

        class Connection:
            def recv(self, size):
                clock.now += 25
                part = next(parts)
                if isinstance(part, OSError):
                    raise part
                return part

        method, path, headers, body = load_entrypoint().read_request(
            Connection(), pump=clock.pump, now_ms=clock.ticks,
            deadline_ms=500,
        )
        self.assertEqual((method, path, body), ("POST", "/v1/invoke", b"{}"))
        self.assertGreaterEqual(clock.pumps, 5)

    def test_response_handles_partial_sends_and_retries_without_duplication(self):
        clock = Clock()
        output = bytearray()

        class Connection:
            calls = 0

            def send(self, data):
                self.calls += 1
                clock.now += 1
                if self.calls % 3 == 0:
                    raise OSError(11)
                count = min(7, len(data))
                output.extend(data[:count])
                return count

        load_entrypoint().send_response(
            Connection(), 200, b'{"ok":true}', pump=clock.pump,
            now_ms=clock.ticks, deadline_ms=500,
        )
        header, body = bytes(output).split(b"\r\n\r\n", 1)
        self.assertEqual(body, b'{"ok":true}')
        self.assertIn(b"Content-Length: 11", header)
        self.assertGreater(clock.pumps, 5)

    def test_unresponsive_peer_cannot_hold_send_forever(self):
        clock = Clock()

        class Connection:
            def send(self, data):
                clock.now += 100
                raise OSError(110)

        with self.assertRaisesRegex(OSError, "deadline"):
            load_entrypoint().send_response(
                Connection(), 200, b"{}", pump=clock.pump,
                now_ms=clock.ticks, deadline_ms=250,
            )
        self.assertLessEqual(clock.now, 300)
        self.assertGreaterEqual(clock.pumps, 2)
