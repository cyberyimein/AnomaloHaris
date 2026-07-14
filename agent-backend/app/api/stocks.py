import json
import logging
from asyncio import Lock, sleep, to_thread
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.security import require_management_access
from app.config import get_settings

router = APIRouter(prefix="/api/stocks", tags=["stocks"])
logger = logging.getLogger(__name__)


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
_scan_lock = Lock()


@router.post("/reports", status_code=status.HTTP_201_CREATED)
async def ingest_stock_report(report: StockAnalysisReport) -> Response:
    """Accept a raw analysis report and atomically publish the latest revision."""

    report_payload = report.model_dump(mode="json", exclude_none=True, exclude_unset=True)
    content, accepted, report_hash = await _accept_report(report_payload)
    return JSONResponse(
        status_code=status.HTTP_201_CREATED if accepted else status.HTTP_200_OK,
        content=content,
        headers=_cache_headers(report_hash),
    )


@router.post("/scan", dependencies=[Depends(require_management_access)])
async def run_stock_scan() -> Response:
    """Run the in-process stock workflow and publish its report atomically."""

    if _scan_lock.locked():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A stock scan is already running.",
        )

    async with _scan_lock:
        try:
            content, report_hash = await _execute_stock_scan()
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Stock scan failed: {exc}",
            ) from exc
        return JSONResponse(content=content, headers=_cache_headers(report_hash))


async def run_stock_scheduler() -> None:
    """Run the stock workflow once per production day at the configured local time."""

    settings = get_settings()
    while True:
        now = datetime.now(UTC)
        next_run = _next_scheduled_run(
            now,
            timezone_name=settings.stock_schedule_timezone,
            hour=settings.stock_schedule_hour,
            minute=settings.stock_schedule_minute,
        )
        delay_seconds = max(0.0, (next_run.astimezone(UTC) - now).total_seconds())
        logger.info("Next stock scan scheduled for %s.", next_run.isoformat())
        await sleep(delay_seconds)

        if _scan_lock.locked():
            logger.info("Skipping scheduled stock scan because another scan is running.")
            continue

        async with _scan_lock:
            try:
                await _execute_stock_scan()
            except Exception:
                logger.exception("Scheduled stock scan failed.")


async def _execute_stock_scan() -> tuple[dict[str, Any], str]:
    report = await to_thread(_run_integrated_scan)
    content, _, report_hash = await _accept_report(report)
    content["scan"] = {
        "market_session": report.get("market_session", {}).get("name"),
        "market_regime": report.get("market_context", {}).get("regime"),
        "top_symbols": [row.get("symbol") for row in report.get("stocks", [])[:3]],
    }
    return content, report_hash


def _next_scheduled_run(
    now: datetime,
    *,
    timezone_name: str,
    hour: int,
    minute: int,
) -> datetime:
    timezone = ZoneInfo(timezone_name)
    local_now = now.astimezone(timezone)
    target = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target < local_now:
        target += timedelta(days=1)
    return target


@router.get("/reports/latest")
async def latest_stock_report(
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    """Return the latest report, or 304 when the caller already has this revision."""

    async with _report_lock:
        if _latest_report is None:
            persisted_report = _read_persisted_report()
            if persisted_report is not None:
                _store_report_unlocked(
                    persisted_report,
                    received_at=persisted_report["generated_at"],
                )

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


async def _accept_report(report: dict[str, Any]) -> tuple[dict[str, Any], bool, str]:
    report_hash = _report_hash(report)
    async with _report_lock:
        if _latest_report_hash == report_hash:
            return (
                _ingest_response(
                    report,
                    received_at=_latest_received_at,
                    report_hash=report_hash,
                    revision=_latest_revision,
                    accepted=False,
                ),
                False,
                report_hash,
            )

        _store_report_unlocked(report, received_at=datetime.now(UTC).isoformat())
        return (
            _ingest_response(
                report,
                received_at=_latest_received_at,
                report_hash=report_hash,
                revision=_latest_revision,
                accepted=True,
            ),
            True,
            report_hash,
        )


def _store_report_unlocked(report: dict[str, Any], *, received_at: str) -> None:
    global _latest_received_at, _latest_report, _latest_report_hash, _latest_revision

    _latest_report = deepcopy(report)
    _latest_received_at = received_at
    _latest_report_hash = _report_hash(report)
    _latest_revision += 1


def _run_integrated_scan() -> dict[str, Any]:
    from stock_backend.config_loader import load_yaml
    from stock_backend.workflows.morning_scan import run_scan_with_settings

    app_settings = get_settings()
    project_root = app_settings.stock_backend_dir
    settings = load_yaml(project_root / "config" / "settings.yaml")
    settings["workflow"]["data_mode"] = (
        app_settings.stock_data_mode or settings["workflow"]["data_mode"]
    )
    settings["opend"]["host"] = (
        app_settings.stock_opend_host or settings["opend"]["host"]
    )
    settings["opend"]["port"] = (
        app_settings.stock_opend_port or settings["opend"]["port"]
    )
    return run_scan_with_settings(project_root, settings)


def _read_persisted_report() -> dict[str, Any] | None:
    report_path = get_settings().stock_backend_dir / "outputs" / "report.json"
    if not report_path.is_file():
        return None
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
        validated = StockAnalysisReport.model_validate(payload)
    except (OSError, ValueError):
        return None
    return validated.model_dump(mode="json", exclude_none=True, exclude_unset=True)


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
