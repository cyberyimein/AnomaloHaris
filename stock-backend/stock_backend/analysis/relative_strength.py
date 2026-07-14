"""Relative-strength context for a watchlist symbol."""

from __future__ import annotations


def summarize_relative_strength(
    stock: dict,
    group_benchmark: dict | None,
    market_benchmark: dict | None,
) -> dict:
    group = _comparison(stock, group_benchmark)
    market = _comparison(stock, market_benchmark)
    primary = group if group["available"] else market

    if not primary["available"]:
        state = "unavailable"
        summary = "缺少可比较的基准数据"
    else:
        five_day = primary["excess_return_5d_pct"]
        twenty_day = primary["excess_return_20d_pct"]
        if five_day >= 1 and twenty_day >= 2:
            state = "outperforming"
            summary = f"5日和20日均跑赢 {primary['benchmark']}，相对强度支持延续观察"
        elif five_day <= -1 and twenty_day <= -2:
            state = "underperforming"
            summary = f"5日和20日均跑输 {primary['benchmark']}，反弹质量需要打折"
        else:
            state = "mixed"
            summary = f"相对 {primary['benchmark']} 的5日与20日表现不一致"

    return {
        "state": state,
        "summary": summary,
        "group_benchmark": group,
        "market": market,
        "role": "directional_context",
        "evidence_level": "moderate_when_horizons_agree",
    }


def _comparison(stock: dict, benchmark: dict | None) -> dict:
    if not benchmark:
        return {
            "available": False,
            "benchmark": None,
            "excess_return_5d_pct": None,
            "excess_return_20d_pct": None,
        }

    stock_technicals = stock["technicals"]
    benchmark_technicals = benchmark["technicals"]
    return {
        "available": True,
        "benchmark": benchmark["symbol"],
        "excess_return_5d_pct": round(
            stock_technicals["return_5d_pct"] - benchmark_technicals["return_5d_pct"], 2
        ),
        "excess_return_20d_pct": round(
            stock_technicals["return_20d_pct"] - benchmark_technicals["return_20d_pct"], 2
        ),
    }
