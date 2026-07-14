"""Conservative options-derived volatility and positioning summaries."""

from __future__ import annotations

from datetime import date
from statistics import mean, median

from stock_backend.clients.moomoo_client import OptionContract


def summarize_options(
    chain: list[OptionContract],
    spot_price: float,
    realized_volatility_pct: float | None = None,
    as_of_date: date | None = None,
    quote_session: str = "regular",
    spot_reference_type: str = "live_regular_price",
) -> dict | None:
    valid_chain = [contract for contract in chain if contract.strike > 0]
    if not valid_chain:
        return None

    nearest_expiry = min(contract.expiry for contract in valid_chain)
    nearest = [contract for contract in valid_chain if contract.expiry == nearest_expiry]
    atm_strike = min(
        {contract.strike for contract in nearest}, key=lambda strike: abs(strike - spot_price)
    )
    atm_call = _find(nearest, atm_strike, "CALL")
    atm_put = _find(nearest, atm_strike, "PUT")
    quote_quality = _quote_quality(atm_call, atm_put, quote_session)

    call_volume = sum(contract.volume for contract in nearest if contract.option_type == "CALL")
    put_volume = sum(contract.volume for contract in nearest if contract.option_type == "PUT")
    call_oi = sum(contract.open_interest for contract in nearest if contract.option_type == "CALL")
    put_oi = sum(contract.open_interest for contract in nearest if contract.option_type == "PUT")

    atm_ivs = [
        contract.implied_volatility
        for contract in (atm_call, atm_put)
        if contract is not None and contract.implied_volatility > 0
    ]
    near_money = [
        contract
        for contract in nearest
        if abs(contract.strike - spot_price) / max(spot_price, 1) <= 0.10
    ]
    near_money_ivs = [
        contract.implied_volatility for contract in near_money if contract.implied_volatility > 0
    ]
    atm_iv = mean(atm_ivs) if atm_ivs else median(near_money_ivs) if near_money_ivs else None

    call_mid = _mid(atm_call)
    put_mid = _mid(atm_put)
    straddle_mid = call_mid + put_mid if call_mid is not None and put_mid is not None else None
    implied_move_pct = (
        straddle_mid / spot_price * 100 if straddle_mid is not None and spot_price > 0 else None
    )
    implied_range = None
    if implied_move_pct is not None:
        implied_range = {
            "low": round(spot_price * (1 - implied_move_pct / 100), 2),
            "high": round(spot_price * (1 + implied_move_pct / 100), 2),
        }

    iv_hv_ratio = None
    if atm_iv is not None and realized_volatility_pct and realized_volatility_pct > 0:
        iv_hv_ratio = atm_iv * 100 / realized_volatility_pct

    positioning = _positioning_summary(nearest, spot_price)
    days_to_expiry = max((nearest_expiry - (as_of_date or date.today())).days, 0)
    risk_reminders = _risk_reminders(
        expected_move_pct=implied_move_pct,
        iv_hv_ratio=iv_hv_ratio,
        days_to_expiry=days_to_expiry,
        quote_quality=quote_quality,
        positioning=positioning,
    )

    unusual = sorted(
        [
            {
                "symbol": contract.symbol,
                "expiry": contract.expiry.isoformat(),
                "strike": contract.strike,
                "type": contract.option_type,
                "volume": contract.volume,
                "open_interest": contract.open_interest,
                "volume_oi_ratio": round(contract.volume / contract.open_interest, 2),
            }
            for contract in nearest
            if contract.volume >= 1000
            and contract.open_interest >= 100
            and contract.volume / contract.open_interest >= 0.5
        ],
        key=lambda item: item["volume_oi_ratio"],
        reverse=True,
    )[:5]

    call_ivs = [
        contract.implied_volatility
        for contract in near_money
        if contract.option_type == "CALL" and contract.implied_volatility > 0
    ]
    put_ivs = [
        contract.implied_volatility
        for contract in near_money
        if contract.option_type == "PUT" and contract.implied_volatility > 0
    ]
    call_iv = _mean_or_none(call_ivs)
    put_iv = _mean_or_none(put_ivs)

    return {
        "spot_reference": round(spot_price, 4),
        "spot_reference_type": spot_reference_type,
        "nearest_expiry": nearest_expiry.isoformat(),
        "days_to_expiry": days_to_expiry,
        "atm_strike": atm_strike,
        "atm_straddle_mid": round(straddle_mid, 2) if straddle_mid is not None else None,
        "straddle_implied_move_pct": round(implied_move_pct, 2)
        if implied_move_pct is not None
        else None,
        "expected_move_pct": round(implied_move_pct, 2) if implied_move_pct is not None else None,
        "implied_range": implied_range,
        "atm_iv": round(atm_iv, 4) if atm_iv is not None else None,
        "average_iv": round(atm_iv, 4) if atm_iv is not None else None,
        "realized_vol_20d_pct": realized_volatility_pct,
        "iv_hv_ratio": round(iv_hv_ratio, 2) if iv_hv_ratio is not None else None,
        "put_call_volume_ratio": round(put_volume / max(call_volume, 1), 2),
        "put_call_oi_ratio": round(put_oi / max(call_oi, 1), 2),
        "average_call_iv": round(call_iv, 4) if call_iv is not None else None,
        "average_put_iv": round(put_iv, 4) if put_iv is not None else None,
        "skew_put_minus_call_iv": round(put_iv - call_iv, 4)
        if put_iv is not None and call_iv is not None
        else None,
        "quote_quality": quote_quality,
        "positioning": positioning,
        "flow_summary": {
            "put_call_volume_ratio": round(put_volume / max(call_volume, 1), 2),
            "directional_value": "low",
            "reason": "trade side and opening_or_closing intent are unavailable",
        },
        "activity_summary": {
            "flagged_contract_count": len(unusual),
            "call_count": sum(1 for item in unusual if item["type"] == "CALL"),
            "put_count": sum(1 for item in unusual if item["type"] == "PUT"),
            "max_volume_oi_ratio": max((item["volume_oi_ratio"] for item in unusual), default=None),
            "directional_value": "low",
        },
        "unusual_activity": [],
        "contract_details_omitted": True,
        "risk_reminders": risk_reminders,
        "limitations": [
            "ATM straddle estimates move magnitude, not direction or probability bounds",
            "US open interest does not reveal dealer long_or_short positioning",
            "volume/OI does not reveal buy_or_sell or opening_or_closing intent",
            "OI levels are calculated only from the selected near-money strike window",
        ],
    }


def _positioning_summary(chain: list[OptionContract], spot_price: float) -> dict:
    total_oi = sum(contract.open_interest for contract in chain)
    near_atm_oi = sum(
        contract.open_interest
        for contract in chain
        if abs(contract.strike - spot_price) / max(spot_price, 1) <= 0.05
    )
    call_above = [
        contract
        for contract in chain
        if contract.option_type == "CALL" and contract.strike >= spot_price
    ]
    put_below = [
        contract
        for contract in chain
        if contract.option_type == "PUT" and contract.strike <= spot_price
    ]
    call_wall = max(call_above, key=lambda contract: contract.open_interest, default=None)
    put_wall = max(put_below, key=lambda contract: contract.open_interest, default=None)

    return {
        "dealer_gamma_sign": "unknown",
        "near_atm_oi": near_atm_oi,
        "near_atm_oi_share": round(near_atm_oi / max(total_oi, 1), 2),
        "call_oi_level": call_wall.strike if call_wall else None,
        "put_oi_level": put_wall.strike if put_wall else None,
        "interpretation": "OI levels may mark hedging-sensitive prices; they do not identify positive or negative dealer gamma",
    }


def _risk_reminders(
    expected_move_pct: float | None,
    iv_hv_ratio: float | None,
    days_to_expiry: int,
    quote_quality: dict,
    positioning: dict,
) -> list[dict]:
    reminders = []

    if expected_move_pct is not None and expected_move_pct >= 4:
        reminders.append(
            {
                "tag": "large_implied_move",
                "label": "高隐含波动范围",
                "severity": "medium"
                if quote_quality["reliable"] and quote_quality["timing_reliable"]
                else "low",
                "reason": f"nearest-expiry ATM straddle costs about {expected_move_pct:.2f}% of spot",
            }
        )

    if iv_hv_ratio is not None and iv_hv_ratio >= 1.3:
        reminders.append(
            {
                "tag": "iv_rich_vs_realized",
                "label": "隐波高于近期实波",
                "severity": "medium"
                if quote_quality["reliable"] and quote_quality["timing_reliable"]
                else "low",
                "reason": f"ATM IV is {iv_hv_ratio:.2f}x 20-day realized volatility",
            }
        )

    if (
        days_to_expiry <= 7
        and positioning["near_atm_oi"] >= 1000
        and positioning["near_atm_oi_share"] >= 0.20
    ):
        reminders.append(
            {
                "tag": "short_dated_positioning_watch",
                "label": "短期期权放大观察",
                "severity": "low",
                "reason": "near-ATM short-dated OI is concentrated, but dealer gamma sign is unknown",
            }
        )

    return reminders


def _quote_quality(
    atm_call: OptionContract | None,
    atm_put: OptionContract | None,
    quote_session: str,
) -> dict:
    spreads = {
        "call_relative_spread": _relative_spread(atm_call),
        "put_relative_spread": _relative_spread(atm_put),
    }
    values = [value for value in spreads.values() if value is not None]
    if len(values) < 2:
        status = "missing"
    elif max(values) > 0.25:
        status = "wide"
    else:
        status = "good"

    return {
        "status": status,
        "reliable": status == "good",
        "timing_reliable": quote_session == "regular",
        "quote_session_assumption": "live_regular"
        if quote_session == "regular"
        else "previous_regular_session",
        **{key: round(value, 3) if value is not None else None for key, value in spreads.items()},
        "freshness": "not_provided_by_current_adapter",
    }


def _find(chain: list[OptionContract], strike: float, option_type: str) -> OptionContract | None:
    return next(
        (
            contract
            for contract in chain
            if contract.strike == strike and contract.option_type == option_type
        ),
        None,
    )


def _mid(contract: OptionContract | None) -> float | None:
    if contract is None or contract.bid <= 0 or contract.ask <= 0 or contract.ask < contract.bid:
        return None
    return (contract.bid + contract.ask) / 2


def _relative_spread(contract: OptionContract | None) -> float | None:
    mid = _mid(contract)
    if contract is None or mid is None or mid <= 0:
        return None
    return (contract.ask - contract.bid) / mid


def _mean_or_none(values: list[float]) -> float | None:
    return mean(values) if values else None
