from types import SimpleNamespace

from app.api.security import require_management_access
from app.main import create_app
from fastapi.testclient import TestClient


class FakeBuddyGateway:
    def __init__(self) -> None:
        self.connected = True
        self.state_calls: list[tuple[str, str | None]] = []
        self.approval_calls: list[tuple[str, str, float]] = []
        self.approval_choice = "approve"

    def connect(self) -> dict[str, object]:
        return {"connected": self.connected}

    def disconnect(self) -> dict[str, object]:
        return {"connected": self.connected}

    def is_connected(self) -> bool:
        return self.connected

    def set_state(self, state: str, text: str | None = None) -> dict[str, object]:
        self.state_calls.append((state, text))
        return {"state": state, "text": text, "connected": self.connected}

    def request_approval(
        self,
        request_id: str,
        text: str,
        *,
        timeout_seconds: float = 30.0,
    ) -> dict[str, object]:
        self.approval_calls.append((request_id, text, timeout_seconds))
        return {
            "type": "approval.response",
            "payload": {"id": request_id, "choice": self.approval_choice},
        }


class FakeBuddyAudioBridge:
    def start(self) -> None:
        return

    def stop(self) -> None:
        return


def _client(
    monkeypatch,
    gateway: FakeBuddyGateway,
    *,
    permission_bridge_enabled: bool = False,
) -> TestClient:
    monkeypatch.setattr("buddy_backend.copilot_api.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr(
        "buddy_backend.copilot_api.get_settings",
        lambda: SimpleNamespace(
            copilot_buddy_approval_timeout_seconds=90.0,
            copilot_buddy_permission_bridge_enabled=permission_bridge_enabled,
        ),
    )
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    app = create_app()
    app.dependency_overrides[require_management_access] = lambda: None
    return TestClient(app)


def test_user_prompt_submitted_sets_buddy_coding_state(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    client = _client(monkeypatch, gateway)

    response = client.post(
        "/api/copilot/hooks/userPromptSubmitted",
        json={"sessionId": "session-1", "prompt": "Check the flaky integration test"},
    )

    assert response.status_code == 200
    assert response.json() == {}
    assert gateway.state_calls == [("coding", "Check the flaky integration test")]


def test_pre_tool_use_restores_coding_state(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    client = _client(monkeypatch, gateway)

    response = client.post(
        "/api/copilot/hooks/preToolUse",
        json={
            "sessionId": "session-1",
            "timestamp": 1234,
            "toolName": "bash",
            "toolArgs": {"command": "pytest -q buddy-backend/tests/test_buddy_api.py"},
        },
    )

    assert response.status_code == 200
    assert response.json() == {}
    assert gateway.state_calls == [
        ("coding", "bash: pytest -q buddy-backend/tests/test_buddy_api.py")
    ]


def test_post_tool_use_clears_approval_state(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    client = _client(monkeypatch, gateway)

    response = client.post(
        "/api/copilot/hooks/PostToolUse",
        json={"session_id": "session-1", "tool_name": "exec_command"},
    )

    assert response.status_code == 200
    assert response.json() == {}
    assert gateway.state_calls == [("coding", "exec_command complete")]


def test_notification_permission_prompt_sets_approval_state(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    client = _client(monkeypatch, gateway)

    response = client.post(
        "/api/copilot/hooks/notification",
        json={
            "sessionId": "session-1",
            "notification_type": "permission_prompt",
            "title": "Permission needed",
            "message": "Copilot wants to run bash",
        },
    )

    assert response.status_code == 200
    assert response.json() == {}
    assert gateway.state_calls == [("approval", "Permission needed")]


def test_permission_request_does_not_bridge_by_default(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    client = _client(monkeypatch, gateway)

    response = client.post(
        "/api/copilot/hooks/permissionRequest",
        json={"sessionId": "session-1", "toolName": "bash", "toolArgs": {"command": "pwd"}},
    )

    assert response.status_code == 200
    assert response.json() == {}
    assert gateway.approval_calls == []
    assert gateway.state_calls == [("approval", "Allow bash: pwd")]


def test_permission_request_uses_buddy_approval_when_bridge_enabled(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    client = _client(monkeypatch, gateway, permission_bridge_enabled=True)

    response = client.post(
        "/api/copilot/hooks/permissionRequest",
        json={
            "sessionId": "session-1",
            "timestamp": 1234,
            "toolName": "bash",
            "toolArgs": {"command": "pytest -q buddy-backend/tests/test_buddy_api.py"},
        },
    )

    assert response.status_code == 200
    assert response.json() == {"behavior": "allow"}
    assert (
        gateway.approval_calls[0][1]
        == "Allow bash: pytest -q buddy-backend/tests/test_buddy_api.py"
    )
    assert gateway.approval_calls[0][2] == 90.0
    assert gateway.state_calls[-1] == ("coding", "continuing")


def test_permission_request_denial_is_returned_to_copilot(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    gateway.approval_choice = "deny"
    client = _client(monkeypatch, gateway, permission_bridge_enabled=True)

    response = client.post(
        "/api/copilot/hooks/permissionRequest",
        json={"sessionId": "session-1", "toolName": "edit", "toolArgs": {"path": "app/main.py"}},
    )

    assert response.status_code == 200
    assert response.json() == {
        "behavior": "deny",
        "message": "Buddy denied the permission request.",
    }
    assert gateway.approval_calls[0][1] == "Allow edit: app/main.py"
    assert gateway.state_calls[-1] == ("done", "denied")


def test_disconnected_buddy_falls_back_to_normal_permission_flow(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    gateway.connected = False
    client = _client(monkeypatch, gateway, permission_bridge_enabled=True)

    response = client.post(
        "/api/copilot/hooks/permissionRequest",
        json={"sessionId": "session-1", "toolName": "bash", "toolArgs": {"command": "pwd"}},
    )

    assert response.status_code == 200
    assert response.json() == {}
    assert gateway.approval_calls == []


def test_error_and_session_end_update_buddy_state(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    client = _client(monkeypatch, gateway)

    error_response = client.post(
        "/api/copilot/hooks/errorOccurred",
        json={"error": {"message": "model timed out"}},
    )
    session_end_response = client.post(
        "/api/copilot/hooks/sessionEnd",
        json={"reason": "user_exit"},
    )

    assert error_response.status_code == 200
    assert session_end_response.status_code == 200
    assert gateway.state_calls == [("error", "model timed out"), ("idle", "user exit")]
