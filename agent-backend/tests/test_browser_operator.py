import asyncio
import json
from pathlib import Path

import pytest
from app.agent.events import event
from app.agent.runtime import AgentRuntime
from app.agent.session import SessionStore
from app.agents.browser_operator import (
    BROWSER_OPERATOR_ID,
    BROWSER_OPERATOR_SYSTEM_PROMPT,
    BROWSER_TOOL_NAMES,
    BrowserToolBroker,
    BrowserToolProvider,
    ensure_browser_operator,
)
from app.agents.store import PresetAgentStore
from app.api import websocket as websocket_api
from app.config import Settings
from app.llm.openai_client import LLMStreamEvent
from app.tools.base import ToolContext
from app.tools.registry import ToolRegistry
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.mark.asyncio
async def test_browser_tool_broker_round_trip() -> None:
    sent: list[dict[str, object]] = []
    broker = BrowserToolBroker(timeout_seconds=1)

    async def send(payload: dict[str, object]) -> None:
        sent.append(payload)

    broker.register("session-1", send)
    provider = BrowserToolProvider(broker)
    call = asyncio.create_task(
        provider.call_tool(
            "browser.get_page_state",
            {"max_targets": 10},
            ToolContext(
                session_id="session-1",
                run_id="run-1",
                tool_call_id="call-1",
            ),
        )
    )

    await asyncio.sleep(0)
    assert sent[0]["type"] == "browser.tool.call"
    assert sent[0]["data"]["tool_call_id"] == "call-1"  # type: ignore[index]
    assert broker.complete(
        session_id="session-1",
        run_id="run-1",
        tool_call_id="call-1",
        status="ok",
        result={"url": "https://example.com"},
    )

    result = await call
    assert result.ok is True
    assert json.loads(result.content) == {"url": "https://example.com"}
    assert result.data == {"url": "https://example.com"}


@pytest.mark.asyncio
async def test_old_browser_registration_cannot_unregister_new_connection() -> None:
    first_sent: list[dict[str, object]] = []
    second_sent: list[dict[str, object]] = []
    broker = BrowserToolBroker(timeout_seconds=1)

    async def first_send(payload: dict[str, object]) -> None:
        first_sent.append(payload)

    async def second_send(payload: dict[str, object]) -> None:
        second_sent.append(payload)

    first_registration = broker.register("session-1", first_send)
    broker.register("session-1", second_send)
    await broker.unregister("session-1", registration=first_registration)

    call = asyncio.create_task(
        broker.call(
            session_id="session-1",
            run_id="run-1",
            tool_call_id="call-1",
            tool="browser.get_page_state",
            arguments={},
        )
    )
    await asyncio.sleep(0)
    assert first_sent == []
    assert second_sent[0]["type"] == "browser.tool.call"
    assert broker.complete(
        session_id="session-1",
        run_id="run-1",
        tool_call_id="call-1",
        status="ok",
        result={"title": "Example"},
    )
    assert (await call).ok is True


@pytest.mark.asyncio
async def test_browser_prompt_extends_the_standard_anomalo_prompt() -> None:
    llm = _PromptRuntimeLlm()
    runtime = AgentRuntime(
        settings=Settings(
            OPENROUTER_API_KEY=None,
            WEB_TOOLS_ENABLED=False,
            ANOMALO_AGENT_PROMPT_PROFILE="agent",
        ),
        sessions=SessionStore(),
        skills=_PromptSkills(),
        mcp=_PromptMcp(),
        tools=ToolRegistry([]),
        llm=llm,
    )

    events = [
        item
        async for item in runtime.run(
            "browser-session",
            "Help me inspect this page.",
            system_prompt_appendix=BROWSER_OPERATOR_SYSTEM_PROMPT,
            allowed_tool_names=set(BROWSER_TOOL_NAMES),
        )
    ]

    assert events[-1].type == "run.finished"
    assert llm.messages[0]["role"] == "system"
    assert "You are Anomalo" in llm.messages[0]["content"]
    assert llm.messages[1] == {
        "role": "system",
        "content": BROWSER_OPERATOR_SYSTEM_PROMPT.strip(),
    }
    assert "not your sole role" in llm.messages[1]["content"]


def test_builtin_browser_operator_is_stable_and_restricted(tmp_path: Path) -> None:
    store = PresetAgentStore(tmp_path / "preset-agents.sqlite3")
    agent = ensure_browser_operator(
        store,
        model="provider/model",
        temperature=0.2,
    )

    assert agent.id == BROWSER_OPERATOR_ID
    assert agent.tool_names == list(BROWSER_TOOL_NAMES)
    assert agent.tool_sources == {name: "browser_bridge" for name in BROWSER_TOOL_NAMES}

    repaired = ensure_browser_operator(
        store,
        model="provider/other-model",
        temperature=0.3,
    )
    assert repaired.id == BROWSER_OPERATOR_ID
    assert repaired.model == "provider/other-model"
    assert repaired.tool_names == list(BROWSER_TOOL_NAMES)


def test_browser_websocket_handshake_and_result_round_trip(monkeypatch) -> None:
    store = PresetAgentStore()
    agent = ensure_browser_operator(store, model="provider/model", temperature=0.2)
    broker = BrowserToolBroker(timeout_seconds=2)
    provider = BrowserToolProvider(broker)
    runtime = _BrowserRuntime(provider)
    app = FastAPI()
    app.include_router(websocket_api.router)

    monkeypatch.setattr(websocket_api, "get_preset_agent_store", lambda: store)
    monkeypatch.setattr(websocket_api, "get_browser_tool_broker", lambda: broker)
    monkeypatch.setattr(websocket_api, "get_agent_runtime", lambda: runtime)
    monkeypatch.setattr(websocket_api, "get_session_store", lambda: _SessionState())

    with TestClient(app) as client:
        with client.websocket_connect("/ws/chat/browser-session") as socket:
            assert socket.receive_json()["type"] == "session.state"
            socket.send_json(
                {
                    "type": "client.hello",
                    "session_id": "browser-session",
                    "data": {
                        "protocol_version": 1,
                        "agent_profile": "browser_operator",
                        "capabilities": {
                            "browser_bridge": True,
                            "browser_tools": list(BROWSER_TOOL_NAMES),
                        },
                    },
                }
            )
            ready = socket.receive_json()
            assert ready["type"] == "client.ready"
            assert ready["data"]["preset_agent"]["id"] == agent.id

            socket.send_json({"type": "user.message", "content": "Inspect the page."})
            started = socket.receive_json()
            assert started["type"] == "run.started"
            call = socket.receive_json()
            assert call["type"] == "browser.tool.call"
            socket.send_json(
                {
                    "type": "browser.tool.result",
                    "session_id": "browser-session",
                    "run_id": call["run_id"],
                    "data": {
                        "tool_call_id": call["data"]["tool_call_id"],
                        "status": "ok",
                        "result": {"title": "Example"},
                    },
                }
            )
            finished = socket.receive_json()
            assert finished["type"] == "tool.finished"
            assert json.loads(finished["data"]["content"]) == {"title": "Example"}
            assert socket.receive_json()["type"] == "run.finished"


class _BrowserRuntime:
    def __init__(self, provider: BrowserToolProvider) -> None:
        self.provider = provider

    def has_checkpoint(self, session_id: str) -> bool:
        del session_id
        return False

    def request_stop(self, session_id: str, *, reason: str = "user_stop") -> None:
        del session_id, reason

    async def run(self, session_id: str, content: str | None = None, **options: object):
        del content, options
        run_id = "run-browser"
        yield event("run.started", session_id, run_id)
        result = await self.provider.call_tool(
            "browser.get_page_state",
            {},
            ToolContext(
                session_id=session_id,
                run_id=run_id,
                tool_call_id="call-browser",
            ),
        )
        yield event(
            "tool.finished" if result.ok else "tool.error",
            session_id,
            run_id,
            tool_call_id="call-browser",
            tool="browser.get_page_state",
            ok=result.ok,
            content=result.content,
            data=result.data,
        )
        yield event("run.finished", session_id, run_id, final_text=result.content)


class _PromptRuntimeLlm:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []

    def request_payload(
        self,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        return {"messages": messages, "tools": tools}

    async def stream_chat(
        self,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ):
        del tools
        self.messages = messages
        yield LLMStreamEvent(type="message.done")


class _PromptSkills:
    def skill_catalog_message(self):
        return None

    def build_active_skill_messages(self, names):
        del names
        return []


class _PromptMcp:
    def catalog_message(self):
        return None

    def build_active_server_messages(self, names):
        del names
        return []


class _SessionState:
    def get_search_mode(self, session_id: str) -> str:
        del session_id
        return "diy"

    def set_active_skills(self, session_id: str, names: set[str]) -> None:
        del session_id, names

    def set_active_mcp_servers(self, session_id: str, names: set[str]) -> None:
        del session_id, names
