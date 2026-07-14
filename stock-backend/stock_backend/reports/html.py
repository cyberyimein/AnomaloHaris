"""Tiny HTML renderer placeholder for later service/UI work."""

from __future__ import annotations

from html import escape


def render_html(report: dict) -> str:
    rows = []
    for item in report["stocks"]:
        rows.append(
            "<tr>"
            f"<td>{escape(item['symbol'])}</td>"
            f"<td>{escape(item['bucket'])}</td>"
            f"<td>{item['attention_score']}</td>"
            f"<td>{((item.get('session_quote') or item.get('premarket', {})).get('change_pct', (item.get('premarket') or {}).get('gap_pct', 0)) or 0):+.2f}%</td>"
            f"<td>{escape(item['technicals']['trend'])}</td>"
            "</tr>"
        )

    return (
        "<!doctype html><html><head><meta charset='utf-8'><title>KabuLens</title></head>"
        "<body><h1>KabuLens Morning Brief</h1>"
        f"<p>Market regime: {escape(report['market_context']['regime'])}</p>"
        "<table><thead><tr><th>Symbol</th><th>Bucket</th><th>Score</th><th>Gap</th><th>Trend</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></body></html>"
    )
