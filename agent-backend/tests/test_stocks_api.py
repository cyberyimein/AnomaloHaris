from datetime import UTC, datetime
from types import SimpleNamespace

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
    monkeypatch.setattr(stocks, "_read_persisted_report", lambda: None)
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


def test_stock_scan_runs_integrated_workflow_and_publishes(monkeypatch) -> None:
    _reset_stock_report()
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    monkeypatch.setattr(
        stocks,
        "_run_integrated_scan",
        lambda: {
            "generated_at": "2026-07-14T14:00:00+00:00",
            "data_mode": "mock",
            "market_session": {"name": "premarket"},
            "market_context": {"regime": "risk_on"},
            "warnings": [],
            "stocks": [{"symbol": "US.NVDA", "attention_score": 81.0}],
        },
    )
    monkeypatch.setattr(
        "app.api.security.get_settings",
        lambda: SimpleNamespace(admin_token="stock-secret"),
    )
    client = TestClient(create_app())

    denied_response = client.post("/api/stocks/scan")
    scan_response = client.post(
        "/api/stocks/scan",
        headers={"X-Anomalo-Admin-Token": "stock-secret"},
    )
    latest_response = client.get("/api/stocks/reports/latest")

    assert denied_response.status_code == 403
    assert scan_response.status_code == 200
    assert scan_response.json()["status"] == "accepted"
    assert scan_response.json()["scan"]["top_symbols"] == ["US.NVDA"]
    assert latest_response.json()["report"]["data_mode"] == "mock"
    assert latest_response.json()["report"]["stocks"][0]["symbol"] == "US.NVDA"


def test_next_stock_scan_uses_tokyo_2200() -> None:
    before_run = datetime(2026, 7, 14, 12, 0, tzinfo=UTC)
    after_run = datetime(2026, 7, 14, 14, 0, tzinfo=UTC)

    same_day = stocks._next_scheduled_run(
        before_run,
        timezone_name="Asia/Tokyo",
        hour=22,
        minute=0,
    )
    next_day = stocks._next_scheduled_run(
        after_run,
        timezone_name="Asia/Tokyo",
        hour=22,
        minute=0,
    )

    assert same_day.isoformat() == "2026-07-14T22:00:00+09:00"
    assert next_day.isoformat() == "2026-07-15T22:00:00+09:00"
