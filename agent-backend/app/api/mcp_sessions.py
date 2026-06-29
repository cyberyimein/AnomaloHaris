from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.container import get_mcp_manager, get_session_store

router = APIRouter(prefix="/api", tags=["mcp"])


class SessionMCPRequest(BaseModel):
    active_servers: list[str] = Field(default_factory=list)


@router.get("/sessions/{session_id}/mcp")
async def session_mcp(session_id: str) -> dict[str, Any]:
    active_server_names = get_session_store().get_active_mcp_servers(session_id)
    return {
        "session_id": session_id,
        "active_servers": sorted(active_server_names),
        "servers": get_mcp_manager().list_server_catalog(active_server_names),
    }


@router.put("/sessions/{session_id}/mcp")
async def set_session_mcp(
    session_id: str,
    request: SessionMCPRequest,
) -> dict[str, Any]:
    manager = get_mcp_manager()
    servers = manager.list_server_catalog()
    available = {str(server["name"]): server for server in servers}

    normalized: list[str] = []
    for server_name in request.active_servers:
        normalized_name = str(server_name).strip()
        if normalized_name not in available:
            raise HTTPException(status_code=404, detail=f"Unknown MCP server: {normalized_name}")
        if not available[normalized_name].get("enabled", True):
            raise HTTPException(status_code=409, detail=f"MCP server is disabled: {normalized_name}")
        normalized.append(normalized_name)

    get_session_store().set_active_mcp_servers(session_id, normalized)
    active_server_names = get_session_store().get_active_mcp_servers(session_id)
    return {
        "session_id": session_id,
        "active_servers": sorted(active_server_names),
        "servers": manager.list_server_catalog(active_server_names),
    }
