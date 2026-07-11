import json
from asyncio import Lock
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from typing import Annotated, Any

from fastapi import APIRouter, Header, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

router = APIRouter(prefix="/api/stocks", tags=["stocks"])


class StockReportRow(BaseModel):
    """Keep stock rows flexible while requiring the one field the UI needs."""

    model_config = ConfigDict(extra="allow")

    symbol: str = Field(min_length=1)


class StockAnalysisReport(BaseModel):
    """Stable ingest boundary for analysis-service reports.

    The analysis program owns the detailed market and stock schemas. This model
    validates the report envelope and preserves new fields so the frontend can
    evolve with the output contract without this endpoint discarding data.
    """

    model_config = ConfigDict(extra="allow")

    generated_at: str = Field(min_length=1)
    stocks: list[StockReportRow]
    data_mode: str | None = None
    warnings: list[str] = Field(default_factory=list)
    market_session: dict[str, Any] | None = None
    market_context: dict[str, Any] | None = None
    methodology: dict[str, Any] | None = None


_latest_report: dict[str, Any] | None = None
_latest_received_at: str | None = None
_latest_report_hash: str | None = None
_latest_revision = 0
_report_lock = Lock()


@router.post("/reports", status_code=status.HTTP_201_CREATED)
async def ingest_stock_report(report: StockAnalysisReport) -> Response:
    """Accept a raw analysis report and atomically publish the latest revision."""

    global _latest_received_at, _latest_report, _latest_report_hash, _latest_revision

    report_payload = report.model_dump(mode="json", exclude_none=True, exclude_unset=True)
    report_hash = _report_hash(report_payload)

    async with _report_lock:
        if _latest_report_hash == report_hash:
            return JSONResponse(
                status_code=status.HTTP_200_OK,
                content=_ingest_response(
                    report_payload,
                    received_at=_latest_received_at,
                    report_hash=report_hash,
                    revision=_latest_revision,
                    accepted=False,
                ),
                headers=_cache_headers(report_hash),
            )

        received_at = datetime.now(UTC).isoformat()
        _latest_report = deepcopy(report_payload)
        _latest_received_at = received_at
        _latest_report_hash = report_hash
        _latest_revision += 1

        return JSONResponse(
            status_code=status.HTTP_201_CREATED,
            content=_ingest_response(
                report_payload,
                received_at=received_at,
                report_hash=report_hash,
                revision=_latest_revision,
                accepted=True,
            ),
            headers=_cache_headers(report_hash),
        )


@router.get("/reports/latest")
async def latest_stock_report(
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    """Return the latest report, or 304 when the caller already has this revision."""

    async with _report_lock:
        if _latest_report is None or _latest_report_hash is None:
            return JSONResponse(
                content={
                    "status": "empty",
                    "received_at": None,
                    "revision": 0,
                    "report_id": None,
                    "report": None,
                },
                headers={"Cache-Control": "no-store"},
            )

        report_hash = _latest_report_hash
        if _etag_matches(if_none_match, report_hash):
            return Response(
                status_code=status.HTTP_304_NOT_MODIFIED,
                headers=_cache_headers(report_hash),
            )

        payload = {
            "status": "ready",
            "received_at": _latest_received_at,
            "revision": _latest_revision,
            "report_id": report_hash,
            **_report_metadata(_latest_report),
            "report": deepcopy(_latest_report),
        }
        return JSONResponse(content=payload, headers=_cache_headers(report_hash))


def _ingest_response(
    report: dict[str, Any],
    *,
    received_at: str | None,
    report_hash: str,
    revision: int,
    accepted: bool,
) -> dict[str, Any]:
    return {
        "status": "accepted" if accepted else "unchanged",
        "changed": accepted,
        "received_at": received_at,
        "revision": revision,
        "report_id": report_hash,
        **_report_metadata(report),
    }


def _report_metadata(report: dict[str, Any]) -> dict[str, Any]:
    methodology = report.get("methodology")
    methodology = methodology if isinstance(methodology, dict) else {}
    return {
        "generated_at": report.get("generated_at"),
        "data_mode": report.get("data_mode"),
        "stock_count": _stock_count(report),
        "warning_count": _warning_count(report),
        "output_contract_version": methodology.get("output_contract_version"),
        "methodology_status": methodology.get("status"),
    }


def _report_hash(report: dict[str, Any]) -> str:
    serialized = json.dumps(report, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    encoded = serialized.encode("utf-8")
    return sha256(encoded).hexdigest()


def _cache_headers(report_hash: str) -> dict[str, str]:
    return {
        "Cache-Control": "no-cache",
        "ETag": f'"{report_hash}"',
    }


def _etag_matches(if_none_match: str | None, report_hash: str) -> bool:
    if not if_none_match:
        return False
    target = f'"{report_hash}"'
    return any(tag.strip().removeprefix("W/") in {"*", target} for tag in if_none_match.split(","))


def _stock_count(report: dict[str, Any]) -> int:
    stocks = report.get("stocks")
    return len(stocks) if isinstance(stocks, list) else 0


def _warning_count(report: dict[str, Any]) -> int:
    warnings = report.get("warnings")
    return len(warnings) if isinstance(warnings, list) else 0
