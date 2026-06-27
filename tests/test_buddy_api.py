from fastapi.testclient import TestClient

from app.api.security import require_management_access
from app.main import create_app


class FakeBuddyGateway:
    def __init__(self) -> None:
        self.connected = False

    def status(self) -> dict[str, object]:
        return {
            "connected": self.connected,
            "port": "/dev/tty.usbmodem2101" if self.connected else None,
            "available_ports": ["/dev/tty.usbmodem2101"],
        }

    def connect(
        self,
        *,
        transport: str | None = None,
        port: str | None = None,
        baud_rate: int | None = None,
        tcp_host: str | None = None,
        tcp_port: int | None = None,
        tcp_client_ip: str | None = None,
    ) -> dict[str, object]:
        del transport, port, baud_rate, tcp_host, tcp_port, tcp_client_ip
        self.connected = True
        return self.status()

    def disconnect(self) -> dict[str, object]:
        self.connected = False
        return self.status()

    def get_events(
        self,
        *,
        after_id: int | None = None,
        limit: int = 50,
    ) -> list[dict[str, object]]:
        del after_id, limit
        return [{"id": 1, "type": "touch.click", "payload": {"action": "listen_start"}}]

    def send_raw_command(self, command: str) -> dict[str, object]:
        return {"command": command, "connected": self.connected}

    def set_state(self, state: str, text: str | None = None) -> dict[str, object]:
        return {"state": state, "text": text, "connected": self.connected}

    def request_approval(
        self,
        request_id: str,
        text: str,
        *,
        timeout_seconds: float = 30.0,
    ) -> dict[str, object]:
        del text, timeout_seconds
        return {
            "id": 3,
            "type": "approval.response",
            "payload": {"id": request_id, "choice": "approve", "method": "tap"},
        }


class FakeBuddyAudioBridge:
    def start(self) -> None:
        return

    def stop(self) -> None:
        return


def test_buddy_connect_and_status_endpoints(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    monkeypatch.setattr("app.api.buddy.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    app = create_app()
    app.dependency_overrides[require_management_access] = lambda: None
    client = TestClient(app)

    connect_response = client.post("/api/buddy/connect")
    assert connect_response.status_code == 200
    assert connect_response.json()["connected"] is True

    status_response = client.get("/api/buddy/status")
    assert status_response.status_code == 200
    assert status_response.json()["connected"] is True


def test_buddy_connect_endpoint_accepts_tcp_config(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    monkeypatch.setattr("app.api.buddy.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    app = create_app()
    app.dependency_overrides[require_management_access] = lambda: None
    client = TestClient(app)

    response = client.post(
        "/api/buddy/connect",
        json={"transport": "tcp", "tcp_port": 8787, "tcp_client_ip": "192.168.31.78"},
    )

    assert response.status_code == 200


def test_buddy_state_and_approval_endpoints(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    gateway.connected = True
    monkeypatch.setattr("app.api.buddy.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    app = create_app()
    app.dependency_overrides[require_management_access] = lambda: None
    client = TestClient(app)

    state_response = client.post(
        "/api/buddy/state",
        json={"state": "thinking", "text": "asking model"},
    )
    assert state_response.status_code == 200
    assert state_response.json()["state"] == "thinking"

    approval_response = client.post(
        "/api/buddy/approval",
        json={"request_id": "codex-42", "text": "Approve shell command?"},
    )
    assert approval_response.status_code == 200
    assert approval_response.json()["payload"]["choice"] == "approve"


def test_buddy_events_endpoint(monkeypatch) -> None:
    gateway = FakeBuddyGateway()
    monkeypatch.setattr("app.api.buddy.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    app = create_app()
    app.dependency_overrides[require_management_access] = lambda: None
    client = TestClient(app)

    response = client.get("/api/buddy/events")

    assert response.status_code == 200
    assert response.json()["events"][0]["type"] == "touch.click"
