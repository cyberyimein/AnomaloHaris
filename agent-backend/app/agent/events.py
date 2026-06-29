from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


class AgentEvent(BaseModel):
    type: str
    session_id: str
    run_id: str
    data: dict[str, Any] = Field(default_factory=dict)
    timestamp: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())


def make_run_id() -> str:
    return f"run_{uuid4().hex}"


def event(
    event_type: str,
    session_id: str,
    run_id: str,
    **data: Any,
) -> AgentEvent:
    return AgentEvent(type=event_type, session_id=session_id, run_id=run_id, data=data)

