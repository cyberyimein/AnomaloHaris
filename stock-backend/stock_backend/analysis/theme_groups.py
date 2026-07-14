"""Watchlist-group breadth used as technology leadership confirmation."""

from __future__ import annotations

from math import sqrt


def summarize_theme_groups(raw_results: list[dict], group_catalog: dict) -> dict:
    by_symbol = {item["symbol"]: item for item in raw_results}
    groups = {}

    for group_name, definition in group_catalog.items():
        member_symbols = definition.get("active_symbols", [])
        items = []
        for symbol in member_symbols:
            stock = by_symbol.get(symbol)
            if not stock:
                continue
            score = _breadth_score(stock)
            items.append(
                {
                    "symbol": symbol,
                    "score": score,
                    "session_change_pct": _session_change(stock),
                    "return_5d_pct": stock["technicals"].get("return_5d_pct", 0),
                    "trend": stock["technicals"].get("trend", "mixed"),
                }
            )

        score = _mean([item["score"] for item in items])
        benchmark_symbol = definition.get("benchmark")
        benchmark = by_symbol.get(benchmark_symbol)
        benchmark_score = _breadth_score(benchmark) if benchmark else None
        peer_states = {item["symbol"]: _peer_state(item["symbol"], items) for item in items}
        groups[group_name] = {
            "label": _label(score, bool(items)),
            "score": round(score, 1),
            "display_name": definition.get("label", group_name),
            "benchmark_symbol": benchmark_symbol,
            "benchmark_score": benchmark_score,
            "benchmark_alignment": _alignment(score, benchmark_score),
            "coverage": round(len(items) / len(member_symbols), 2) if member_symbols else 0,
            "available_symbols": len(items),
            "configured_symbols": len(member_symbols),
            "positive_symbols": sum(1 for item in items if item["score"] > 0),
            "negative_symbols": sum(1 for item in items if item["score"] < 0),
            "strong_positive_symbols": sum(1 for item in items if item["score"] >= 20),
            "strong_negative_symbols": sum(1 for item in items if item["score"] <= -20),
            "symbols": items,
            "peer_states": peer_states,
            "role": "leadership_breadth_confirmation",
            "contributes_to_risk_score": False,
        }

    state = _overall_state(groups)
    return {
        "state": state,
        "summary": _overall_summary(groups, state),
        "groups": groups,
        "role": "technology_leadership_confirmation",
        "contributes_to_risk_score": False,
        "limitations": [
            "groups are curated technology watchlists rather than the full US market",
            "peer state excludes the current stock to reduce circular confirmation",
        ],
    }


def stock_group_context(stock: dict, theme_groups: dict) -> dict:
    group_name = stock.get("group")
    group = theme_groups.get("groups", {}).get(group_name, {})
    peer = group.get("peer_states", {}).get(stock.get("symbol"), {})
    return {
        "group": group_name,
        "display_name": group.get("display_name", stock.get("group_label", group_name)),
        "group_label": group.get("label", "unavailable"),
        "group_score": group.get("score"),
        "peer_label": peer.get("label", "unavailable"),
        "peer_score": peer.get("score"),
        "benchmark_symbol": group.get("benchmark_symbol", stock.get("benchmark_symbol")),
        "benchmark_alignment": group.get("benchmark_alignment", "unavailable"),
        "role": "peer_confirmation_not_independent_market_signal",
    }


def _breadth_score(stock: dict | None) -> float | None:
    if not stock:
        return None
    technicals = stock["technicals"]
    atr_pct = max(float(technicals.get("atr_pct", 0) or 0), 0.5)
    current = _clamp(_session_change(stock) / atr_pct * 35, -35, 35)
    five_day = _clamp(
        float(technicals.get("return_5d_pct", 0) or 0) / (atr_pct * sqrt(5)) * 30,
        -30,
        30,
    )
    trend = _clamp(float(technicals.get("trend_score", 0) or 0) * 0.35, -35, 35)
    return round(_clamp(current + five_day + trend, -100, 100), 1)


def _peer_state(symbol: str, items: list[dict]) -> dict:
    peer_scores = [item["score"] for item in items if item["symbol"] != symbol]
    if not peer_scores:
        return {"label": "unavailable", "score": None, "peer_count": 0}
    score = _mean(peer_scores)
    return {
        "label": _label(score, True),
        "score": round(score, 1),
        "peer_count": len(peer_scores),
    }


def _alignment(group_score: float, benchmark_score: float | None) -> str:
    if benchmark_score is None:
        return "unavailable"
    group_label = _label(group_score, True)
    benchmark_label = _label(benchmark_score, True)
    if group_label == benchmark_label and group_label in {"bullish", "bearish"}:
        return "confirming"
    if {group_label, benchmark_label} == {"bullish", "bearish"}:
        return "diverging"
    return "mixed"


def _overall_state(groups: dict[str, dict]) -> str:
    labels = [group["label"] for group in groups.values() if group["label"] != "unavailable"]
    bullish = labels.count("bullish")
    bearish = labels.count("bearish")
    if bullish >= 3 and bearish == 0:
        return "broad_tech_strength"
    if bearish >= 3 and bullish == 0:
        return "broad_tech_weakness"
    if bullish and bearish:
        return "rotation"
    return "mixed"


def _overall_summary(groups: dict[str, dict], state: str) -> str:
    parts = [f"{group['display_name']} {_localize(group['label'])}" for group in groups.values()]
    prefix = {
        "broad_tech_strength": "科技观察组多数走强",
        "broad_tech_weakness": "科技观察组多数走弱",
        "rotation": "科技内部轮动明显",
        "mixed": "科技观察组方向不一致",
    }[state]
    return f"{prefix}；" + "，".join(parts) + "。"


def _label(score: float, available: bool) -> str:
    if not available:
        return "unavailable"
    if score >= 15:
        return "bullish"
    if score <= -15:
        return "bearish"
    return "mixed"


def _session_change(stock: dict) -> float:
    quote = stock.get("session_quote") or stock.get("premarket", {})
    return float(quote.get("change_pct", quote.get("gap_pct", 0)) or 0)


def _localize(label: str) -> str:
    return {
        "bullish": "偏强",
        "bearish": "偏弱",
        "mixed": "混合",
        "unavailable": "不可用",
    }.get(label, label)


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))
