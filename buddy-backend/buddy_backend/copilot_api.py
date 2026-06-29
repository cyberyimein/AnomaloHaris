from typing import Any

from app.api.security import require_management_access
from app.config import get_settings
from app.container import get_buddy_gateway
from fastapi import APIRouter, Body, Depends, HTTPException, status

from buddy_backend import BuddyConfigurationError
from buddy_backend.copilot_hooks import CopilotHookError, CopilotHookService

router = APIRouter(
    prefix="/api/copilot",
    tags=["copilot"],
    dependencies=[Depends(require_management_access)],
)

HOOK_BODY = Body(default_factory=dict)


@router.post("/hooks/{event_name}")
async def copilot_hook(
    event_name: str,
    payload: dict[str, Any] = HOOK_BODY,
) -> dict[str, Any]:
    try:
        return CopilotHookService(
            get_buddy_gateway(),
            approval_timeout_seconds=get_settings().copilot_buddy_approval_timeout_seconds,
            permission_bridge_enabled=get_settings().copilot_buddy_permission_bridge_enabled,
        ).handle_event(event_name, payload)
    except CopilotHookError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except BuddyConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
