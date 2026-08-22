from __future__ import annotations

import json
from typing import Any

from buddy_backend.bridge import get_buddy_gateway

ALLOWED_PRESENCE_STATES = frozenset(
    {"idle", "listening", "thinking", "speaking", "coding", "done", "error"}
)


def set_presence(state: str, text: str | None = None) -> str:
    """Set Buddy to a high-level visual state with optional short status text."""
    gateway = _connected_gateway()
    normalized_state = state.strip().lower()
    if normalized_state not in ALLOWED_PRESENCE_STATES:
        msg = f"Unsupported Buddy presence state: {state}"
        raise ValueError(msg)

    result = gateway.set_state(normalized_state, text)
    return _json(
        {
            "ok": True,
            "state": normalized_state,
            "text": text or "",
            "transport": result.get("transport"),
        }
    )


def set_status_text(text: str) -> str:
    """Update Buddy's short bottom status text without changing the visual state."""
    gateway = _connected_gateway()
    result = gateway.set_text(text)
    return _json({"ok": True, "text": text, "transport": result.get("transport")})


def cue_led(r: int, g: int, b: int, ms: int = 800) -> str:
    """Show a temporary LED color cue on Buddy."""
    gateway = _connected_gateway()
    gateway.set_led(r, g, b, ms)
    return _json({"ok": True, "r": r, "g": g, "b": b, "ms": ms})


def look(yaw: int, pitch: int, speed: int | None = None) -> str:
    """Aim Buddy's head toward a target yaw and pitch."""
    gateway = _connected_gateway()
    gateway.look(yaw, pitch, speed)
    return _json({"ok": True, "yaw": yaw, "pitch": pitch, "speed": speed})


def request_approval(request_id: str, text: str, timeout_seconds: float = 30.0) -> str:
    """Ask for human approval on Buddy and wait for the tap/swipe response."""
    gateway = _connected_gateway()
    event = gateway.request_approval(request_id, text, timeout_seconds=timeout_seconds)
    payload = dict(event.get("payload") or {})
    return _json(
        {
            "ok": True,
            "request_id": str(payload.get("id") or request_id),
            "choice": str(payload.get("choice") or "unknown"),
            "method": str(payload.get("method") or "unknown"),
        }
    )


def recent_events(
    limit: int = 10,
    event_type: str | None = None,
    after_id: int | None = None,
) -> str:
    """Return recent Buddy events for touch, listen, approval, and heartbeat flows."""
    gateway = _connected_gateway()
    events = gateway.get_events(after_id=after_id, limit=limit)
    normalized_event_type = event_type.strip() if event_type else None
    if normalized_event_type:
        events = [
            event
            for event in events
            if str(event.get("type") or "") == normalized_event_type
        ]
    compact_events = [
        {
            "id": event.get("id"),
            "type": event.get("type"),
            "payload": event.get("payload"),
            "received_at": event.get("received_at"),
        }
        for event in events
    ]
    return _json(compact_events)


def connection_status() -> str:
    """Return Buddy bridge connection status for the current Anomalo host."""
    status = get_buddy_gateway().status()
    return _json(
        {
            "connected": status.get("connected"),
            "listening": status.get("listening"),
            "transport": status.get("transport"),
            "client_address": status.get("client_address"),
            "tcp_port": status.get("tcp_port"),
            "serial_port": status.get("serial_port"),
        }
    )


def _connected_gateway() -> Any:
    gateway = get_buddy_gateway()
    if not gateway.is_connected():
        msg = "Buddy is not connected."
        raise RuntimeError(msg)
    return gateway


def _json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)
