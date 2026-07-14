"""Machine-readable description of what the heuristic model can claim."""

from __future__ import annotations


def build_methodology_summary() -> dict:
    return {
        "model_version": "2.5",
        "output_contract_version": "2.3",
        "submodel_versions": {
            "market_context": "2.4",
            "attention_ranking": "2.2",
            "daily_technicals": "2.1",
            "options_summary": "2.0",
            "session_quote": "2.1",
        },
        "status": "heuristic_not_backtested",
        "purpose": "attention_triage_and_conditional_scenarios",
        "not_a_claim": "buy_sell_or_return_prediction",
        "signal_roles": {
            "trend_and_relative_strength": {
                "use": "directional_context",
                "evidence": "moderate",
                "limitation": "does not time reversals",
            },
            "gap_vs_atr": {
                "use": "opening_attention_and_move_significance",
                "evidence": "moderate",
                "limitation": "does not predict continuation direction",
            },
            "levels": {
                "use": "conditional_trigger_and_invalidation",
                "evidence": "low_to_moderate",
                "limitation": "level selection is heuristic",
            },
            "rsi_and_bollinger": {
                "use": "stretch_or_compression_modifier_conditioned_on_adx_and_trend",
                "evidence": "low_when_used_alone",
                "limitation": "band touches are never treated as standalone bottoms or reversal signals",
            },
            "theme_group_breadth": {
                "use": "peer_confirmation_and_technology_rotation_context",
                "evidence": "low_to_moderate",
                "limitation": "curated watchlists are not full-market breadth and do not enter risk_score",
            },
            "option_implied_move": {
                "use": "forward_move_magnitude",
                "evidence": "moderate_when_quotes_are_liquid",
                "limitation": "non_directional and sensitive to bid_ask quality",
            },
            "option_volume_oi": {
                "use": "activity_context_only",
                "evidence": "low_for_direction",
                "limitation": "trade side and opening_or_closing intent are unknown",
            },
            "dealer_gamma": {
                "use": "unavailable",
                "evidence": "insufficient",
                "limitation": "US open interest does not reveal dealer long_or_short sign",
            },
            "macro_etfs": {
                "use": "conditional_context_only",
                "evidence": "conditional",
                "limitation": "gold, oil and bonds do not have a stable one-direction risk mapping",
            },
        },
        "validation": {
            "required": True,
            "scan_archive": "enabled_for_opend_runs",
            "next_step": "attach future 1d_5d outcomes and score trigger hit rate, false positives, and calibration out of sample",
        },
    }
