from app.buddy.skill_api import (
    connection_status as _connection_status,
)
from app.buddy.skill_api import (
    recent_events as _recent_events,
)


def recent_events(
    limit: int = 10,
    event_type: str | None = None,
    after_id: int | None = None,
) -> str:
    """Return recent Buddy events for touch, listen, approval, and heartbeat flows."""
    return _recent_events(limit=limit, event_type=event_type, after_id=after_id)


def connection_status() -> str:
    """Return Buddy bridge connection status for the current Anomalo host."""
    return _connection_status()
