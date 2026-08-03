from pathlib import Path

import pytest
from app.agent.events import event
from app.agent.runtime import AgentRuntime
from app.agent.session import SessionStore
from app.agents.store import PresetAgentStore
from app.config import Settings
from app.llm.openai_client import OpenAIChatClient
from app.tools.base import ToolResult, ToolSpec
from fastapi import FastAPI
from fastapi.testclient import TestClient


class FakeSkills:
    def skill_catalog_message(self):
        return None

    def build_active_skill_messages(self, names):
        del names
        return []


class FakeMcp:
    def catalog_message(self):
        return None

    def build_active_server_messages(self, names):
        del names
        return []


class TwoToolProvider:
    async def openai_tools(self, context):
        del context
        return [
            ToolSpec(name="web_search", description="Search", source="web").as_openai_tool(),
            ToolSpec(name="python", description="Calculate", source="python").as_openai_tool(),
        ]

    async def call_tool(self, name, arguments, *, context):
        del arguments, context
        return ToolResult(name=name, content="done")


class CapturingRuntime:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def run(self, session_id, message, **options):
        self.calls.append({"session_id": session_id, "message": message, **options})
        yield event("run.started", session_id, "run-1")
        yield event(
            "llm.request",
            session_id,
            "run-1",
            request={
                "model": "deepseek/deepseek-v4-flash",
                "messages": [{"role": "system", "content": "private system prompt"}],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "web_search",
                            "description": "private tool description",
                            "parameters": {"type": "object"},
                        },
                    }
                ],
            },
            context={"active_skills": ["private-skill"], "tool_count": 1},
        )
        yield event(
            "run.finished",
            session_id,
            "run-1",
            final_text="Rates held steady.",
            output={"summary": "Rates held steady."},
            output_format="json_schema",
        )


def _definition(name: str = "fomc-brief") -> dict[str, object]:
    return {
        "name": name,
        "description": "FOMC summary agent",
        "ghost": "📈",
        "system_prompt": "Summarize market decisions concisely.",
        "model": "deepseek/deepseek-v4-flash",
        "temperature": 0.1,
        "tool_names": ["web_search"],
        "tool_sources": {"web_search": "web"},
    }


def test_preset_agent_store_persists_and_resolves_name_case_insensitively(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "preset-agents.sqlite3"
    first = PresetAgentStore(db_path)
    created = first.create(**_definition())
    first.close()

    second = PresetAgentStore(db_path)
    loaded = second.get("FOMC-BRIEF")

    assert loaded is not None
    assert loaded.id == created.id
    assert loaded.tool_names == ["web_search"]
    second.close()


def test_preset_agent_names_are_unique_case_insensitively() -> None:
    store = PresetAgentStore()
    store.create(**_definition())

    with pytest.raises(ValueError, match="already exists"):
        store.create(**_definition("FOMC-BRIEF"))


def test_session_cannot_be_shared_by_different_preset_agents() -> None:
    store = PresetAgentStore()
    first = store.create(**_definition())
    second = store.create(**_definition("earnings-brief"))

    assert store.bind_session("stock-task-1", first.id) is True
    assert store.bind_session("stock-task-1", first.id) is True
    assert store.bind_session("stock-task-1", second.id) is False
    assert store.get_bound_agent_id("stock-task-1") == first.id
    store.unbind_session("stock-task-1")
    assert store.get_bound_agent_id("stock-task-1") is None


def test_preset_agent_name_cannot_be_whitespace() -> None:
    from app.api.preset_agents import PresetAgentDefinition

    with pytest.raises(ValueError, match="cannot be blank"):
        PresetAgentDefinition(name="   ", system_prompt="Prompt", model="model")


def test_preset_agent_can_be_invoked_by_name(monkeypatch) -> None:
    from app.api import preset_agents

    store = PresetAgentStore()
    agent = store.create(**_definition())
    runtime = CapturingRuntime()
    sessions = SessionStore()
    monkeypatch.setattr(preset_agents, "get_preset_agent_store", lambda: store)
    monkeypatch.setattr(preset_agents, "get_agent_runtime", lambda: runtime)
    monkeypatch.setattr(preset_agents, "get_session_store", lambda: sessions)
    app = FastAPI()
    app.include_router(preset_agents.invocation_router)
    client = TestClient(app)

    response = client.post(
        "/api/agents/FOMC-BRIEF/chat",
        json={"message": "Summarize the decision.", "session_id": "stock-task-1"},
    )

    assert response.status_code == 200
    assert response.json()["agent"] == {"id": agent.id, "name": "fomc-brief"}
    assert response.json()["output"] == {"summary": "Rates held steady."}
    assert runtime.calls[0]["model"] == "deepseek/deepseek-v4-flash"
    assert runtime.calls[0]["allowed_tool_names"] == {"web_search"}
    llm_request = next(
        item for item in response.json()["events"] if item["type"] == "llm.request"
    )
    assert llm_request["data"]["request"]["messages"] == []
    assert llm_request["data"]["request"]["tools"] == [
        {"type": "function", "function": {"name": "web_search"}}
    ]
    assert "active_skills" not in llm_request["data"]["context"]
    assert "private system prompt" not in response.text
    assert "private tool description" not in response.text


def test_invocable_preset_agent_list_does_not_expose_system_prompt(monkeypatch) -> None:
    from app.api import preset_agents

    store = PresetAgentStore()
    agent = store.create(**_definition())
    monkeypatch.setattr(preset_agents, "get_preset_agent_store", lambda: store)
    app = FastAPI()
    app.include_router(preset_agents.invocation_router)
    client = TestClient(app)

    response = client.get("/api/agents")

    assert response.status_code == 200
    assert response.json() == {
        "agents": [
            {
                "id": agent.id,
                "name": "fomc-brief",
                "description": "FOMC summary agent",
                "ghost": "📈",
                "model": "deepseek/deepseek-v4-flash",
                "tool_count": 1,
            }
        ]
    }
    assert "system_prompt" not in response.json()["agents"][0]


def test_preset_agent_resume_requires_session_id(monkeypatch) -> None:
    from app.api import preset_agents

    app = FastAPI()
    app.include_router(preset_agents.invocation_router)
    client = TestClient(app)

    response = client.post("/api/agents/fomc-brief/chat", json={"resume": True})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_runtime_applies_custom_prompt_model_temperature_and_tool_allowlist() -> None:
    settings = Settings(OPENROUTER_API_KEY=None)
    runtime = AgentRuntime(
        settings=settings,
        sessions=SessionStore(),
        skills=FakeSkills(),
        mcp=FakeMcp(),
        tools=TwoToolProvider(),
        llm=OpenAIChatClient(settings),
    )

    events = [
        item
        async for item in runtime.run(
            "preset-session",
            "What did the FOMC decide?",
            system_prompt="You are the stock system's FOMC analyst.",
            allowed_tool_names={"web_search"},
            model="deepseek/deepseek-v4-flash",
            temperature=0.1,
        )
    ]

    request = next(item for item in events if item.type == "llm.request").data["request"]
    assert request["model"] == "deepseek/deepseek-v4-flash"
    assert request["temperature"] == 0.1
    assert request["messages"][0] == {
        "role": "system",
        "content": "You are the stock system's FOMC analyst.",
    }
    assert [tool["function"]["name"] for tool in request["tools"]] == ["web_search"]


@pytest.mark.asyncio
async def test_preset_tool_allowlist_blocks_python_debug_shortcut() -> None:
    settings = Settings(OPENROUTER_API_KEY=None)
    runtime = AgentRuntime(
        settings=settings,
        sessions=SessionStore(),
        skills=FakeSkills(),
        mcp=FakeMcp(),
        tools=TwoToolProvider(),
        llm=OpenAIChatClient(settings),
    )

    events = [
        item
        async for item in runtime.run(
            "preset-no-tools",
            "/python print(1)",
            allowed_tool_names=set(),
        )
    ]

    assert all(item.type != "tool.started" for item in events)
    request = next(item for item in events if item.type == "llm.request")
    assert request.data["request"]["tools"] is None


def test_default_chat_rejects_a_preset_bound_session(monkeypatch) -> None:
    from app.api import chat

    store = PresetAgentStore()
    agent = store.create(**_definition())
    store.bind_session("preset-session", agent.id)
    monkeypatch.setattr(chat, "get_preset_agent_store", lambda: store)
    app = FastAPI()
    app.include_router(chat.router)
    client = TestClient(app)

    response = client.post(
        "/api/chat",
        json={"message": "Continue with the default agent", "session_id": "preset-session"},
    )

    assert response.status_code == 409
    assert "belongs to a preset agent" in response.json()["detail"]


def test_session_history_includes_preset_agent_identity(monkeypatch) -> None:
    from app.api import sessions as sessions_api

    preset_store = PresetAgentStore()
    agent = preset_store.create(**_definition())
    preset_store.bind_session("preset-session", agent.id)
    session_store = SessionStore()
    session_store.append("preset-session", {"role": "user", "content": "FOMC dates"})
    monkeypatch.setattr(sessions_api, "get_preset_agent_store", lambda: preset_store)
    monkeypatch.setattr(sessions_api, "get_session_store", lambda: session_store)
    app = FastAPI()
    app.include_router(sessions_api.router)
    client = TestClient(app)

    response = client.get("/api/sessions")

    assert response.status_code == 200
    assert response.json()["sessions"][0]["preset_agent"] == {
        "id": agent.id,
        "name": "fomc-brief",
        "description": "FOMC summary agent",
        "ghost": "📈",
        "model": "deepseek/deepseek-v4-flash",
        "tool_count": 1,
        "deleted": False,
    }
