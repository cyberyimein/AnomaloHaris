import queue
import socket
import threading
import time

from app.buddy.gateway import BuddyGateway
from app.config import Settings


class FakeSerial:
    def __init__(self, *_: object, **__: object) -> None:
        self.lines: queue.Queue[bytes] = queue.Queue()
        self.writes: list[bytes] = []
        self.dtr = True
        self.rts = True

    def write(self, data: bytes) -> int:
        self.writes.append(data)
        decoded = data.decode("utf-8").strip()
        if decoded.startswith("CODEX APPROVAL"):
            self.lines.put(
                b'{"type":"approval.response","payload":{"id":"req-1","choice":"approve","method":"tap"}}\n'
            )
        return len(data)

    def flush(self) -> None:
        return

    def readline(self) -> bytes:
        try:
            return self.lines.get(timeout=0.05)
        except queue.Empty:
            return b""

    def close(self) -> None:
        return


def test_buddy_gateway_connects_and_waits_for_approval() -> None:
    created: list[FakeSerial] = []

    def serial_factory(*_: object, **__: object) -> FakeSerial:
        serial = FakeSerial()
        created.append(serial)
        return serial

    gateway = BuddyGateway(
        Settings(
            ANOMALO_BUDDY_TRANSPORT="serial",
            ANOMALO_BUDDY_HOST_NAME="anomalo-host",
        ),
        serial_factory=serial_factory,
        glob_func=lambda pattern: ["/dev/tty.usbmodem2101"] if "usbmodem" in pattern else [],
    )

    status = gateway.connect()
    assert status["connected"] is True
    assert created[0].writes[0].decode("utf-8").strip() == "CB connect anomalo-host online"
    assert created[0].dtr is False
    assert created[0].rts is False

    result = gateway.request_approval("req-1", "Approve shell command?", timeout_seconds=0.5)
    assert result["payload"]["choice"] == "approve"
    assert any(b"CODEX APPROVAL req-1 Approve shell command?" in item for item in created[0].writes)

    disconnected = gateway.disconnect()
    assert disconnected["connected"] is False


def test_buddy_gateway_records_json_and_text_events() -> None:
    serial = FakeSerial()

    def serial_factory(*_: object, **__: object) -> FakeSerial:
        return serial

    gateway = BuddyGateway(
        Settings(ANOMALO_BUDDY_TRANSPORT="serial"),
        serial_factory=serial_factory,
        glob_func=lambda pattern: ["/dev/tty.usbmodem2101"] if "usbmodem" in pattern else [],
    )
    gateway.connect()
    serial.lines.put(b'{"type":"touch.click","payload":{"action":"listen_start"}}\n')
    serial.lines.put(b"plain text line\n")

    event = gateway.wait_for_event(
        timeout_seconds=0.5,
        after_id=0,
        predicate=lambda item: item.type == "touch.click",
    )
    assert event is not None
    assert event.payload["action"] == "listen_start"

    events = gateway.get_events(limit=10)
    assert any(item["type"] == "buddy.raw" for item in events)


def test_buddy_gateway_ignores_json_primitives_without_crashing_reader() -> None:
    serial = FakeSerial()

    def serial_factory(*_: object, **__: object) -> FakeSerial:
        return serial

    gateway = BuddyGateway(
        Settings(ANOMALO_BUDDY_TRANSPORT="serial"),
        serial_factory=serial_factory,
        glob_func=lambda pattern: ["/dev/tty.usbmodem2101"] if "usbmodem" in pattern else [],
    )
    gateway.connect()
    serial.lines.put(b"1\n")
    serial.lines.put(b'{"type":"touch.click","payload":{"action":"listen_start"}}\n')

    event = gateway.wait_for_event(
        timeout_seconds=0.5,
        after_id=0,
        predicate=lambda item: item.type == "touch.click",
    )

    assert event is not None
    events = gateway.get_events(limit=10)
    assert any(
        item["type"] == "buddy.raw"
        and item["source"] == "json"
        and item["payload"].get("json_type") == "int"
        and item["payload"].get("value") == 1
        for item in events
    )


def test_buddy_gateway_tcp_mode_accepts_client_and_commands() -> None:
    gateway = BuddyGateway(
        Settings(
            ANOMALO_BUDDY_TRANSPORT="tcp",
            ANOMALO_BUDDY_TCP_HOST="127.0.0.1",
            ANOMALO_BUDDY_TCP_PORT=0,
            ANOMALO_BUDDY_TCP_CLIENT_IP="127.0.0.1",
            ANOMALO_BUDDY_HOST_NAME="anomalo-host",
        )
    )

    status = gateway.connect()
    assert status["listening"] is True
    assert status["transport"] == "tcp"

    received_commands: list[str] = []

    def device() -> None:
        with socket.create_connection(("127.0.0.1", int(status["tcp_port"])), timeout=2) as sock:
            initial = sock.recv(4096).decode("utf-8")
            received_commands.append(initial.strip())
            sock.sendall(
                b'{"type":"touch.click","payload":{"action":"listen_start"}}\n'
            )
            next_line = sock.recv(4096).decode("utf-8")
            received_commands.append(next_line.strip())

    thread = threading.Thread(target=device, daemon=True)
    thread.start()

    event = gateway.wait_for_event(
        timeout_seconds=2.0,
        after_id=0,
        predicate=lambda item: item.type == "touch.click",
    )
    assert event is not None
    assert event.payload["action"] == "listen_start"

    gateway.set_state("thinking", "asking model")
    thread.join(timeout=2.0)

    assert received_commands[0] == "CB connect anomalo-host online"
    assert received_commands[1] == "CB think asking model"


def test_buddy_gateway_tcp_mode_collects_audio_turns() -> None:
    gateway = BuddyGateway(
        Settings(
            ANOMALO_BUDDY_TRANSPORT="tcp",
            ANOMALO_BUDDY_TCP_HOST="127.0.0.1",
            ANOMALO_BUDDY_TCP_PORT=0,
            ANOMALO_BUDDY_TCP_CLIENT_IP="127.0.0.1",
            ANOMALO_BUDDY_HOST_NAME="anomalo-host",
        )
    )
    status = gateway.connect()

    payload_a = b"\x01\x00" * 320
    payload_b = b"\x02\x00" * 320

    def device() -> None:
        with socket.create_connection(("127.0.0.1", int(status["tcp_port"])), timeout=2) as sock:
            sock.recv(4096)
            sock.sendall(b'{"type":"audio.input.start","payload":{"sample_rate_hz":16000}}\n')
            sock.sendall(_audio_frame(1, payload_a))
            sock.sendall(_audio_frame(2, payload_b))
            sock.sendall(b'{"type":"audio.input.stop","payload":{}}\n')

    thread = threading.Thread(target=device, daemon=True)
    thread.start()

    turn = gateway.wait_for_audio_turn(timeout_seconds=2.0)
    thread.join(timeout=2.0)

    assert turn is not None
    assert turn.sample_rate_hz == 16000
    assert turn.frame_count == 2
    assert turn.audio_bytes == payload_a + payload_b


def test_buddy_gateway_tcp_mode_preserves_frames_when_start_arrives_late() -> None:
    gateway = BuddyGateway(
        Settings(
            ANOMALO_BUDDY_TRANSPORT="tcp",
            ANOMALO_BUDDY_TCP_HOST="127.0.0.1",
            ANOMALO_BUDDY_TCP_PORT=0,
            ANOMALO_BUDDY_TCP_CLIENT_IP="127.0.0.1",
            ANOMALO_BUDDY_HOST_NAME="anomalo-host",
        )
    )
    status = gateway.connect()

    payload_a = b"\x01\x00" * 320
    payload_b = b"\x02\x00" * 320

    def device() -> None:
        with socket.create_connection(("127.0.0.1", int(status["tcp_port"])), timeout=2) as sock:
            sock.recv(4096)
            sock.sendall(_audio_frame(1, payload_a))
            sock.sendall(b'{"type":"audio.input.start","payload":{"sample_rate_hz":16000}}\n')
            sock.sendall(_audio_frame(2, payload_b))
            sock.sendall(b'{"type":"audio.input.stop","payload":{}}\n')

    thread = threading.Thread(target=device, daemon=True)
    thread.start()

    turn = gateway.wait_for_audio_turn(timeout_seconds=2.0)
    thread.join(timeout=2.0)

    assert turn is not None
    assert turn.sample_rate_hz == 16000
    assert turn.frame_count == 2
    assert turn.audio_bytes == payload_a + payload_b


def test_buddy_gateway_tcp_mode_streams_audio_output() -> None:
    gateway = BuddyGateway(
        Settings(
            ANOMALO_BUDDY_TRANSPORT="tcp",
            ANOMALO_BUDDY_TCP_HOST="127.0.0.1",
            ANOMALO_BUDDY_TCP_PORT=0,
            ANOMALO_BUDDY_TCP_CLIENT_IP="127.0.0.1",
            ANOMALO_BUDDY_HOST_NAME="anomalo-host",
        )
    )
    status = gateway.connect()

    received = bytearray()

    def device() -> None:
        with socket.create_connection(("127.0.0.1", int(status["tcp_port"])), timeout=2) as sock:
            deadline = time.time() + 1.0
            while time.time() < deadline:
                try:
                    chunk = sock.recv(4096)
                except TimeoutError:
                    continue
                if not chunk:
                    break
                received.extend(chunk)
                if b"AUDIO OUT STOP\n" in received:
                    break

    thread = threading.Thread(target=device, daemon=True)
    thread.start()
    event = gateway.wait_for_event(
        timeout_seconds=2.0,
        after_id=0,
        predicate=lambda item: item.type == "buddy.tcp.connected",
    )
    assert event is not None

    gateway.send_audio_output(b"\x10\x00" * 480)
    thread.join(timeout=2.0)

    assert b"AUDIO OUT START 24000 960\n" in received
    assert b"AUDIO OUT STOP\n" in received
    assert b"\x21\x02" in received


def _audio_frame(stream_seq: int, payload: bytes) -> bytes:
    return (
        bytes([0x20, 0x02])
        + stream_seq.to_bytes(4, "big")
        + int(time.time() * 1000).to_bytes(8, "big")
        + payload
    )
