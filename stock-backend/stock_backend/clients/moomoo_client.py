"""Market data client interface and mock implementation.

The real OpenD implementation should adapt Futu/moomoo return values into the
plain dataclasses below. Keeping the analysis layer free of SDK objects makes
the workflow easy to test and later expose through FastAPI.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from math import sin
from pathlib import Path
from random import Random
from typing import Any, Protocol
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Bar:
    date: date
    open: float
    high: float
    low: float
    close: float
    volume: int


@dataclass(frozen=True)
class StockSnapshot:
    symbol: str
    name: str
    last_price: float
    previous_close: float
    premarket_price: float
    premarket_volume: int
    volume: int = 0
    premarket_provider_change_pct: float | None = None
    afterhours_price: float | None = None
    afterhours_volume: int = 0
    afterhours_provider_change_pct: float | None = None
    overnight_price: float | None = None
    overnight_volume: int = 0
    overnight_provider_change_pct: float | None = None
    quote_time: str | None = None


@dataclass(frozen=True)
class OptionContract:
    symbol: str
    expiry: date
    strike: float
    option_type: str
    bid: float
    ask: float
    last: float
    volume: int
    open_interest: int
    implied_volatility: float
    delta: float = 0.0
    gamma: float = 0.0
    contract_size: float = 100.0


class MarketDataClient(Protocol):
    def get_stock_snapshot(self, symbol: str, name: str = "") -> StockSnapshot: ...

    def get_daily_bars(self, symbol: str, days: int) -> list[Bar]: ...

    def get_option_chain(
        self, symbol: str, spot_price: float, expiries: int
    ) -> list[OptionContract]: ...


class MockMarketDataClient:
    """Deterministic mock data for local workflow development."""

    def __init__(self, market_timezone: str = "America/New_York") -> None:
        self._market_timezone = market_timezone

    def get_stock_snapshot(self, symbol: str, name: str = "") -> StockSnapshot:
        rng = Random(_seed(symbol))
        bars = self.get_daily_bars(symbol, 260)
        previous_close = bars[-2].close
        last_price = bars[-1].close
        premarket_price = round(last_price * (1 + rng.uniform(-0.028, 0.04)), 2)
        premarket_volume = rng.randint(120_000, 8_500_000)
        return StockSnapshot(
            symbol=symbol,
            name=name or symbol,
            last_price=last_price,
            previous_close=previous_close,
            premarket_price=premarket_price,
            premarket_volume=premarket_volume,
            volume=bars[-1].volume,
            premarket_provider_change_pct=_pct(premarket_price, last_price),
            quote_time=datetime.now(ZoneInfo(self._market_timezone)).isoformat(),
        )

    def get_daily_bars(self, symbol: str, days: int) -> list[Bar]:
        rng = Random(_seed(symbol) + 17)
        price = rng.uniform(45, 780)
        bars: list[Bar] = []
        start = self._today() - timedelta(days=days * 2)

        for idx in range(days):
            drift = 0.0007 + sin(idx / 17) * 0.003
            shock = rng.uniform(-0.028, 0.028)
            open_price = price * (1 + rng.uniform(-0.01, 0.01))
            close = max(2.0, price * (1 + drift + shock))
            high = max(open_price, close) * (1 + rng.uniform(0.002, 0.028))
            low = min(open_price, close) * (1 - rng.uniform(0.002, 0.028))
            volume = rng.randint(900_000, 90_000_000)
            bars.append(
                Bar(
                    date=start + timedelta(days=idx),
                    open=round(open_price, 2),
                    high=round(high, 2),
                    low=round(low, 2),
                    close=round(close, 2),
                    volume=volume,
                )
            )
            price = close

        return bars

    def get_option_chain(
        self, symbol: str, spot_price: float, expiries: int
    ) -> list[OptionContract]:
        rng = Random(_seed(symbol) + 31)
        contracts: list[OptionContract] = []
        step = _strike_step(spot_price)
        atm = round(spot_price / step) * step

        for expiry_idx in range(expiries):
            expiry = self._today() + timedelta(days=7 * (expiry_idx + 1))
            for offset in range(-5, 6):
                strike = round(atm + offset * step, 2)
                moneyness = abs(strike - spot_price) / max(spot_price, 1)
                for option_type in ("CALL", "PUT"):
                    extrinsic = max(0.4, spot_price * (0.025 + moneyness * 0.65))
                    intrinsic = (
                        max(0, spot_price - strike)
                        if option_type == "CALL"
                        else max(0, strike - spot_price)
                    )
                    mid = intrinsic + extrinsic * rng.uniform(0.75, 1.25)
                    spread = max(0.05, mid * rng.uniform(0.03, 0.08))
                    bid = max(0.01, mid - spread / 2)
                    ask = bid + spread
                    volume = rng.randint(0, 12_000)
                    open_interest = rng.randint(50, 80_000)
                    contracts.append(
                        OptionContract(
                            symbol=f"{symbol}-{expiry.isoformat()}-{strike}-{option_type[0]}",
                            expiry=expiry,
                            strike=strike,
                            option_type=option_type,
                            bid=round(bid, 2),
                            ask=round(ask, 2),
                            last=round(mid, 2),
                            volume=volume,
                            open_interest=open_interest,
                            implied_volatility=round(rng.uniform(0.22, 0.95), 4),
                            delta=round(rng.uniform(0.25, 0.75), 4)
                            * (1 if option_type == "CALL" else -1),
                            gamma=round(rng.uniform(0.002, 0.08), 5),
                        )
                    )

        return contracts

    def _today(self) -> date:
        return _today(self._market_timezone)


class OpenDMarketDataClient:
    """Futu/moomoo OpenD-backed quote client.

    This class imports the SDK lazily so the rest of the project remains
    runnable without network access or local OpenD during development.
    """

    def __init__(
        self,
        host: str,
        port: int,
        sdk_home: Path | None = None,
        market_timezone: str = "America/New_York",
    ) -> None:
        sdk = _import_moomoo_sdk(sdk_home)
        self._sdk = sdk
        self._market_timezone = market_timezone
        self._quote_ctx = sdk.OpenQuoteContext(host=host, port=port)

    def close(self) -> None:
        close = getattr(self._quote_ctx, "close", None)
        if close:
            close()

    def get_stock_snapshot(self, symbol: str, name: str = "") -> StockSnapshot:
        data = self._call("get_market_snapshot", [symbol])
        row = _first_row(data, f"snapshot for {symbol}")
        previous_close = _number(
            row, ["prev_close_price", "pre_close_price", "previous_close", "prev_close"]
        )
        last_price = _number(row, ["last_price", "cur_price", "price"])
        premarket_price = _number(row, ["pre_price", "premarket_price"], default=0)
        premarket_volume = int(_number(row, ["pre_volume", "premarket_volume"], default=0))
        afterhours_price = _positive_or_none(
            _number(row, ["after_price", "afterhours_price"], default=0)
        )
        overnight_price = _positive_or_none(_number(row, ["overnight_price"], default=0))
        quote_time = str(_value(row, ["update_time"], default="")).strip()
        if not quote_time:
            quote_date = str(_value(row, ["data_date"], default="")).strip()
            quote_clock = str(_value(row, ["data_time"], default="")).strip()
            quote_time = " ".join(value for value in (quote_date, quote_clock) if value)
        display_name = str(_value(row, ["stock_name", "name"], default=name or symbol))

        return StockSnapshot(
            symbol=symbol,
            name=display_name,
            last_price=last_price,
            previous_close=previous_close,
            premarket_price=premarket_price,
            premarket_volume=premarket_volume,
            volume=int(_number(row, ["volume"], default=0)),
            premarket_provider_change_pct=_optional_number(row, ["pre_change_rate"]),
            afterhours_price=afterhours_price,
            afterhours_volume=int(_number(row, ["after_volume"], default=0)),
            afterhours_provider_change_pct=_optional_number(row, ["after_change_rate"]),
            overnight_price=overnight_price,
            overnight_volume=int(_number(row, ["overnight_volume"], default=0)),
            overnight_provider_change_pct=_optional_number(row, ["overnight_change_rate"]),
            quote_time=quote_time or None,
        )

    def get_daily_bars(self, symbol: str, days: int) -> list[Bar]:
        end = self._today()
        start = end - timedelta(days=max(days * 2, 365))
        kwargs = {
            "code": symbol,
            "start": start.isoformat(),
            "end": end.isoformat(),
        }
        if hasattr(self._sdk, "KLType"):
            kwargs["ktype"] = self._sdk.KLType.K_DAY
        if hasattr(self._sdk, "AuType"):
            kwargs["autype"] = self._sdk.AuType.QFQ

        data = self._call("request_history_kline", **kwargs)
        rows = _iter_rows(data)
        bars = [
            Bar(
                date=_date(_value(row, ["time_key", "date", "time"])),
                open=_number(row, ["open"]),
                high=_number(row, ["high"]),
                low=_number(row, ["low"]),
                close=_number(row, ["close"]),
                volume=int(_number(row, ["volume"], default=0)),
            )
            for row in rows
        ]
        if len(bars) < min(days, 20):
            raise RuntimeError(f"OpenD returned only {len(bars)} daily bars for {symbol}")
        return bars[-days:]

    def get_option_chain(
        self, symbol: str, spot_price: float, expiries: int
    ) -> list[OptionContract]:
        today = self._today()
        end = today + timedelta(days=7 * max(expiries, 1) + 10)
        kwargs = {
            "code": symbol,
            "start": today.isoformat(),
            "end": end.isoformat(),
        }
        if hasattr(self._sdk, "OptionType"):
            kwargs["option_type"] = self._sdk.OptionType.ALL

        try:
            data = self._call("get_option_chain", **kwargs)
        except Exception as exc:
            raise RuntimeError(f"Could not fetch option chain for {symbol}: {exc}") from exc

        chain_rows = _select_option_rows(_iter_rows(data), spot_price, expiries)
        quote_rows = {}
        codes = [str(_value(row, ["code", "symbol"], default="")) for row in chain_rows]
        if codes:
            quote_data = self._call("get_market_snapshot", codes)
            quote_rows = {
                str(_value(row, ["code", "symbol"], default="")): row
                for row in _iter_rows(quote_data)
            }

        contracts = []
        for chain_row in chain_rows:
            code = str(_value(chain_row, ["code", "symbol"], default=""))
            row = {**chain_row, **quote_rows.get(code, {})}
            expiry_value = _value(row, ["strike_time", "expiry_date", "expiration", "expiry"])
            option_type = str(_value(row, ["option_type", "type"], default="")).upper()
            if option_type in {"C", "CALL_OPTION"}:
                option_type = "CALL"
            elif option_type in {"P", "PUT_OPTION"}:
                option_type = "PUT"
            if option_type not in {"CALL", "PUT"}:
                code = str(_value(row, ["code", "stock_child_type"], default="")).upper()
                option_type = "PUT" if "PUT" in code or code.endswith("P") else "CALL"

            contracts.append(
                OptionContract(
                    symbol=code,
                    expiry=_date(expiry_value),
                    strike=_number(row, ["option_strike_price", "strike_price", "strike"]),
                    option_type=option_type,
                    bid=_number(row, ["bid_price", "bid"], default=0),
                    ask=_number(row, ["ask_price", "ask"], default=0),
                    last=_number(row, ["last_price", "cur_price", "price"], default=0),
                    volume=int(_number(row, ["volume"], default=0)),
                    open_interest=int(
                        _number(row, ["option_open_interest", "open_interest", "oi"], default=0)
                    ),
                    implied_volatility=_iv_number(
                        row, ["option_implied_volatility", "implied_volatility", "iv"]
                    ),
                    delta=_number(row, ["option_delta", "delta"], default=0),
                    gamma=_number(row, ["option_gamma", "gamma"], default=0),
                    contract_size=_number(
                        row,
                        ["option_contract_size", "contract_size", "contract_multiplier"],
                        default=100,
                    ),
                )
            )

        contracts.sort(key=lambda contract: (contract.expiry, abs(contract.strike - spot_price)))
        return contracts

    def _today(self) -> date:
        return _today(self._market_timezone)

    def _call(self, method_name: str, *args: Any, **kwargs: Any) -> Any:
        method = getattr(self._quote_ctx, method_name)
        result = method(*args, **kwargs)
        if not isinstance(result, tuple) or len(result) < 2:
            return result
        ret, data = result[0], result[1]
        if ret != getattr(self._sdk, "RET_OK", 0):
            raise RuntimeError(f"OpenD {method_name} failed: {data}")
        return data


def _seed(value: str) -> int:
    seed = 0
    for char in value:
        seed = (seed * 131 + ord(char)) % 2_147_483_647
    return seed


def _strike_step(spot_price: float) -> float:
    if spot_price < 50:
        return 1.0
    if spot_price < 200:
        return 2.5
    if spot_price < 500:
        return 5.0
    return 10.0


def _import_moomoo_sdk(sdk_home: Path | None = None) -> Any:
    original_home = os.environ.get("HOME")
    if sdk_home is not None:
        sdk_home.mkdir(parents=True, exist_ok=True)
        os.environ["HOME"] = str(sdk_home)

    try:
        try:
            import moomoo as sdk  # type: ignore

            return sdk
        except ModuleNotFoundError:
            try:
                import futu as sdk  # type: ignore

                return sdk
            except ModuleNotFoundError as exc:
                raise RuntimeError(
                    "Neither moomoo nor futu Python SDK is installed. "
                    "Install one in the project environment before using data_mode=opend."
                ) from exc
    finally:
        if sdk_home is not None:
            if original_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = original_home


def _iter_rows(data: Any) -> list[dict[str, Any]]:
    if hasattr(data, "to_dict"):
        return list(data.to_dict("records"))
    if isinstance(data, list):
        return [dict(item) for item in data]
    raise TypeError(f"Unsupported OpenD response type: {type(data).__name__}")


def _first_row(data: Any, label: str) -> dict[str, Any]:
    rows = _iter_rows(data)
    if not rows:
        raise RuntimeError(f"OpenD returned no rows for {label}")
    return rows[0]


def _value(row: dict[str, Any], keys: list[str], default: Any = None) -> Any:
    for key in keys:
        if key in row and row[key] is not None and row[key] == row[key]:
            return row[key]
    if default is not None:
        return default
    raise KeyError(f"None of {keys} found in OpenD row with columns {sorted(row)}")


def _number(row: dict[str, Any], keys: list[str], default: float | None = None) -> float:
    value = _value(row, keys, default=default)
    if value in {"", "N/A", "--"}:
        if default is not None:
            return default
        raise ValueError(f"Missing numeric value for {keys}")
    return float(value)


def _optional_number(row: dict[str, Any], keys: list[str]) -> float | None:
    for key in keys:
        if key not in row:
            continue
        value = row[key]
        if value is None or value in {"", "N/A", "--"} or value != value:
            return None
        return float(value)
    return None


def _iv_number(row: dict[str, Any], keys: list[str]) -> float:
    value = _number(row, keys, default=0)
    if value > 5:
        return value / 100
    return value


def _positive_or_none(value: float) -> float | None:
    return value if value > 0 else None


def _select_option_rows(
    rows: list[dict[str, Any]], spot_price: float, expiries: int
) -> list[dict[str, Any]]:
    if not rows:
        return []

    expiry_values = sorted(
        {_date(_value(row, ["strike_time", "expiry_date", "expiration", "expiry"])) for row in rows}
    )
    allowed_expiries = set(expiry_values[: max(expiries, 1)])
    near_expiry_rows = [
        row
        for row in rows
        if _date(_value(row, ["strike_time", "expiry_date", "expiration", "expiry"]))
        in allowed_expiries
    ]
    strikes = sorted(
        {
            _number(row, ["strike_price", "option_strike_price", "strike"])
            for row in near_expiry_rows
        }
    )
    if not strikes:
        return near_expiry_rows[:80]

    atm_index = min(range(len(strikes)), key=lambda index: abs(strikes[index] - spot_price))
    selected_strikes = set(strikes[max(0, atm_index - 8) : atm_index + 9])
    selected = [
        row
        for row in near_expiry_rows
        if _number(row, ["strike_price", "option_strike_price", "strike"]) in selected_strikes
    ]
    return selected[:100]


def _date(value: Any) -> date:
    if isinstance(value, date):
        return value
    text = str(value)
    return date.fromisoformat(text[:10])


def _today(market_timezone: str) -> date:
    return datetime.now(ZoneInfo(market_timezone)).date()


def _pct(current: float, previous: float) -> float:
    if previous == 0:
        return 0.0
    return round((current - previous) / previous * 100, 2)
