"""Developer-facing Markdown report."""

from __future__ import annotations


def render_dev_markdown(report: dict) -> str:
    lines = [
        "# KabuLens Dev View",
        "",
        f"Generated: {report['generated_at']}",
        f"Data mode: `{report['data_mode']}`",
        f"Market session: `{report.get('market_session', {}).get('name', 'unknown')}`",
        "",
        "## Output Contract",
        "",
        "- `outputs/report.json`: full API payload for agent/UI integration",
        "- `outputs/market_context.json`: market regime block only",
        "- `outputs/report.md`: human trading brief",
        "- `outputs/dev_report.md`: this developer view",
        "",
        "## Market Context Blocks",
        "",
        "| Block | Label | Score | Weight | Coverage |",
        "| --- | --- | ---: | ---: | ---: |",
    ]

    for name, group in report["market_context"].get("groups", {}).items():
        lines.append(
            f"| {name} | {group['label']} | {group['score']:+.1f} | "
            f"{group['weight']:.2f} | {group['available_symbols']}/{group['configured_symbols']} |"
        )

    lines.extend(["", "## UI Hints", ""])
    lines.extend(
        [
            "- Treat `market_context.regime` as the top-level badge.",
            "- Use `market_context.judgment.display.market_state.label` as the human-facing market state.",
            "- Show `judgment.display.signal_quality` as environment-signal agreement (low/medium/high), never as probability or score.",
            "- Show `judgment.display.data_quality.label`; keep numeric coverage in details only.",
            "- Obey `judgment.display.score_policy`: internal heuristic scores are hidden from the primary UI.",
            "- The info icon should open `reads.*.score_explanation` plus `drivers[].score_components` so scores remain auditable.",
            "- Use `market_context.risk_score_explanation` for the overall weighted-score details.",
            "- Use each read's `display_drivers` or macro `display_components`; these contain actual session moves and meanings.",
            "- Use `market_context.judgment.headline` as the main market summary.",
            "- Use `market_context.judgment.reads.macro.components` for the gold/dollar/oil/bond strip.",
            "- Do not render `groups.macro.score` as a gauge; `groups.macro.role` is `context_only`.",
            "- Render `market_context.theme_groups.groups` as four breadth cards; these do not enter `risk_score`.",
            "- Label SOXX as the tradable SOX proxy and IGV as software leadership.",
            "- Use `market_context.judgment.scenarios` for market scenario cards.",
            "- Use `stocks[].judgment.headline` as the main human-readable stock summary.",
            "- Use `stocks[].judgment.scenarios` for possible-outcome cards.",
            "- Draw four compact cards from `market_context.groups`: equity, volatility, macro, sector.",
            "- Use `stocks[].bucket` for row grouping: watch, observe, ignore.",
            "- Use `stocks[].group` for semiconductor, optical, compute, and software tabs.",
            "- Show `unavailable_symbols` separately so scheduled SKHY is not mistaken for a fetch failure.",
            "- Use `stocks[].reasons` as expandable explanation chips.",
            "- Hide `options.unusual_activity` by default; it has low directional value.",
            "- Use `docs/indicator_glossary.md` as the human-language explanation layer.",
        ]
    )

    lines.extend(
        [
            "",
            "## Indicator Translation",
            "",
            "| Field | Human meaning |",
            "| --- | --- |",
            "| `market_context.regime` | Overall market mood: risk-on, risk-off, or mixed. |",
            "| `risk_score` | Internal composite without natural units; debug/tooltip only. |",
            "| `data_coverage` | Configured regime inputs successfully loaded. |",
            "| `signal_confidence` | Internal heuristic strength and agreement; primary UI uses `judgment.display.signal_quality`. |",
            "| `judgment.display.score_policy` | Explicit instruction to hide internal scores from the primary UI. |",
            "| `bucket` | Attention category: watch, observe, ignore. |",
            "| `attention_score` | Priority score for attention, not a buy/sell signal. |",
            "| `attention_components` | Explainable 45/25/10/10/10 move, setup, participation, options, and context weights. |",
            "| `session_quote.change_pct` | Selected-session move; extended hours exclude the prior regular day's return. |",
            "| `session_quote.reference_price` | Explicit baseline for the selected session; extended hours use the latest regular close. |",
            "| `session_quote.change_source` | Named local calculation; extended hours always use the latest regular close. |",
            "| `session_quote.raw_opend_change_pct` | Provider cumulative rate retained for audit and never used for scoring. |",
            "| `technicals.atr_pct` | Normal daily movement range, used to judge whether a gap is meaningful. |",
            "| `technicals.adx14` | Trend strength only; ADX does not say whether the trend is up or down. |",
            "| `market_context.theme_groups` | Curated peer breadth and technology rotation context, excluded from market risk score. |",
            "| `group_context.peer_label` | Same-group confirmation calculated without the current stock. |",
            "| `levels.support_zone` | Area where buyers may appear; useful for hold/break decisions. |",
            "| `options.straddle_implied_move_pct` | Nearest-expiry ATM straddle cost as a move range, not direction. |",
            "| `options.quote_quality` | Whether ATM bid/ask spreads support using the straddle estimate. |",
            "| `options.unusual_activity` | Contracts with high volume versus open interest; activity, not intent. |",
            "| `setups.tags` | Human-readable daily setup labels; attention aids, not trade instructions. |",
            "| `judgment.technical_read.ema` | Human-readable EMA state for UI display. |",
            "| `judgment.technical_read.bollinger` | ADX-conditioned Bollinger behavior, position, and width state. |",
            "| `judgment.scenarios` | Possible outcomes and trigger conditions. |",
            "| `market_context.judgment` | Human-readable market intelligence layer. |",
            "| `market_context.judgment.reads.macro.components` | Gold, dollar, oil, and bond interpretations for UI display. |",
            "",
            "Full glossary: `docs/indicator_glossary.md`",
        ]
    )

    if report.get("warnings"):
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in report["warnings"])

    lines.extend(["", "## Watchlist Rows", ""])
    lines.extend(
        [
            "| Symbol | Group | Bucket | Score | Session Move | Trend | Signal | Option Move | Setups | Headline |",
            "| --- | --- | --- | ---: | ---: | --- | --- | ---: | --- | --- |",
        ]
    )
    for item in report["stocks"]:
        option_move = ""
        if item.get("options") and item["options"].get("expected_move_pct") is not None:
            option_move = f"{item['options']['expected_move_pct']}%"
        setup_labels = ", ".join(tag["label"] for tag in item.get("setups", {}).get("tags", []))
        headline = item.get("judgment", {}).get("headline", "")
        quote = item.get("session_quote") or item.get("premarket", {})
        change = quote.get("change_pct", quote.get("gap_pct", 0)) or 0
        lines.append(
            f"| {item['symbol']} | {item.get('group', '')} | {item['bucket']} | {item['attention_score']:.1f} | "
            f"{change:+.2f}% | {item['technicals']['trend']} | {item.get('signal', {}).get('direction', 'neutral')} | "
            f"{option_move} | {setup_labels} | {headline} |"
        )

    return "\n".join(lines).rstrip() + "\n"
