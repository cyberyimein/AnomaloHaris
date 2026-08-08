import asyncio
import json
from pathlib import Path

import pytest
from app.agent.events import event
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
from app.tools.base import ToolContext
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
async def test_browser_type_text_is_registered_and_callable() -> None:
    sent: list[dict[str, object]] = []
    broker = BrowserToolBroker(timeout_seconds=1)

    async def send(payload: dict[str, object]) -> None:
        sent.append(payload)

    broker.register("session-1", send)
    provider = BrowserToolProvider(broker)
    context = ToolContext(
        session_id="session-1",
        run_id="run-1",
        tool_call_id="type-text-1",
    )
    specs = await provider.list_tools(context)
    spec = next(spec for spec in specs if spec.name == "browser.type_text")

    assert spec.parameters["required"] == [
        "target_ref",
        "expected_document_epoch",
        "text",
    ]
    assert spec.parameters["properties"]["text"] == {
        "type": "string",
        "maxLength": 20000,
    }

    call = asyncio.create_task(
        provider.call_tool(
            "browser.type_text",
            {
                "target_ref": "target-opaque-1",
                "expected_document_epoch": "epoch-1",
                "text": "hello editor",
            },
            context,
        )
    )
    await asyncio.sleep(0)
    assert sent[0]["type"] == "browser.tool.call"
    assert sent[0]["data"]["tool"] == "browser.type_text"  # type: ignore[index]
    assert sent[0]["data"]["arguments"] == {  # type: ignore[index]
        "target_ref": "target-opaque-1",
        "expected_document_epoch": "epoch-1",
        "text": "hello editor",
    }
    assert broker.complete(
        session_id="session-1",
        run_id="run-1",
        tool_call_id="type-text-1",
        status="ok",
        result={"verified": True},
    )

    result = await call
    assert result.ok is True
    assert result.name == "browser.type_text"
    assert result.data == {"verified": True}


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


def test_browser_prompt_combines_anomalo_and_browser_instructions() -> None:
    assert "You are Anomalo" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "primarily text" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "not your sole role" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "browser.get_page_state" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "Do not call browser.screenshot as a startup" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "If a browser action returns STALE_TARGET" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "Never conclude that JavaScript is disabled" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "cannot type arbitrary text" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "browser.type_text" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "native input and textarea controls" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "contenteditable, canvas, and iframe-backed editors" in BROWSER_OPERATOR_SYSTEM_PROMPT
    assert "Never use browser.press_key or Space" in BROWSER_OPERATOR_SYSTEM_PROMPT


def test_builtin_browser_operator_is_stable_and_restricted(tmp_path: Path) -> None:
    store = PresetAgentStore(tmp_path / "preset-agents.sqlite3")
    agent = ensure_browser_operator(
        store,
        model="provider/model",
        temperature=0.2,
    )

    assert agent.id == BROWSER_OPERATOR_ID
    assert agent.tool_names == list(BROWSER_TOOL_NAMES)
    assert len(agent.tool_names) == 9
    assert "browser.type_text" in agent.tool_names
    assert agent.bootstrap_tools == []
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


class _SessionState:
    def get_search_mode(self, session_id: str) -> str:
        del session_id
        return "diy"

    def set_active_skills(self, session_id: str, names: set[str]) -> None:
        del session_id, names

    def set_active_mcp_servers(self, session_id: str, names: set[str]) -> None:
        del session_id, names
