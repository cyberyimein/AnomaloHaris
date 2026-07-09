import pytest
from app.agent.runtime import AgentRuntime
from app.config import Settings
from app.tools.python_sandbox import PythonSandboxProvider


@pytest.mark.asyncio
async def test_python_sandbox_provider_hides_tool_when_disabled() -> None:
    provider = PythonSandboxProvider(Settings(PYTHON_SANDBOX_ENABLED=False))

    assert await provider.list_tools() == []

    status = await provider.status()
    assert status["enabled"] is False
    assert status["tools"] == []


@pytest.mark.asyncio
async def test_python_sandbox_provider_reports_disabled_call() -> None:
    provider = PythonSandboxProvider(Settings(PYTHON_SANDBOX_ENABLED=False))

    result = await provider.call_tool("sandbox_python_run", {"code": "print(1)"})

    assert result.ok is False
    assert result.content == "Python sandbox is disabled for this deployment."


@pytest.mark.asyncio
async def test_python_debug_command_does_not_call_disabled_sandbox() -> None:
    runtime = AgentRuntime(
        settings=Settings(PYTHON_SANDBOX_ENABLED=False),
        sessions=object(),  # type: ignore[arg-type]
        skills=object(),  # type: ignore[arg-type]
        mcp=object(),  # type: ignore[arg-type]
        tools=object(),  # type: ignore[arg-type]
        llm=object(),  # type: ignore[arg-type]
    )

    stream = await runtime._maybe_run_debug_command("session_1", "run_1", "/python print(1)")

    assert stream is not None
    events = [item async for item in stream]
    assert [item.type for item in events] == [
        "message.delta",
        "message.done",
        "run.finished",
    ]
    assert events[0].data["content"] == "Python sandbox is disabled for this deployment."
    assert events[-1].data["final_text"] == "Python sandbox is disabled for this deployment."
