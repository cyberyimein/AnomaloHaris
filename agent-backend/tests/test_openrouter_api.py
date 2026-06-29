import asyncio
from types import SimpleNamespace

import pytest

from app.api import openrouter


def _reset_credit_state() -> None:
    openrouter._credits_cache = None
    openrouter._credits_fetch_lock = asyncio.Lock()


def _settings(**overrides: object) -> SimpleNamespace:
    values = {
        "openrouter_management_api_key": "management-key",
        "openrouter_credits_cache_seconds": 82800,
        "openrouter_credits_timeout_seconds": 8.0,
        "openai_base_url": "https://openrouter.ai/api/v1",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.mark.asyncio
async def test_openrouter_credits_reports_missing_management_key(monkeypatch) -> None:
    _reset_credit_state()
    monkeypatch.setattr(openrouter, "get_settings", lambda: _settings(openrouter_management_api_key=None))

    payload = await openrouter.openrouter_credits(False)

    assert payload["status"] == "config_missing"
    assert payload["configured"] is False


@pytest.mark.asyncio
async def test_openrouter_credits_uses_cached_payload(monkeypatch) -> None:
    _reset_credit_state()
    calls = 0

    async def fake_fetch(api_key: str) -> dict[str, object]:
        nonlocal calls
        calls += 1
        assert api_key == "management-key"
        return {
            "status": "ready",
            "configured": True,
            "remaining_credits": 12.5,
            "total_credits": 20.0,
            "total_usage": 7.5,
            "updated_at": "2026-06-29T00:00:00+00:00",
        }

    monkeypatch.setattr(openrouter, "get_settings", lambda: _settings())
    monkeypatch.setattr(openrouter, "_fetch_openrouter_credits", fake_fetch)

    first_payload = await openrouter.openrouter_credits(False)
    second_payload = await openrouter.openrouter_credits(False)

    assert calls == 1
    assert first_payload["cached"] is False
    assert second_payload["cached"] is True
    assert second_payload["remaining_credits"] == 12.5


@pytest.mark.asyncio
async def test_openrouter_credits_force_refresh_bypasses_cache(monkeypatch) -> None:
    _reset_credit_state()
    remaining_values = [12.5, 11.0]

    async def fake_fetch(api_key: str) -> dict[str, object]:
        del api_key
        remaining = remaining_values.pop(0)
        return {
            "status": "ready",
            "configured": True,
            "remaining_credits": remaining,
            "total_credits": 20.0,
            "total_usage": 20.0 - remaining,
            "updated_at": "2026-06-29T00:00:00+00:00",
        }

    monkeypatch.setattr(openrouter, "get_settings", lambda: _settings())
    monkeypatch.setattr(openrouter, "_fetch_openrouter_credits", fake_fetch)

    first_payload = await openrouter.openrouter_credits(False)
    forced_payload = await openrouter.openrouter_credits(True)

    assert first_payload["remaining_credits"] == 12.5
    assert forced_payload["cached"] is False
    assert forced_payload["remaining_credits"] == 11.0
