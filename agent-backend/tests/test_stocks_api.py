from app.api import stocks
from app.main import create_app
from fastapi.testclient import TestClient


class FakeBuddyGateway:
    def connect(self) -> dict[str, object]:
        return {"connected": False}

    def disconnect(self) -> dict[str, object]:
        return {"connected": False}


class FakeBuddyAudioBridge:
    def start(self) -> None:
        return

    def stop(self) -> None:
        return


def _reset_stock_report() -> None:
    stocks._latest_report = None
    stocks._latest_received_at = None


def test_stock_report_latest_is_empty_before_ingest(monkeypatch) -> None:
    _reset_stock_report()
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    client = TestClient(create_app())

    response = client.get("/api/stocks/reports/latest")

    assert response.status_code == 200
    assert response.json() == {
        "status": "empty",
        "received_at": None,
        "report": None,
    }


def test_stock_report_ingest_and_latest(monkeypatch) -> None:
    _reset_stock_report()
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    client = TestClient(create_app())
    report = {
        "generated_at": "2026-07-08T14:24:56.504343+00:00",
        "data_mode": "opend",
        "warnings": [],
        "stocks": [
            {
                "symbol": "US.MRVL",
                "attention_score": 66.7,
            }
        ],
    }

    ingest_response = client.post("/api/stocks/reports", json=report)
    latest_response = client.get("/api/stocks/reports/latest")

    assert ingest_response.status_code == 201
    assert ingest_response.json()["status"] == "accepted"
    assert ingest_response.json()["stock_count"] == 1
    assert latest_response.status_code == 200
    latest_payload = latest_response.json()
    assert latest_payload["status"] == "ready"
    assert latest_payload["report"] == report
