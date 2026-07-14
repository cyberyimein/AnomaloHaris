import unittest
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from stock_backend.analysis.judgment import build_market_judgment, build_stock_judgment
from stock_backend.analysis.levels import calculate_levels
from stock_backend.analysis.market_context import summarize_market_context
from stock_backend.analysis.options import summarize_options
from stock_backend.analysis.ranking import score_stock
from stock_backend.analysis.session import classify_market_session, select_session_quote
from stock_backend.analysis.setups import classify_daily_setups
from stock_backend.analysis.technicals import calculate_technicals
from stock_backend.analysis.theme_groups import summarize_theme_groups
from stock_backend.clients.moomoo_client import (
    Bar,
    MockMarketDataClient,
    OptionContract,
    StockSnapshot,
)
from stock_backend.config_loader import load_yaml
from stock_backend.reports.dev_markdown import render_dev_markdown
from stock_backend.workflows.morning_scan import (
    _data_quality_issues,
    _prepare_watchlist,
    _select_completed_daily_bars,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class AnalysisTests(unittest.TestCase):
    def test_mock_technicals_include_core_fields(self):
        client = MockMarketDataClient()
        bars = client.get_daily_bars("US.NVDA", 260)

        technicals = calculate_technicals(bars)

        self.assertGreater(technicals["ema20"], 0)
        self.assertGreater(technicals["ema50"], 0)
        self.assertGreater(technicals["ema200"], 0)
        self.assertGreaterEqual(technicals["rsi14"], 0)
        self.assertLessEqual(technicals["rsi14"], 100)
        self.assertIn("bollinger", technicals)
        self.assertIn("percent_b", technicals["bollinger"])
        self.assertIn("width_percentile_120d", technicals["bollinger"])
        self.assertGreaterEqual(technicals["adx14"], 0)
        self.assertLessEqual(technicals["adx14"], 100)
        self.assertIn(technicals["trend_strength"], {"weak", "moderate", "strong"})

    def test_watchlist_groups_match_requested_universe(self):
        watchlists = load_yaml(PROJECT_ROOT / "config" / "watchlists.yaml")
        settings = load_yaml(PROJECT_ROOT / "config" / "settings.yaml")

        entries, catalog, unavailable = _prepare_watchlist(watchlists, date(2026, 7, 10))
        active_symbols = {entry["symbol"] for entry in entries}

        self.assertEqual(
            set(catalog),
            {"semiconductors", "optical", "compute", "software"},
        )
        self.assertEqual(
            active_symbols,
            {
                "US.INTC",
                "US.AMD",
                "US.MU",
                "US.SNDK",
                "US.LITE",
                "US.COHR",
                "US.MRVL",
                "US.NOK",
                "US.NVDA",
                "US.NBIS",
                "US.ORCL",
                "US.MSFT",
                "US.NOW",
                "US.PLTR",
            },
        )
        self.assertEqual(catalog["semiconductors"]["benchmark"], "US.SOXX")
        self.assertEqual(catalog["software"]["benchmark"], "US.IGV")
        self.assertEqual(
            settings["analysis"]["market_context"]["sector_symbols"], ["US.SOXX", "US.IGV"]
        )
        self.assertEqual(unavailable[0]["symbol"], "US.SKHY")
        self.assertEqual(unavailable[0]["status"], "scheduled")

        listing_day_entries, _, listing_day_unavailable = _prepare_watchlist(
            watchlists,
            date(2026, 7, 13),
        )
        self.assertIn("US.SKHY", {entry["symbol"] for entry in listing_day_entries})
        self.assertFalse(listing_day_unavailable)

    def test_ranking_returns_expected_bucket_values(self):
        stock = {
            "symbol": "US.NVDA",
            "session_quote": {
                "session": "premarket",
                "price": 103,
                "change_pct": 3.0,
                "volume": 100_000,
            },
            "technicals": {
                "atr_pct": 2.0,
                "trend": "uptrend",
                "avg_volume_20d": 1_000_000,
            },
            "options": {
                "expected_move_pct": 4.0,
                "days_to_expiry": 1,
                "quote_quality": {"reliable": True},
                "risk_reminders": [
                    {"tag": "iv_rich_vs_realized"},
                    {"tag": "short_dated_positioning_watch"},
                ],
            },
            "setups": {
                "tags": [{"tag": "trend_pullback"}],
                "confirmation_needed": ["hold EMA20"],
            },
            "relative_strength": {"state": "outperforming", "summary": "outperforming benchmark"},
            "levels": {
                "support_zone": {"low": 99, "high": 101},
                "resistance_zone": {"low": 108, "high": 110},
            },
        }

        ranking = score_stock(stock, {"regime": "risk_on"}, {"watch": 70, "observe": 45})

        self.assertEqual(ranking["bucket"], "watch")
        self.assertGreaterEqual(ranking["attention_score"], 70)
        self.assertEqual(ranking["signal"]["direction"], "bullish")

    def test_large_event_move_is_observed_without_directional_setup(self):
        stock = {
            "symbol": "US.TEST",
            "session_quote": {
                "session": "premarket",
                "price": 109,
                "change_pct": 9,
                "volume": 0,
            },
            "technicals": {
                "atr_pct": 9,
                "trend": "mixed",
                "avg_volume_20d": 1_000_000,
            },
            "options": None,
            "setups": {"tags": [], "confirmation_needed": []},
            "relative_strength": {"state": "unavailable"},
            "levels": {
                "support_zone": {"low": 95, "high": 97},
                "resistance_zone": {"low": 112, "high": 114},
            },
        }

        ranking = score_stock(
            stock,
            {"regime": "mixed", "signal_confidence": 0},
            {"watch": 70, "observe": 45},
        )

        self.assertEqual(ranking["attention_score"], 45)
        self.assertEqual(ranking["bucket"], "observe")
        self.assertIn("catalyst review", " ".join(ranking["reasons"]))
        self.assertEqual(ranking["attention_components"]["option_risk"]["max"], 10)

    def test_session_quote_does_not_label_regular_price_as_premarket(self):
        session = classify_market_session(
            datetime(2026, 7, 10, 15, 0, tzinfo=UTC),
            "America/New_York",
        )
        snapshot = StockSnapshot(
            symbol="US.TEST",
            name="Test",
            last_price=105,
            previous_close=100,
            premarket_price=102,
            premarket_volume=10_000,
            volume=500_000,
        )

        quote = select_session_quote(snapshot, session)

        self.assertEqual(session["name"], "regular")
        self.assertEqual(quote["source"], "last_price")
        self.assertEqual(quote["price"], 105)
        self.assertEqual(quote["change_pct"], 5)

    def test_missing_quote_timestamp_is_exposed_as_data_quality_issue(self):
        snapshot = StockSnapshot(
            symbol="US.TEST",
            name="Test",
            last_price=100,
            previous_close=99,
            premarket_price=101,
            premarket_volume=10_000,
            quote_time=None,
        )

        issues = _data_quality_issues(snapshot, {"calendar_accuracy": "exchange_calendar"})

        self.assertEqual(
            issues,
            ["snapshot quote timestamp is unavailable; freshness cannot be verified"],
        )

    def test_premarket_change_does_not_include_previous_regular_session(self):
        session = classify_market_session(
            datetime(2026, 7, 10, 12, 0, tzinfo=UTC),
            "America/New_York",
        )
        snapshot = StockSnapshot(
            symbol="US.NOK",
            name="Nokia",
            last_price=12.90,
            previous_close=11.95,
            premarket_price=12.68,
            premarket_volume=700_000,
            premarket_provider_change_pct=6.11,
        )

        quote = select_session_quote(snapshot, session)

        self.assertEqual(quote["change_pct"], -1.71)
        self.assertEqual(quote["reference_price"], 12.90)
        self.assertEqual(quote["reference_type"], "last_regular_close")
        self.assertEqual(quote["change_source"], "calculated_from_last_regular_close")
        self.assertEqual(quote["raw_opend_change_pct"], 6.11)
        self.assertFalse(quote["raw_opend_change_used"])

    def test_premarket_change_fallback_uses_last_regular_close(self):
        session = classify_market_session(
            datetime(2026, 7, 10, 12, 0, tzinfo=UTC),
            "America/New_York",
        )
        snapshot = StockSnapshot(
            symbol="US.NOK",
            name="Nokia",
            last_price=12.90,
            previous_close=11.95,
            premarket_price=12.68,
            premarket_volume=700_000,
        )

        quote = select_session_quote(snapshot, session)

        self.assertEqual(quote["change_pct"], -1.71)
        self.assertEqual(quote["change_source"], "calculated_from_last_regular_close")

    def test_premarket_excludes_current_incomplete_daily_bar(self):
        bars = self._dated_bars(date(2026, 7, 9), 2)
        session = classify_market_session(
            datetime(2026, 7, 10, 12, 0, tzinfo=UTC),
            "America/New_York",
        )

        selected, policy = _select_completed_daily_bars(bars, session)

        self.assertEqual([bar.date for bar in selected], [date(2026, 7, 9)])
        self.assertFalse(policy["includes_market_date"])

    def test_afterhours_includes_current_completed_daily_bar(self):
        bars = self._dated_bars(date(2026, 7, 9), 2)
        session = classify_market_session(
            datetime(2026, 7, 10, 21, 0, tzinfo=UTC),
            "America/New_York",
        )

        selected, policy = _select_completed_daily_bars(bars, session)

        self.assertEqual([bar.date for bar in selected], [date(2026, 7, 9), date(2026, 7, 10)])
        self.assertTrue(policy["includes_market_date"])

    def test_late_overnight_includes_current_completed_daily_bar(self):
        bars = self._dated_bars(date(2026, 7, 9), 2)
        session = classify_market_session(
            datetime(2026, 7, 11, 1, 0, tzinfo=UTC),
            "America/New_York",
        )

        selected, policy = _select_completed_daily_bars(bars, session)

        self.assertEqual([bar.date for bar in selected], [date(2026, 7, 9), date(2026, 7, 10)])
        self.assertTrue(policy["includes_market_date"])

    def test_overnight_session_uses_overnight_quote(self):
        session = classify_market_session(
            datetime(2026, 7, 10, 7, 0, tzinfo=UTC),
            "America/New_York",
        )
        snapshot = StockSnapshot(
            symbol="US.TEST",
            name="Test",
            last_price=100,
            previous_close=100,
            premarket_price=0,
            premarket_volume=0,
            overnight_price=103,
            overnight_volume=20_000,
        )

        quote = select_session_quote(snapshot, session)

        self.assertEqual(session["name"], "overnight")
        self.assertEqual(quote["source"], "overnight_price")
        self.assertEqual(quote["change_pct"], 3)

    def test_extended_hours_price_fallback_does_not_reuse_regular_volume(self):
        session = classify_market_session(
            datetime(2026, 7, 10, 7, 0, tzinfo=UTC),
            "America/New_York",
        )
        snapshot = StockSnapshot(
            symbol="US.TEST",
            name="Test",
            last_price=100,
            previous_close=100,
            premarket_price=0,
            premarket_volume=0,
            volume=10_000_000,
        )

        quote = select_session_quote(snapshot, session)

        self.assertTrue(quote["fallback_used"])
        self.assertEqual(quote["volume"], 0)

    def test_macro_context_does_not_change_regime_score(self):
        base = [
            self._proxy("US.SPY", 1.0, 2.0, 60),
            self._proxy("US.VIXY", -1.0, -2.0, -100),
            self._proxy("US.SOXX", 1.0, 2.0, 60),
        ]
        config = {
            "equity_symbols": ["US.SPY"],
            "volatility_symbols": ["US.VIXY"],
            "macro_symbols": ["US.UUP"],
            "sector_symbols": ["US.SOXX"],
            "sector_breadth_symbols": [],
        }

        strong_dollar = summarize_market_context(
            base + [self._proxy("US.UUP", 8.0, 10.0, 100)], config
        )
        weak_dollar = summarize_market_context(
            base + [self._proxy("US.UUP", -8.0, -10.0, -100)], config
        )

        self.assertEqual(strong_dollar["risk_score"], weak_dollar["risk_score"])
        self.assertEqual(strong_dollar["groups"]["macro"]["role"], "context_only")

    def test_vixy_long_term_trend_is_not_used_in_volatility_score(self):
        config = {
            "equity_symbols": [],
            "volatility_symbols": ["US.VIXY"],
            "macro_symbols": [],
            "sector_symbols": [],
            "sector_breadth_symbols": [],
        }
        uptrend = summarize_market_context([self._proxy("US.VIXY", 1.0, 1.0, 100)], config)
        downtrend = summarize_market_context([self._proxy("US.VIXY", 1.0, 1.0, -100)], config)

        self.assertEqual(
            uptrend["groups"]["volatility"]["score"],
            downtrend["groups"]["volatility"]["score"],
        )

    def test_options_do_not_claim_negative_gamma_from_open_interest(self):
        expiry = date(2026, 7, 17)
        chain = [
            OptionContract("C100", expiry, 100, "CALL", 4, 6, 5, 2000, 5000, 0.8, 0.5, 0.05),
            OptionContract("P100", expiry, 100, "PUT", 4, 6, 5, 1800, 5000, 0.9, -0.5, 0.05),
            OptionContract("C105", expiry, 105, "CALL", 2, 3, 2.5, 1500, 6000, 0.85, 0.35, 0.04),
            OptionContract("P95", expiry, 95, "PUT", 2, 3, 2.5, 1500, 6000, 0.85, -0.35, 0.04),
        ]

        summary = summarize_options(
            chain,
            100,
            realized_volatility_pct=20,
            as_of_date=date(2026, 7, 10),
            quote_session="premarket",
            spot_reference_type="last_regular_price",
        )
        tags = {item["tag"] for item in summary["risk_reminders"]}

        self.assertEqual(summary["quote_quality"]["status"], "wide")
        self.assertFalse(summary["quote_quality"]["timing_reliable"])
        self.assertEqual(summary["spot_reference_type"], "last_regular_price")
        self.assertEqual(summary["positioning"]["dealer_gamma_sign"], "unknown")
        self.assertNotIn("negative_gamma_watch", tags)
        self.assertNotIn("gamma_squeeze_candidate", tags)

    def test_high_absolute_volatility_is_not_called_a_squeeze(self):
        stock = {
            "symbol": "US.TEST",
            "session_quote": {"price": 100},
            "technicals": {
                "atr_pct": 9,
                "rsi14": 50,
                "trend": "mixed",
                "distance_to_ema20_pct": 0,
                "distance_to_ema50_pct": 1,
                "bollinger": {"percent_b": 0.5, "width_pct": 34, "width_percentile_120d": 0.05},
            },
            "levels": {
                "support_zone": {"low": 90, "high": 92},
                "resistance_zone": {"low": 108, "high": 110},
            },
            "options": None,
        }

        setups = classify_daily_setups(stock, {"groups": {"sector": {"label": "mixed"}}})
        tags = {item["tag"] for item in setups["tags"]}

        self.assertIn("relative_band_compression", tags)
        self.assertNotIn("volatility_squeeze", tags)

    def test_setup_uses_session_price_for_bollinger_position(self):
        stock = {
            "symbol": "US.TEST",
            "session_quote": {"price": 111},
            "technicals": {
                "atr_pct": 3,
                "rsi14": 72,
                "trend": "mixed",
                "bollinger": {
                    "lower": 90,
                    "upper": 110,
                    "percent_b": 0.5,
                    "width_pct": 12,
                    "width_percentile_120d": 0.5,
                },
            },
            "levels": {
                "support_zone": {"low": 95, "high": 97},
                "resistance_zone": {"low": 120, "high": 122},
            },
            "options": None,
        }

        setups = classify_daily_setups(stock, {"groups": {"sector": {"label": "mixed"}}})

        self.assertIn("overextended", {item["tag"] for item in setups["tags"]})

    def test_strong_uptrend_walking_upper_band_is_not_called_overextended(self):
        stock = {
            "symbol": "US.TEST",
            "session_quote": {"price": 111},
            "technicals": {
                "atr_pct": 3,
                "rsi14": 72,
                "trend": "uptrend",
                "adx14": 30,
                "bollinger": {
                    "lower": 90,
                    "upper": 110,
                    "width_pct": 12,
                    "width_percentile_120d": 0.5,
                },
            },
            "levels": {
                "support_zone": {"low": 95, "high": 97},
                "resistance_zone": {"low": 120, "high": 122},
            },
            "options": None,
        }

        setups = classify_daily_setups(stock, {"groups": {"sector": {"label": "mixed"}}})
        tags = {item["tag"] for item in setups["tags"]}

        self.assertIn("upper_band_trend", tags)
        self.assertNotIn("overextended", tags)

    def test_strong_downtrend_walking_lower_band_warns_against_dip_buying(self):
        stock = {
            "symbol": "US.TEST",
            "session_quote": {"price": 89},
            "technicals": {
                "atr_pct": 3,
                "rsi14": 25,
                "trend": "downtrend",
                "adx14": 32,
                "bollinger": {
                    "lower": 90,
                    "upper": 110,
                    "width_pct": 12,
                    "width_percentile_120d": 0.5,
                },
            },
            "levels": {
                "support_zone": {"low": 86, "high": 88},
                "resistance_zone": {"low": 100, "high": 102},
            },
            "options": None,
        }

        setups = classify_daily_setups(stock, {"groups": {"sector": {"label": "mixed"}}})

        self.assertIn("lower_band_trend_risk", {item["tag"] for item in setups["tags"]})

    def test_technicals_compare_latest_volume_with_prior_average(self):
        start = date(2026, 1, 1)
        bars = [
            Bar(start + timedelta(days=index), 100, 102, 98, 100 + index * 0.1, 100)
            for index in range(20)
        ]
        bars.append(Bar(start + timedelta(days=20), 102, 104, 100, 103, 200))

        technicals = calculate_technicals(bars)

        self.assertEqual(technicals["avg_volume_20d"], 100)
        self.assertEqual(technicals["volume_vs_20d"], 2)

    def test_levels_use_latest_completed_bar_and_nearest_pivots(self):
        start = date(2026, 1, 1)
        bars = []
        for index in range(30):
            close = 90 + index * 0.5
            high = close + 1
            low = close - 1
            if index == 25:
                high = 110
            bars.append(Bar(start + timedelta(days=index), close, high, low, close, 1_000_000))

        levels = calculate_levels(bars, reference_price=106, atr=2)

        self.assertEqual(levels["yesterday_high"], bars[-1].high)
        self.assertGreater(levels["support_zone"]["mid"], 100)
        self.assertGreaterEqual(levels["resistance_zone"]["mid"], 106)
        self.assertFalse(levels["zones_overlap"])

    def test_market_context_has_ui_ready_groups(self):
        client = MockMarketDataClient()
        proxy_results = []
        for symbol in ["US.SPY", "US.QQQ", "US.IWM", "US.VIXY", "US.SOXX", "US.IGV"]:
            bars = client.get_daily_bars(symbol, 260)
            snapshot = client.get_stock_snapshot(symbol)
            proxy_results.append(
                {
                    "symbol": symbol,
                    "premarket": {
                        "price": snapshot.premarket_price,
                        "volume": snapshot.premarket_volume,
                        "gap_pct": snapshot.premarket_provider_change_pct,
                    },
                    "technicals": calculate_technicals(bars),
                }
            )

        context = summarize_market_context(
            proxy_results,
            {
                "equity_symbols": ["US.SPY", "US.QQQ", "US.IWM"],
                "volatility_symbols": ["US.VIXY"],
                "macro_symbols": [],
                "leadership_groups": {
                    "semiconductors": {"symbols": ["US.SOXX"]},
                    "software": {"symbols": ["US.IGV"]},
                },
            },
        )

        self.assertIn(context["regime"], {"risk_on", "risk_off", "mixed"})
        self.assertIn("equity", context["groups"])
        self.assertIn("volatility", context["groups"])
        self.assertIn("sector", context["groups"])
        self.assertGreater(context["confidence"], 0)
        equity_symbol = context["groups"]["equity"]["symbols"][0]
        self.assertEqual(
            set(equity_symbol["score_components"]),
            {"current_session", "five_day", "trend"},
        )
        self.assertAlmostEqual(
            sum(item["score"] for item in equity_symbol["score_components"].values()),
            equity_symbol["score"],
            delta=0.2,
        )
        self.assertIn("current_meaning", context["groups"]["equity"]["score_explanation"])
        self.assertAlmostEqual(
            sum(
                item["contribution"]
                for item in context["risk_score_explanation"]["contributions"].values()
            ),
            context["risk_score"],
            delta=0.2,
        )

    def test_opposing_soxx_and_igv_are_classified_as_rotation(self):
        context = summarize_market_context(
            [
                self._proxy("US.SOXX", 2.0, 4.0, 100),
                self._proxy("US.IGV", -2.0, -4.0, -100),
            ],
            {
                "equity_symbols": [],
                "volatility_symbols": [],
                "macro_symbols": [],
                "leadership_groups": {
                    "semiconductors": {"symbols": ["US.SOXX"]},
                    "software": {"symbols": ["US.IGV"]},
                },
                "sector_breadth_symbols": [],
            },
        )

        leadership = context["groups"]["sector"]
        self.assertEqual(leadership["score"], 0)
        self.assertEqual(leadership["score_method"], "aligned_breadth_or_rotation_neutral")
        self.assertEqual(leadership["relationship"]["state"], "rotation_to_semiconductors")
        self.assertEqual(leadership["relationship"]["label"], "半导体占优")
        self.assertTrue(leadership["relationship"]["is_rotation"])
        self.assertEqual(
            leadership["relationship"]["broad_market_effect"],
            "internal_offset_no_directional_confirmation",
        )

        judgment = build_market_judgment(context)
        self.assertEqual(judgment["reads"]["sector"]["title"], "科技风格")
        self.assertEqual(judgment["reads"]["sector"]["label"], "半导体占优")
        self.assertIn("科技内部轮动", judgment["reads"]["sector"]["summary"])

    def test_rotation_does_not_dilute_aligned_index_and_volatility_direction(self):
        context = summarize_market_context(
            [
                self._proxy("US.SPY", 0.25, -0.28, 100),
                self._proxy("US.QQQ", 1.11, -1.53, 20),
                self._proxy("US.IWM", 0.69, -1.81, 60),
                self._proxy("US.VIXY", -1.71, 1.79, -100),
                self._proxy("US.SOXX", 4.99, -4.8, 20),
                self._proxy("US.IGV", -3.38, -2.2, 60),
            ],
            {
                "equity_symbols": ["US.SPY", "US.QQQ", "US.IWM"],
                "volatility_symbols": ["US.VIXY"],
                "macro_symbols": [],
                "leadership_groups": {
                    "semiconductors": {"symbols": ["US.SOXX"]},
                    "software": {"symbols": ["US.IGV"]},
                },
                "sector_breadth_symbols": [],
            },
        )

        self.assertEqual(context["regime"], "risk_on")
        self.assertGreater(context["risk_score"], 20)
        self.assertEqual(context["data_coverage"], 1.0)
        self.assertEqual(context["groups"]["sector"]["directional_coverage"], 0.0)
        sector_contribution = context["risk_score_explanation"]["contributions"]["sector"]
        self.assertEqual(sector_contribution["effective_weight"], 0)
        self.assertEqual(sector_contribution["contribution"], 0)

    def test_volatility_read_explains_small_directional_impact(self):
        context = {
            "regime": "mixed",
            "groups": {
                "equity": {"label": "mixed", "score": 0, "symbols": []},
                "volatility": {
                    "label": "mixed",
                    "score": 8,
                    "symbols": [
                        {
                            "symbol": "US.VIXY",
                            "score": 8,
                            "raw_score": -8,
                            "gap_pct": -1.11,
                            "trend": "mixed",
                        }
                    ],
                },
                "macro": {"label": "context", "score": 0, "symbols": []},
                "sector": {"label": "mixed", "score": 0, "symbols": []},
            },
        }

        read = build_market_judgment(context)["reads"]["volatility"]

        self.assertEqual(read["label"], "轻微支持风险偏好")
        self.assertEqual(read["risk_impact"], "mildly_supportive")
        self.assertIn("-1.11%", read["summary"])
        self.assertNotIn("变化不大", read["summary"])

    def test_macro_read_labels_offsetting_risk_impacts(self):
        context = {
            "regime": "mixed",
            "groups": {
                "equity": {"label": "mixed", "score": 0, "symbols": []},
                "volatility": {"label": "mixed", "score": 0, "symbols": []},
                "macro": {
                    "label": "context",
                    "score": 0,
                    "symbols": [
                        {
                            "symbol": "US.UUP",
                            "score": -30,
                            "raw_score": -30,
                            "gap_pct": -0.8,
                            "trend": "mixed",
                        },
                        {
                            "symbol": "US.USO",
                            "score": 30,
                            "raw_score": 30,
                            "gap_pct": 2.0,
                            "trend": "mixed",
                        },
                        {
                            "symbol": "US.GLD",
                            "score": 20,
                            "raw_score": 20,
                            "gap_pct": 1.0,
                            "trend": "mixed",
                        },
                    ],
                },
                "sector": {"label": "mixed", "score": 0, "symbols": []},
            },
        }

        read = build_market_judgment(context)["reads"]["macro"]

        self.assertEqual(read["label"], "多空因素抵消")
        self.assertEqual(read["risk_impact"], "offsetting")
        self.assertFalse(read["contributes_to_risk_score"])
        self.assertNotIn("仅作背景", read["summary"])

    def test_theme_peer_score_excludes_current_stock(self):
        catalog = {
            "compute": {
                "label": "算力 / 云基础设施",
                "benchmark": "US.QQQ",
                "active_symbols": ["US.A", "US.B", "US.C"],
            }
        }
        base = [
            self._proxy("US.A", 10.0, 10.0, 100),
            self._proxy("US.B", -1.0, -2.0, -50),
            self._proxy("US.C", -1.0, -2.0, -50),
        ]
        changed_current = [self._proxy("US.A", -10.0, -10.0, -100), *base[1:]]

        first = summarize_theme_groups(base, catalog)
        second = summarize_theme_groups(changed_current, catalog)

        first_peer = first["groups"]["compute"]["peer_states"]["US.A"]
        second_peer = second["groups"]["compute"]["peer_states"]["US.A"]
        self.assertEqual(first_peer, second_peer)
        self.assertEqual(first_peer["peer_count"], 2)
        self.assertEqual(first_peer["label"], "bearish")

    def test_market_judgment_contains_macro_and_scenarios(self):
        context = {
            "regime": "mixed",
            "risk_score": -12,
            "confidence": 1.0,
            "groups": {
                "equity": {
                    "label": "mixed",
                    "score": -5,
                    "symbols": [
                        {
                            "symbol": "US.SPY",
                            "score": -5,
                            "raw_score": -5,
                            "gap_pct": -0.4,
                            "trend": "mixed",
                        }
                    ],
                },
                "volatility": {
                    "label": "bearish",
                    "score": -25,
                    "symbols": [
                        {
                            "symbol": "US.VIXY",
                            "score": -25,
                            "raw_score": 25,
                            "gap_pct": 2.0,
                            "trend": "mixed",
                        }
                    ],
                },
                "macro": {
                    "label": "bearish",
                    "score": -20,
                    "symbols": [
                        {
                            "symbol": "US.UUP",
                            "score": -18,
                            "raw_score": 18,
                            "gap_pct": 0.5,
                            "trend": "uptrend",
                        },
                        {
                            "symbol": "US.USO",
                            "score": -30,
                            "raw_score": 42,
                            "gap_pct": 3.0,
                            "trend": "mixed",
                        },
                    ],
                },
                "sector": {
                    "label": "bearish",
                    "score": -22,
                    "symbols": [
                        {
                            "symbol": "US.SOXX",
                            "score": -22,
                            "raw_score": -22,
                            "gap_pct": -1.0,
                            "trend": "mixed",
                        }
                    ],
                },
            },
        }

        judgment = build_market_judgment(context)

        self.assertIn("headline", judgment)
        self.assertIn("macro", judgment["reads"])
        self.assertIn("US.UUP", judgment["reads"]["macro"]["components"])
        self.assertGreater(len(judgment["scenarios"]), 0)
        self.assertFalse(judgment["display"]["score_policy"]["show_internal_scores"])
        self.assertTrue(judgment["display"]["score_policy"]["show_scores_on_demand"])
        self.assertNotIn("分数", judgment["reads"]["equity"]["summary"])
        self.assertTrue(judgment["reads"]["equity"]["display_drivers"][0]["value"].endswith("%"))

    def test_dev_markdown_renderer_includes_indicator_translation(self):
        report = {
            "generated_at": "2026-07-08T00:00:00+00:00",
            "data_mode": "mock",
            "warnings": [],
            "market_context": {
                "groups": {
                    "equity": {
                        "label": "mixed",
                        "score": 0,
                        "weight": 0.35,
                        "available_symbols": 3,
                        "configured_symbols": 3,
                    }
                }
            },
            "stocks": [
                {
                    "symbol": "US.INTC",
                    "bucket": "ignore",
                    "attention_score": 10,
                    "premarket": {"gap_pct": 0.1},
                    "technicals": {"trend": "mixed"},
                    "options": {"expected_move_pct": 5.0},
                }
            ],
        }

        rendered = render_dev_markdown(report)

        self.assertIn("Indicator Translation", rendered)
        self.assertIn("docs/indicator_glossary.md", rendered)

    def test_daily_setup_classifier_returns_tags_shape(self):
        stock = {
            "symbol": "US.TEST",
            "premarket": {"price": 100},
            "technicals": {
                "atr_pct": 4,
                "rsi14": 35,
                "trend": "mixed",
                "distance_to_ema20_pct": -1,
                "distance_to_ema50_pct": -2,
                "bollinger": {"percent_b": 0.2, "width_percentile_120d": 0.1},
            },
            "levels": {
                "support_zone": {"low": 99, "high": 101},
                "resistance_zone": {"low": 120, "high": 125},
            },
            "options": {
                "risk_reminders": [
                    {
                        "tag": "large_implied_move",
                        "label": "高隐含波动范围",
                        "severity": "medium",
                        "reason": "test",
                    }
                ]
            },
        }

        setups = classify_daily_setups(stock, {"groups": {"sector": {"label": "mixed"}}})
        tags = {item["tag"] for item in setups["tags"]}

        self.assertIn("support_test", tags)
        self.assertIn("bounce_candidate", tags)
        self.assertIn("volatility_squeeze", tags)
        self.assertIn("large_implied_move", tags)

    def test_judgment_contains_frontend_ready_summary(self):
        stock = {
            "symbol": "US.TEST",
            "bucket": "observe",
            "previous_close": 101,
            "premarket": {"price": 100, "gap_pct": -1},
            "technicals": {
                "ema20": 102,
                "ema50": 105,
                "ema200": 95,
                "trend": "mixed",
                "bollinger": {"percent_b": 0.1, "width_pct": 12, "width_percentile_120d": 0.2},
            },
            "levels": {
                "support_zone": {"low": 99, "high": 101},
                "resistance_zone": {"low": 120, "high": 125},
            },
            "options": {
                "expected_move_pct": 7,
                "average_iv": 1.2,
                "put_call_volume_ratio": 0.8,
                "risk_reminders": [{"label": "高隐波/大波动提醒"}],
            },
            "setups": {
                "tags": [{"tag": "bounce_candidate", "label": "反弹候选"}],
                "confirmation_needed": ["开盘后观察是否守住支撑区"],
            },
        }

        judgment = build_stock_judgment(
            stock, {"regime": "mixed", "groups": {"sector": {"label": "mixed"}}}
        )

        self.assertIn("headline", judgment)
        self.assertIn("technical_read", judgment)
        self.assertIn("ema", judgment["technical_read"])
        self.assertIn("bollinger", judgment["technical_read"])
        self.assertGreater(len(judgment["scenarios"]), 0)

    @staticmethod
    def _proxy(symbol: str, change: float, return_5d: float, trend_score: float) -> dict:
        return {
            "symbol": symbol,
            "session_quote": {"price": 100, "change_pct": change},
            "technicals": {
                "atr_pct": 2,
                "return_5d_pct": return_5d,
                "return_20d_pct": return_5d * 2,
                "trend_score": trend_score,
                "trend": "uptrend"
                if trend_score > 20
                else "downtrend"
                if trend_score < -20
                else "mixed",
                "daily_change_pct": 0,
                "distance_to_ema20_pct": 1 if trend_score > 0 else -1,
                "rsi14": 50,
            },
        }

    @staticmethod
    def _dated_bars(start: date, count: int) -> list[Bar]:
        return [
            Bar(start + timedelta(days=index), 100, 102, 98, 101, 1_000_000)
            for index in range(count)
        ]


if __name__ == "__main__":
    unittest.main()
