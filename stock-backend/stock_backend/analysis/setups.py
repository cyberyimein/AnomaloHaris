"""Daily-chart setup labels.

These labels are meant to guide attention, not issue buy/sell instructions.
"""

from __future__ import annotations


def classify_daily_setups(stock: dict, market_context: dict) -> dict:
    price = _stock_price(stock)
    technicals = stock["technicals"]
    levels = stock["levels"]
    options = stock.get("options") or {}

    tags = []
    confirmations = []
    atr_pct = max(technicals["atr_pct"], 0.01)
    support_distance = _distance_to_zone_pct(price, levels["support_zone"])
    resistance_distance = _distance_to_zone_pct(price, levels["resistance_zone"])
    sector_label = stock.get("group_context", {}).get("peer_label")
    if sector_label in {None, "unavailable"}:
        sector_label = market_context.get("groups", {}).get("sector", {}).get("label", "mixed")
    bollinger = technicals.get("bollinger", {})
    percent_b = _session_percent_b(price, bollinger)
    width_percentile = bollinger.get("width_percentile_120d", 0.5)
    width_pct = bollinger.get("width_pct", 0)
    relative_state = stock.get("relative_strength", {}).get("state", "unavailable")
    adx = technicals.get("adx14") or 0

    near_support = support_distance <= min(1.5, atr_pct * 0.25)
    near_resistance = resistance_distance <= min(1.5, atr_pct * 0.25)
    below_support = price < levels["support_zone"]["low"]

    if near_support:
        tags.append(
            _tag(
                "support_test",
                "支撑测试",
                "medium",
                f"price is {support_distance:.2f}% from support zone",
            )
        )
        confirmations.append("开盘后观察是否守住支撑区")

    if (
        near_support
        and technicals["rsi14"] <= 40
        and percent_b <= 0.25
        and technicals["trend"] != "downtrend"
        and relative_state != "underperforming"
    ):
        severity = "medium" if sector_label != "bearish" else "low"
        tags.append(
            _tag(
                "bounce_candidate",
                "反弹候选",
                severity,
                "near support with stretched momentum, without confirmed trend or relative-strength failure",
            )
        )
        confirmations.append("需要看到支撑区止跌和第一段反弹放量")

    if below_support:
        tags.append(
            _tag(
                "breakdown_risk",
                "下破风险",
                "high" if sector_label == "bearish" else "medium",
                "premarket price is below support zone",
            )
        )
        confirmations.append("若无法重新站回支撑区，避免急着抄底")

    if near_resistance and technicals["trend"] != "downtrend":
        tags.append(
            _tag(
                "breakout_watch",
                "突破观察",
                "medium",
                f"price is {resistance_distance:.2f}% from resistance zone",
            )
        )
        confirmations.append("需要突破压力区并维持成交量")

    if technicals["trend"] == "uptrend" and _near_ema_pullback(price, technicals):
        tags.append(
            _tag(
                "trend_pullback",
                "趋势回调",
                "medium",
                "uptrend remains intact while price is close to EMA20/EMA50",
            )
        )

    if width_percentile <= 0.15 and technicals["atr_pct"] <= 5 and width_pct <= 20:
        tags.append(
            _tag(
                "volatility_squeeze",
                "日线波动压缩",
                "medium",
                "Bollinger bandwidth is near the low end of its 120-day range",
            )
        )
        confirmations.append("压缩只提示可能要放大波动，不提示方向")
    elif width_percentile <= 0.15:
        tags.append(
            _tag(
                "relative_band_compression",
                "相对历史收窄",
                "low",
                "Bollinger width is low versus its own history, but absolute volatility remains high",
            )
        )
        confirmations.append("布林带相对自身历史收窄，但绝对波动仍高，不能视为低波动蓄势")

    if percent_b >= 0.95 and technicals["rsi14"] >= 68:
        if technicals["trend"] == "uptrend" and adx >= 25:
            tags.append(
                _tag(
                    "upper_band_trend",
                    "上轨趋势延续",
                    "medium",
                    "price is walking the upper Bollinger band while ADX confirms a strong uptrend",
                )
            )
            confirmations.append("强趋势贴上轨不等于卖点；观察回落后能否继续守住布林中轨或 EMA20")
        else:
            tags.append(
                _tag(
                    "overextended",
                    "短线过热",
                    "medium",
                    "price is near the upper Bollinger band with elevated RSI without strong-trend confirmation",
                )
            )

    if percent_b <= 0.05 and technicals["trend"] == "downtrend" and adx >= 25:
        tags.append(
            _tag(
                "lower_band_trend_risk",
                "下轨趋势风险",
                "high",
                "price is walking the lower Bollinger band while ADX confirms a strong downtrend",
            )
        )
        confirmations.append("强下跌贴下轨不是抄底依据；至少等待脱离下轨并收回支撑")

    for reminder in options.get("risk_reminders", []):
        tags.append(
            _tag(
                reminder["tag"],
                reminder["label"],
                reminder["severity"],
                reminder["reason"],
            )
        )

    return {
        "primary": tags[0]["tag"] if tags else "no_clear_daily_setup",
        "tags": tags,
        "confirmation_needed": _dedupe(confirmations),
    }


def _tag(tag: str, label: str, severity: str, reason: str) -> dict:
    return {
        "tag": tag,
        "label": label,
        "severity": severity,
        "reason": reason,
    }


def _distance_to_zone_pct(price: float, zone: dict) -> float:
    if zone["low"] <= price <= zone["high"]:
        return 0.0
    if price < zone["low"]:
        return round((zone["low"] - price) / price * 100, 2)
    return round((price - zone["high"]) / price * 100, 2)


def _near_ema_pullback(price: float, technicals: dict) -> bool:
    distances = [
        abs((price - value) / value * 100)
        for value in (technicals.get("ema20"), technicals.get("ema50"))
        if value is not None and value != 0
    ]
    return bool(distances) and min(distances) <= 1.5


def _session_percent_b(price: float, bollinger: dict) -> float:
    upper = bollinger.get("upper")
    lower = bollinger.get("lower")
    if upper is not None and lower is not None and upper != lower:
        return (price - lower) / (upper - lower)
    return bollinger.get("percent_b", 0.5)


def _stock_price(stock: dict) -> float:
    quote = stock.get("session_quote") or stock.get("premarket", {})
    return float(quote["price"])


def _dedupe(values: list[str]) -> list[str]:
    seen = set()
    result = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result
