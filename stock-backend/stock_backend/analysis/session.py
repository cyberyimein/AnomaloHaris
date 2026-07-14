"""US market-session classification and quote selection."""

from __future__ import annotations

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

SESSION_LABELS = {
    "overnight": "隔夜",
    "premarket": "盘前",
    "regular": "盘中",
    "afterhours": "盘后",
    "closed": "休市",
}


def classify_market_session(
    as_of: datetime | None = None,
    market_timezone: str = "America/New_York",
) -> dict:
    """Classify the US equity session using weekday clock time.

    Holiday handling intentionally remains explicit as a limitation. The scan is
    designed for premarket use, so this lightweight classifier prevents a regular
    session quote from being mislabeled as premarket without adding a calendar
    dependency.
    """

    value = as_of or datetime.now(UTC)
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    local = value.astimezone(ZoneInfo(market_timezone))
    clock = local.time().replace(tzinfo=None)

    if local.weekday() >= 5:
        name = "closed"
    elif clock < time(4, 0) or clock >= time(20, 0):
        name = "overnight"
    elif time(4, 0) <= clock < time(9, 30):
        name = "premarket"
    elif time(9, 30) <= clock < time(16, 0):
        name = "regular"
    elif time(16, 0) <= clock < time(20, 0):
        name = "afterhours"
    else:
        name = "closed"

    return {
        "name": name,
        "label": SESSION_LABELS[name],
        "timezone": market_timezone,
        "as_of_local": local.isoformat(),
        "market_date": local.date().isoformat(),
        "calendar_accuracy": "weekday_clock_only",
    }


def select_session_quote(snapshot, market_session: dict) -> dict:
    """Select the quote matching the current market session."""

    session = market_session["name"]
    candidates = {
        "overnight": (
            (
                getattr(snapshot, "overnight_price", None),
                getattr(snapshot, "overnight_volume", 0),
                "overnight_price",
                getattr(snapshot, "overnight_provider_change_pct", None),
                snapshot.last_price,
                "last_regular_close",
            ),
            (
                snapshot.last_price,
                0,
                "last_price_fallback",
                0.0,
                snapshot.last_price,
                "last_regular_close",
            ),
        ),
        "premarket": (
            (
                getattr(snapshot, "premarket_price", None),
                getattr(snapshot, "premarket_volume", 0),
                "pre_price",
                getattr(snapshot, "premarket_provider_change_pct", None),
                snapshot.last_price,
                "last_regular_close",
            ),
            (
                snapshot.last_price,
                0,
                "last_price_fallback",
                0.0,
                snapshot.last_price,
                "last_regular_close",
            ),
        ),
        "regular": (
            (
                snapshot.last_price,
                getattr(snapshot, "volume", 0),
                "last_price",
                None,
                snapshot.previous_close,
                "previous_regular_close",
            ),
        ),
        "afterhours": (
            (
                getattr(snapshot, "afterhours_price", None),
                getattr(snapshot, "afterhours_volume", 0),
                "after_price",
                getattr(snapshot, "afterhours_provider_change_pct", None),
                snapshot.last_price,
                "current_regular_close",
            ),
            (
                snapshot.last_price,
                0,
                "last_price_fallback",
                0.0,
                snapshot.last_price,
                "current_regular_close",
            ),
        ),
        "closed": (
            (
                snapshot.last_price,
                getattr(snapshot, "volume", 0),
                "last_price",
                None,
                snapshot.previous_close,
                "previous_regular_close",
            ),
        ),
    }

    price = snapshot.last_price
    volume = 0
    source = "last_price_fallback"
    provided_change = None
    reference_price = snapshot.previous_close
    reference_type = "previous_regular_close"
    for (
        candidate_price,
        candidate_volume,
        candidate_source,
        candidate_change,
        candidate_reference,
        candidate_reference_type,
    ) in candidates[session]:
        if candidate_price is not None and candidate_price > 0:
            price = float(candidate_price)
            volume = int(candidate_volume or 0)
            source = candidate_source
            provided_change = candidate_change
            reference_price = float(candidate_reference)
            reference_type = candidate_reference_type
            break

    change_pct = _pct(price, reference_price)
    change_source = (
        "fallback_zero"
        if source.endswith("fallback")
        else "calculated_from_last_regular_close"
        if session in {"overnight", "premarket", "afterhours"}
        else "calculated_from_previous_regular_close"
    )

    return {
        "session": session,
        "label": market_session["label"],
        "price": round(price, 4),
        "volume": volume,
        "change_pct": change_pct,
        "reference_price": round(reference_price, 4),
        "reference_type": reference_type,
        "change_source": change_source,
        "raw_opend_change_pct": round(float(provided_change), 3)
        if provided_change is not None
        else None,
        "raw_opend_change_used": False,
        "source": source,
        "fallback_used": source.endswith("fallback"),
        "quote_time": getattr(snapshot, "quote_time", None),
    }


def _pct(current: float, previous: float) -> float:
    if previous == 0:
        return 0.0
    return round((current - previous) / previous * 100, 2)
