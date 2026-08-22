from app import worker
from app.tools.base import ToolResult, ToolSpec
from fastapi.testclient import TestClient


class FakeRegistry:
    async def list_tools(self, *, context):
        assert context.session_id == "session-1"
        return [ToolSpec(name="python_echo", description="Echo", source="test")]

    async def call_tool(self, name, arguments, *, context):
        return ToolResult(
            name=name,
            content=str(arguments.get("value") or ""),
            data={"session": context.session_id},
        )

    async def status(self, *, context):
        return [{"provider": "fake", "tools": []}]


def test_worker_auth_and_tool_contract(monkeypatch) -> None:
    monkeypatch.setenv("ANOMALO_PYTHON_WORKER_TOKEN", "worker-token")
    monkeypatch.setattr(worker, "get_tool_registry", lambda: FakeRegistry())
    client = TestClient(worker.app)
    headers = {"x-anomalo-worker-token": "worker-token"}

    health = client.get("/internal/health", headers=headers)
    assert health.status_code == 200
    assert health.json()["runtime"] == "python-worker"

    listed = client.post(
        "/internal/tools/list",
        headers=headers,
        json={"context": {"session_id": "session-1"}},
    )
    assert listed.status_code == 200
    assert listed.json()["tools"][0]["name"] == "python_echo"

    called = client.post(
        "/internal/tools/call",
        headers=headers,
        json={
            "request_id": "request-1",
            "session_id": "session-1",
            "run_id": "run-1",
            "tool_call_id": "call-1",
            "tool": "python_echo",
            "arguments": {"value": "ok"},
        },
    )
    assert called.status_code == 200
    assert called.json()["result"] == {
        "name": "python_echo",
        "content": "ok",
        "ok": True,
        "data": {"session": "session-1"},
    }


def test_worker_rejects_missing_token(monkeypatch) -> None:
    monkeypatch.setenv("ANOMALO_PYTHON_WORKER_TOKEN", "worker-token")
    client = TestClient(worker.app)
    response = client.get("/internal/health")
    assert response.status_code == 401
