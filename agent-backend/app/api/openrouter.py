import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import APIRouter, Query

from app.config import get_settings

router = APIRouter(prefix="/api/openrouter", tags=["openrouter"])


@dataclass
class CreditsCache:
    payload: dict[str, Any]
    expires_at: float


_credits_cache: CreditsCache | None = None
_credits_fetch_lock = asyncio.Lock()


@router.get("/credits")
async def openrouter_credits(force: bool = Query(default=False)) -> dict[str, Any]:
    settings = get_settings()
    api_key = settings.openrouter_management_api_key
    if not api_key:
        return {
            "status": "config_missing",
            "configured": False,
            "message": "Set OPENROUTER_MANAGEMENT_API_KEY to show OpenRouter credits.",
        }

    cached = _fresh_cached_credits()
    if cached is not None and not force:
        return {**cached, "cached": True}

    async with _credits_fetch_lock:
        cached = _fresh_cached_credits()
        if cached is not None and not force:
            return {**cached, "cached": True}

        try:
            payload = await _fetch_openrouter_credits(api_key)
        except (httpx.HTTPError, ValueError) as exc:
            if _credits_cache is not None:
                return {
                    **_credits_cache.payload,
                    "status": "stale",
                    "cached": True,
                    "message": f"Credit refresh failed: {exc}",
                }
            return {
                "status": "error",
                "configured": True,
                "message": f"Credit refresh failed: {exc}",
            }

    return _store_credits(payload, max(settings.openrouter_credits_cache_seconds, 0))


async def _fetch_openrouter_credits(api_key: str) -> dict[str, Any]:
    settings = get_settings()
    url = f"{settings.openai_base_url.rstrip('/')}/credits"
    async with httpx.AsyncClient(timeout=settings.openrouter_credits_timeout_seconds) as client:
        response = await client.get(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
        )
        response.raise_for_status()
        raw_payload = response.json()

    data = raw_payload.get("data", raw_payload)
    if not isinstance(data, dict):
        raise ValueError("OpenRouter credits response did not include an object payload.")

    total_credits = _number_or_none(data.get("total_credits"))
    total_usage = _number_or_none(data.get("total_usage"))
    remaining_credits = (
        max(total_credits - total_usage, 0.0)
        if total_credits is not None and total_usage is not None
        else None
    )

    return {
        "status": "ready",
        "configured": True,
        "currency": "USD",
        "total_credits": total_credits,
        "total_usage": total_usage,
        "remaining_credits": remaining_credits,
        "updated_at": datetime.now(UTC).isoformat(),
    }


def _fresh_cached_credits() -> dict[str, Any] | None:
    if _credits_cache is None or time.monotonic() >= _credits_cache.expires_at:
        return None
    return _credits_cache.payload


def _store_credits(payload: dict[str, Any], cache_seconds: int) -> dict[str, Any]:
    global _credits_cache

    result = {**payload, "cached": False}
    _credits_cache = CreditsCache(
        payload=payload,
        expires_at=time.monotonic() + cache_seconds,
    )
    return result


def _number_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
