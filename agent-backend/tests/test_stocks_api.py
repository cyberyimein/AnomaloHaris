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
    stocks._latest_report_hash = None
    stocks._latest_revision = 0


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
        "revision": 0,
        "report_id": None,
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
    assert ingest_response.json()["changed"] is True
    assert ingest_response.json()["revision"] == 1
    assert ingest_response.json()["stock_count"] == 1
    assert ingest_response.headers["etag"]
    assert latest_response.status_code == 200
    latest_payload = latest_response.json()
    assert latest_payload["status"] == "ready"
    assert latest_payload["revision"] == 1
    assert latest_payload["report_id"] == ingest_response.json()["report_id"]
    assert latest_response.headers["etag"] == ingest_response.headers["etag"]
    assert latest_payload["report"] == report


def test_stock_report_ingest_is_idempotent_and_supports_etag(monkeypatch) -> None:
    _reset_stock_report()
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    client = TestClient(create_app())
    report = {
        "generated_at": "2026-07-11T04:12:17.504246+00:00",
        "data_mode": "opend",
        "methodology": {
            "output_contract_version": "2.2",
            "status": "heuristic_not_backtested",
        },
        "market_session": {"name": "closed", "label": "休市"},
        "market_context": {"regime": "risk_on"},
        "stocks": [{"symbol": "US.NVDA", "attention_score": 69.0}],
    }

    accepted = client.post("/api/stocks/reports", json=report)
    duplicate = client.post("/api/stocks/reports", json=report)
    unchanged = client.get(
        "/api/stocks/reports/latest",
        headers={"If-None-Match": accepted.headers["etag"]},
    )

    assert accepted.status_code == 201
    assert duplicate.status_code == 200
    assert duplicate.json()["status"] == "unchanged"
    assert duplicate.json()["changed"] is False
    assert duplicate.json()["revision"] == accepted.json()["revision"]
    assert duplicate.json()["report_id"] == accepted.json()["report_id"]
    assert unchanged.status_code == 304
    assert unchanged.content == b""
    assert unchanged.headers["etag"] == accepted.headers["etag"]


def test_stock_report_rejects_rows_without_symbols(monkeypatch) -> None:
    _reset_stock_report()
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    client = TestClient(create_app())

    response = client.post(
        "/api/stocks/reports",
        json={"generated_at": "2026-07-11T04:12:17.504246+00:00", "stocks": [{}]},
    )

    assert response.status_code == 422
