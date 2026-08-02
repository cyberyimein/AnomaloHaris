from typing import Any

from fastapi import APIRouter, HTTPException, Response, status

from app.agent.session import RESUME_PROMPT_MARKER
from app.container import get_agent_runtime, get_session_store

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("")
async def list_sessions() -> dict[str, Any]:
    return {"sessions": get_session_store().list_sessions()}


@router.get("/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    snapshot = get_session_store().get_session_snapshot(session_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return {
        **snapshot,
        "messages": _visible_messages(snapshot["messages"]),
    }


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(session_id: str) -> Response:
    runtime = get_agent_runtime()
    if runtime.has_active_run(session_id):
        raise HTTPException(status_code=409, detail="Stop the active run before deleting it.")
    if get_session_store().get_session_snapshot(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    get_session_store().clear(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _visible_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    visible: list[dict[str, str]] = []
    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        content = content.strip()
        if not content or content.startswith(RESUME_PROMPT_MARKER):
            continue
        visible.append({"role": role, "content": content})
    return visible
