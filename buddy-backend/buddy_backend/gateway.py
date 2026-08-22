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
                raw = stream.readline()
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
        try:
            current.close()
        except Exception:
            pass

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

    def write(self, data: bytes) -> int:
        self.conn.sendall(data)
        return len(data)

    def flush(self) -> None:
        return

    def close(self) -> None:
        self.conn.close()
