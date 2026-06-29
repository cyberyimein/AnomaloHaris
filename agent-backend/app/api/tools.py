from fastapi import APIRouter, Query

from app.container import get_session_store, get_tool_registry
from app.tools.base import ToolContext

router = APIRouter(prefix="/api", tags=["tools"])


@router.get("/tools")
async def list_tools(session_id: str | None = Query(default=None)) -> dict[str, object]:
    registry = get_tool_registry()
    context = None
    if session_id:
        context = ToolContext(
            session_id=session_id,
            active_skills=frozenset(get_session_store().get_active_skills(session_id)),
            active_mcp_servers=frozenset(get_session_store().get_active_mcp_servers(session_id)),
        )
    return {
        "tools": [tool.model_dump() for tool in await registry.list_tools(context=context)],
        "providers": await registry.status(context=context),
    }

