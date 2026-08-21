"""Agent context assembly seam.

The caller supplies a small immutable request. Prompt files, memory, skills,
MCP notes, session history, and tool filtering remain inside this module so the
runtime loop does not need to know how resources are loaded.
"""

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from app.agent.memory import load_agent_memory_message
from app.agent.prompts import load_prompt_messages
from app.config import Settings
from app.search_modes import SEARCH_MODE_DIY, SearchMode, search_mode_instruction
from app.tools.base import ToolContext

BOOTSTRAP_CONTEXT_PREFIX = (
    "Authoritative runtime context captured at the start of this run. "
    "Use these values directly; do not call a tool to rediscover them:\n"
)


@dataclass(frozen=True)
class ContextRequest:
    session_id: str
    prompt_profile: str
    system_prompt: str | None
    search_mode: SearchMode
    model: str
    allowed_tool_names: frozenset[str] | None
    bootstrap_context: list[dict[str, Any]]
    history_messages: list[dict[str, Any]]
    current_user_message: dict[str, Any]
    loop_messages: list[dict[str, Any]]


@dataclass(frozen=True)
class BuiltContext:
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]]
    diagnostics: dict[str, Any]


@dataclass(frozen=True)
class ContextSnapshot:
    """Static run context; active plugins and tools are resolved per iteration."""

    session_id: str
    prompt_profile: str
    search_mode: SearchMode
    model: str
    allowed_tool_names: frozenset[str] | None
    prompt_messages: tuple[dict[str, Any], ...]
    bootstrap_messages: tuple[dict[str, Any], ...]
    memory_messages: tuple[dict[str, Any], ...]
    skill_catalog_messages: tuple[dict[str, Any], ...]
    mcp_catalog_messages: tuple[dict[str, Any], ...]
    history_messages: tuple[dict[str, Any], ...]
    current_user_message: dict[str, Any]


class ContextBuilder:
    """Capture static run context and project dynamic tools for each model request."""

    def __init__(
        self,
        settings: Settings,
        sessions: Any,
        skills: Any,
        mcp: Any,
        tools: Any,
    ) -> None:
        self.settings = settings
        self.sessions = sessions
        self.skills = skills
        self.mcp = mcp
        self.tools = tools

    async def prepare(self, request: ContextRequest) -> ContextSnapshot:
        """Capture all filesystem, session, plugin, and tool state for one run."""
        prompt_messages = (
            [{"role": "system", "content": request.system_prompt}]
            if request.system_prompt is not None
            else load_prompt_messages(self.settings.prompts_config_path, request.prompt_profile)
        )
        has_search_tool = (
            (request.allowed_tool_names is None or "web_search" in request.allowed_tool_names)
            and (request.search_mode != SEARCH_MODE_DIY or self.settings.web_tools_enabled)
        )
        if has_search_tool:
            prompt_messages.append(
                {
                    "role": "system",
                    "content": search_mode_instruction(
                        request.search_mode,
                        model=request.model,
                        subagent_model=self.settings.web_research_subagent_model,
                    ),
                }
            )

        memory_message = load_agent_memory_message(self.settings.agent_memory_path)
        memory_messages = [memory_message] if memory_message is not None else []
        skill_catalog_message = self.skills.skill_catalog_message()
        skill_catalog_messages = (
            [skill_catalog_message] if skill_catalog_message is not None else []
        )
        mcp_catalog_message = self.mcp.catalog_message()
        mcp_catalog_messages = [mcp_catalog_message] if mcp_catalog_message is not None else []
        bootstrap_messages = (
            [
                {
                    "role": "system",
                    "content": BOOTSTRAP_CONTEXT_PREFIX
                    + _compact_json(request.bootstrap_context),
                }
            ]
            if request.bootstrap_context
            else []
        )

        return ContextSnapshot(
            session_id=request.session_id,
            prompt_profile=request.prompt_profile,
            search_mode=request.search_mode,
            model=request.model,
            allowed_tool_names=request.allowed_tool_names,
            prompt_messages=tuple(deepcopy(prompt_messages)),
            bootstrap_messages=tuple(deepcopy(bootstrap_messages)),
            memory_messages=tuple(deepcopy(memory_messages)),
            skill_catalog_messages=tuple(deepcopy(skill_catalog_messages)),
            mcp_catalog_messages=tuple(deepcopy(mcp_catalog_messages)),
            history_messages=tuple(deepcopy(request.history_messages)),
            current_user_message=deepcopy(request.current_user_message),
        )

    async def render(
        self,
        snapshot: ContextSnapshot,
        loop_messages: list[dict[str, Any]],
    ) -> BuiltContext:
        """Refresh active plugin projections while reusing the static run snapshot."""
        active_skill_names = frozenset(self.sessions.get_active_skills(snapshot.session_id))
        active_skill_messages = self.skills.build_active_skill_messages(active_skill_names)
        active_mcp_server_names = frozenset(
            self.sessions.get_active_mcp_servers(snapshot.session_id)
        )
        active_mcp_messages = self.mcp.build_active_server_messages(active_mcp_server_names)
        all_tools = await self.tools.openai_tools(
            ToolContext(
                session_id=snapshot.session_id,
                active_skills=active_skill_names,
                active_mcp_servers=active_mcp_server_names,
                search_mode=snapshot.search_mode,
                model=snapshot.model,
            )
        )
        if snapshot.allowed_tool_names is not None:
            all_tools = [
                tool
                for tool in all_tools
                if str(tool.get("function", {}).get("name")) in snapshot.allowed_tool_names
            ]

        messages = [
            *deepcopy(snapshot.prompt_messages),
            *deepcopy(snapshot.bootstrap_messages),
            *deepcopy(snapshot.memory_messages),
            *deepcopy(snapshot.skill_catalog_messages),
            *deepcopy(active_skill_messages),
            *deepcopy(snapshot.mcp_catalog_messages),
            *deepcopy(active_mcp_messages),
            *deepcopy(snapshot.history_messages),
            deepcopy(snapshot.current_user_message),
            *deepcopy(loop_messages),
        ]
        current_user_message_index = (
            len(snapshot.prompt_messages)
            + len(snapshot.bootstrap_messages)
            + len(snapshot.memory_messages)
            + len(snapshot.skill_catalog_messages)
            + len(active_skill_messages)
            + len(snapshot.mcp_catalog_messages)
            + len(active_mcp_messages)
            + len(snapshot.history_messages)
        )
        diagnostics = context_diagnostics(
            profile=snapshot.prompt_profile,
            prompt_message_count=len(snapshot.prompt_messages),
            bootstrap_message_count=len(snapshot.bootstrap_messages),
            memory_message_count=len(snapshot.memory_messages),
            skill_catalog_message_count=len(snapshot.skill_catalog_messages),
            active_skill_message_count=len(active_skill_messages),
            mcp_catalog_message_count=len(snapshot.mcp_catalog_messages),
            active_mcp_message_count=len(active_mcp_messages),
            history_message_count=len(snapshot.history_messages),
            current_user_message_index=current_user_message_index,
            total_message_count=len(messages),
            tool_count=len(all_tools),
            active_skills=sorted(active_skill_names),
            active_mcp_servers=sorted(active_mcp_server_names),
            search_mode=snapshot.search_mode,
            model=snapshot.model,
        )
        return BuiltContext(
            messages=messages,
            tools=deepcopy(all_tools),
            diagnostics=diagnostics,
        )

    async def build(self, request: ContextRequest) -> BuiltContext:
        """Build a context for compatibility callers using a single request."""
        snapshot = await self.prepare(request)
        return await self.render(snapshot, request.loop_messages)


def _compact_json(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def context_diagnostics(
    *,
    profile: str,
    prompt_message_count: int,
    bootstrap_message_count: int,
    memory_message_count: int,
    skill_catalog_message_count: int,
    active_skill_message_count: int,
    mcp_catalog_message_count: int,
    active_mcp_message_count: int,
    history_message_count: int,
    current_user_message_index: int,
    total_message_count: int,
    tool_count: int,
    active_skills: list[str],
    active_mcp_servers: list[str],
    search_mode: SearchMode,
    model: str,
) -> dict[str, Any]:
    bootstrap_start = prompt_message_count
    memory_start = bootstrap_start + bootstrap_message_count
    skill_catalog_start = memory_start + memory_message_count
    active_skill_start = skill_catalog_start + skill_catalog_message_count
    mcp_catalog_start = active_skill_start + active_skill_message_count
    active_mcp_start = mcp_catalog_start + mcp_catalog_message_count
    history_start = active_mcp_start + active_mcp_message_count
    tool_loop_start = current_user_message_index + 1
    segments = [
        {
            "name": "prompt_profile",
            "label": f"Prompt profile: {profile}",
            "start": 0,
            "end": prompt_message_count,
            "count": prompt_message_count,
        },
        {
            "name": "bootstrap_context",
            "label": "Runtime bootstrap context",
            "start": bootstrap_start,
            "end": memory_start,
            "count": bootstrap_message_count,
        },
        {
            "name": "agent_memory",
            "label": "AGENTS.md memory",
            "start": memory_start,
            "end": skill_catalog_start,
            "count": memory_message_count,
        },
        {
            "name": "skill_catalog",
            "label": "Available skill catalog",
            "start": skill_catalog_start,
            "end": active_skill_start,
            "count": skill_catalog_message_count,
        },
        {
            "name": "active_skills",
            "label": "Active skill instructions",
            "start": active_skill_start,
            "end": mcp_catalog_start,
            "count": active_skill_message_count,
        },
        {
            "name": "mcp_catalog",
            "label": "Available MCP servers",
            "start": mcp_catalog_start,
            "end": active_mcp_start,
            "count": mcp_catalog_message_count,
        },
        {
            "name": "active_mcp_servers",
            "label": "Active MCP server notes",
            "start": active_mcp_start,
            "end": history_start,
            "count": active_mcp_message_count,
        },
        {
            "name": "session_history",
            "label": "Session history",
            "start": history_start,
            "end": history_start + history_message_count,
            "count": history_message_count,
        },
        {
            "name": "current_user_message",
            "label": "Current user message",
            "start": current_user_message_index,
            "end": current_user_message_index + 1,
            "count": 1,
        },
        {
            "name": "tool_loop_transcript",
            "label": "Tool loop transcript",
            "start": tool_loop_start,
            "end": total_message_count,
            "count": max(0, total_message_count - tool_loop_start),
        },
    ]
    return {
        "profile": profile,
        "model": model,
        "search_mode": search_mode,
        "prompt_message_count": prompt_message_count,
        "bootstrap_message_count": bootstrap_message_count,
        "memory_message_count": memory_message_count,
        "skill_catalog_message_count": skill_catalog_message_count,
        "active_skill_message_count": active_skill_message_count,
        "mcp_catalog_message_count": mcp_catalog_message_count,
        "active_mcp_message_count": active_mcp_message_count,
        "history_message_count": history_message_count,
        "active_skill_count": len(active_skills),
        "active_skills": active_skills,
        "active_mcp_server_count": len(active_mcp_servers),
        "active_mcp_servers": active_mcp_servers,
        "current_user_message_index": current_user_message_index,
        "total_message_count": total_message_count,
        "tool_count": tool_count,
        "segments": segments,
    }
