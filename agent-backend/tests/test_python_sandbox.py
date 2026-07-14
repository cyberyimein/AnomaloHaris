import pytest
from app.agent.runtime import AgentRuntime
from app.config import Settings
from app.tools import python_sandbox
from app.tools.python_sandbox import HttpJsonResponse, PythonSandboxProvider


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
async def test_python_sandbox_provider_exposes_tool_when_fruitspy_ready(monkeypatch) -> None:
    def fake_request(
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, object] | None,
        timeout_seconds: float,
    ) -> HttpJsonResponse:
        del headers, body, timeout_seconds
        assert method == "GET"
        assert url == "http://fruitspy.test/api/v1/tools/python"
        return HttpJsonResponse(
            status_code=200,
            payload={"schema_version": 1, "ready": True, "state": "ready"},
            headers={},
            text='{"ready":true}',
        )

    monkeypatch.setattr(python_sandbox, "_http_json_request", fake_request)
    provider = PythonSandboxProvider(
        Settings(
            FRUITSPY_PYTHON_TOOL_BASE_URL="http://fruitspy.test",
            FRUITSPY_PYTHON_TOOL_TOKEN="token",
        )
    )

    tools = await provider.list_tools()

    assert [tool.name for tool in tools] == ["sandbox_python_run"]
    assert "timeout_ms" in tools[0].parameters["properties"]
    assert "artifacts" in tools[0].parameters["properties"]


@pytest.mark.asyncio
async def test_python_sandbox_provider_calls_fruitspy_execution(monkeypatch, tmp_path) -> None:
    calls: list[dict[str, object]] = []

    def fake_request(
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, object] | None,
        timeout_seconds: float,
    ) -> HttpJsonResponse:
        calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers,
                "body": body,
                "timeout_seconds": timeout_seconds,
            }
        )
        if method == "GET":
            return HttpJsonResponse(
                status_code=200,
                payload={"schema_version": 1, "ready": True, "state": "ready"},
                headers={},
                text='{"ready":true}',
            )
        return HttpJsonResponse(
            status_code=200,
            payload={
                "schema_version": 1,
                "request_id": "request-1",
                "execution_id": "py-1",
                "ok": True,
                "status": "succeeded",
                "exit_code": 0,
                "stdout": "45\n",
                "stderr": "",
                "content": "stdout:\n45\n",
                "truncated": {"stdout": False, "stderr": False},
                "duration_ms": 100,
                "image": "anomalo-python:latest",
                "artifacts": [
                    {
                        "name": "plot.png",
                        "media_type": "image/png",
                        "size_bytes": 7,
                        "download_url": (
                            "/api/v1/tools/python/executions/py-1/artifacts/plot.png"
                        ),
                    }
                ],
                "artifact_errors": [],
            },
            headers={},
            text='{"ok":true}',
        )

    monkeypatch.setattr(python_sandbox, "_http_json_request", fake_request)
    artifact_calls: list[dict[str, object]] = []

    def fake_artifact_request(
        url: str,
        headers: dict[str, str],
        timeout_seconds: float,
        max_bytes: int,
    ) -> bytes:
        artifact_calls.append(
            {
                "url": url,
                "headers": headers,
                "timeout_seconds": timeout_seconds,
                "max_bytes": max_bytes,
            }
        )
        return b"pngdata"

    monkeypatch.setattr(python_sandbox, "_http_bytes_request", fake_artifact_request)
    provider = PythonSandboxProvider(
        Settings(
            FRUITSPY_PYTHON_TOOL_BASE_URL="http://fruitspy.test",
            FRUITSPY_PYTHON_TOOL_TOKEN="token",
            artifacts_dir=tmp_path,
        )
    )

    result = await provider.call_tool(
        "sandbox_python_run",
        {
            "code": "print(sum(range(10)))",
            "timeout_ms": 5000,
            "artifacts": [{"path": "plot.png", "media_type": "image/png"}],
        },
    )

    assert result.ok is True
    assert result.content == "stdout:\n45\n"
    assert result.data["backend"] == "fruitspy"
    assert result.data["execution_id"] == "py-1"
    assert result.data["artifacts"] == [
        {
            "name": "plot.png",
            "media_type": "image/png",
            "size_bytes": 7,
            "url": "/api/artifacts/python/py-1/plot.png",
        }
    ]
    assert (tmp_path / "python" / "py-1" / "plot.png").read_bytes() == b"pngdata"
    assert artifact_calls[0]["url"] == (
        "http://fruitspy.test/api/v1/tools/python/executions/py-1/artifacts/plot.png"
    )
    assert artifact_calls[0]["headers"] == {
        "Authorization": "Bearer token",
        "Accept": "*/*",
    }
    assert calls[1]["method"] == "POST"
    assert calls[1]["url"] == "http://fruitspy.test/api/v1/tools/python/executions"
    assert calls[1]["body"] == {
        "code": "print(sum(range(10)))",
        "timeout_ms": 5000,
        "artifacts": [{"path": "plot.png", "media_type": "image/png"}],
    }
    headers = calls[1]["headers"]
    assert isinstance(headers, dict)
    assert headers["Authorization"] == "Bearer token"
    assert headers["Content-Type"] == "application/json"
    assert headers["Idempotency-Key"]


@pytest.mark.asyncio
async def test_python_sandbox_provider_reports_fruitspy_error(monkeypatch) -> None:
    def fake_request(
        method: str,
        url: str,
        headers: dict[str, str],
        body: dict[str, object] | None,
        timeout_seconds: float,
    ) -> HttpJsonResponse:
        del url, headers, body, timeout_seconds
        if method == "GET":
            return HttpJsonResponse(
                status_code=200,
                payload={"schema_version": 1, "ready": True, "state": "ready"},
                headers={},
                text='{"ready":true}',
            )
        return HttpJsonResponse(
            status_code=403,
            payload={
                "schema_version": 1,
                "error": {
                    "code": "loopback_required",
                    "message": "Python execution is only available over loopback",
                    "retryable": False,
                },
            },
            headers={},
            text='{"error":{"code":"loopback_required"}}',
        )

    monkeypatch.setattr(python_sandbox, "_http_json_request", fake_request)
    provider = PythonSandboxProvider(
        Settings(
            FRUITSPY_PYTHON_TOOL_BASE_URL="http://fruitspy.test",
            FRUITSPY_PYTHON_TOOL_TOKEN="token",
        )
    )

    result = await provider.call_tool("sandbox_python_run", {"code": "print(1)"})

    assert result.ok is False
    assert "loopback_required" in result.content
    assert result.data["http_status"] == 403


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
