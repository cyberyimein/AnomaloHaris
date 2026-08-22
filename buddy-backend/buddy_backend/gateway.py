from __future__ import annotations

import glob
import json
import logging
import socket
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class BuddyConfigurationError(RuntimeError):
    """Raised when the Buddy gateway is not configured or dependencies are missing."""


class BuddyConnectionError(RuntimeError):
    """Raised when Buddy is disconnected or the transport fails."""


@dataclass(frozen=True)
class BuddyEvent:
    id: int
    type: str
    payload: dict[str, Any]
    raw: str
    source: str
    received_at: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class BuddyAudioTurn:
    audio_bytes: bytes
    sample_rate_hz: int
    channels: int
    sample_width_bytes: int
    frame_count: int
    started_at: str | None = None
    finished_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class _BuddyBinaryFrame:
    frame_type: int
    codec: int
    stream_seq: int
    timestamp_ms: int
    payload: bytes


class BuddyGateway:
    def __init__(
        self,
        settings: Any,
        *,
        serial_factory: Callable[..., Any] | None = None,
        glob_func: Callable[[str], list[str]] | None = None,
        socket_factory: Callable[..., socket.socket] | None = None,
    ) -> None:
        self.settings = settings
        self._serial_factory = serial_factory
        self._glob = glob_func or glob.glob
        self._socket_factory = socket_factory or socket.socket
        self._stream: _LineEndpoint | None = None
        self._reader_thread: threading.Thread | None = None
        self._listener_thread: threading.Thread | None = None
        self._server_socket: socket.socket | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._events: deque[BuddyEvent] = deque(maxlen=self.settings.buddy_event_buffer_size)
        self._next_event_id = 1
        self._transport: str | None = None
        self._port: str | None = None
        self._client_address: str | None = None
        self._baud_rate: int | None = None
        self._tcp_host: str | None = None
        self._tcp_port: int | None = None
        self._tcp_client_ip: str | None = None
        self._audio_input_active = False
        self._audio_input_started_at: str | None = None
        self._audio_input_buffer = bytearray()
        self._audio_input_frame_count = 0
        self._audio_turns: deque[BuddyAudioTurn] = deque(maxlen=8)

    def connect(
        self,
        *,
        port: str | None = None,
        baud_rate: int | None = None,
        transport: str | None = None,
        tcp_host: str | None = None,
        tcp_port: int | None = None,
        tcp_client_ip: str | None = None,
    ) -> dict[str, Any]:
        selected_transport = self._normalize_transport(transport)
        self.disconnect()
        self._stop_event.clear()

        if selected_transport == "tcp":
            return self._connect_tcp(
                host=tcp_host or self.settings.buddy_tcp_host,
                port=tcp_port or self.settings.buddy_tcp_port,
                client_ip=tcp_client_ip or self.settings.buddy_tcp_client_ip,
            )

        return self._connect_serial(port=port, baud_rate=baud_rate)

    def disconnect(self) -> dict[str, Any]:
        with self._lock:
            stream = self._stream
            server_socket = self._server_socket
            reader_thread = self._reader_thread
            listener_thread = self._listener_thread
            self._stream = None
            self._server_socket = None
            self._reader_thread = None
            self._listener_thread = None
            self._transport = None
            self._port = None
            self._client_address = None
            self._tcp_host = None
            self._tcp_port = None
            self._tcp_client_ip = None
            self._baud_rate = None
            self._audio_input_active = False
            self._audio_input_started_at = None
            self._audio_input_buffer.clear()
            self._audio_input_frame_count = 0
            self._audio_turns.clear()
            self._stop_event.set()

        if stream is not None:
            try:
                self._write_line(stream, f"CB disconnect {self._host_name()} offline")
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass

        if server_socket is not None:
            try:
                server_socket.close()
            except Exception:
                pass

        for thread in (reader_thread, listener_thread):
            if thread is not None and thread.is_alive():
                thread.join(timeout=1.0)
        return self.status()

    def status(self) -> dict[str, Any]:
        with self._lock:
            last_event = self._events[-1].as_dict() if self._events else None
            listening = self._transport == "tcp" and self._server_socket is not None
            return {
                "connected": self._stream is not None,
                "listening": listening,
                "transport": self._transport,
                "serial_port": self._port if self._transport == "serial" else None,
                "baud_rate": self._baud_rate,
                "tcp_host": self._tcp_host,
                "tcp_port": self._tcp_port,
                "tcp_client_ip": self._tcp_client_ip,
                "client_address": self._client_address,
                "host_name": self._host_name(),
                "audio_input_active": self._audio_input_active,
                "queued_audio_turns": len(self._audio_turns),
                "recent_event_count": len(self._events),
                "last_event": last_event,
                "available_ports": self._available_ports(),
            }

    def is_connected(self) -> bool:
        with self._lock:
            return self._stream is not None

    def get_events(self, *, after_id: int | None = None, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            events = [
                event.as_dict()
                for event in self._events
                if after_id is None or event.id > after_id
            ]
        return events[-limit:]

    def send_raw_command(self, command: str) -> dict[str, Any]:
        normalized = command.strip()
        if not normalized:
            raise BuddyConfigurationError("Buddy command must not be empty.")

        with self._lock:
            stream = self._stream
        if stream is None:
            raise BuddyConnectionError("Buddy is not connected.")

        try:
            self._write_line(stream, normalized)
        except Exception as exc:  # noqa: BLE001
            raise BuddyConnectionError(f"Failed to send Buddy command: {exc}") from exc
        return {"command": normalized, **self.status()}

    def set_state(self, state: str, text: str | None = None) -> dict[str, Any]:
        normalized_state = state.strip().lower()
        command_name = {
            "connect": "CB connect",
            "disconnect": "CB disconnect",
            "idle": "CB idle",
            "listening": "CB listen",
            "thinking": "CB think",
            "waiting_user": "CB think",
            "speaking": "CB speak",
            "stop": "CB stop",
            "error": "CB error",
            "coding": "CODEX CODING",
            "approval": "CODEX APPROVAL codex-hook",
            "done": "CODEX DONE",
        }.get(normalized_state)
        if command_name is None:
            raise BuddyConfigurationError(f"Unsupported Buddy state: {state}")
        suffix = f" {text.strip()}" if text and text.strip() else ""
        return self.send_raw_command(f"{command_name}{suffix}")

    def set_text(self, text: str) -> dict[str, Any]:
        return self.send_raw_command(f"TEXT {text.strip()}")

    def set_coding(self, text: str | None = None) -> dict[str, Any]:
        suffix = f" {text.strip()}" if text and text.strip() else ""
        return self.send_raw_command(f"CODEX CODING{suffix}")

    def look(self, yaw: int, pitch: int, speed: int | None = None) -> dict[str, Any]:
        parts = ["LOOK", str(yaw), str(pitch)]
        if speed is not None:
            parts.append(str(speed))
        return self.send_raw_command(" ".join(parts))

    def set_led(self, r: int, g: int, b: int, ms: int | None = None) -> dict[str, Any]:
        parts = ["LED", str(r), str(g), str(b)]
        if ms is not None:
            parts.append(str(ms))
        return self.send_raw_command(" ".join(parts))

    def request_approval(
        self,
        request_id: str,
        text: str,
        *,
        timeout_seconds: float = 30.0,
    ) -> dict[str, Any]:
        with self._lock:
            start_id = self._events[-1].id if self._events else 0
        self.send_raw_command(f"CODEX APPROVAL {request_id} {text.strip()}")
        event = self.wait_for_event(
            timeout_seconds=timeout_seconds,
            after_id=start_id,
            predicate=lambda item: item.type == "approval.response"
            and str(item.payload.get("id") or "") == request_id,
        )
        if event is None:
            raise BuddyConnectionError(
                f"Timed out waiting for Buddy approval response: {request_id}"
            )
        return event.as_dict()

    def show_approval(self, request_id: str, text: str) -> dict[str, Any]:
        return self.send_raw_command(f"CODEX APPROVAL {request_id} {text.strip()}")

    def wait_for_event(
        self,
        *,
        timeout_seconds: float,
        after_id: int = 0,
        predicate: Callable[[BuddyEvent], bool],
    ) -> BuddyEvent | None:
        deadline = time.monotonic() + timeout_seconds
        with self._condition:
            while True:
                for event in self._events:
                    if event.id > after_id and predicate(event):
                        return event
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._condition.wait(timeout=remaining)

    def wait_for_audio_turn(self, *, timeout_seconds: float) -> BuddyAudioTurn | None:
        deadline = time.monotonic() + timeout_seconds
        with self._condition:
            while True:
                if self._audio_turns:
                    return self._audio_turns.popleft()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._condition.wait(timeout=remaining)

    def send_audio_output(
        self,
        audio_bytes: bytes,
        *,
        sample_rate_hz: int = 24000,
        chunk_bytes: int = 960,
    ) -> dict[str, Any]:
        if not audio_bytes:
            raise BuddyConfigurationError("Buddy output audio must not be empty.")
        if chunk_bytes <= 0 or chunk_bytes > 2048:
            raise BuddyConfigurationError("Buddy output chunk_bytes must be between 1 and 2048.")

        with self._lock:
            stream = self._stream
            transport = self._transport
        if stream is None:
            raise BuddyConnectionError("Buddy is not connected.")
        if transport != "tcp" or not isinstance(stream, _SocketLineEndpoint):
            raise BuddyConfigurationError("Buddy audio output requires an active TCP transport.")

        try:
            self._write_line(stream, f"AUDIO OUT START {sample_rate_hz} {chunk_bytes}")
            for index, chunk in enumerate(_chunk_audio(audio_bytes, chunk_bytes), start=1):
                padded = (
                    chunk
                    if len(chunk) == chunk_bytes
                    else chunk + b"\x00" * (chunk_bytes - len(chunk))
                )
                header = (
                    bytes([0x21, 0x02])
                    + index.to_bytes(4, "big")
                    + _timestamp_ms().to_bytes(8, "big")
                )
                stream.write(header + padded)
            self._write_line(stream, "AUDIO OUT STOP")
            stream.flush()
        except Exception as exc:  # noqa: BLE001
            raise BuddyConnectionError(f"Failed to stream Buddy audio output: {exc}") from exc

        self._append_event(
            type_name="audio.output.sent",
            payload={
                "sample_rate_hz": sample_rate_hz,
                "chunk_bytes": chunk_bytes,
                "size_bytes": len(audio_bytes),
            },
            raw="audio-output",
            source="tcp",
        )
        return self.status()

    def _connect_serial(self, *, port: str | None, baud_rate: int | None) -> dict[str, Any]:
        selected_port = port or self.settings.buddy_serial_port or self._auto_detect_port()
        if not selected_port:
            raise BuddyConfigurationError(
                "Buddy serial port is not configured. Set ANOMALO_BUDDY_SERIAL_PORT or "
                "connect a Call Buddy device at /dev/tty.usbmodem*."
            )

        serial_factory = self._serial_factory or self._load_pyserial_factory()
        serial_obj = serial_factory(
            selected_port,
            baudrate=baud_rate or self.settings.buddy_baud_rate,
            timeout=0.2,
            write_timeout=1.0,
            dsrdtr=False,
            rtscts=False,
        )
        self._set_handshake_lines(serial_obj)
        stream = _SerialLineEndpoint(serial_obj)

        with self._lock:
            self._stream = stream
            self._transport = "serial"
            self._port = selected_port
            self._baud_rate = baud_rate or self.settings.buddy_baud_rate
            self._start_reader_thread_locked()

        logger.info("Buddy serial connected: port=%s baud_rate=%s", selected_port, self._baud_rate)
        self.send_raw_command(f"CB connect {self._host_name()} online")
        return self.status()

    def _connect_tcp(self, *, host: str, port: int, client_ip: str | None) -> dict[str, Any]:
        server = self._socket_factory(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((host, port))
        server.listen(1)
        server.settimeout(0.2)
        bound_host, bound_port = server.getsockname()[:2]

        with self._lock:
            self._server_socket = server
            self._transport = "tcp"
            self._tcp_host = str(bound_host)
            self._tcp_port = int(bound_port)
            self._tcp_client_ip = client_ip
            self._start_reader_thread_locked()
            self._listener_thread = threading.Thread(
                target=self._accept_loop,
                name="anomalo-buddy-accept",
                daemon=True,
            )
            self._listener_thread.start()

        self._append_event(
            type_name="buddy.tcp.listening",
            payload={
                "host": str(bound_host),
                "port": int(bound_port),
                "client_ip": client_ip,
            },
            raw="tcp-listening",
            source="tcp",
        )
        logger.info(
            "Buddy TCP listener started: host=%s port=%s client_ip=%s",
            bound_host,
            bound_port,
            client_ip,
        )
        return self.status()

    def _accept_loop(self) -> None:
        while not self._stop_event.is_set():
            with self._lock:
                server = self._server_socket
                allowed_client_ip = self._tcp_client_ip
            if server is None:
                return

            try:
                conn, address = server.accept()
            except TimeoutError:
                continue
            except OSError:
                return

            client_host = str(address[0])
            client_label = f"{address[0]}:{address[1]}"
            if allowed_client_ip and client_host != allowed_client_ip:
                conn.close()
                self._append_event(
                    type_name="buddy.tcp.rejected",
                    payload={
                        "client_address": client_label,
                        "allowed_client_ip": allowed_client_ip,
                    },
                    raw=client_label,
                    source="tcp",
                )
                continue

            stream = _SocketLineEndpoint(conn)
            with self._lock:
                previous = self._stream
                self._stream = stream
                self._client_address = client_label
            if previous is not None:
                previous.close()

            self._append_event(
                type_name="buddy.tcp.connected",
                payload={"client_address": client_label},
                raw=client_label,
                source="tcp",
            )
            logger.info("Buddy TCP client connected: client_address=%s", client_label)
            try:
                self.send_raw_command(f"CB connect {self._host_name()} online")
            except BuddyConnectionError:
                continue

    def _read_loop(self) -> None:
        while not self._stop_event.is_set():
            with self._lock:
                stream = self._stream
                transport = self._transport
            if stream is None:
                time.sleep(0.05)
                continue

            try:
                raw = (
                    stream.read_message()
                    if isinstance(stream, _SocketLineEndpoint)
                    else stream.readline()
                )
            except Exception as exc:  # noqa: BLE001
                self._append_event(
                    type_name="buddy.connection.error",
                    payload={"error": str(exc), "transport": transport},
                    raw=str(exc),
                    source="error",
                )
                self._drop_stream(stream)
                continue

            if not raw:
                continue
            if isinstance(raw, _BuddyBinaryFrame):
                self._append_audio_input_frame(raw)
                continue
            line = raw.decode("utf-8", errors="replace").strip()
            if line:
                self._append_parsed_line(line)

    def _append_parsed_line(self, line: str) -> None:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            self._append_event(type_name="buddy.raw", payload={}, raw=line, source="text")
            return

        if not isinstance(payload, dict):
            self._append_event(
                type_name="buddy.raw",
                payload={"json_type": type(payload).__name__, "value": payload},
                raw=line,
                source="json",
            )
            return

        type_name = str(payload.get("type") or "buddy.raw")
        event_payload = payload.get("payload")
        if not isinstance(event_payload, dict):
            event_payload = {}
        self._append_event(type_name=type_name, payload=event_payload, raw=line, source="json")
        if type_name == "audio.input.start":
            self._begin_audio_input_turn()
        elif type_name in {"audio.input.stop", "touch.listen_cancel", "touch.listen_timeout"}:
            self._finish_audio_input_turn()

    def _append_event(
        self,
        *,
        type_name: str,
        payload: dict[str, Any],
        raw: str,
        source: str,
    ) -> None:
        with self._condition:
            event = BuddyEvent(
                id=self._next_event_id,
                type=type_name,
                payload=payload,
                raw=raw,
                source=source,
                received_at=datetime.now(UTC).isoformat(),
            )
            self._next_event_id += 1
            self._events.append(event)
            self._condition.notify_all()

    def _auto_detect_port(self) -> str | None:
        ports = self._available_ports()
        return ports[0] if ports else None

    def _available_ports(self) -> list[str]:
        patterns = ["/dev/tty.usbmodem*", "/dev/tty.usbserial*", "/dev/cu.usbmodem*"]
        results: list[str] = []
        seen: set[str] = set()
        for pattern in patterns:
            for match in sorted(self._glob(pattern)):
                normalized = str(Path(match))
                if normalized not in seen:
                    seen.add(normalized)
                    results.append(normalized)
        return results

    def _host_name(self) -> str:
        return self.settings.buddy_host_name or socket.gethostname()

    def _normalize_transport(self, transport: str | None) -> str:
        requested = (transport or self.settings.buddy_transport).strip().lower()
        if requested == "auto":
            return "serial" if self.settings.buddy_serial_port else "tcp"
        if requested not in {"serial", "tcp"}:
            raise BuddyConfigurationError(f"Unsupported Buddy transport: {transport}")
        return requested

    def _load_pyserial_factory(self) -> Callable[..., Any]:
        try:
            import serial
        except ImportError as exc:
            raise BuddyConfigurationError(
                "Buddy integration requires the optional buddy dependency. "
                "Install it with `pip install -e \".[buddy]\"`."
            ) from exc
        return serial.Serial

    def _set_handshake_lines(self, serial_obj: Any) -> None:
        for attr in ("dtr", "rts"):
            try:
                setattr(serial_obj, attr, False)
            except Exception:
                continue

    def _write_line(self, stream: _LineEndpoint, command: str) -> None:
        stream.write((command + "\n").encode("utf-8"))
        stream.flush()

    def _start_reader_thread_locked(self) -> None:
        if self._reader_thread is not None and self._reader_thread.is_alive():
            return
        self._reader_thread = threading.Thread(
            target=self._read_loop,
            name="anomalo-buddy-reader",
            daemon=True,
        )
        self._reader_thread.start()

    def _drop_stream(self, current: _LineEndpoint) -> None:
        with self._lock:
            if self._stream is not current:
                return
            self._stream = None
            self._client_address = None
            self._audio_input_active = False
            self._audio_input_started_at = None
            self._audio_input_buffer.clear()
            self._audio_input_frame_count = 0
        try:
            current.close()
        except Exception:
            pass

    def _begin_audio_input_turn(self) -> None:
        with self._condition:
            if self._audio_input_active:
                logger.warning(
                    "Buddy audio input start received while a turn is already active; "
                    "preserving buffered audio: frames=%s bytes=%s",
                    self._audio_input_frame_count,
                    len(self._audio_input_buffer),
                )
                self._condition.notify_all()
                return
            self._audio_input_active = True
            self._audio_input_started_at = datetime.now(UTC).isoformat()
            self._audio_input_buffer.clear()
            self._audio_input_frame_count = 0
            logger.info("Buddy audio input started.")
            self._condition.notify_all()

    def _append_audio_input_frame(self, frame: _BuddyBinaryFrame) -> None:
        if frame.frame_type != 0x20 or frame.codec != 0x02:
            self._append_event(
                type_name="audio.frame.ignored",
                payload={"frame_type": frame.frame_type, "codec": frame.codec},
                raw="binary-frame",
                source="tcp",
            )
            return
        with self._condition:
            if not self._audio_input_active:
                self._audio_input_active = True
                self._audio_input_started_at = datetime.now(UTC).isoformat()
                self._audio_input_buffer.clear()
                self._audio_input_frame_count = 0
            self._audio_input_buffer.extend(frame.payload)
            self._audio_input_frame_count += 1
            self._condition.notify_all()

    def _finish_audio_input_turn(self) -> None:
        with self._condition:
            if not self._audio_input_active:
                return
            audio_bytes = bytes(self._audio_input_buffer)
            started_at = self._audio_input_started_at
            frame_count = self._audio_input_frame_count
            self._audio_input_active = False
            self._audio_input_started_at = None
            self._audio_input_buffer.clear()
            self._audio_input_frame_count = 0
            if audio_bytes:
                logger.info(
                    "Buddy audio input finished: frames=%s bytes=%s",
                    frame_count,
                    len(audio_bytes),
                )
                self._audio_turns.append(
                    BuddyAudioTurn(
                        audio_bytes=audio_bytes,
                        sample_rate_hz=16000,
                        channels=1,
                        sample_width_bytes=2,
                        frame_count=frame_count,
                        started_at=started_at,
                        finished_at=datetime.now(UTC).isoformat(),
                    )
                )
            else:
                logger.info("Buddy audio input finished with no PCM payload.")
            self._condition.notify_all()


class _LineEndpoint:
    def readline(self) -> bytes:
        raise NotImplementedError

    def write(self, data: bytes) -> int:
        raise NotImplementedError

    def flush(self) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError


class _SerialLineEndpoint(_LineEndpoint):
    def __init__(self, serial_obj: Any) -> None:
        self.serial_obj = serial_obj

    def readline(self) -> bytes:
        return self.serial_obj.readline()

    def write(self, data: bytes) -> int:
        return self.serial_obj.write(data)

    def flush(self) -> None:
        if hasattr(self.serial_obj, "flush"):
            self.serial_obj.flush()

    def close(self) -> None:
        self.serial_obj.close()


class _SocketLineEndpoint(_LineEndpoint):
    def __init__(self, conn: socket.socket) -> None:
        self.conn = conn
        self.conn.settimeout(0.2)
        self._buffer = bytearray()

    def readline(self) -> bytes:
        while True:
            newline_index = self._buffer.find(b"\n")
            if newline_index != -1:
                line = bytes(self._buffer[: newline_index + 1])
                del self._buffer[: newline_index + 1]
                return line
            try:
                chunk = self.conn.recv(4096)
            except TimeoutError:
                return b""
            if not chunk:
                raise BuddyConnectionError("Buddy TCP client disconnected.")
            self._buffer.extend(chunk)

    def read_message(self) -> bytes | _BuddyBinaryFrame:
        while True:
            binary_size = _binary_frame_size(self._buffer)
            if binary_size is not None and len(self._buffer) >= binary_size:
                frame = bytes(self._buffer[:binary_size])
                del self._buffer[:binary_size]
                return _parse_binary_frame(frame)

            newline_index = self._buffer.find(b"\n")
            if newline_index != -1:
                line = bytes(self._buffer[: newline_index + 1])
                del self._buffer[: newline_index + 1]
                return line

            try:
                chunk = self.conn.recv(4096)
            except TimeoutError:
                return b""
            if not chunk:
                raise BuddyConnectionError("Buddy TCP client disconnected.")
            self._buffer.extend(chunk)

    def write(self, data: bytes) -> int:
        self.conn.sendall(data)
        return len(data)

    def flush(self) -> None:
        return

    def close(self) -> None:
        self.conn.close()


def _binary_frame_size(buffer: bytearray) -> int | None:
    if len(buffer) < 2:
        return None
    frame_type = buffer[0]
    codec = buffer[1]
    if frame_type == 0x20 and codec == 0x02:
        return 14 + 640
    if frame_type == 0x21 and codec == 0x02:
        return 14 + 960
    return None


def _parse_binary_frame(frame: bytes) -> _BuddyBinaryFrame:
    return _BuddyBinaryFrame(
        frame_type=frame[0],
        codec=frame[1],
        stream_seq=int.from_bytes(frame[2:6], "big"),
        timestamp_ms=int.from_bytes(frame[6:14], "big"),
        payload=frame[14:],
    )


def _timestamp_ms() -> int:
    return int(time.time() * 1000)


def _chunk_audio(audio_bytes: bytes, chunk_bytes: int) -> list[bytes]:
    return [
        audio_bytes[index : index + chunk_bytes]
        for index in range(0, len(audio_bytes), chunk_bytes)
    ]
