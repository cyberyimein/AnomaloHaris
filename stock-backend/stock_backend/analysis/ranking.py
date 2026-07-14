"""Independent-component attention scoring for scan triage."""

from __future__ import annotations

from math import sqrt

SETUP_ATTENTION = {
    "breakdown_risk": 25,
    "bounce_candidate": 24,
    "breakout_watch": 22,
    "trend_pullback": 20,
    "support_test": 18,
    "volatility_squeeze": 12,
    "overextended": 10,
    "upper_band_trend": 15,
    "lower_band_trend_risk": 25,
    "relative_band_compression": 5,
}


def score_stock(stock: dict, market_context: dict, thresholds: dict) -> dict:
    technicals = stock["technicals"]
    quote = stock.get("session_quote") or stock.get("premarket", {})
    change_pct = float(quote.get("change_pct", quote.get("gap_pct", 0)) or 0)
    atr_pct = max(float(technicals.get("atr_pct", 0) or 0), 0.25)
    normalized_move = abs(change_pct) / atr_pct
    tags = {item["tag"] for item in stock.get("setups", {}).get("tags", [])}

    movement_score = normalized_move * 35 + min(abs(change_pct), 8) * 1.25
    if normalized_move >= 1 or abs(change_pct) >= 5:
        movement_score = max(movement_score, 45)
    movement_score = min(45, movement_score)
    setup_score = max((SETUP_ATTENTION.get(tag, 0) for tag in tags), default=0)
    participation_score, participation = _participation_score(quote, technicals)
    option_score = _option_score(stock.get("options"), atr_pct)
    signal = _direction_signal(stock, market_context, tags)
    context_score = _context_score(stock, market_context, signal["direction"])

    components = {
        "current_move": _component(
            movement_score,
            45,
            "move significance and catalyst-review priority, not continuation direction",
        ),
        "actionable_setup": _component(setup_score, 25, "conditional trigger quality"),
        "participation": _component(
            participation_score, 10, "uncalibrated session volume versus average daily volume"
        ),
        "option_risk": _component(option_score, 10, "forward magnitude reminder only"),
        "context_alignment": _component(
            context_score, 10, "relative strength and market alignment"
        ),
    }
    score = round(min(sum(item["score"] for item in components.values()), 100), 1)

    reasons = []
    if movement_score >= 10:
        reasons.append(f"session move {change_pct:+.2f}% equals {normalized_move:.2f} ATR")
    if normalized_move >= 1 or abs(change_pct) >= 5:
        reasons.append("large event move deserves catalyst review even without a directional setup")
    if setup_score:
        primary = max(tags, key=lambda tag: SETUP_ATTENTION.get(tag, 0))
        reasons.append(f"actionable setup: {primary}")
    if participation_score:
        reasons.append(f"session volume is {participation['fraction_of_adv']:.1%} of 20d ADV")
    if option_score:
        reasons.append("options imply elevated move magnitude; direction remains unknown")
    relative = stock.get("relative_strength", {})
    if relative.get("state") in {"outperforming", "underperforming"}:
        reasons.append(relative["summary"])
    if signal["confidence"] != "low":
        reasons.append(
            f"conditional {signal['direction']} evidence has {signal['confidence']} agreement"
        )

    return {
        "attention_score": score,
        "bucket": _bucket(score, thresholds),
        "normalized_move_atr": round(normalized_move, 2),
        "participation": participation,
        "attention_components": components,
        "signal": signal,
        "reasons": reasons[:6],
    }


def _participation_score(quote: dict, technicals: dict) -> tuple[float, dict]:
    volume = int(quote.get("volume", 0) or 0)
    average_volume = float(technicals.get("avg_volume_20d", 0) or 0)
    fraction = volume / average_volume if average_volume > 0 else 0
    session = quote.get("session", "premarket")
    if session in {"overnight", "premarket", "afterhours"}:
        score = min(10, fraction * 100)
    elif session == "regular":
        score = min(10, fraction * 10)
    else:
        score = 0
    return round(score, 1), {
        "fraction_of_adv": round(fraction, 4),
        "time_of_day_adjusted": False,
        "limitation": "same-time historical volume baseline is not yet available",
    }


def _option_score(options: dict | None, atr_pct: float) -> float:
    if not options:
        return 0.0
    expected_move = options.get("straddle_implied_move_pct")
    if expected_move is None:
        expected_move = options.get("expected_move_pct")
    quality = options.get("quote_quality", {})
    spread_reliability = 1.0 if quality.get("reliable") else 0.5
    timing_reliability = 1.0 if quality.get("timing_reliable", True) else 0.5
    reliability = spread_reliability * timing_reliability
    days = max(int(options.get("days_to_expiry", 1) or 1), 1)
    expected_baseline = atr_pct * sqrt(days)
    move_ratio = float(expected_move or 0) / max(expected_baseline, 0.25)
    score = min(6, move_ratio * 4) * reliability

    tags = {item["tag"] for item in options.get("risk_reminders", [])}
    if "iv_rich_vs_realized" in tags:
        score += 2 * reliability
    if "short_dated_positioning_watch" in tags:
        score += 2
    return round(min(score, 10), 1)


def _context_score(stock: dict, market_context: dict, direction: str) -> float:
    score = 0.0
    relative_state = stock.get("relative_strength", {}).get("state")
    if relative_state in {"outperforming", "underperforming"}:
        score += 5

    peer_label = stock.get("group_context", {}).get("peer_label")
    if (direction == "bullish" and peer_label == "bullish") or (
        direction == "bearish" and peer_label == "bearish"
    ):
        score += 3

    regime = market_context.get("regime")
    market_signal_is_usable = market_context.get("signal_confidence", 1) >= 0.35
    if market_signal_is_usable and (
        (direction == "bullish" and regime == "risk_on")
        or (direction == "bearish" and regime == "risk_off")
    ):
        score += 2
    return min(score, 10)


def _direction_signal(stock: dict, market_context: dict, tags: set[str]) -> dict:
    technicals = stock["technicals"]
    relative_state = stock.get("relative_strength", {}).get("state", "unavailable")
    bullish_evidence = []
    bearish_evidence = []

    if tags & {"bounce_candidate", "breakout_watch", "trend_pullback", "upper_band_trend"}:
        bullish_evidence.append("price setup")
    if tags & {"breakdown_risk", "lower_band_trend_risk"}:
        bearish_evidence.append("support failure")
    if technicals.get("trend") == "uptrend":
        bullish_evidence.append("completed-daily trend")
    elif technicals.get("trend") == "downtrend":
        bearish_evidence.append("completed-daily trend")
    if relative_state == "outperforming":
        bullish_evidence.append("relative strength")
    elif relative_state == "underperforming":
        bearish_evidence.append("relative weakness")
    peer_label = stock.get("group_context", {}).get("peer_label")
    if peer_label == "bullish":
        bullish_evidence.append("peer group")
    elif peer_label == "bearish":
        bearish_evidence.append("peer group")
    market_signal_is_usable = market_context.get("signal_confidence", 1) >= 0.35
    if market_signal_is_usable and market_context.get("regime") == "risk_on":
        bullish_evidence.append("market regime")
    elif market_signal_is_usable and market_context.get("regime") == "risk_off":
        bearish_evidence.append("market regime")

    if len(bullish_evidence) >= 2 and len(bullish_evidence) > len(bearish_evidence):
        direction = "bullish"
        evidence = bullish_evidence
    elif len(bearish_evidence) >= 2 and len(bearish_evidence) > len(bullish_evidence):
        direction = "bearish"
        evidence = bearish_evidence
    else:
        direction = "neutral"
        evidence = _dedupe(bullish_evidence + bearish_evidence)

    independent_count = len(_dedupe(evidence))
    has_price_setup = "price setup" in evidence or "support failure" in evidence
    if independent_count >= 3 and has_price_setup:
        confidence = "high"
    elif independent_count >= 2:
        confidence = "moderate"
    else:
        confidence = "low"

    levels = stock.get("levels", {})
    support = levels.get("support_zone", {})
    resistance = levels.get("resistance_zone", {})
    if direction == "bullish":
        confirmations = stock.get("setups", {}).get("confirmation_needed", [])
        trigger = confirmations[0] if confirmations else "等待价格突破并由成交量确认"
        invalidation = f"跌破 {support.get('low')}" if support else "价格 setup 失效"
    elif direction == "bearish":
        trigger = "跌破支撑后无法快速收回"
        invalidation = f"重新站上 {support.get('high')}" if support else "重新站回支撑"
    else:
        trigger = (
            f"等待突破 {resistance.get('high')} 或跌破 {support.get('low')}"
            if support and resistance
            else "等待价格确认"
        )
        invalidation = "方向尚未建立"

    return {
        "direction": direction,
        "confidence": confidence,
        "evidence": evidence,
        "trigger": trigger,
        "invalidation": invalidation,
        "claim": "conditional_scenario_not_return_prediction",
    }


def _component(score: float, maximum: float, role: str) -> dict:
    return {"score": round(score, 1), "max": maximum, "role": role}


def _bucket(score: float, thresholds: dict) -> str:
    if score >= thresholds.get("watch", 70):
        return "watch"
    if score >= thresholds.get("observe", 45):
        return "observe"
    return "ignore"


def _dedupe(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))
