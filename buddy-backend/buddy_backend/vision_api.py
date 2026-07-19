from typing import Any

from app.api.security import require_management_access
from app.config import get_settings
from app.container import get_buddy_gateway, get_buddy_vision_service
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status

from buddy_backend import BuddyConnectionError
from buddy_backend.vision import BuddyVisionConfigurationError, BuddyVisionProcessingError

router = APIRouter(
    prefix="/api/buddy/vision",
    tags=["buddy-vision"],
)

VISION_UPLOAD = File(...)


async def require_buddy_vision_frame_access(request: Request) -> None:
    try:
        await require_management_access(request)
        return
    except HTTPException as exc:
        if exc.status_code != status.HTTP_403_FORBIDDEN:
            raise

    settings = get_settings()
    frame_token = request.headers.get("x-anomalo-buddy-vision-token")
    if settings.buddy_vision_frame_token and frame_token == settings.buddy_vision_frame_token:
        return

    client_host = request.client.host if request.client else ""
    allowed_ip = settings.buddy_vision_frame_client_ip or settings.buddy_tcp_client_ip
    if allowed_ip and client_host == allowed_ip:
        return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            "Buddy vision frame upload requires localhost access, a valid admin token, "
            "a valid Buddy vision frame token, or a configured Buddy client IP."
        ),
    )


@router.get("/status", dependencies=[Depends(require_management_access)])
async def buddy_vision_status() -> dict[str, Any]:
    return get_buddy_vision_service().status()


@router.post("/start", dependencies=[Depends(require_management_access)])
async def buddy_vision_start() -> dict[str, Any]:
    service = get_buddy_vision_service()
    detector_was_loaded = bool(service.status().get("detector_loaded"))
    try:
        result = service.start()
        command = get_buddy_gateway().send_raw_command("VISION START")
        return {**result, "capture_command": command["command"]}
    except BuddyVisionConfigurationError as exc:
        raise _vision_http_error(exc) from exc
    except BuddyConnectionError as exc:
        if not detector_was_loaded:
            service.stop()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


@router.post("/enable", dependencies=[Depends(require_management_access)])
async def buddy_vision_enable() -> dict[str, Any]:
    try:
        return get_buddy_vision_service().enable()
    except BuddyVisionConfigurationError as exc:
        raise _vision_http_error(exc) from exc


@router.post("/disable", dependencies=[Depends(require_management_access)])
async def buddy_vision_disable() -> dict[str, Any]:
    try:
        command = get_buddy_gateway().send_raw_command("VISION STOP")
    except BuddyConnectionError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    result = get_buddy_vision_service().disable()
    return {**result, "capture_command": command["command"]}


@router.post("/detect", dependencies=[Depends(require_management_access)])
async def buddy_vision_detect(
    file: UploadFile = VISION_UPLOAD,
    apply_buddy_action: bool = Form(False),
    min_confidence: float | None = Form(None),
) -> dict[str, Any]:
    return await _detect_upload(
        file,
        apply_buddy_action=apply_buddy_action,
        min_confidence=min_confidence,
    )


@router.post("/frame", dependencies=[Depends(require_buddy_vision_frame_access)])
async def buddy_vision_frame(
    file: UploadFile = VISION_UPLOAD,
    apply_buddy_action: bool = Form(True),
    min_confidence: float | None = Form(None),
) -> dict[str, Any]:
    return await _detect_upload(
        file,
        apply_buddy_action=apply_buddy_action,
        min_confidence=min_confidence,
    )


async def _detect_upload(
    file: UploadFile,
    *,
    apply_buddy_action: bool,
    min_confidence: float | None,
) -> dict[str, Any]:
    try:
        payload = await file.read()
        return get_buddy_vision_service().detect_image(
            payload,
            apply_buddy_action=apply_buddy_action,
            min_confidence=min_confidence,
        )
    except (BuddyVisionConfigurationError, BuddyVisionProcessingError, ValueError) as exc:
        raise _vision_http_error(exc) from exc


def _vision_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, BuddyVisionConfigurationError):
        return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
