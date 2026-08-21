import pytest
from app.agent.events import AgentEvent
from app.agent.replay import (
    DeterministicToolProvider,
    ReplayModel,
    ReplayStep,
    replay_tool_call,
)
from app.agent.runtime import AgentRuntime
from app.agent.session import SessionStore
from app.config import Settings
from app.llm.openai_client import LLMStreamEvent
from app.tools.base import ToolSpec
from app.tools.registry import ToolRegistry


class EmptySkills:
    def skill_catalog_message(self):
        return None

    def build_active_skill_messages(self, names):
        del names
        return []


class EmptyMcp:
    def catalog_message(self):
        return None

    def build_active_server_messages(self, names):
        del names
        return []


@pytest.mark.asyncio
async def test_replay_model_and_deterministic_tool_produce_a_stable_contract_sequence() -> None:
    provider = DeterministicToolProvider(
        definitions=[
            ToolSpec(
                name="deterministic_echo",
                description="Echo a deterministic value.",
                source="test",
            )
        ],
        handlers={"deterministic_echo": lambda arguments, _context: arguments["value"]},
    )
    llm = ReplayModel(
        [
            ReplayStep.from_events(
                [replay_tool_call("call-1", "deterministic_echo", {"value": "ok"})]
            ),
            ReplayStep.from_events(
                [
                    LLMStreamEvent(type="message.delta", content="Tool result received."),
                    LLMStreamEvent(type="message.done"),
                ]
            ),
        ]
    )
    runtime = AgentRuntime(
        settings=Settings(MAX_TOOL_ITERATIONS=3),
        sessions=SessionStore(),
        skills=EmptySkills(),
        mcp=EmptyMcp(),
        tools=ToolRegistry([provider]),
        llm=llm,
    )

    events = [item async for item in runtime.run("replay-session", "use the tool")]

    assert all(isinstance(item, AgentEvent) for item in events)
    assert [item.type for item in events] == [
        "run.started",
        "llm.request",
        "tool.started",
        "tool.finished",
        "llm.request",
        "message.delta",
        "message.done",
        "run.finished",
    ]
    assert provider.calls[0]["arguments"] == {"value": "ok"}
    assert events[-1].data["final_text"] == "Tool result received."
