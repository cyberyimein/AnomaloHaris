from typing import Any

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel

from app.agent.session import RESUME_PROMPT_MARKER
from app.config import get_settings
from app.container import get_agent_runtime, get_preset_agent_store, get_session_store
from app.search_modes import SearchMode, search_mode_options

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


class SearchModeUpdate(BaseModel):
    mode: SearchMode


@router.get("")
async def list_sessions() -> dict[str, Any]:
    return {
        "sessions": [
            {**summary, "preset_agent": _preset_agent_summary(summary["session_id"])}
            for summary in get_session_store().list_sessions()
        ]
    }


@router.get("/{session_id}")
async def get_session(session_id: str) -> dict[str, Any]:
    snapshot = get_session_store().get_session_snapshot(session_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return {
        **snapshot,
        "messages": _visible_messages(snapshot["messages"]),
        "preset_agent": _preset_agent_summary(session_id),
    }


@router.get("/{session_id}/search-mode")
async def get_search_mode(session_id: str) -> dict[str, object]:
    settings = get_settings()
    return _search_mode_payload(session_id, settings.web_research_subagent_model)


@router.patch("/{session_id}/search-mode")
async def update_search_mode(
    session_id: str,
    request: SearchModeUpdate,
) -> dict[str, object]:
    runtime = get_agent_runtime()
    if runtime.has_active_run(session_id):
        raise HTTPException(
            status_code=409,
            detail="Stop the active run before changing search mode.",
        )
    settings = get_settings()
    mode = get_session_store().set_search_mode(session_id, request.mode)
    return _search_mode_payload(session_id, settings.web_research_subagent_model, mode=mode)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(session_id: str) -> Response:
    runtime = get_agent_runtime()
    if runtime.has_active_run(session_id):
        raise HTTPException(status_code=409, detail="Stop the active run before deleting it.")
    if get_session_store().get_session_snapshot(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    get_session_store().clear(session_id)
    get_preset_agent_store().unbind_session(session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _preset_agent_summary(session_id: str) -> dict[str, object] | None:
    store = get_preset_agent_store()
    agent_id = store.get_bound_agent_id(session_id)
    if agent_id is None:
        return None
    agent = store.get(agent_id)
    if agent is None:
        return {"id": agent_id, "name": "Deleted preset agent", "deleted": True}
    return {
        "id": agent.id,
        "name": agent.name,
        "description": agent.description,
        "ghost": agent.ghost,
        "model": agent.model,
        "tool_count": len(agent.tool_names),
        "deleted": False,
    }


def _search_mode_payload(
    session_id: str,
    subagent_model: str,
    *,
    mode: SearchMode | None = None,
) -> dict[str, object]:
    selected_mode = mode or get_session_store().get_search_mode(session_id)
    return {
        "session_id": session_id,
        "mode": selected_mode,
        "model": get_settings().openrouter_model,
        "subagent_model": subagent_model,
        "modes": search_mode_options(subagent_model),
    }


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
