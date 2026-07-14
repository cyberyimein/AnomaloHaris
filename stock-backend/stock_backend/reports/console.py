"""Terminal summary renderer for development runs."""

from __future__ import annotations


def render_console_summary(report: dict) -> str:
    market = report["market_context"]
    lines = [
        "KabuLens scan complete",
        f"Generated: {report['generated_at']}",
        f"Data mode: {report['data_mode']}",
        f"Session: {report.get('market_session', {}).get('name', 'unknown')}",
        f"Market: {market['regime']} score {market['risk_score']:+.1f} "
        f"coverage {market.get('data_coverage', market.get('confidence', 0)):.2f} "
        f"signal confidence {market.get('signal_confidence', 0):.2f}",
    ]
    if market.get("judgment"):
        lines.append(f"Market read: {market['judgment']['headline']}")
        for point in market["judgment"].get("key_intelligence", [])[:3]:
            lines.append(f"  - {point}")
    lines.extend(["", "Market blocks:"])

    for name, group in market.get("groups", {}).items():
        lines.append(
            f"  {name:10} {group['label']:11} score {group['score']:+6.1f} "
            f"coverage {group['available_symbols']}/{group['configured_symbols']}"
        )

    theme_groups = market.get("theme_groups", {})
    if theme_groups.get("groups"):
        lines.extend(["", f"Technology groups: {theme_groups.get('state', 'mixed')}"])
        for group in theme_groups["groups"].values():
            lines.append(
                f"  {group['display_name']:16} {group['label']:11} score {group['score']:+6.1f} "
                f"breadth {group['positive_symbols']}/{group['available_symbols']} "
                f"benchmark {group.get('benchmark_symbol') or 'n/a'}"
            )

    if report.get("warnings"):
        lines.extend(["", "Warnings:"])
        lines.extend(f"  - {warning}" for warning in report["warnings"])

    if report.get("unavailable_symbols"):
        lines.extend(["", "Unavailable or scheduled symbols:"])
        for item in report["unavailable_symbols"]:
            availability = item.get("active_from") or item.get("reason", "unknown")
            lines.append(f"  - {item['symbol']} ({item['status']}): {availability}")

    lines.extend(["", "Watchlist:"])
    for item in report["stocks"]:
        option_text = ""
        if item.get("options") and item["options"].get("expected_move_pct") is not None:
            option_text = f" | opt move {item['options']['expected_move_pct']}%"
        setup_text = ""
        if item.get("setups", {}).get("tags"):
            setup_text = " | " + ", ".join(tag["label"] for tag in item["setups"]["tags"][:2])
        quote = item.get("session_quote") or item.get("premarket", {})
        change = quote.get("change_pct", quote.get("gap_pct", 0)) or 0
        lines.append(
            f"  {item['symbol']:8} {item.get('group', 'ungrouped'):14} "
            f"{item['bucket']:7} score {item['attention_score']:5.1f} "
            f"{quote.get('label', 'quote')} {change:+6.2f}%{option_text}{setup_text}"
        )
        if item.get("judgment"):
            lines.append(f"    {item['judgment']['headline']}")

    lines.extend(
        [
            "",
            "Human report: outputs/report.md",
            "Machine JSON: outputs/report.json",
            "Market JSON: outputs/market_context.json",
            "Dev notes: outputs/dev_report.md",
        ]
    )
    return "\n".join(lines)
