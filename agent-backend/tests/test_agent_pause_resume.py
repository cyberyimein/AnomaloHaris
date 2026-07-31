import asyncio

import pytest
from app.agent.events import AgentEvent
from app.agent.runtime import AgentRuntime
from app.agent.session import SessionStore
from app.config import Settings
from app.llm.openai_client import LLMStreamEvent, LLMToolCall
from app.tools.base import ToolResult


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


class FakeTools:
    async def openai_tools(self, context):
        del context
        return []

    async def call_tool(self, name, arguments, *, context):
        del arguments, context
        return ToolResult(name=name, content="done")


class BlockingTextLlm:
    def __init__(self) -> None:
        self.started = asyncio.Event()

    def request_payload(self, messages, tools):
        return {"messages": messages, "tools": tools}

    async def stream_chat(self, messages, tools):
        del messages, tools
        self.started.set()
        yield LLMStreamEvent(type="message.delta", content="partial")
        await asyncio.Event().wait()


class BlockingToolProvider(FakeTools):
    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def call_tool(self, name, arguments, *, context):
        del arguments, context
        self.started.set()
        await asyncio.Event().wait()
        return ToolResult(name=name, content="unexpected")


class ResumeLlm:
    def __init__(self) -> None:
        self.calls = 0
        self.tool_started = asyncio.Event()

    def request_payload(self, messages, tools):
        return {"messages": messages, "tools": tools}

    async def stream_chat(self, messages, tools):
        del tools
        self.calls += 1
        if self.calls == 1:
            yield LLMStreamEvent(
                type="tool_calls",
                tool_calls=[
                    LLMToolCall(
                        id="call-slow",
                        name="slow_tool",
                        arguments={"value": 1},
                    )
                ],
            )
            await asyncio.Event().wait()
            return

        assert any(
            message.get("role") == "tool"
            and message.get("tool_call_id") == "call-slow"
            and "[recovery]" in message.get("content", "")
            for message in messages
        )
        yield LLMStreamEvent(type="message.delta", content="resumed")
        yield LLMStreamEvent(type="message.done")


class FailingLlm:
    def request_payload(self, messages, tools):
        return {"messages": messages, "tools": tools}

    async def stream_chat(self, messages, tools):
        del messages, tools
        if False:
            yield LLMStreamEvent(type="message.done")
        raise RuntimeError("temporary model failure")


def make_runtime(llm, tools=None):
    return AgentRuntime(
        settings=Settings(MAX_TOOL_ITERATIONS=3),
        sessions=SessionStore(),
        skills=FakeSkills(),
        mcp=FakeMcp(),
        tools=tools or FakeTools(),
        llm=llm,
    )


async def consume(stream, events):
    async for item in stream:
        assert isinstance(item, AgentEvent)
        events.append(item)


@pytest.mark.asyncio
async def test_stop_saves_partial_assistant_context_for_the_session() -> None:
    llm = BlockingTextLlm()
    runtime = make_runtime(llm)
    events: list[AgentEvent] = []
    task = asyncio.create_task(consume(runtime.run("session-1", "do work"), events))

    await llm.started.wait()
    runtime.request_stop("session-1")
    task.cancel()
    await task

    assert events[-1].type == "run.stopped"
    checkpoint = runtime.sessions.get_checkpoint("session-1")
    assert checkpoint is not None
    assert checkpoint.messages[-1] == {"role": "assistant", "content": "partial"}
    assert checkpoint.reason == "user_stop"


@pytest.mark.asyncio
async def test_stop_repairs_an_interrupted_tool_call_and_resume_reuses_it() -> None:
    llm = ResumeLlm()
    tools = BlockingToolProvider()
    runtime = make_runtime(llm, tools)
    events: list[AgentEvent] = []
    task = asyncio.create_task(consume(runtime.run("session-2", "use the tool"), events))

    await tools.started.wait()
    runtime.request_stop("session-2")
    task.cancel()
    await task

    checkpoint = runtime.sessions.get_checkpoint("session-2")
    assert checkpoint is not None
    assistant = next(message for message in checkpoint.messages if message.get("tool_calls"))
    recovery = next(
        message
        for message in checkpoint.messages
        if message.get("role") == "tool" and message.get("tool_call_id") == "call-slow"
    )
    assert assistant["tool_calls"][0]["id"] == "call-slow"
    assert "[recovery]" in recovery["content"]

    resumed_events = [item async for item in runtime.run("session-2", resume=True)]

    assert resumed_events[0].type == "run.started"
    assert resumed_events[0].data["resumed"] is True
    assert resumed_events[-1].type == "run.finished"
    assert resumed_events[-1].data["final_text"] == "resumed"
    assert runtime.sessions.get_checkpoint("session-2") is None


@pytest.mark.asyncio
async def test_failed_resume_keeps_checkpoint_available_for_retry() -> None:
    runtime = make_runtime(FailingLlm())
    runtime.sessions.save_checkpoint(
        "session-3",
        [{"role": "user", "content": "unfinished work"}],
        run_id="paused-run",
        prompt_profile="agent",
        user_content="unfinished work",
        iteration=1,
    )

    events = [item async for item in runtime.run("session-3", resume=True)]

    assert events[-1].type == "run.error"
    assert events[-1].data["can_resume"] is True
    checkpoint = runtime.sessions.get_checkpoint("session-3")
    assert checkpoint is not None
    assert checkpoint.run_id == "paused-run"


@pytest.mark.asyncio
async def test_new_message_does_not_consume_a_paused_checkpoint() -> None:
    runtime = make_runtime(ResumeLlm())
    runtime.sessions.save_checkpoint(
        "session-4",
        [{"role": "user", "content": "unfinished work"}],
        run_id="paused-run",
        prompt_profile="agent",
        user_content="unfinished work",
        iteration=1,
    )

    events = [item async for item in runtime.run("session-4", "start something else")]

    assert events[-1].type == "run.error"
    assert events[-1].data["can_resume"] is True
    assert runtime.sessions.get_checkpoint("session-4") is not None
