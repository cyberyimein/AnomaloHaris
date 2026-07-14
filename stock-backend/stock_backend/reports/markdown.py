"""Markdown report renderer."""

from __future__ import annotations


def render_markdown(report: dict) -> str:
    judgment = report["market_context"].get("judgment", {})
    display = judgment.get("display", {})
    market_state = display.get("market_state", {}).get("label", report["market_context"]["regime"])
    signal_quality = display.get("signal_quality", {}).get("label", "不可用")
    data_quality = display.get("data_quality", {}).get("label", "不可用")
    lines = [
        "# KabuLens Morning Brief",
        "",
        f"Generated: {report['generated_at']}",
        f"Session: **{report.get('market_session', {}).get('label', 'unknown')}**",
        f"Market state: **{market_state}**; signal quality **{signal_quality}**; {data_quality}",
        "",
    ]

    if judgment:
        lines.extend(["## Market Judgment", ""])
        lines.append(f"- {judgment['headline']}")
        lines.append(f"- Stance: `{judgment['stance']}`")
        lines.append("")
        lines.extend(["### Key Intelligence", ""])
        lines.extend(f"- {point}" for point in judgment.get("key_intelligence", []))
        lines.append("")
        lines.extend(["### Market Scenarios", ""])
        for scenario in judgment.get("scenarios", []):
            lines.append(f"- {scenario['label']}: {scenario['trigger']} -> {scenario['meaning']}")
        lines.append("")

    groups = report["market_context"].get("groups", {})
    if groups:
        lines.extend(["## Market Blocks", ""])
        lines.extend(["| Block | Signal | Coverage |", "| --- | --- | ---: |"])
        for name, group in groups.items():
            lines.append(
                f"| {name} | {group['label']} | {group['available_symbols']}/{group['configured_symbols']} |"
            )
        lines.append("")

    theme_groups = report["market_context"].get("theme_groups", {})
    if theme_groups.get("groups"):
        lines.extend(["## Technology Group Breadth", "", theme_groups.get("summary", ""), ""])
        lines.extend(
            [
                "| Group | State | Score | Positive / Available | Benchmark | Alignment |",
                "| --- | --- | ---: | ---: | --- | --- |",
            ]
        )
        for group in theme_groups["groups"].values():
            lines.append(
                f"| {group['display_name']} | {group['label']} | {group['score']:+.1f} | "
                f"{group['positive_symbols']}/{group['available_symbols']} | "
                f"{group.get('benchmark_symbol') or '-'} | {group.get('benchmark_alignment', 'unavailable')} |"
            )
        lines.append("")

    notes = report["market_context"].get("notes", [])
    if notes:
        lines.extend(["## Market Notes", ""])
        lines.extend(f"- {note}" for note in notes)
        lines.append("")

    if report.get("warnings"):
        lines.extend(["## Data Warnings", ""])
        lines.extend(f"- {warning}" for warning in report["warnings"])
        lines.append("")

    if report.get("unavailable_symbols"):
        lines.extend(["## Unavailable Or Scheduled", ""])
        for item in report["unavailable_symbols"]:
            detail = item.get("active_from") or item.get("reason", "unknown")
            lines.append(f"- {item['symbol']}: `{item['status']}` ({detail})")
        lines.append("")

    lines.extend(["## Attention List", ""])
    for item in report["stocks"]:
        lines.append(
            f"### {item['symbol']} - {item['bucket'].upper()} - score {item['attention_score']}"
        )
        lines.append(
            f"- Group: {item.get('group_label', item.get('group', 'unavailable'))}; "
            f"benchmark {item.get('benchmark_symbol') or 'unavailable'}"
        )
        if item.get("judgment"):
            lines.append(f"- Judgment: {item['judgment']['headline']}")
        quote = item.get("session_quote") or item.get("premarket", {})
        change = quote.get("change_pct", quote.get("gap_pct", 0)) or 0
        lines.append(f"- {quote.get('label', 'Quote')}: {quote['price']:.2f} ({change:+.2f}%)")
        lines.append(
            f"- Trend: {item['technicals']['trend']}; RSI {item['technicals']['rsi14']}; ATR {item['technicals']['atr_pct']}%"
        )
        if item.get("judgment"):
            technical = item["judgment"]["technical_read"]
            lines.append(f"- EMA: {technical['ema']['label']} - {technical['ema']['summary']}")
            lines.append(
                f"- Bollinger / ADX: {technical['bollinger']['summary']} - "
                f"{technical['bollinger']['interpretation']}"
            )
            lines.append(f"- Peer group: {technical['peer_group']['summary']}")
        lines.append(
            f"- Levels: YH {item['levels']['yesterday_high']}, YL {item['levels']['yesterday_low']}, "
            f"nearest support {item['levels']['support_zone']['low']}-{item['levels']['support_zone']['high']}, "
            f"nearest resistance {item['levels']['resistance_zone']['low']}-{item['levels']['resistance_zone']['high']}"
        )
        if item.get("judgment") and item["judgment"].get("scenarios"):
            lines.append("- Scenarios:")
            for scenario in item["judgment"]["scenarios"]:
                lines.append(
                    f"  - {scenario['label']}: {scenario['trigger']} -> {scenario['meaning']}"
                )
        if item.get("setups", {}).get("tags"):
            labels = ", ".join(tag["label"] for tag in item["setups"]["tags"])
            lines.append(f"- Daily setup: {labels}")
            if item["setups"].get("confirmation_needed"):
                lines.append(f"- Confirmation: {'; '.join(item['setups']['confirmation_needed'])}")
        if item.get("options"):
            expected_move = item["options"].get("expected_move_pct")
            move_text = f"{expected_move}%" if expected_move is not None else "unavailable"
            lines.append(
                f"- Options: ATM {item['options']['atm_strike']}, implied range {move_text}, "
                f"quote quality {item['options'].get('quote_quality', {}).get('status', 'unknown')}"
            )
            if item["options"].get("risk_reminders"):
                reminders = ", ".join(
                    reminder["label"] for reminder in item["options"]["risk_reminders"]
                )
                lines.append(f"- Option reminders: {reminders}")
        if item["reasons"]:
            lines.append(f"- Why: {'; '.join(item['reasons'])}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"
