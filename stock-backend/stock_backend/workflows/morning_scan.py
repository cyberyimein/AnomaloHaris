"""Run the KabuLens premarket scan."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, date, datetime, time
from pathlib import Path

from stock_backend.analysis.evidence import build_methodology_summary
from stock_backend.analysis.judgment import build_market_judgment, build_stock_judgment
from stock_backend.analysis.levels import calculate_levels
from stock_backend.analysis.market_context import summarize_market_context
from stock_backend.analysis.options import summarize_options
from stock_backend.analysis.ranking import score_stock
from stock_backend.analysis.relative_strength import summarize_relative_strength
from stock_backend.analysis.session import classify_market_session, select_session_quote
from stock_backend.analysis.setups import classify_daily_setups
from stock_backend.analysis.technicals import calculate_technicals
from stock_backend.analysis.theme_groups import stock_group_context, summarize_theme_groups
from stock_backend.clients.moomoo_client import MockMarketDataClient, OpenDMarketDataClient
from stock_backend.config_loader import load_yaml
from stock_backend.reports.console import render_console_summary
from stock_backend.reports.dev_markdown import render_dev_markdown
from stock_backend.reports.markdown import render_markdown

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def run_scan(project_root: Path = PROJECT_ROOT) -> dict:
    settings = _load_yaml(project_root / "config" / "settings.yaml")
    return run_scan_with_settings(project_root, settings)


def run_scan_with_settings(project_root: Path, settings: dict) -> dict:
    watchlists = _load_yaml(project_root / "config" / "watchlists.yaml")
    client = _build_client(settings, project_root)
    generated_at = datetime.now(UTC)
    market_timezone = settings["workflow"].get("market_timezone", "America/New_York")
    market_session = classify_market_session(generated_at, market_timezone)

    history_days = settings["workflow"]["history_days"]
    option_expiries = settings["workflow"]["option_expiries"]
    thresholds = settings["analysis"]["attention_thresholds"]
    risk_proxies = set(settings["analysis"]["risk_proxy_symbols"])
    market_context_config = settings["analysis"].get("market_context", {})

    market_date = date.fromisoformat(market_session["market_date"])
    target_entries, group_catalog, unavailable_symbols = _prepare_watchlist(watchlists, market_date)
    proxy_entries = [
        {"symbol": symbol, "name": symbol, "options": False, "report": False}
        for symbol in settings["analysis"]["risk_proxy_symbols"]
        if symbol not in {entry["symbol"] for entry in target_entries}
    ]

    raw_results = []
    warnings = []
    if market_session["name"] != "premarket":
        warnings.append(
            f"Scan ran during {market_session['name']}; session_quote uses the matching quote instead of labeling it premarket"
        )
    try:
        for entry in target_entries:
            try:
                raw_results.append(
                    _analyze_entry(client, entry, history_days, option_expiries, market_session)
                )
            except Exception as exc:
                warnings.append(f"Watchlist {entry['symbol']} unavailable: {exc}")
                unavailable_symbols.append(
                    {
                        "symbol": entry["symbol"],
                        "group": entry["group"],
                        "status": "data_unavailable",
                        "reason": str(exc),
                    }
                )
        for entry in proxy_entries:
            try:
                raw_results.append(
                    _analyze_entry(client, entry, history_days, option_expiries, market_session)
                )
            except Exception as exc:
                warnings.append(f"Proxy {entry['symbol']} unavailable: {exc}")
    finally:
        close = getattr(client, "close", None)
        if close:
            close()

    by_symbol = {item["symbol"]: item for item in raw_results}
    target_by_symbol = {entry["symbol"]: entry for entry in target_entries}
    market_benchmark = by_symbol.get("US.SPY")
    for symbol, entry in target_by_symbol.items():
        stock = by_symbol.get(symbol)
        if stock:
            benchmark_symbol = entry.get("benchmark")
            stock["relative_strength"] = summarize_relative_strength(
                stock,
                by_symbol.get(benchmark_symbol) if benchmark_symbol else None,
                market_benchmark,
            )

    market_context = summarize_market_context(
        [item for item in raw_results if item["symbol"] in risk_proxies],
        market_context_config,
    )
    theme_groups = summarize_theme_groups(raw_results, group_catalog)
    market_context = {**market_context, "theme_groups": theme_groups}
    market_context = {**market_context, "judgment": build_market_judgment(market_context)}

    ranked = []
    report_symbols = {entry["symbol"] for entry in target_entries}
    for stock in raw_results:
        if stock["symbol"] not in report_symbols:
            continue
        stock = {**stock, "group_context": stock_group_context(stock, theme_groups)}
        setups = classify_daily_setups(stock, market_context)
        stock_with_setups = {**stock, "setups": setups}
        ranking = score_stock(stock_with_setups, market_context, thresholds)
        ranked_stock = {**stock_with_setups, **ranking}
        ranked.append(
            {**ranked_stock, "judgment": build_stock_judgment(ranked_stock, market_context)}
        )

    ranked.sort(key=lambda item: item["attention_score"], reverse=True)

    report = {
        "generated_at": generated_at.isoformat(),
        "data_mode": settings["workflow"]["data_mode"],
        "market_session": market_session,
        "methodology": build_methodology_summary(),
        "watchlist_groups": group_catalog,
        "unavailable_symbols": unavailable_symbols,
        "market_context": market_context,
        "warnings": warnings,
        "stocks": ranked,
    }

    archive_path = None
    if settings["workflow"].get("archive_live_scans", False) and report["data_mode"] == "opend":
        archive_dir = project_root / settings["workflow"].get("archive_dir", "data/scan_history")
        archive_dir.mkdir(parents=True, exist_ok=True)
        archive_path = archive_dir / f"{generated_at.strftime('%Y%m%dT%H%M%SZ')}.json"
    report["archive"] = {
        "enabled": archive_path is not None,
        "path": str(archive_path.relative_to(project_root)) if archive_path else None,
        "purpose": "future_outcome_validation",
    }

    output_dir = project_root / settings["workflow"]["output_dir"]
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / settings["workflow"]["report_json"]).write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (output_dir / settings["workflow"]["market_context_json"]).write_text(
        json.dumps(market_context, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (output_dir / settings["workflow"]["report_markdown"]).write_text(
        render_markdown(report),
        encoding="utf-8",
    )
    (output_dir / settings["workflow"]["dev_report_markdown"]).write_text(
        render_dev_markdown(report),
        encoding="utf-8",
    )
    if archive_path:
        archive_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    return report


def _analyze_entry(
    client,
    entry: dict,
    history_days: int,
    option_expiries: int,
    market_session: dict,
) -> dict:
    symbol = entry["symbol"]
    snapshot = client.get_stock_snapshot(symbol, entry.get("name", ""))
    raw_bars = client.get_daily_bars(symbol, history_days)
    bars, daily_bar_policy = _select_completed_daily_bars(raw_bars, market_session)
    market_date = date.fromisoformat(market_session["market_date"])
    if len(bars) < 20:
        raise RuntimeError(f"Only {len(bars)} completed daily bars available for {symbol}")
    technicals = calculate_technicals(bars)
    session_quote = select_session_quote(snapshot, market_session)
    levels = calculate_levels(bars, session_quote["price"], technicals["atr14"])
    premarket_available = snapshot.premarket_price > 0
    premarket_is_current = market_session["name"] == "premarket"
    premarket_change_pct = (
        _pct(snapshot.premarket_price, snapshot.last_price)
        if premarket_available and premarket_is_current
        else None
    )
    premarket = {
        "available": premarket_available,
        "is_current_session": premarket_is_current,
        "price": snapshot.premarket_price if premarket_available else None,
        "volume": snapshot.premarket_volume,
        "gap_pct": premarket_change_pct,
        "change_pct": premarket_change_pct,
        "reference_price": snapshot.last_price,
        "reference_type": "last_regular_close",
        "change_source": "calculated_from_last_regular_close" if premarket_is_current else None,
        "raw_opend_change_pct": snapshot.premarket_provider_change_pct,
        "raw_opend_change_used": False,
        "role": "raw_compatibility_field",
    }

    stock = {
        "symbol": symbol,
        "name": snapshot.name,
        "last_price": snapshot.last_price,
        "previous_close": session_quote["reference_price"],
        "snapshot_prices": {
            "last_price": snapshot.last_price,
            "prev_close_price": snapshot.previous_close,
            "note": "raw OpenD fields; use session_quote.reference_price for the selected session",
        },
        "session_quote": session_quote,
        "premarket": premarket,
        "technicals": technicals,
        "levels": levels,
        "benchmark_symbol": entry.get("benchmark"),
        "group": entry.get("group"),
        "group_label": entry.get("group_label"),
        "data_quality": {
            "latest_completed_bar_date": technicals["last_bar_date"],
            "daily_bar_policy": daily_bar_policy,
            "quote_source": session_quote["source"],
            "quote_fallback_used": session_quote["fallback_used"],
            "issues": _data_quality_issues(snapshot, market_session),
        },
        "options": None,
    }

    if entry.get("options"):
        option_spot = (
            session_quote["price"] if market_session["name"] == "regular" else snapshot.last_price
        )
        spot_reference_type = (
            "live_regular_price" if market_session["name"] == "regular" else "last_regular_price"
        )
        chain = client.get_option_chain(symbol, option_spot, option_expiries)
        stock["options"] = summarize_options(
            chain,
            option_spot,
            realized_volatility_pct=technicals["realized_vol_20d_pct"],
            as_of_date=market_date,
            quote_session=market_session["name"],
            spot_reference_type=spot_reference_type,
        )
        expected_move = (stock["options"] or {}).get("straddle_implied_move_pct")
        if expected_move:
            move_from_option_reference = (
                abs(session_quote["price"] - option_spot) / option_spot * 100
            )
            stock["options"]["current_move_vs_implied_ratio"] = round(
                move_from_option_reference / expected_move,
                2,
            )

    return stock


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the KabuLens morning scan")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    parser.add_argument(
        "--data-mode", choices=["mock", "opend"], help="Override workflow.data_mode"
    )
    parser.add_argument("--opend-host", help="Override OpenD host")
    parser.add_argument("--opend-port", type=int, help="Override OpenD port")
    parser.add_argument("--summary-format", choices=["text", "json"], default="text")
    args = parser.parse_args()

    if args.data_mode or args.opend_host or args.opend_port:
        settings_path = args.project_root / "config" / "settings.yaml"
        settings = _load_yaml(settings_path)
        if args.data_mode:
            settings["workflow"]["data_mode"] = args.data_mode
        if args.opend_host:
            settings["opend"]["host"] = args.opend_host
        if args.opend_port:
            settings["opend"]["port"] = args.opend_port
        report = run_scan_with_settings(args.project_root, settings)
    else:
        report = run_scan(args.project_root)
    summary = {
        "generated_at": report["generated_at"],
        "data_mode": report["data_mode"],
        "market_session": report["market_session"]["name"],
        "market_regime": report["market_context"]["regime"],
        "market_score": report["market_context"]["risk_score"],
        "market_data_coverage": report["market_context"].get("data_coverage", 0),
        "market_signal_confidence": report["market_context"].get("signal_confidence", 0),
        "archive_file": report.get("archive", {}).get("path"),
        "top_symbols": [item["symbol"] for item in report["stocks"][:3]],
        "output_files": [
            "outputs/report.json",
            "outputs/market_context.json",
            "outputs/report.md",
            "outputs/dev_report.md",
        ],
    }
    if args.summary_format == "json":
        print(json.dumps(summary, indent=2))
    else:
        print(render_console_summary(report))


def _load_yaml(path: Path) -> dict:
    return load_yaml(path)


def _build_client(settings: dict, project_root: Path = PROJECT_ROOT):
    mode = settings["workflow"].get("data_mode", "mock")
    market_timezone = settings["workflow"].get("market_timezone", "America/New_York")
    if mode == "mock":
        return MockMarketDataClient(market_timezone=market_timezone)
    if mode == "opend":
        opend = settings["opend"]
        sdk_home = Path(opend.get("sdk_home", "data/cache/futu_home"))
        if not sdk_home.is_absolute():
            sdk_home = project_root / sdk_home
        return OpenDMarketDataClient(
            host=opend["host"],
            port=int(opend["port"]),
            sdk_home=sdk_home,
            market_timezone=market_timezone,
        )
    raise ValueError(f"Unsupported data_mode: {mode}")


def _prepare_watchlist(watchlists: dict, market_date: date) -> tuple[list[dict], dict, list[dict]]:
    entries = []
    catalog = {}
    unavailable = []

    for group_name, definition in watchlists.get("groups", {}).items():
        label = definition.get("label", group_name)
        benchmark = definition.get("benchmark")
        configured_symbols = []
        active_symbols = []
        scheduled_symbols = []

        for member in definition.get("members", []):
            symbol = member["symbol"]
            configured_symbols.append(symbol)
            active_from_text = member.get("active_from")
            active_from = date.fromisoformat(active_from_text) if active_from_text else None
            if active_from and market_date < active_from:
                scheduled_symbols.append(symbol)
                unavailable.append(
                    {
                        "symbol": symbol,
                        "group": group_name,
                        "status": "scheduled",
                        "active_from": active_from.isoformat(),
                        "reason": member.get("availability_note", "symbol is not active yet"),
                    }
                )
                continue

            active_symbols.append(symbol)
            entries.append(
                {
                    **member,
                    "group": group_name,
                    "group_label": label,
                    "benchmark": member.get("benchmark", benchmark),
                }
            )

        catalog[group_name] = {
            "label": label,
            "benchmark": benchmark,
            "configured_symbols": configured_symbols,
            "active_symbols": active_symbols,
            "scheduled_symbols": scheduled_symbols,
        }

    return entries, catalog, unavailable


def _data_quality_issues(snapshot, market_session: dict) -> list[str]:
    issues = []
    if market_session["calendar_accuracy"] != "exchange_calendar":
        issues.append("US holiday calendar is not yet applied")
    if not snapshot.quote_time:
        issues.append("snapshot quote timestamp is unavailable; freshness cannot be verified")
    return issues


def _select_completed_daily_bars(raw_bars: list, market_session: dict) -> tuple[list, dict]:
    market_date = date.fromisoformat(market_session["market_date"])
    local_time = datetime.fromisoformat(market_session["as_of_local"]).time().replace(tzinfo=None)
    include_market_date = market_session["name"] == "afterhours" or (
        market_session["name"] == "overnight" and local_time >= time(20, 0)
    )
    if include_market_date:
        bars = [bar for bar in raw_bars if bar.date <= market_date]
        rule = "include_market_date_after_regular_close"
    else:
        bars = [bar for bar in raw_bars if bar.date < market_date]
        rule = "exclude_market_date_before_regular_close"
    return bars, {
        "rule": rule,
        "market_date": market_date.isoformat(),
        "includes_market_date": include_market_date,
    }


def _pct(current: float, previous: float) -> float:
    if previous == 0:
        return 0.0
    return round((current - previous) / previous * 100, 2)


if __name__ == "__main__":
    main()
