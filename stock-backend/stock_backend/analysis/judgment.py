"""Human-facing stock judgment derived from raw indicators."""

from __future__ import annotations


def build_market_judgment(market_context: dict) -> dict:
    groups = market_context.get("groups", {})
    equity = groups.get("equity", {})
    volatility = groups.get("volatility", {})
    macro = groups.get("macro", {})
    sector = groups.get("sector", {})
    theme_groups = market_context.get("theme_groups", {})

    reads = {
        "equity": _market_group_read("指数环境", equity),
        "volatility": _volatility_read(volatility),
        "macro": _macro_read(macro),
        "sector": _technology_style_read(sector),
        "themes": _theme_groups_read(theme_groups),
    }
    intelligence = _market_key_intelligence(market_context, reads)
    display = _market_display_contract(market_context)

    return {
        "headline": _market_headline(market_context, reads),
        "stance": _market_stance(market_context, reads),
        "display": display,
        "key_intelligence": intelligence,
        "reads": reads,
        "scenarios": _market_scenarios(market_context, reads),
        "ui_zones": [
            {
                "zone": "market_header",
                "title": "市场总览",
                "fields": [
                    "judgment.display.market_state",
                    "judgment.display.signal_quality",
                    "judgment.display.data_quality",
                    "judgment.headline",
                ],
            },
            {
                "zone": "cross_asset_cards",
                "title": "影响大盘的四块信号",
                "fields": [
                    "judgment.reads.equity",
                    "judgment.reads.volatility",
                    "judgment.reads.macro",
                    "judgment.reads.sector",
                ],
            },
            {
                "zone": "theme_breadth",
                "title": "观察组广度",
                "fields": ["judgment.reads.themes"],
            },
            {
                "zone": "macro_strip",
                "title": "黄金 / 美元 / 油 / 债",
                "fields": ["judgment.reads.macro.components"],
            },
            {
                "zone": "scenario_cards",
                "title": "可能发生的市场情景",
                "fields": ["judgment.scenarios"],
            },
        ],
    }


def build_stock_judgment(stock: dict, market_context: dict) -> dict:
    technicals = stock["technicals"]
    levels = stock["levels"]
    options = stock.get("options") or {}
    setups = stock.get("setups", {})
    price = _stock_price(stock)

    ema = _ema_read(price, technicals)
    bollinger = _bollinger_read(price, technicals)
    level_read = _level_read(price, levels)
    option_read = _option_read(options)
    relative_read = _relative_strength_read(stock.get("relative_strength", {}))
    group_read = _group_context_read(stock.get("group_context", {}))
    scenarios = _scenarios(stock, market_context, ema, bollinger, level_read, option_read)

    return {
        "stance": _stance(stock, market_context),
        "headline": _headline(stock, market_context),
        "signal": stock.get("signal", {}),
        "group_read": group_read,
        "key_points": _key_points(
            ema, bollinger, level_read, relative_read, group_read, option_read, setups
        ),
        "technical_read": {
            "ema": ema,
            "bollinger": bollinger,
            "levels": level_read,
            "relative_strength": relative_read,
            "peer_group": group_read,
        },
        "option_read": option_read,
        "scenarios": scenarios,
        "ui_priority": {
            "show_first": [
                "headline",
                "signal",
                "key_points",
                "technical_read",
                "option_read",
                "scenarios",
            ],
            "hide_by_default": ["options.unusual_activity"],
        },
    }


def _market_group_read(title: str, group: dict) -> dict:
    label = group.get("label", "unavailable")
    score = group.get("score", 0)
    symbols = group.get("symbols", [])
    drivers = sorted(symbols, key=lambda item: abs(item.get("score", 0)), reverse=True)[:3]

    return {
        "title": title,
        "label": _localize_market_label(label),
        "state": label,
        "score": score,
        "summary": _market_group_summary(title, label, drivers),
        "score_role": "internal_heuristic_no_natural_unit",
        "show_score_in_primary_ui": False,
        "score_explanation": group.get("score_explanation", {}),
        "drivers": [
            {
                "symbol": item["symbol"],
                "score": item["score"],
                "gap_pct": item["gap_pct"],
                "trend": item["trend"],
                "meaning": _symbol_market_meaning(item["symbol"], item),
                "score_components": item.get("score_components", {}),
            }
            for item in drivers
        ],
        "display_drivers": [
            {
                "symbol": item["symbol"],
                "session_move_pct": item["gap_pct"],
                "value": f"{item['gap_pct']:+.2f}%",
                "meaning": _symbol_market_meaning(item["symbol"], item),
            }
            for item in drivers
        ],
    }


def _volatility_read(group: dict) -> dict:
    read = _market_group_read("波动率环境", group)
    state = group.get("label", "unavailable")
    drivers = group.get("symbols", [])
    session_move = float(drivers[0].get("gap_pct", 0) or 0) if drivers else 0
    if state == "bullish":
        read["label"] = "支持风险偏好"
        read["risk_impact"] = "supportive"
    elif state == "bearish":
        read["label"] = "压制风险偏好"
        read["risk_impact"] = "headwind"
    elif state == "mixed":
        if session_move <= -0.5:
            read["label"] = "轻微支持风险偏好"
            read["risk_impact"] = "mildly_supportive"
        elif session_move >= 0.5:
            read["label"] = "轻微压制风险偏好"
            read["risk_impact"] = "mild_headwind"
        else:
            read["label"] = "影响接近中性"
            read["risk_impact"] = "neutral"
    else:
        read["label"] = "不可用"
        read["risk_impact"] = "unknown"
    if drivers:
        read["summary"] = (
            f"VIXY 当前时段 {session_move:+.2f}%，{read['label']}；力度不足时不能单独确认大盘方向。"
        )
    else:
        read["summary"] = "VIXY 数据不可用，无法判断短线波动率压力。"
    read["proxy_limitation"] = "VIXY tracks short-term VIX futures rather than spot VIX"
    return read


def _technology_style_read(group: dict) -> dict:
    read = _market_group_read("科技风格", group)
    relationship = group.get("relationship", {})
    style_state = relationship.get("state", "no_clear_style_signal")
    read["style_state"] = style_state
    read["aggregate_state"] = group.get("label", "unavailable")
    read["relationship"] = relationship
    read["label"] = relationship.get("label", read["label"])
    read["broad_market_effect"] = relationship.get("broad_market_effect", "unknown")
    if relationship.get("is_rotation"):
        spread = relationship.get("session_spread_pct", 0)
        read["summary"] = (
            f"科技内部轮动：{read['label']}，SOXX 相对 IGV 的当前时段差为 {spread:+.2f} 个百分点；"
            "这用于选择方向占优的科技组，不作为大盘整体看多或看空确认。"
        )
    elif style_state == "broad_tech_strength":
        read["summary"] = "SOXX 与 IGV 同步走强，科技广度支持风险偏好。"
    elif style_state == "broad_tech_weakness":
        read["summary"] = "SOXX 与 IGV 同步承压，科技广度压制风险偏好。"
    else:
        read["summary"] = "SOXX 与 IGV 尚未形成同步方向，暂不提供科技广度确认。"
    return read


def _macro_read(group: dict) -> dict:
    components = {}
    for item in group.get("symbols", []):
        components[item["symbol"]] = {
            "symbol": item["symbol"],
            "score": item["score"],
            "raw_score": item["raw_score"],
            "gap_pct": item["gap_pct"],
            "trend": item["trend"],
            "meaning": _symbol_market_meaning(item["symbol"], item),
            "score_components": item.get("score_components", {}),
        }

    assessment = _macro_assessment(components)
    return {
        "title": "宏观背景",
        "label": assessment["label"] if components else "不可用",
        "state": group.get("label", "unavailable"),
        "risk_impact": assessment["risk_impact"],
        "assessment": assessment,
        "score": group.get("score", 0),
        "score_role": "context_only_internal_heuristic",
        "show_score_in_primary_ui": False,
        "score_explanation": group.get("score_explanation", {}),
        "summary": _macro_summary(components),
        "components": components,
        "display_components": [
            {
                "symbol": item["symbol"],
                "session_move_pct": item["gap_pct"],
                "value": f"{item['gap_pct']:+.2f}%",
                "meaning": _symbol_market_meaning(item["symbol"], item),
            }
            for item in group.get("symbols", [])
        ],
        "contributes_to_risk_score": False,
    }


def _theme_groups_read(theme_groups: dict) -> dict:
    cards = []
    for name, group in theme_groups.get("groups", {}).items():
        cards.append(
            {
                "group": name,
                "title": group.get("display_name", name),
                "state": group.get("label", "unavailable"),
                "label": _localize_market_label(group.get("label", "unavailable")),
                "score": group.get("score", 0),
                "breadth": f"{group.get('positive_symbols', 0)}/{group.get('available_symbols', 0)}",
                "benchmark_symbol": group.get("benchmark_symbol"),
                "benchmark_alignment": group.get("benchmark_alignment"),
                "show_score_in_primary_ui": False,
            }
        )
    return {
        "title": "观察组广度",
        "state": theme_groups.get("state", "mixed"),
        "summary": theme_groups.get("summary", "观察组数据不可用。"),
        "groups": cards,
        "contributes_to_risk_score": False,
        "show_score_in_primary_ui": False,
    }


def _market_display_contract(market_context: dict) -> dict:
    regime = market_context.get("regime", "unknown")
    confidence = market_context.get("signal_confidence_label", "low")
    coverage = float(market_context.get("data_coverage", 0) or 0)
    regime_labels = {
        "risk_on": "偏进攻",
        "risk_off": "偏防守",
        "mixed": "方向混合",
        "unknown": "暂不可用",
    }
    confidence_labels = {"low": "低", "moderate": "中", "high": "高"}
    confidence_explanations = {
        "low": "各块信号较弱或互相抵消，不适合预设方向",
        "moderate": "部分信号一致，仍需等待价格触发确认",
        "high": "多块环境信号一致，但这不是上涨或下跌概率",
    }
    if coverage >= 0.95:
        coverage_label = "数据完整"
    elif coverage >= 0.7:
        coverage_label = "部分缺失"
    else:
        coverage_label = "数据不足"

    return {
        "schema_version": "2.3",
        "market_state": {
            "title": "市场状态",
            "state": regime,
            "label": regime_labels.get(regime, regime),
        },
        "signal_quality": {
            "title": "环境信号一致性",
            "state": confidence,
            "label": confidence_labels.get(confidence, confidence),
            "explanation": confidence_explanations.get(confidence, "信号质量不可用"),
            "not_probability": True,
        },
        "data_quality": {
            "title": "数据状态",
            "coverage": coverage,
            "label": coverage_label,
        },
        "score_policy": {
            "show_internal_scores": False,
            "show_scores_on_demand": True,
            "placement_if_needed": "info_popover_or_debug_panel",
            "reason": "scores are normalized heuristic values without natural units",
            "hidden_fields": [
                "market_context.risk_score",
                "market_context.signal_confidence",
                "market_context.groups.*.score",
                "market_context.judgment.reads.*.score",
                "market_context.judgment.reads.*.drivers[].score",
                "market_context.judgment.reads.macro.components.*.score",
                "market_context.judgment.reads.macro.components.*.raw_score",
                "market_context.judgment.reads.themes.groups[].score",
            ],
        },
        "overall_score_explanation": market_context.get("risk_score_explanation", {}),
    }


def _market_headline(market_context: dict, reads: dict) -> str:
    regime = market_context.get("regime", "unknown")
    sector_state = reads["sector"].get("aggregate_state", reads["sector"]["state"])
    vol_state = reads["volatility"]["state"]
    theme_state = reads.get("themes", {}).get("state")

    if regime == "risk_off":
        return "大盘偏防守；优先控制仓位，等待波动率和科技广度压力缓和。"
    if regime == "risk_on":
        return "大盘偏进攻；顺势机会更容易成立，但仍需避开过热标的。"
    if sector_state == "bearish":
        return "大盘整体混合，但 SOXX 与 IGV 同步承压；科技股反弹需要更强确认。"
    if reads["sector"].get("relationship", {}).get("is_rotation"):
        return (
            f"大盘整体混合，科技内部呈现{reads['sector']['label']}；选组比押注整个科技板块更重要。"
        )
    if theme_state == "broad_tech_weakness":
        return "大盘整体混合，但四个科技观察组多数走弱；优先等待组内广度止跌。"
    if vol_state == "bearish":
        return "大盘整体混合，但波动率压力偏高；开盘追单风险上升。"
    return "大盘信号混合；当前更适合按触发条件观察，而不是预设方向。"


def _market_stance(market_context: dict, reads: dict) -> str:
    if market_context.get("regime") == "risk_off":
        return "defensive"
    if market_context.get("regime") == "risk_on":
        return "offensive_selective"
    if (
        reads["sector"].get("aggregate_state", reads["sector"]["state"]) == "bearish"
        or reads["volatility"]["state"] == "bearish"
        or reads.get("themes", {}).get("state") == "broad_tech_weakness"
    ):
        return "cautious_selective"
    return "neutral_wait_for_confirmation"


def _market_key_intelligence(market_context: dict, reads: dict) -> list[str]:
    points = [
        reads["equity"]["summary"],
        reads["volatility"]["summary"],
        reads["macro"]["summary"],
        reads["sector"]["summary"],
        reads.get("themes", {}).get("summary", ""),
    ]
    macro_components = reads["macro"].get("components", {})
    uup = macro_components.get("US.UUP")
    uso = macro_components.get("US.USO")
    gld = macro_components.get("US.GLD")
    tlt = macro_components.get("US.TLT")

    if uup and uup["raw_score"] >= 12:
        points.append("美元走强通常压制成长股和高估值风险资产。")
    if uso and uso["raw_score"] >= 20:
        points.append("油价走强会增加通胀/利率担忧，可能压制风险偏好。")
    if gld and gld["raw_score"] >= 20:
        points.append("黄金走强可能来自避险、实际利率或美元变化，单独不作为大盘看空信号。")
    if tlt and tlt["raw_score"] <= -12:
        points.append("TLT 走弱通常对应长端利率压力，成长股反弹质量要打折。")
    if reads["sector"]["score"] <= -15:
        points.append("SOXX 与 IGV 同步偏弱，个股反弹需要所属观察组与基准共同止跌。")
    if market_context.get("confidence", 0) < 0.8:
        points.append("市场数据覆盖不足，大盘判断可信度下降。")

    return _dedupe(points)[:8]


def _market_scenarios(market_context: dict, reads: dict) -> list[dict]:
    scenarios = [
        {
            "case": "risk_on_confirmation",
            "label": "风险偏好确认",
            "trigger": "SPY/QQQ 转强，同时 VIXY 回落，SOXX 与 IGV 不再拖累",
            "meaning": "反弹 setup 的成功率提高，可更积极观察强势标的",
            "direction": "up",
        },
        {
            "case": "risk_off_escalation",
            "label": "防守升级",
            "trigger": "VIXY 继续上行，QQQ/SOXX/IGV 同时走弱",
            "meaning": "个股支撑更容易失效，优先避免抄底",
            "direction": "down",
        },
    ]

    if _macro_headwind(reads["macro"].get("components", {})):
        scenarios.append(
            {
                "case": "macro_headwind",
                "label": "宏观压制",
                "trigger": "美元/油价/利率压力继续走强",
                "meaning": "高波动成长股容易反弹失败，仓位和确认条件要更严格",
                "direction": "risk_down",
            }
        )

    if reads["sector"]["score"] <= -10:
        scenarios.append(
            {
                "case": "sector_drag",
                "label": "科技广度拖累",
                "trigger": "SOXX 与 IGV 继续弱于 SPY/QQQ",
                "meaning": "科技个股即使靠近支撑，也需要等待所属组和领导力 ETF 止跌",
                "direction": "sector_down",
            }
        )

    style = reads["sector"].get("relationship", {})
    if style.get("is_rotation"):
        scenarios.append(
            {
                "case": "technology_style_rotation",
                "label": style.get("label", "科技内部轮动"),
                "trigger": "SOXX 与 IGV 继续反向，且相对强弱差维持",
                "meaning": "优先观察占优风格中的强势标的，不用科技 ETF 的平均结果判断所有科技股",
                "direction": "rotation",
            }
        )

    theme_state = reads.get("themes", {}).get("state")
    if theme_state == "rotation":
        scenarios.append(
            {
                "case": "technology_rotation",
                "label": "科技内部轮动",
                "trigger": "半导体、光模块、算力和软件组继续出现强弱分化",
                "meaning": "大盘指数不能代表所有组，优先只观察组内相对强势标的",
                "direction": "rotation",
            }
        )

    if market_context.get("regime") == "mixed":
        scenarios.append(
            {
                "case": "range_chop",
                "label": "震荡消耗",
                "trigger": "指数、波动率和板块信号继续互相抵消",
                "meaning": "更适合等关键位触发，不适合提前押方向",
                "direction": "neutral",
            }
        )

    return scenarios[:5]


def _market_group_summary(title: str, label: str, drivers: list[dict]) -> str:
    localized = _localize_market_label(label)
    if not drivers:
        return f"{title}数据不可用。"
    driver_text = "，".join(
        f"{item['symbol']} {_symbol_market_meaning(item['symbol'], item)}" for item in drivers[:2]
    )
    return f"{title}{localized}；主要观察：{driver_text}。"


def _macro_summary(components: dict) -> str:
    if not components:
        return "宏观数据不可用。"
    assessment = _macro_assessment(components)
    parts = []
    for symbol, label in (
        ("US.UUP", "美元"),
        ("US.TLT", "长债"),
        ("US.GLD", "黄金"),
        ("US.USO", "油价"),
    ):
        item = components.get(symbol)
        if item:
            direction = (
                "走强" if item["raw_score"] > 10 else "走弱" if item["raw_score"] < -10 else "中性"
            )
            parts.append(f"{label}{direction}")
    return f"宏观影响判断为{assessment['label']}；" + "，".join(parts) + "。"


def _macro_assessment(components: dict) -> dict:
    impacts = {}
    if "US.UUP" in components:
        impacts["US.UUP"] = -float(components["US.UUP"].get("raw_score", 0) or 0)
    if "US.TLT" in components:
        impacts["US.TLT"] = float(components["US.TLT"].get("raw_score", 0) or 0) * 0.5
    if "US.USO" in components:
        impacts["US.USO"] = -float(components["US.USO"].get("raw_score", 0) or 0)

    balance = sum(impacts.values()) / len(impacts) if impacts else 0
    has_support = any(value >= 10 for value in impacts.values())
    has_headwind = any(value <= -10 for value in impacts.values())
    if balance >= 15:
        risk_impact, label = "supportive", "风险条件改善"
    elif balance <= -15:
        risk_impact, label = "headwind", "宏观压力偏高"
    elif has_support and has_headwind:
        risk_impact, label = "offsetting", "多空因素抵消"
    else:
        risk_impact, label = "neutral", "宏观影响有限"
    primary = max(impacts, key=lambda symbol: abs(impacts[symbol])) if impacts else None
    return {
        "risk_impact": risk_impact,
        "label": label,
        "balance": round(balance, 1),
        "primary_driver": primary,
        "component_impacts": {symbol: round(value, 1) for symbol, value in impacts.items()},
        "gold_treatment": "GLD is shown separately because gold can reflect haven demand, real yields, or USD moves",
        "contributes_to_risk_score": False,
    }


def _macro_headwind(components: dict) -> bool:
    headwinds = 0
    if components.get("US.UUP", {}).get("raw_score", 0) >= 20:
        headwinds += 1
    if components.get("US.TLT", {}).get("raw_score", 0) <= -20:
        headwinds += 1
    if components.get("US.USO", {}).get("raw_score", 0) >= 25:
        headwinds += 1
    return headwinds >= 2


def _symbol_market_meaning(symbol: str, item: dict) -> str:
    raw = item.get("raw_score", item.get("score", 0))
    score = item.get("score", 0)
    if symbol in {"US.SPY", "US.QQQ", "US.IWM"}:
        return (
            "指数本身走强支持风险偏好"
            if score >= 20
            else "指数偏弱拖累风险偏好"
            if score <= -20
            else "指数信号中性"
        )
    if symbol == "US.VIXY":
        return (
            "波动率上行，偏防守"
            if score < -10
            else "波动率压力缓和"
            if score > 10
            else "波动率中性"
        )
    if symbol == "US.UUP":
        return (
            "美元走强，对成长股偏压制"
            if raw > 10
            else "美元走弱，对风险资产压力减轻"
            if raw < -10
            else "美元中性"
        )
    if symbol == "US.TLT":
        return (
            "长债走强，利率压力缓和或避险升温"
            if raw > 10
            else "长债走弱，利率压力可能上升"
            if raw < -10
            else "长债中性"
        )
    if symbol == "US.GLD":
        return (
            "黄金走强，偏避险"
            if raw > 10
            else "黄金走弱，避险需求下降"
            if raw < -10
            else "黄金中性"
        )
    if symbol == "US.USO":
        return (
            "油价走强，通胀压力风险上升"
            if raw > 10
            else "油价走弱，宏观压力缓和"
            if raw < -10
            else "油价中性"
        )
    if symbol == "US.SOXX":
        return "SOX 代理偏强" if score >= 20 else "SOX 代理偏弱" if score <= -20 else "SOX 代理中性"
    if symbol == "US.IGV":
        return (
            "软件领导力偏强"
            if score >= 20
            else "软件领导力偏弱"
            if score <= -20
            else "软件领导力中性"
        )
    return "市场 proxy"


def _ema_read(price: float, technicals: dict) -> dict:
    distances = {}
    for label, key in (("ema20", "ema20"), ("ema50", "ema50"), ("ema200", "ema200")):
        value = technicals.get(key)
        distances[label] = _pct_distance(price, value) if value else None

    valid_distances = [value for value in distances.values() if value is not None]
    above_count = sum(1 for value in valid_distances if value >= 0)
    below_count = sum(1 for value in valid_distances if value < 0)

    if above_count == len(valid_distances) and valid_distances:
        state = "above_key_emas"
        label = "站上关键 EMA"
        summary = "价格站上 EMA20/50/200，趋势背景偏支持"
    elif below_count == len(valid_distances) and valid_distances:
        state = "below_key_emas"
        label = "跌破关键 EMA"
        summary = "价格低于 EMA20/50/200，反弹需要确认"
    elif distances.get("ema20") is not None and distances["ema20"] < 0:
        state = "below_short_ema"
        label = "低于短期 EMA"
        summary = "价格低于 EMA20，短线动能仍弱"
    else:
        state = "mixed_ema"
        label = "EMA 结构混合"
        summary = "价格在关键 EMA 之间，趋势信号不干净"

    return {
        "state": state,
        "label": label,
        "summary": summary,
        "distances_pct": {
            key: round(value, 2) if value is not None else None for key, value in distances.items()
        },
    }


def _bollinger_read(price: float, technicals: dict) -> dict:
    bollinger = technicals.get("bollinger", {})
    upper = bollinger.get("upper")
    lower = bollinger.get("lower")
    if upper is not None and lower is not None and upper != lower:
        percent_b = round((price - lower) / (upper - lower), 2)
    else:
        percent_b = bollinger.get("percent_b", 0.5)
    width_percentile = bollinger.get("width_percentile_120d", 0.5)
    trend = technicals.get("trend", "mixed")
    adx = technicals.get("adx14")

    if percent_b <= 0:
        position = "below_lower_band"
        label = "跌破布林下轨"
    elif percent_b <= 0.15:
        position = "near_lower_band"
        label = "贴近布林下轨"
    elif percent_b <= 0.35:
        position = "lower_half"
        label = "布林下半区"
    elif percent_b >= 1:
        position = "above_upper_band"
        label = "突破布林上轨"
    elif percent_b >= 0.85:
        position = "near_upper_band"
        label = "贴近布林上轨"
    else:
        position = "middle_band"
        label = "布林中性区"

    if width_percentile <= 0.15:
        width_state = "compressed"
        width_label = "波动压缩"
    elif width_percentile >= 0.85:
        width_state = "expanded"
        width_label = "波动扩张"
    else:
        width_state = "normal"
        width_label = "波动正常"

    if percent_b >= 0.85 and trend == "uptrend" and (adx or 0) >= 25:
        behavior = "upper_band_trend"
        behavior_label = "强趋势贴上轨"
        interpretation = "上轨在强趋势中常代表持续买盘，不应单独视为卖点"
    elif percent_b <= 0.15 and trend == "downtrend" and (adx or 0) >= 25:
        behavior = "lower_band_trend"
        behavior_label = "强趋势贴下轨"
        interpretation = "下轨在强下跌中可能持续扩张，不应单独视为抄底点"
    elif percent_b <= 0.15 and technicals.get("trend_strength") == "weak":
        behavior = "mean_reversion_watch"
        behavior_label = "均值回归观察"
        interpretation = "弱趋势环境接近下轨时可观察反弹，但仍需支撑与价格确认"
    elif percent_b >= 0.85 and technicals.get("trend_strength") == "weak":
        behavior = "upper_reversion_watch"
        behavior_label = "回归中轨观察"
        interpretation = "弱趋势环境接近上轨时追高风险增加，但不等于立即反转"
    else:
        behavior = "context_only"
        behavior_label = "仅作位置参考"
        interpretation = "布林位置需要结合趋势强度、支撑压力和成交量解释"

    return {
        "position": position,
        "label": label,
        "width_state": width_state,
        "width_label": width_label,
        "behavior": behavior,
        "behavior_label": behavior_label,
        "interpretation": interpretation,
        "summary": f"{label}; {width_label}; {behavior_label}",
        "percent_b": percent_b,
        "width_pct": bollinger.get("width_pct"),
        "width_percentile_120d": width_percentile,
        "adx14": adx,
        "trend_strength": technicals.get("trend_strength", "unavailable"),
        "position_price_source": "session_quote",
        "band_source": "latest_completed_daily_bars",
    }


def _level_read(price: float, levels: dict) -> dict:
    support = levels["support_zone"]
    resistance = levels["resistance_zone"]
    support_distance = _distance_to_zone_pct(price, support)
    resistance_distance = _distance_to_zone_pct(price, resistance)

    if support["low"] <= price <= support["high"]:
        state = "inside_support"
        label = "正在支撑区"
    elif support_distance <= 1.5:
        state = "near_support"
        label = "接近支撑区"
    elif price < support["low"]:
        state = "below_support"
        label = "跌破支撑区"
    elif price > resistance["high"]:
        state = "above_resistance"
        label = "站上原压力区"
    elif resistance_distance <= 1.5:
        state = "near_resistance"
        label = "接近压力区"
    else:
        state = "between_levels"
        label = "位于支撑和压力之间"

    return {
        "state": state,
        "label": label,
        "summary": f"{label}; 支撑 {support['low']}-{support['high']}，压力 {resistance['low']}-{resistance['high']}",
        "support_distance_pct": support_distance,
        "resistance_distance_pct": resistance_distance,
        "support_source": levels.get("support_source", []),
        "resistance_source": levels.get("resistance_source", []),
    }


def _option_read(options: dict) -> dict:
    if not options:
        return {
            "label": "无期权摘要",
            "summary": "没有可用期权摘要",
            "display_contracts": False,
            "key_metrics": [],
            "risk_labels": [],
            "directional_value": "none",
        }

    risk_labels = [reminder["label"] for reminder in options.get("risk_reminders", [])]
    expected_move = options.get("straddle_implied_move_pct", options.get("expected_move_pct"))
    atm_iv = options.get("atm_iv", options.get("average_iv"))
    iv_hv_ratio = options.get("iv_hv_ratio")
    quote_quality = options.get("quote_quality", {})
    positioning = options.get("positioning", {})
    move_consumed = options.get("current_move_vs_implied_ratio")

    summary_parts = []
    if expected_move is not None:
        summary_parts.append(f"最近到期跨式隐含范围 {expected_move}%")
    if atm_iv is not None:
        summary_parts.append(f"ATM IV {atm_iv:.0%}")
    if iv_hv_ratio is not None:
        summary_parts.append(f"IV/实波 {iv_hv_ratio:.2f}x")
    if quote_quality:
        summary_parts.append(f"报价质量 {quote_quality.get('status', 'unknown')}")
        if not quote_quality.get("timing_reliable", True):
            summary_parts.append("期权报价按上一常规时段解释")
    if move_consumed is not None:
        summary_parts.append(f"当前移动占隐含范围 {move_consumed:.0%}")

    return {
        "label": "期权大波动提醒" if risk_labels else "期权中性",
        "summary": "; ".join(summary_parts) if summary_parts else "期权数据可用",
        "display_contracts": False,
        "key_metrics": [
            {"label": "跨式隐含范围", "value": expected_move, "unit": "%"},
            {
                "label": "ATM IV",
                "value": round(atm_iv * 100, 1) if atm_iv is not None else None,
                "unit": "%",
            },
            {"label": "IV/实波", "value": iv_hv_ratio, "unit": "ratio"},
            {
                "label": "已消耗隐含范围",
                "value": round(move_consumed * 100, 1) if move_consumed is not None else None,
                "unit": "%",
            },
        ],
        "risk_labels": risk_labels,
        "quote_quality": quote_quality,
        "positioning": {
            "call_oi_level": positioning.get("call_oi_level"),
            "put_oi_level": positioning.get("put_oi_level"),
            "dealer_gamma_sign": positioning.get("dealer_gamma_sign", "unknown"),
        },
        "directional_value": "none",
        "limitation": "期权摘要用于判断波动幅度；P/C、OI 和成交量不直接判断方向",
    }


def _scenarios(
    stock: dict,
    market_context: dict,
    ema: dict,
    bollinger: dict,
    levels: dict,
    option_read: dict,
) -> list[dict]:
    price = _stock_price(stock)
    raw_levels = stock["levels"]
    support = raw_levels["support_zone"]
    resistance = raw_levels["resistance_zone"]
    previous_close = stock["previous_close"]
    scenarios = []

    if levels["state"] in {"near_support", "inside_support"}:
        scenarios.append(
            {
                "case": "bounce_confirmation",
                "label": "反弹确认",
                "trigger": f"守住 {support['low']}-{support['high']} 并重新站回 {previous_close:.2f}",
                "meaning": "支撑有效，反弹尝试可信度提高",
                "direction": "up",
                "confidence": "needs_open_confirmation",
            }
        )
        scenarios.append(
            {
                "case": "support_failure",
                "label": "支撑失败",
                "trigger": f"跌破 {support['low']}",
                "meaning": "反弹条件失效，下行可能延续",
                "direction": "down",
                "confidence": "needs_open_confirmation",
            }
        )

    if levels["state"] == "above_resistance":
        scenarios.append(
            {
                "case": "breakout_hold",
                "label": "突破保持",
                "trigger": f"回踩后守住 {resistance['low']}-{resistance['high']}",
                "meaning": "原压力转为支撑，突破延续的可信度提高",
                "direction": "up",
                "confidence": "needs_price_confirmation",
            }
        )
        scenarios.append(
            {
                "case": "failed_breakout",
                "label": "假突破",
                "trigger": f"重新跌回 {resistance['low']} 下方",
                "meaning": "突破条件失效，追高风险上升",
                "direction": "down",
                "confidence": "needs_price_confirmation",
            }
        )

    if resistance["low"] > price and support["high"] < resistance["low"]:
        scenarios.append(
            {
                "case": "range_trade",
                "label": "区间震荡",
                "trigger": f"维持在 {support['high']} 到 {resistance['low']} 之间",
                "meaning": "价格没有明确方向确认",
                "direction": "neutral",
                "confidence": "base_case" if market_context["regime"] == "mixed" else "secondary",
            }
        )

    if "短期期权放大观察" in option_read.get("risk_labels", []):
        positioning = option_read.get("positioning", {})
        call_level = positioning.get("call_oi_level")
        put_level = positioning.get("put_oi_level")
        scenarios.append(
            {
                "case": "short_dated_option_levels",
                "label": "短期期权关键位",
                "trigger": f"价格接近 put OI {put_level} 或 call OI {call_level}",
                "meaning": "临近到期的对冲可能放大波动，但 dealer gamma 正负未知，不能预判方向",
                "direction": "two_way",
                "confidence": "context_only",
            }
        )

    if bollinger["width_state"] == "compressed":
        scenarios.append(
            {
                "case": "volatility_expansion",
                "label": "波动扩张",
                "trigger": "突破压缩区间",
                "meaning": "日线波动可能放大，方向未知",
                "direction": "two_way",
                "confidence": "watch_only",
            }
        )

    return scenarios[:4]


def _stance(stock: dict, market_context: dict) -> str:
    tags = {item["tag"] for item in stock.get("setups", {}).get("tags", [])}
    if stock["bucket"] == "watch":
        return "watch_now"
    signal = stock.get("signal", {})
    if signal.get("direction") == "bearish" and signal.get("confidence") != "low":
        return "avoid_until_invalidation"
    if signal.get("direction") == "bullish" and signal.get("confidence") != "low":
        return "observe_for_trigger"
    if "bounce_candidate" in tags:
        return "observe_for_confirmation"
    if "breakdown_risk" in tags:
        return "avoid_until_reclaim"
    if market_context["regime"] == "risk_off":
        return "defensive_observe"
    return "low_priority"


def _headline(stock: dict, market_context: dict) -> str:
    tags = {item["tag"] for item in stock.get("setups", {}).get("tags", [])}
    signal = stock.get("signal", {})
    if signal.get("direction") == "bullish" and signal.get("confidence") in {"moderate", "high"}:
        return f"{stock['symbol']} 的{_signal_evidence_text(signal)}偏多，但必须等待触发条件成立。"
    if signal.get("direction") == "bearish" and signal.get("confidence") in {"moderate", "high"}:
        return f"{stock['symbol']} 的{_signal_evidence_text(signal)}偏弱，未收回失效位前不适合把下跌当成抄底信号。"
    peer_label = stock.get("group_context", {}).get("peer_label", "mixed")
    group_background = _localize_market_label(peer_label)
    if "bounce_candidate" in tags:
        return f"{stock['symbol']} 是支撑区反弹候选，但同组股票背景为{group_background}，需要价格确认。"
    if "large_implied_move" in tags:
        return f"{stock['symbol']} 的期权定价提示波动幅度较大，但没有可靠方向结论。"
    if "volatility_squeeze" in tags:
        return f"{stock['symbol']} 出现日线波动压缩，后续可能扩张，但方向未知。"
    if "relative_band_compression" in tags:
        return f"{stock['symbol']} 的布林带相对自身历史收窄，但绝对波动仍高，不能当作低波动蓄势。"
    return f"{stock['symbol']} 暂时没有高置信度日线 setup。"


def _localize_market_label(label: str) -> str:
    return {
        "bullish": "偏强",
        "bearish": "偏弱",
        "mixed": "混合",
        "unavailable": "不可用",
    }.get(label, label)


def _key_points(
    ema: dict,
    bollinger: dict,
    levels: dict,
    relative_strength: dict,
    group_read: dict,
    option_read: dict,
    setups: dict,
) -> list[str]:
    points = [
        ema["summary"],
        relative_strength["summary"],
        group_read["summary"],
        bollinger["summary"],
        levels["summary"],
    ]
    if option_read.get("key_metrics"):
        points.append(option_read["summary"])
    for item in setups.get("confirmation_needed", [])[:2]:
        points.append(item)
    return points[:6]


def _relative_strength_read(relative_strength: dict) -> dict:
    state = relative_strength.get("state", "unavailable")
    return {
        "state": state,
        "label": {
            "outperforming": "相对强势",
            "underperforming": "相对弱势",
            "mixed": "相对表现混合",
            "unavailable": "相对强度不可用",
        }.get(state, state),
        "summary": relative_strength.get("summary", "缺少可比较的基准数据"),
        "group_benchmark": relative_strength.get("group_benchmark", {}),
        "market": relative_strength.get("market", {}),
    }


def _group_context_read(group_context: dict) -> dict:
    peer_label = group_context.get("peer_label", "unavailable")
    display_name = group_context.get("display_name") or "所属观察组"
    benchmark = group_context.get("benchmark_symbol")
    if peer_label == "unavailable":
        summary = f"{display_name}同组数据不足"
    else:
        summary = (
            f"{display_name}同组股票{_localize_market_label(peer_label)}，"
            f"基准 {benchmark or '不可用'}，对齐状态 {group_context.get('benchmark_alignment', 'unavailable')}"
        )
    return {
        **group_context,
        "peer_label_localized": _localize_market_label(peer_label),
        "summary": summary,
    }


def _signal_evidence_text(signal: dict) -> str:
    labels = {
        "price setup": "价格形态",
        "support failure": "支撑失效",
        "completed-daily trend": "已完成日线趋势",
        "relative strength": "相对强度",
        "relative weakness": "相对弱势",
        "peer group": "同组股票",
        "market regime": "大盘环境",
    }
    translated = [labels.get(item, item) for item in signal.get("evidence", [])]
    return "与".join(translated) if translated else "条件证据"


def _stock_price(stock: dict) -> float:
    quote = stock.get("session_quote") or stock.get("premarket", {})
    return float(quote["price"])


def _pct_distance(price: float, reference: float | None) -> float | None:
    if reference is None or reference == 0:
        return None
    return (price - reference) / reference * 100


def _distance_to_zone_pct(price: float, zone: dict) -> float:
    if zone["low"] <= price <= zone["high"]:
        return 0.0
    if price < zone["low"]:
        return round((zone["low"] - price) / price * 100, 2)
    return round((price - zone["high"]) / price * 100, 2)


def _dedupe(values: list[str]) -> list[str]:
    seen = set()
    result = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result
