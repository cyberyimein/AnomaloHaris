"""Broad-market context with separated regime inputs and macro context."""

from __future__ import annotations

from math import sqrt

DEFAULT_MARKET_CONFIG = {
    "equity_symbols": ["US.SPY", "US.QQQ", "US.IWM"],
    "volatility_symbols": ["US.VIXY"],
    "macro_symbols": ["US.TLT", "US.UUP", "US.GLD", "US.USO"],
    "sector_symbols": ["US.SOXX", "US.IGV"],
    "leadership_groups": {
        "semiconductors": {
            "label": "半导体领导力",
            "proxy_for": "SOX",
            "symbols": ["US.SOXX"],
        },
        "software": {
            "label": "软件领导力",
            "symbols": ["US.IGV"],
        },
    },
    "sector_breadth_symbols": [],
}

REGIME_GROUP_WEIGHTS = {
    "equity": 0.50,
    "volatility": 0.30,
    "sector": 0.20,
}


def summarize_market_context(proxy_results: list[dict], config: dict | None = None) -> dict:
    if not proxy_results:
        return _empty_context("No market proxy data available")

    provided_config = config or {}
    market_config = {**DEFAULT_MARKET_CONFIG, **provided_config}
    by_symbol = {result["symbol"]: result for result in proxy_results}
    equity = _score_directional_group("equity", market_config["equity_symbols"], by_symbol)
    volatility = _score_volatility_group(market_config["volatility_symbols"], by_symbol)
    macro = _summarize_macro_group(market_config["macro_symbols"], by_symbol)
    if "leadership_groups" in provided_config or "sector_symbols" not in provided_config:
        sector = _score_leadership_group(market_config["leadership_groups"], by_symbol)
    else:
        sector = _score_directional_group("sector", market_config["sector_symbols"], by_symbol)
    sector["breadth"] = _summarize_breadth(market_config["sector_breadth_symbols"], by_symbol)
    groups = {
        "equity": equity,
        "volatility": volatility,
        "macro": macro,
        "sector": sector,
    }

    available_weight = sum(
        REGIME_GROUP_WEIGHTS[name] * groups[name]["coverage"] for name in REGIME_GROUP_WEIGHTS
    )
    directional_weight = sum(
        REGIME_GROUP_WEIGHTS[name]
        * groups[name].get("directional_coverage", groups[name]["coverage"])
        for name in REGIME_GROUP_WEIGHTS
    )
    if available_weight == 0:
        return _empty_context("Configured regime proxy symbols were unavailable")

    risk_score = (
        sum(
            groups[name]["score"]
            * REGIME_GROUP_WEIGHTS[name]
            * groups[name].get("directional_coverage", groups[name]["coverage"])
            for name in REGIME_GROUP_WEIGHTS
        )
        / directional_weight
        if directional_weight
        else 0
    )
    data_coverage = available_weight / sum(REGIME_GROUP_WEIGHTS.values())
    agreement = _signal_agreement(groups, risk_score, directional_weight)
    signal_confidence = data_coverage * agreement * min(abs(risk_score) / 30, 1)
    regime = _regime(risk_score, equity["score"], volatility["score"])

    return {
        "regime": regime,
        "risk_score": round(risk_score, 1),
        "risk_score_explanation": _risk_score_explanation(groups, directional_weight, risk_score),
        "data_coverage": round(data_coverage, 2),
        "confidence": round(data_coverage, 2),
        "confidence_kind": "data_coverage_compatibility_alias",
        "signal_agreement": round(agreement, 2),
        "signal_confidence": round(signal_confidence, 2),
        "signal_confidence_label": _confidence_label(signal_confidence),
        "signal_confidence_kind": "heuristic_strength_and_agreement_not_probability",
        "scoring_model_version": "2.4",
        "risk_score_inputs": ["equity", "volatility", "sector_when_soxx_igv_aligned"],
        "context_only_inputs": ["macro"],
        "groups": groups,
        "notes": _collect_notes(groups)[:12],
        "limitations": [
            "VIXY tracks short-term VIX futures, not spot VIX, so only short-horizon changes are used",
            "macro ETFs are conditional context and do not contribute to the scalar risk score",
            "SOXX is used as a tradable proxy for SOX; IGV represents software leadership",
            "SOXX/IGV rotation is detected from current divergence and is not assumed to be permanent",
            "the risk score is a triage heuristic and has not yet been backtested",
        ],
    }


def _score_directional_group(name: str, symbols: list[str], by_symbol: dict[str, dict]) -> dict:
    items = []
    for symbol in symbols:
        result = by_symbol.get(symbol)
        if not result:
            continue
        components = _direction_components(result)
        score = sum(component["score"] for component in components.values())
        items.append(_symbol_item(result, score, score, components))
    return _group_payload(name, symbols, items, role="regime_input")


def _score_leadership_group(config: dict, by_symbol: dict[str, dict]) -> dict:
    subgroups = {}
    active_scores = []
    items = []
    configured_symbols = 0

    for name, definition in config.items():
        symbols = definition.get("symbols", [])
        configured_symbols += len(symbols)
        subgroup = _score_directional_group(name, symbols, by_symbol)
        subgroup["display_name"] = definition.get("label", name)
        subgroup["proxy_for"] = definition.get("proxy_for")
        subgroups[name] = subgroup
        items.extend(subgroup["symbols"])
        if subgroup["coverage"] > 0:
            active_scores.append(subgroup["score"])

    raw_average_score = mean(active_scores)
    relationship = _technology_relationship(subgroups)
    score = 0.0 if relationship["is_rotation"] else raw_average_score
    available_symbols = sum(group["available_symbols"] for group in subgroups.values())
    coverage = len(active_scores) / len(subgroups) if subgroups else 0
    return {
        "label": _group_label(score, coverage),
        "score": round(score, 3),
        "weight": REGIME_GROUP_WEIGHTS["sector"],
        "coverage": round(coverage, 2),
        "available_symbols": available_symbols,
        "configured_symbols": configured_symbols,
        "symbols": items,
        "subgroups": subgroups,
        "relationship": relationship,
        "raw_average_score": round(raw_average_score, 3),
        "directional_coverage": 0.0 if relationship["is_rotation"] else round(coverage, 2),
        "role": "technology_breadth_and_rotation_regime_input",
        "score_method": "aligned_breadth_or_rotation_neutral",
        "score_explanation": _group_score_explanation(
            score,
            "SOXX 与 IGV 同向时等权确认科技广度；明显反向时识别为内部轮动，对大盘方向贡献归零",
        ),
        "notes": _group_notes("leadership", items, score, coverage),
    }


def _technology_relationship(subgroups: dict[str, dict]) -> dict:
    semiconductors = subgroups.get("semiconductors", {})
    software = subgroups.get("software", {})
    if not semiconductors.get("symbols") or not software.get("symbols"):
        return {
            "state": "insufficient_data",
            "label": "数据不足",
            "is_rotation": False,
            "broad_market_effect": "unknown",
        }

    semi_score = float(semiconductors.get("score", 0) or 0)
    software_score = float(software.get("score", 0) or 0)
    semi_move = float(semiconductors["symbols"][0].get("session_change_pct", 0) or 0)
    software_move = float(software["symbols"][0].get("session_change_pct", 0) or 0)
    score_rotation = semi_score * software_score < 0 and abs(semi_score - software_score) >= 30
    session_rotation = semi_move * software_move < 0 and abs(semi_move - software_move) >= 2

    if score_rotation or session_rotation:
        semi_leads = semi_move > software_move if session_rotation else semi_score > software_score
        return {
            "state": "rotation_to_semiconductors" if semi_leads else "rotation_to_software",
            "label": "半导体占优" if semi_leads else "软件占优",
            "is_rotation": True,
            "broad_market_effect": "internal_offset_no_directional_confirmation",
            "session_spread_pct": round(semi_move - software_move, 2),
            "score_spread": round(semi_score - software_score, 1),
            "reason": "SOXX 与 IGV 明显反向，代表科技内部资金轮动，而不是整个科技板块方向混合",
        }
    if semi_score >= 20 and software_score >= 20:
        state, label, effect = "broad_tech_strength", "科技同步走强", "supports_risk_appetite"
    elif semi_score <= -20 and software_score <= -20:
        state, label, effect = "broad_tech_weakness", "科技同步承压", "weighs_on_risk_appetite"
    else:
        state, label, effect = "no_clear_style_signal", "暂无明确风格", "no_confirmation"
    return {
        "state": state,
        "label": label,
        "is_rotation": False,
        "broad_market_effect": effect,
        "session_spread_pct": round(semi_move - software_move, 2),
        "score_spread": round(semi_score - software_score, 1),
    }


def _score_volatility_group(symbols: list[str], by_symbol: dict[str, dict]) -> dict:
    items = []
    for symbol in symbols:
        result = by_symbol.get(symbol)
        if not result:
            continue
        technicals = result["technicals"]
        atr_pct = max(technicals.get("atr_pct", 0), 0.5)
        session_change = _session_change(result)
        current_stress = _clamp(session_change / atr_pct * 60, -60, 60)
        five_day_stress = _clamp(
            technicals.get("return_5d_pct", 0) / (atr_pct * sqrt(5)) * 40,
            -40,
            40,
        )
        raw_stress = _clamp(current_stress + five_day_stress, -100, 100)
        risk_support_score = -raw_stress
        components = {
            "current_session": _score_component(
                -current_stress,
                60,
                session_change,
                "VIXY 当前时段上涨会降低风险支持分",
            ),
            "five_day": _score_component(
                -five_day_stress,
                40,
                technicals.get("return_5d_pct", 0),
                "VIXY 近 5 日上涨会降低风险支持分",
            ),
        }
        items.append(_symbol_item(result, risk_support_score, raw_stress, components))

    payload = _group_payload("volatility", symbols, items, role="regime_input")
    payload["score_method"] = "short_horizon_change_only"
    payload["score_explanation"] = _group_score_explanation(
        payload["score"],
        "VIXY 当前时段与近 5 日压力分取反；正分表示波动率压力缓和",
    )
    payload["limitations"] = [
        "VIXY futures carry and long-run decay make EMA trend unsuitable as a fear signal"
    ]
    return payload


def _summarize_macro_group(symbols: list[str], by_symbol: dict[str, dict]) -> dict:
    items = []
    for symbol in symbols:
        result = by_symbol.get(symbol)
        if not result:
            continue
        components = _direction_components(result)
        raw_score = sum(component["score"] for component in components.values())
        items.append(_symbol_item(result, raw_score, raw_score, components))

    coverage = len(items) / len(symbols) if symbols else 0
    return {
        "label": "context" if items else "unavailable",
        "score": 0.0,
        "weight": 0.0,
        "coverage": round(coverage, 2),
        "available_symbols": len(items),
        "configured_symbols": len(symbols),
        "symbols": items,
        "role": "context_only",
        "score_explanation": {
            "current": "宏观不与指数合成为单一方向分；分别解释美元、利率、黄金和油价的风险影响",
            "show_group_score": False,
            "component_scores_available": True,
        },
        "notes": ["macro context is descriptive and excluded from risk_score"],
    }


def _summarize_breadth(symbols: list[str], by_symbol: dict[str, dict]) -> dict:
    items = []
    votes = []
    for symbol in symbols:
        result = by_symbol.get(symbol)
        if not result:
            continue
        technicals = result["technicals"]
        checks = [
            _session_change(result) > 0,
            technicals.get("return_5d_pct", 0) > 0,
            technicals.get("distance_to_ema20_pct", 0) > 0,
        ]
        score = (sum(1 if check else -1 for check in checks) / len(checks)) * 100
        votes.append(score)
        items.append(
            {
                "symbol": symbol,
                "score": round(score, 1),
                "session_change_pct": _session_change(result),
                "return_5d_pct": technicals.get("return_5d_pct", 0),
                "above_ema20": technicals.get("distance_to_ema20_pct", 0) > 0,
            }
        )
    score = mean(votes) if votes else 0
    return {
        "label": _group_label(score, len(items) / len(symbols) if symbols else 0),
        "score": round(score, 1),
        "coverage": round(len(items) / len(symbols), 2) if symbols else 0,
        "positive_symbols": sum(1 for item in items if item["score"] > 0),
        "available_symbols": len(items),
        "configured_symbols": len(symbols),
        "symbols": items,
        "role": "confirmation_only",
    }


def _group_payload(name: str, symbols: list[str], items: list[dict], role: str) -> dict:
    coverage = len(items) / len(symbols) if symbols else 0
    score = mean([item["score"] for item in items]) if items else 0
    return {
        "label": _group_label(score, coverage),
        "score": round(score, 1),
        "weight": REGIME_GROUP_WEIGHTS.get(name, 0),
        "coverage": round(coverage, 2),
        "directional_coverage": round(coverage, 2),
        "available_symbols": len(items),
        "configured_symbols": len(symbols),
        "symbols": items,
        "role": role,
        "score_explanation": _group_score_explanation(
            score,
            "可用标的分数等权平均；每只标的由当前时段、近 5 日和趋势组成",
        ),
        "notes": _group_notes(name, items, score, coverage),
    }


def _symbol_item(
    result: dict,
    score: float,
    raw_score: float,
    score_components: dict | None = None,
) -> dict:
    technicals = result["technicals"]
    change = _session_change(result)
    return {
        "symbol": result["symbol"],
        "score": round(score, 1),
        "raw_score": round(raw_score, 1),
        "bias": 1.0,
        "gap_pct": change,
        "session_change_pct": change,
        "daily_change_pct": technicals.get("daily_change_pct", 0),
        "return_5d_pct": technicals.get("return_5d_pct", 0),
        "return_20d_pct": technicals.get("return_20d_pct", 0),
        "trend": technicals.get("trend", "mixed"),
        "trend_score": technicals.get("trend_score", 0),
        "rsi14": technicals.get("rsi14", 50),
        "score_components": score_components or {},
    }


def _direction_components(result: dict) -> dict:
    technicals = result["technicals"]
    atr_pct = max(technicals.get("atr_pct", 0), 0.5)
    session_change = _session_change(result)
    five_day_return = technicals.get("return_5d_pct", 0)
    trend_score = technicals.get("trend_score", 0)
    current = _clamp(session_change / atr_pct * 45, -45, 45)
    five_day = _clamp(
        five_day_return / (atr_pct * sqrt(5)) * 25,
        -25,
        25,
    )
    trend = _clamp(trend_score * 0.30, -30, 30)
    return {
        "current_session": _score_component(
            current,
            45,
            session_change,
            "当前时段涨跌相对 ATR 标准化",
        ),
        "five_day": _score_component(
            five_day,
            25,
            five_day_return,
            "近 5 日收益相对 ATR 标准化",
        ),
        "trend": _score_component(
            trend,
            30,
            trend_score,
            "EMA 结构与斜率形成的趋势分",
            "internal_trend_score",
        ),
    }


def _score_component(
    score: float,
    max_abs: float,
    input_value: float,
    meaning: str,
    input_unit: str = "%",
) -> dict:
    return {
        "score": round(score, 1),
        "max_abs": max_abs,
        "input_value": round(float(input_value or 0), 2),
        "input_unit": input_unit,
        "meaning": meaning,
    }


def _group_score_explanation(score: float, formula: str) -> dict:
    return {
        "current_score": round(score, 1),
        "current_meaning": _score_band(score),
        "formula": formula,
        "scale": {
            "minimum": -100,
            "maximum": 100,
            "natural_unit": None,
            "bands": [
                {"condition": "score <= -20", "meaning": "偏弱或增加风险压力"},
                {"condition": "-20 < score < +20", "meaning": "混合或不足以确认方向"},
                {"condition": "score >= +20", "meaning": "偏强或支持风险偏好"},
            ],
        },
        "how_to_use": "比较方向和强弱；不要解释成概率、收益率或价格目标",
    }


def _risk_score_explanation(groups: dict, directional_weight: float, risk_score: float) -> dict:
    contributions = {}
    for name, weight in REGIME_GROUP_WEIGHTS.items():
        group = groups[name]
        directional_coverage = group.get("directional_coverage", group["coverage"])
        effective_weight = (
            weight * directional_coverage / directional_weight if directional_weight else 0
        )
        contributions[name] = {
            "group_score": group["score"],
            "configured_weight": weight,
            "data_coverage": group["coverage"],
            "directional_coverage": directional_coverage,
            "effective_weight": round(effective_weight, 3),
            "contribution": round(group["score"] * effective_weight, 1),
        }
    return {
        **_group_score_explanation(
            risk_score,
            "指数 50% + 波动率 30% + 科技广度 20%；SOXX/IGV 明显轮动时科技广度贡献归零",
        ),
        "contributions": contributions,
        "regime_gate": (
            "总分达到 +20 仍需指数不弱且波动率压力不过高才是 risk_on；"
            "达到 -20 仍需指数偏弱且波动率未抵消才是 risk_off"
        ),
    }


def _score_band(score: float) -> str:
    if score >= 20:
        return "偏强或支持风险偏好"
    if score <= -20:
        return "偏弱或增加风险压力"
    return "混合或不足以确认方向"


def _session_change(result: dict) -> float:
    quote = result.get("session_quote") or result.get("premarket", {})
    return float(quote.get("change_pct", quote.get("gap_pct", 0)) or 0)


def _regime(risk_score: float, equity_score: float, volatility_score: float) -> str:
    if risk_score >= 20 and equity_score >= 10 and volatility_score >= -10:
        return "risk_on"
    if risk_score <= -20 and equity_score <= -10 and volatility_score <= 10:
        return "risk_off"
    return "mixed"


def _signal_agreement(
    groups: dict[str, dict], risk_score: float, directional_weight: float
) -> float:
    direction = 1 if risk_score >= 0 else -1
    matching = 0.0
    neutral = 0.0
    for name, weight in REGIME_GROUP_WEIGHTS.items():
        group = groups[name]
        active = weight * group.get("directional_coverage", group["coverage"])
        score = group["score"]
        if abs(score) < 10:
            neutral += active
        elif score * direction > 0:
            matching += active
    return (matching + neutral * 0.5) / directional_weight if directional_weight else 0


def _group_label(score: float, coverage: float) -> str:
    if coverage == 0:
        return "unavailable"
    if score >= 20:
        return "bullish"
    if score <= -20:
        return "bearish"
    return "mixed"


def _confidence_label(value: float) -> str:
    if value >= 0.65:
        return "high"
    if value >= 0.35:
        return "moderate"
    return "low"


def _group_notes(name: str, items: list[dict], score: float, coverage: float) -> list[str]:
    if coverage == 0:
        return [f"{name} data unavailable"]
    notes = [f"{name} {_group_label(score, coverage)} score {score:+.1f}"]
    movers = sorted(items, key=lambda item: abs(item["score"]), reverse=True)[:3]
    for item in movers:
        notes.append(
            f"{item['symbol']} session {item['session_change_pct']:+.2f}%, "
            f"5d {item['return_5d_pct']:+.2f}%, score {item['score']:+.1f}"
        )
    return notes


def _collect_notes(groups: dict[str, dict]) -> list[str]:
    notes: list[str] = []
    for name in ("equity", "volatility", "sector", "macro"):
        notes.extend(groups[name].get("notes", [])[:3])
    return notes


def _empty_context(note: str) -> dict:
    return {
        "regime": "unknown",
        "risk_score": 0,
        "data_coverage": 0,
        "confidence": 0,
        "signal_agreement": 0,
        "signal_confidence": 0,
        "signal_confidence_label": "low",
        "groups": {},
        "notes": [note],
        "limitations": [],
    }


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))
