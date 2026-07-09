from copy import deepcopy
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Body, status

router = APIRouter(prefix="/api/stocks", tags=["stocks"])

_latest_report: dict[str, Any] | None = None
_latest_received_at: str | None = None


@router.post("/reports", status_code=status.HTTP_201_CREATED)
async def ingest_stock_report(report: Annotated[dict[str, Any], Body(...)]) -> dict[str, Any]:
    global _latest_received_at, _latest_report

    received_at = datetime.now(UTC).isoformat()
    _latest_report = deepcopy(report)
    _latest_received_at = received_at

    return {
        "status": "accepted",
        "received_at": received_at,
        "generated_at": report.get("generated_at"),
        "data_mode": report.get("data_mode"),
        "stock_count": _stock_count(report),
        "warning_count": _warning_count(report),
    }


@router.get("/reports/latest")
async def latest_stock_report() -> dict[str, Any]:
    if _latest_report is None:
        return {
            "status": "empty",
            "received_at": None,
            "report": None,
        }

    return {
        "status": "ready",
        "received_at": _latest_received_at,
        "generated_at": _latest_report.get("generated_at"),
        "data_mode": _latest_report.get("data_mode"),
        "stock_count": _stock_count(_latest_report),
        "warning_count": _warning_count(_latest_report),
        "report": deepcopy(_latest_report),
    }


def _stock_count(report: dict[str, Any]) -> int:
    stocks = report.get("stocks")
    return len(stocks) if isinstance(stocks, list) else 0


def _warning_count(report: dict[str, Any]) -> int:
    warnings = report.get("warnings")
    return len(warnings) if isinstance(warnings, list) else 0
