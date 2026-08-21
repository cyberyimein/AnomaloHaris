import asyncio
from types import SimpleNamespace

import pytest
from app.agent.context import ContextBuilder, ContextRequest
from app.agent.controller import RunController
from app.config import Settings


class FakeSessions:
    def get_active_skills(self, session_id):
        assert session_id == "session-1"
        return {"calculator"}

    def get_active_mcp_servers(self, session_id):
        assert session_id == "session-1"
        return {"local"}


class FakeSkills:
    def skill_catalog_message(self):
        return {"role": "system", "content": "skill catalog"}

    def build_active_skill_messages(self, names):
        assert names == {"calculator"}
        return [{"role": "system", "content": "active skill"}]


class FakeMcp:
    def catalog_message(self):
        return {"role": "system", "content": "mcp catalog"}

    def build_active_server_messages(self, names):
        assert names == {"local"}
        return [{"role": "system", "content": "active mcp"}]


class FakeTools:
    async def openai_tools(self, context):
        assert context.active_skills == {"calculator"}
        assert context.active_mcp_servers == {"local"}
        return [
            {"type": "function", "function": {"name": "allowed"}},
            {"type": "function", "function": {"name": "blocked"}},
        ]


class MutableSessions:
    def __init__(self) -> None:
        self.active_skills = {"calculator"}
        self.active_mcp_servers = {"local"}

    def get_active_skills(self, session_id):
        return self.active_skills

    def get_active_mcp_servers(self, session_id):
        return self.active_mcp_servers


class MutableSkills:
    def __init__(self) -> None:
        self.catalog = "skill catalog v1"
        self.active = "active skill v1"

    def skill_catalog_message(self):
        return {"role": "system", "content": self.catalog}

    def build_active_skill_messages(self, names):
        return [{"role": "system", "content": self.active}]


class MutableMcp:
    def __init__(self) -> None:
        self.catalog = "mcp catalog v1"
        self.active = "active mcp v1"

    def catalog_message(self):
        return {"role": "system", "content": self.catalog}

    def build_active_server_messages(self, names):
        return [{"role": "system", "content": self.active}]


class MutableTools:
    def __init__(self) -> None:
        self.tool_name = "tool-v1"

    async def openai_tools(self, context):
        return [{"type": "function", "function": {"name": self.tool_name}}]


@pytest.mark.asyncio
async def test_context_builder_preserves_order_and_filters_tools(tmp_path) -> None:
    settings = Settings(_env_file=None, WEB_TOOLS_ENABLED=False)
    settings.config_dir = tmp_path
    (tmp_path / "prompts.yaml").write_text(
        "version: 1\n"
        "profiles:\n"
        "  agent:\n"
        "    messages:\n"
        "      - role: system\n"
        "        content: profile\n",
        encoding="utf-8",
    )
    (tmp_path / "AGENTS.md").write_text("memory", encoding="utf-8")
    builder = ContextBuilder(settings, FakeSessions(), FakeSkills(), FakeMcp(), FakeTools())
    bootstrap_content = (
        "Authoritative runtime context captured at the start of this run. "
        'Use these values directly; do not call a tool to rediscover them:\n'
        '[{"key":"clock","result":"09:00"}]'
    )

    built = await builder.build(
        ContextRequest(
            session_id="session-1",
            prompt_profile="agent",
            system_prompt=None,
            search_mode="diy",
            model="replay-model",
            allowed_tool_names=frozenset({"allowed"}),
            bootstrap_context=[{"key": "clock", "result": "09:00"}],
            history_messages=[{"role": "user", "content": "history"}],
            current_user_message={"role": "user", "content": "current"},
            loop_messages=[{"role": "assistant", "content": "loop"}],
        )
    )

    assert [message["content"] for message in built.messages] == [
        "profile",
        bootstrap_content,
        "Agent memory from AGENTS.md:\n\nmemory",
        "skill catalog",
        "active skill",
        "mcp catalog",
        "active mcp",
        "history",
        "current",
        "loop",
    ]
    assert [tool["function"]["name"] for tool in built.tools] == ["allowed"]
    assert built.diagnostics["segments"][0]["name"] == "prompt_profile"
    assert built.diagnostics["segments"][-1]["name"] == "tool_loop_transcript"


@pytest.mark.asyncio
async def test_context_snapshot_freezes_resources_and_tools_for_one_run(tmp_path) -> None:
    settings = Settings(_env_file=None, WEB_TOOLS_ENABLED=False)
    settings.config_dir = tmp_path
    prompt_path = tmp_path / "prompts.yaml"
    prompt_path.write_text(
        "version: 1\n"
        "profiles:\n"
        "  agent:\n"
        "    messages:\n"
        "      - role: system\n"
        "        content: profile v1\n",
        encoding="utf-8",
    )
    (tmp_path / "AGENTS.md").write_text("memory v1", encoding="utf-8")
    sessions = MutableSessions()
    skills = MutableSkills()
    mcp = MutableMcp()
    tools = MutableTools()
    builder = ContextBuilder(settings, sessions, skills, mcp, tools)
    request = ContextRequest(
        session_id="session-1",
        prompt_profile="agent",
        system_prompt=None,
        search_mode="diy",
        model="replay-model",
        allowed_tool_names=None,
        bootstrap_context=[],
        history_messages=[],
        current_user_message={"role": "user", "content": "current"},
        loop_messages=[],
    )

    snapshot = await builder.prepare(request)
    prompt_path.write_text(
        "version: 1\n"
        "profiles:\n"
        "  agent:\n"
        "    messages:\n"
        "      - role: system\n"
        "        content: profile v2\n",
        encoding="utf-8",
    )
    (tmp_path / "AGENTS.md").write_text("memory v2", encoding="utf-8")
    sessions.active_skills = {"changed"}
    sessions.active_mcp_servers = {"changed"}
    skills.catalog = "skill catalog v2"
    skills.active = "active skill v2"
    mcp.catalog = "mcp catalog v2"
    mcp.active = "active mcp v2"
    tools.tool_name = "tool-v2"

    first = snapshot.render([])
    second = snapshot.render([{"role": "tool", "content": "loop"}])

    assert [message["content"] for message in first.messages] == [
        "profile v1",
        "Agent memory from AGENTS.md:\n\nmemory v1",
        "skill catalog v1",
        "active skill v1",
        "mcp catalog v1",
        "active mcp v1",
        "current",
    ]
    assert [tool["function"]["name"] for tool in first.tools] == ["tool-v1"]
    assert [message["content"] for message in second.messages][-1] == "loop"
    assert second.diagnostics["total_message_count"] == len(second.messages)
    assert second.diagnostics["tool_count"] == 1


def test_run_controller_enforces_one_active_run_and_idempotent_release() -> None:
    controller = RunController()
    first = SimpleNamespace(run_id="run-1", stop_requested=False, stop_reason="stopped")
    second = SimpleNamespace(run_id="run-2", stop_requested=False, stop_reason="stopped")

    assert controller.claim("session-1", first) is True
    assert controller.claim("session-1", second) is False
    assert controller.request_stop("session-1") == "run-1"
    assert first.stop_requested is True
    assert first.stop_reason == "user_stop"
    assert controller.request_stop("missing") is None
    controller.release("session-1", second)
    assert controller.is_active("session-1") is True
    controller.release("session-1", first)
    controller.release("session-1", first)
    assert controller.is_active("session-1") is False


@pytest.mark.asyncio
async def test_run_controller_stop_reason_can_be_set_by_disconnect() -> None:
    controller = RunController()
    state = SimpleNamespace(run_id="run-1", stop_requested=False, stop_reason="stopped")
    controller.claim("session-1", state)

    await asyncio.sleep(0)
    assert controller.request_stop("session-1", reason="disconnect") == "run-1"
    assert state.stop_reason == "disconnect"
