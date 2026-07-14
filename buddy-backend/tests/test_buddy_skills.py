import json

import pytest
from app.config import get_settings
from app.tools.base import ToolContext
from app.tools.skills import SkillProvider


class FakeBuddyGateway:
    def __init__(self) -> None:
        self.state_calls: list[tuple[str, str | None]] = []
        self.text_calls: list[str] = []
        self.led_calls: list[tuple[int, int, int, int | None]] = []
        self.look_calls: list[tuple[int, int, int | None]] = []
        self.approval_calls: list[tuple[str, str, float]] = []
        self.connected = True

    def is_connected(self) -> bool:
        return self.connected

    def set_state(self, state: str, text: str | None = None) -> dict[str, object]:
        self.state_calls.append((state, text))
        return {"transport": "tcp"}

    def set_text(self, text: str) -> dict[str, object]:
        self.text_calls.append(text)
        return {"transport": "tcp"}

    def set_led(self, r: int, g: int, b: int, ms: int | None = None) -> dict[str, object]:
        self.led_calls.append((r, g, b, ms))
        return {}

    def look(self, yaw: int, pitch: int, speed: int | None = None) -> dict[str, object]:
        self.look_calls.append((yaw, pitch, speed))
        return {}

    def request_approval(
        self,
        request_id: str,
        text: str,
        *,
        timeout_seconds: float = 30.0,
    ) -> dict[str, object]:
        self.approval_calls.append((request_id, text, timeout_seconds))
        return {"payload": {"id": request_id, "choice": "approve", "method": "tap"}}

    def get_events(
        self,
        *,
        after_id: int | None = None,
        limit: int = 50,
    ) -> list[dict[str, object]]:
        del after_id, limit
        return [
            {
                "id": 1,
                "type": "touch.click",
                "payload": {"action": "listen_start"},
                "received_at": "2026-05-29T00:00:00+00:00",
            },
            {
                "id": 2,
                "type": "device.heartbeat",
                "payload": {"state": "idle"},
                "received_at": "2026-05-29T00:00:01+00:00",
            },
        ]

    def status(self) -> dict[str, object]:
        return {
            "connected": True,
            "listening": True,
            "transport": "tcp",
            "client_address": "192.0.2.20:12345",
            "tcp_port": 8787,
            "serial_port": None,
        }


@pytest.mark.asyncio
async def test_buddy_skills_load_and_call_gateway(monkeypatch) -> None:
    fake_gateway = FakeBuddyGateway()
    monkeypatch.setattr("buddy_backend.skill_api.get_buddy_gateway", lambda: fake_gateway)

    provider = SkillProvider(get_settings().skill_dirs)
    context = ToolContext(
        active_skills=frozenset({"buddy_presence", "buddy_approval", "buddy_events"})
    )

    tools = await provider.list_tools(context=context)
    tool_names = {tool.name for tool in tools}

    assert "skill_buddy_presence_set_presence" in tool_names
    assert "skill_buddy_approval_request_approval" in tool_names
    assert "skill_buddy_events_recent_events" in tool_names

    presence = await provider.call_tool(
        "skill_buddy_presence_set_presence",
        {"state": "thinking", "text": "asking model"},
        context=context,
    )
    approval = await provider.call_tool(
        "skill_buddy_approval_request_approval",
        {"request_id": "codex-7", "text": "Approve shell command?"},
        context=context,
    )
    events = await provider.call_tool(
        "skill_buddy_events_recent_events",
        {"event_type": "touch.click"},
        context=context,
    )
    status = await provider.call_tool(
        "skill_buddy_events_connection_status",
        {},
        context=context,
    )

    assert presence.ok is True
    assert fake_gateway.state_calls == [("thinking", "asking model")]

    assert approval.ok is True
    assert fake_gateway.approval_calls == [("codex-7", "Approve shell command?", 30.0)]
    assert json.loads(approval.content)["choice"] == "approve"

    assert events.ok is True
    assert json.loads(events.content) == [
        {
            "id": 1,
            "type": "touch.click",
            "payload": {"action": "listen_start"},
            "received_at": "2026-05-29T00:00:00+00:00",
        }
    ]

    assert status.ok is True
    assert json.loads(status.content)["transport"] == "tcp"
