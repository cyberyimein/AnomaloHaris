"""Bounded HTTP transfers that keep local device input and feedback serviced."""

import socket
import time

MAX_REQUEST_BYTES = 8192
RESPONSE_CHUNK_BYTES = 8192
READ_DEADLINE_MS = 5000
WRITE_DEADLINE_MS = 15000


class TransportTimeout(OSError):
    pass


def _now_ms():
    ticks = getattr(time, "ticks_ms", None)
    return ticks() if ticks else int(time.monotonic() * 1000)


def _elapsed(now, started):
    difference = getattr(time, "ticks_diff", None)
    return difference(now, started) if difference else now - started


def _temporary(error):
    return bool(error.args) and error.args[0] in (11, 110, 116)


def _retry_pause():
    sleep_ms = getattr(time, "sleep_ms", None)
    if sleep_ms is not None:
        sleep_ms(2)
    else:
        time.sleep(0.002)


class TransferBudget:
    def __init__(self, pump, now_ms, deadline_ms):
        self.pump = pump
        self.now_ms = now_ms or _now_ms
        self.deadline_ms = deadline_ms
        self.started = self.now_ms()

    def check(self):
        if _elapsed(self.now_ms(), self.started) >= self.deadline_ms:
            raise TransportTimeout("HTTP transfer deadline exceeded")

    def service(self):
        self.check()
        if self.pump is not None:
            self.pump()
        self.check()

    def receive(self, connection, size):
        while True:
            self.service()
            try:
                data = connection.recv(size)
            except OSError as error:
                if not _temporary(error):
                    raise
                _retry_pause()
                continue
            self.check()
            if data is None:
                _retry_pause()
                continue
            return data

    def write(self, connection, data):
        offset = 0
        payload = memoryview(data)
        send = getattr(connection, "send", None)
        while offset < len(payload):
            self.service()
            stop = min(offset + RESPONSE_CHUNK_BYTES, len(payload))
            try:
                if callable(send):
                    sent = send(payload[offset:stop])
                    if sent is None:
                        _retry_pause()
                        continue
                    if sent <= 0:
                        raise OSError("Connection closed during response")
                else:
                    # Compatibility for file-like adapters; actual sockets use send.
                    connection.sendall(payload[offset:stop])
                    sent = stop - offset
            except OSError as error:
                if not _temporary(error):
                    raise
                _retry_pause()
                continue
            offset += sent
            self.check()


def read_request(connection, pump=None, now_ms=None, deadline_ms=READ_DEADLINE_MS):
    budget = TransferBudget(pump, now_ms, deadline_ms)
    data = bytearray()
    boundary = -1
    while boundary < 0:
        chunk = budget.receive(connection, 512)
        if not chunk:
            raise ValueError("Connection closed before request headers completed")
        data.extend(chunk)
        boundary = data.find(b"\r\n\r\n")
        if len(data) > MAX_REQUEST_BYTES:
            raise ValueError("Request headers exceed the configured size limit")

    lines = bytes(data[:boundary]).decode("utf-8").split("\r\n")
    request_line = lines[0].split(" ")
    if len(request_line) != 3:
        raise ValueError("Malformed HTTP request line")
    method, path, _version = request_line
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    content_length = int(headers.get("content-length", "0"))
    if not 0 <= content_length <= MAX_REQUEST_BYTES:
        raise ValueError("Request body exceeds the configured size limit")
    body = bytearray(data[boundary + 4:boundary + 4 + content_length])
    while len(body) < content_length:
        chunk = budget.receive(connection, min(512, content_length - len(body)))
        if not chunk:
            raise ValueError("Connection closed before request body completed")
        body.extend(chunk)
    return method, path, headers, bytes(body)


def send_response(connection, status, body, pump=None, now_ms=None,
                  deadline_ms=WRITE_DEADLINE_MS):
    reasons = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found"}
    header = (
        "HTTP/1.1 {} {}\r\n".format(status, reasons.get(status, "Error"))
        + "Content-Type: application/json\r\n"
        + "Cache-Control: no-store\r\n"
        + "Content-Length: {}\r\n".format(len(body))
        + "Connection: close\r\n\r\n"
    ).encode("ascii")
    budget = TransferBudget(pump, now_ms, deadline_ms)
    if len(header) + len(body) <= RESPONSE_CHUNK_BYTES:
        budget.write(connection, header + body)
    else:
        budget.write(connection, header)
        budget.write(connection, body)


def configure_connection(connection):
    # ESP32 socket timeouts round short waits up; use bounded cooperative retries.
    connection.settimeout(0)
    protocol = getattr(socket, "IPPROTO_TCP", None)
    no_delay = getattr(socket, "TCP_NODELAY", None)
    if protocol is not None and no_delay is not None:
        try:
            connection.setsockopt(protocol, no_delay, 1)
        except OSError:
            pass
