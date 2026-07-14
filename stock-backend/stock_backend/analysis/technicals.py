"""Technical indicator calculations."""

from __future__ import annotations

from math import log, sqrt
from statistics import mean, pstdev, stdev

from stock_backend.clients.moomoo_client import Bar


def calculate_technicals(bars: list[Bar]) -> dict:
    if len(bars) < 20:
        raise ValueError("At least 20 daily bars are required")

    closes = [bar.close for bar in bars]
    true_ranges = _true_ranges(bars)
    latest = bars[-1]
    previous = bars[-2]
    ema20 = _ema(closes, 20)
    ema50 = _ema(closes, 50) if len(closes) >= 50 else None
    ema200 = _ema(closes, 200) if len(closes) >= 200 else None
    ema20_slope = _ema_slope(closes, 20, 5)
    ema50_slope = _ema_slope(closes, 50, 10) if len(closes) >= 60 else None
    trend_score = _trend_score(latest.close, ema20, ema50, ema200, ema20_slope, ema50_slope)
    bollinger = _bollinger(closes, 20, 2)
    atr14 = mean(true_ranges[-14:])
    average_volume_window = bars[-21:-1] if len(bars) >= 21 else bars[:-1]
    average_volume_20d = mean([bar.volume for bar in average_volume_window])
    adx14 = _adx(bars, 14)

    return {
        "last_bar_date": latest.date.isoformat(),
        "last_close": latest.close,
        "daily_change_pct": _pct(latest.close, previous.close),
        "return_5d_pct": _period_return(closes, 5),
        "return_20d_pct": _period_return(closes, 20),
        "realized_vol_20d_pct": _realized_volatility(closes, 20),
        "ema20": round(ema20, 2),
        "ema50": round(ema50, 2) if ema50 else None,
        "ema200": round(ema200, 2) if ema200 else None,
        "ema20_slope_5d_pct": ema20_slope,
        "ema50_slope_10d_pct": ema50_slope,
        "distance_to_ema20_pct": _pct(latest.close, ema20),
        "distance_to_ema50_pct": _pct(latest.close, ema50) if ema50 else None,
        "distance_to_ema200_pct": _pct(latest.close, ema200) if ema200 else None,
        "rsi14": round(_rsi(closes, 14), 1),
        "adx14": adx14,
        "trend_strength": _trend_strength(adx14),
        "atr14": round(atr14, 2),
        "atr_pct": round(atr14 / latest.close * 100, 2),
        "bollinger": bollinger,
        "avg_volume_20d": round(average_volume_20d),
        "volume_vs_20d": round(latest.volume / max(average_volume_20d, 1), 2),
        "trend_score": trend_score,
        "trend": _trend_label(trend_score),
    }


def _ema(values: list[float], period: int) -> float:
    if not values:
        raise ValueError("Cannot calculate EMA with no values")
    multiplier = 2 / (period + 1)
    ema = values[0]
    for value in values[1:]:
        ema = value * multiplier + ema * (1 - multiplier)
    return ema


def _rsi(values: list[float], period: int) -> float:
    if len(values) <= period:
        return 50.0

    changes = [
        current - previous for previous, current in zip(values, values[1:], strict=False)
    ]
    seed = changes[:period]
    average_gain = mean(max(change, 0) for change in seed)
    average_loss = mean(abs(min(change, 0)) for change in seed)
    for change in changes[period:]:
        average_gain = (average_gain * (period - 1) + max(change, 0)) / period
        average_loss = (average_loss * (period - 1) + abs(min(change, 0))) / period

    if average_loss == 0:
        return 100.0
    relative_strength = average_gain / average_loss
    return 100 - (100 / (1 + relative_strength))


def _true_ranges(bars: list[Bar]) -> list[float]:
    ranges = []
    previous_close = bars[0].close
    for bar in bars:
        ranges.append(
            max(bar.high - bar.low, abs(bar.high - previous_close), abs(bar.low - previous_close))
        )
        previous_close = bar.close
    return ranges


def _adx(bars: list[Bar], period: int) -> float | None:
    if len(bars) < period * 2 + 1:
        return None

    true_ranges = []
    plus_dm = []
    minus_dm = []
    for previous, current in zip(bars, bars[1:], strict=False):
        true_ranges.append(
            max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            )
        )
        up_move = current.high - previous.high
        down_move = previous.low - current.low
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0.0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0.0)

    smoothed_tr = sum(true_ranges[:period])
    smoothed_plus = sum(plus_dm[:period])
    smoothed_minus = sum(minus_dm[:period])
    dx_values = [_dx(smoothed_tr, smoothed_plus, smoothed_minus)]

    for index in range(period, len(true_ranges)):
        smoothed_tr = smoothed_tr - smoothed_tr / period + true_ranges[index]
        smoothed_plus = smoothed_plus - smoothed_plus / period + plus_dm[index]
        smoothed_minus = smoothed_minus - smoothed_minus / period + minus_dm[index]
        dx_values.append(_dx(smoothed_tr, smoothed_plus, smoothed_minus))

    if len(dx_values) < period:
        return None
    adx = mean(dx_values[:period])
    for dx in dx_values[period:]:
        adx = (adx * (period - 1) + dx) / period
    return round(adx, 1)


def _dx(smoothed_tr: float, smoothed_plus: float, smoothed_minus: float) -> float:
    if smoothed_tr == 0:
        return 0.0
    plus_di = 100 * smoothed_plus / smoothed_tr
    minus_di = 100 * smoothed_minus / smoothed_tr
    denominator = plus_di + minus_di
    return 100 * abs(plus_di - minus_di) / denominator if denominator else 0.0


def _trend_strength(adx: float | None) -> str:
    if adx is None:
        return "unavailable"
    if adx >= 25:
        return "strong"
    if adx <= 18:
        return "weak"
    return "moderate"


def _ema_slope(values: list[float], period: int, lookback: int) -> float | None:
    if len(values) <= lookback:
        return None
    current = _ema(values, period)
    previous = _ema(values[:-lookback], period)
    return _pct(current, previous)


def _trend_score(
    close: float,
    ema20: float,
    ema50: float | None,
    ema200: float | None,
    ema20_slope: float | None,
    ema50_slope: float | None,
) -> float:
    comparisons = [(close, ema20)]
    if ema50 is not None:
        comparisons.append((ema20, ema50))
    if ema50 is not None and ema200 is not None:
        comparisons.append((ema50, ema200))

    votes = [1 if left > right else -1 for left, right in comparisons]
    for slope in (ema20_slope, ema50_slope):
        if slope is not None:
            votes.append(1 if slope > 0 else -1)
    return round(sum(votes) / len(votes) * 100, 1)


def _trend_label(trend_score: float) -> str:
    if trend_score >= 40:
        return "uptrend"
    if trend_score <= -40:
        return "downtrend"
    return "mixed"


def _period_return(values: list[float], sessions: int) -> float:
    if len(values) <= sessions:
        return 0.0
    return _pct(values[-1], values[-sessions - 1])


def _realized_volatility(values: list[float], sessions: int) -> float:
    window = values[-(sessions + 1) :]
    returns = [
        log(current / previous)
        for previous, current in zip(window, window[1:], strict=False)
        if previous > 0
    ]
    if len(returns) < 2:
        return 0.0
    return round(stdev(returns) * sqrt(252) * 100, 2)


def _bollinger(values: list[float], period: int, deviations: float) -> dict:
    window = values[-period:]
    middle = mean(window)
    standard_deviation = pstdev(window)
    upper = middle + standard_deviation * deviations
    lower = middle - standard_deviation * deviations
    width_pct = (upper - lower) / middle * 100 if middle else 0
    percent_b = (values[-1] - lower) / (upper - lower) if upper != lower else 0.5

    return {
        "middle": round(middle, 2),
        "upper": round(upper, 2),
        "lower": round(lower, 2),
        "width_pct": round(width_pct, 2),
        "percent_b": round(percent_b, 2),
        "width_percentile_120d": round(_bollinger_width_percentile(values, period, deviations), 2),
    }


def _bollinger_width_percentile(values: list[float], period: int, deviations: float) -> float:
    if len(values) < period + 5:
        return 0.5

    widths = []
    start = max(period, len(values) - 120)
    for end in range(start, len(values) + 1):
        window = values[end - period : end]
        middle = mean(window)
        if middle == 0:
            continue
        width = (pstdev(window) * deviations * 2) / middle * 100
        widths.append(width)

    if not widths:
        return 0.5
    current = widths[-1]
    below_or_equal = sum(1 for width in widths if width <= current)
    return below_or_equal / len(widths)


def _pct(current: float, previous: float) -> float:
    if previous == 0:
        return 0.0
    return round((current - previous) / previous * 100, 2)
