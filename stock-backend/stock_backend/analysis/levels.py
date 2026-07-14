"""Nearest actionable support and resistance level extraction."""

from __future__ import annotations

from stock_backend.clients.moomoo_client import Bar


def calculate_levels(
    bars: list[Bar],
    reference_price: float | None = None,
    atr: float | None = None,
) -> dict:
    if len(bars) < 10:
        raise ValueError("At least 10 completed daily bars are required")

    latest = bars[-1]
    price = reference_price or latest.close
    recent = bars[-60:]
    recent_five = bars[-5:]
    recent_twenty = bars[-20:]
    candidates = [
        _candidate(latest.high, "yesterday_high", 3),
        _candidate(latest.low, "yesterday_low", 3),
        _candidate(max(bar.high for bar in recent_five), "recent_5d_high", 2),
        _candidate(min(bar.low for bar in recent_five), "recent_5d_low", 2),
        _candidate(max(bar.high for bar in recent_twenty), "recent_20d_high", 2),
        _candidate(min(bar.low for bar in recent_twenty), "recent_20d_low", 2),
        *_swing_candidates(recent),
    ]

    tolerance = max(price * 0.003, (atr or price * 0.02) * 0.10)
    merged = _merge_nearby(candidates, tolerance)
    half_width = min(max(price * 0.003, (atr or price * 0.02) * 0.12), price * 0.01)
    supports = sorted(
        (item for item in merged if item["price"] <= price),
        key=lambda item: item["price"],
        reverse=True,
    )
    support = supports[0] if supports else min(merged, key=lambda item: abs(item["price"] - price))
    all_resistances = sorted(
        (item for item in merged if item["price"] >= price), key=lambda item: item["price"]
    )
    resistances = [
        item for item in all_resistances if item["price"] - support["price"] > half_width * 2
    ]
    resistance = (
        resistances[0]
        if resistances
        else all_resistances[0]
        if all_resistances
        else max(merged, key=lambda item: item["price"])
    )

    return {
        "as_of_date": latest.date.isoformat(),
        "yesterday_high": latest.high,
        "yesterday_low": latest.low,
        "last_week_high": round(max(bar.high for bar in recent_five), 2),
        "last_week_low": round(min(bar.low for bar in recent_five), 2),
        "recent_high": round(max(bar.high for bar in recent), 2),
        "recent_low": round(min(bar.low for bar in recent), 2),
        "support_zone": _zone(support["price"], half_width),
        "resistance_zone": _zone(resistance["price"], half_width),
        "support_source": support["sources"],
        "resistance_source": resistance["sources"],
        "support_levels": [_level_for_output(item, price) for item in supports[:3]],
        "resistance_levels": [_level_for_output(item, price) for item in resistances[:3]],
        "method": "nearest_completed_daily_pivots",
        "zones_overlap": support["price"] + half_width >= resistance["price"] - half_width,
    }


def _swing_candidates(bars: list[Bar]) -> list[dict]:
    candidates = []
    for index in range(2, len(bars) - 2):
        bar = bars[index]
        neighbors = bars[index - 2 : index] + bars[index + 1 : index + 3]
        age = len(bars) - 1 - index
        strength = 2 if age <= 20 else 1
        if bar.low <= min(item.low for item in neighbors):
            candidates.append(_candidate(bar.low, "swing_low", strength, age))
        if bar.high >= max(item.high for item in neighbors):
            candidates.append(_candidate(bar.high, "swing_high", strength, age))
    return candidates


def _candidate(price: float, source: str, strength: int, age_sessions: int = 0) -> dict:
    return {
        "price": float(price),
        "sources": [source],
        "strength": strength,
        "age_sessions": age_sessions,
    }


def _merge_nearby(candidates: list[dict], tolerance: float) -> list[dict]:
    merged: list[dict] = []
    for candidate in sorted(candidates, key=lambda item: (-item["strength"], item["age_sessions"])):
        existing = next(
            (item for item in merged if abs(item["price"] - candidate["price"]) <= tolerance),
            None,
        )
        if existing:
            existing["sources"] = _dedupe(existing["sources"] + candidate["sources"])
            existing["strength"] = max(existing["strength"], candidate["strength"])
            existing["age_sessions"] = min(existing["age_sessions"], candidate["age_sessions"])
        else:
            merged.append(dict(candidate))
    return merged


def _level_for_output(level: dict, reference_price: float) -> dict:
    return {
        "price": round(level["price"], 2),
        "distance_pct": round((level["price"] - reference_price) / reference_price * 100, 2),
        "sources": level["sources"],
        "strength": level["strength"],
        "age_sessions": level["age_sessions"],
    }


def _zone(level: float, half_width: float) -> dict:
    return {
        "low": round(level - half_width, 2),
        "high": round(level + half_width, 2),
        "mid": round(level, 2),
    }


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))
