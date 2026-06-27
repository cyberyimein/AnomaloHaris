from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.security import require_management_access
from app.buddy import BuddyConfigurationError, BuddyConnectionError
from app.container import get_buddy_gateway

router = APIRouter(
    prefix="/api/buddy",
    tags=["buddy"],
    dependencies=[Depends(require_management_access)],
)


class BuddyConnectRequest(BaseModel):
    transport: str | None = None
    port: str | None = None
    baud_rate: int | None = None
    tcp_host: str | None = None
    tcp_port: int | None = None
    tcp_client_ip: str | None = None


class BuddyCommandRequest(BaseModel):
    command: str


class BuddyStateRequest(BaseModel):
    state: str
    text: str | None = None


class BuddyApprovalRequest(BaseModel):
    request_id: str
    text: str
    timeout_seconds: float = Field(default=30.0, ge=0.1, le=300.0)


BUDDY_CONNECT_BODY = Body(default_factory=BuddyConnectRequest)


@router.get("/status")
async def buddy_status() -> dict[str, Any]:
    return get_buddy_gateway().status()


@router.post("/connect")
async def buddy_connect(
    request: BuddyConnectRequest = BUDDY_CONNECT_BODY,
) -> dict[str, Any]:
    try:
        return get_buddy_gateway().connect(
            port=request.port,
            baud_rate=request.baud_rate,
            transport=request.transport,
            tcp_host=request.tcp_host,
            tcp_port=request.tcp_port,
            tcp_client_ip=request.tcp_client_ip,
        )
    except (BuddyConfigurationError, BuddyConnectionError) as exc:
        raise _buddy_http_error(exc) from exc


@router.post("/disconnect")
async def buddy_disconnect() -> dict[str, Any]:
    return get_buddy_gateway().disconnect()


@router.get("/events")
async def buddy_events(
    after_id: int | None = Query(default=None, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
) -> dict[str, Any]:
    return {"events": get_buddy_gateway().get_events(after_id=after_id, limit=limit)}


@router.post("/command")
async def buddy_command(request: BuddyCommandRequest) -> dict[str, Any]:
    try:
        return get_buddy_gateway().send_raw_command(request.command)
    except (BuddyConfigurationError, BuddyConnectionError) as exc:
        raise _buddy_http_error(exc) from exc


@router.post("/state")
async def buddy_state(request: BuddyStateRequest) -> dict[str, Any]:
    try:
        return get_buddy_gateway().set_state(request.state, request.text)
    except (BuddyConfigurationError, BuddyConnectionError) as exc:
        raise _buddy_http_error(exc) from exc


@router.post("/approval")
async def buddy_approval(request: BuddyApprovalRequest) -> dict[str, Any]:
    try:
        return get_buddy_gateway().request_approval(
            request.request_id,
            request.text,
            timeout_seconds=request.timeout_seconds,
        )
    except (BuddyConfigurationError, BuddyConnectionError) as exc:
        raise _buddy_http_error(exc) from exc


def _buddy_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, BuddyConfigurationError):
        return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
