import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from app.agent.events import AgentEvent, event, make_run_id
from app.agent.memory import load_agent_memory_message
from app.agent.prompts import load_prompt_messages
from app.agent.session import SessionStore
from app.config import Settings
from app.llm.openai_client import LLMToolCall, OpenAIChatClient
from app.tools.base import ToolContext, ToolResult
from app.tools.mcp_provider import MCPManager
from app.tools.registry import ToolRegistry
from app.tools.skills import SkillManager

logger = logging.getLogger(__name__)


class AgentRuntime:
    def __init__(
        self,
        settings: Settings,
        sessions: SessionStore,
        skills: SkillManager,
        mcp: MCPManager,
        tools: ToolRegistry,
        llm: OpenAIChatClient,
    ) -> None:
        self.settings = settings
        self.sessions = sessions
        self.skills = skills
        self.mcp = mcp
        self.tools = tools
        self.llm = llm

    async def run(
        self,
        session_id: str,
        user_content: str,
        *,
        prompt_profile: str | None = None,
    ) -> AsyncIterator[AgentEvent]:
        run_id = make_run_id()
        profile_name = prompt_profile or self.settings.agent_prompt_profile
        logger.info(
            "Agent run started: session_id=%s profile=%s",
            session_id,
            profile_name,
        )
        yield event("run.started", session_id, run_id)

        try:
            prompt_messages = load_prompt_messages(
                self.settings.prompts_config_path,
                profile_name,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Prompt loading failed for session_id=%s", session_id)
            yield event("run.error", session_id, run_id, error=str(exc))
            return

        memory_message = load_agent_memory_message(self.settings.agent_memory_path)
        memory_messages = [memory_message] if memory_message is not None else []
        skill_catalog_message = self.skills.skill_catalog_message()
        skill_catalog_messages = (
            [skill_catalog_message] if skill_catalog_message is not None else []
        )
        mcp_catalog_message = self.mcp.catalog_message()
        mcp_catalog_messages = [mcp_catalog_message] if mcp_catalog_message is not None else []
        history_messages = self.sessions.get_messages(session_id)
        current_user_message = {"role": "user", "content": user_content}
        loop_messages: list[dict[str, Any]] = []
        self.sessions.append(session_id, {"role": "user", "content": user_content})

        debug_result = await self._maybe_run_debug_command(session_id, run_id, user_content)
        if debug_result is not None:
            async for item in debug_result:
                yield item
            return

        iteration = 0
        final_assistant_text = ""

        while iteration <= self.settings.max_tool_iterations:
            iteration += 1
            assistant_text = ""
            tool_calls: list[LLMToolCall] = []
            active_skill_names = self.sessions.get_active_skills(session_id)
            active_skill_messages = self.skills.build_active_skill_messages(active_skill_names)
            active_mcp_server_names = self.sessions.get_active_mcp_servers(session_id)
            active_mcp_messages = self.mcp.build_active_server_messages(active_mcp_server_names)
            messages = [
                *prompt_messages,
                *memory_messages,
                *skill_catalog_messages,
                *active_skill_messages,
                *mcp_catalog_messages,
                *active_mcp_messages,
                *history_messages,
                current_user_message,
                *loop_messages,
            ]
            all_tools = await self.tools.openai_tools(self._tool_context(session_id))
            current_user_message_index = (
                len(prompt_messages)
                + len(memory_messages)
                + len(skill_catalog_messages)
                + len(active_skill_messages)
                + len(mcp_catalog_messages)
                + len(active_mcp_messages)
                + len(history_messages)
            )

            try:
                yield event(
                    "llm.request",
                    session_id,
                    run_id,
                    profile=profile_name,
                    iteration=iteration,
                    context=_context_assembly(
                        profile=profile_name,
                        prompt_message_count=len(prompt_messages),
                        memory_message_count=len(memory_messages),
                        skill_catalog_message_count=len(skill_catalog_messages),
                        active_skill_message_count=len(active_skill_messages),
                        mcp_catalog_message_count=len(mcp_catalog_messages),
                        active_mcp_message_count=len(active_mcp_messages),
                        history_message_count=len(history_messages),
                        current_user_message_index=current_user_message_index,
                        total_message_count=len(messages),
                        tool_count=len(all_tools),
                        active_skills=sorted(active_skill_names),
                        active_mcp_servers=sorted(active_mcp_server_names),
                    ),
                    request=self.llm.request_payload(messages, all_tools),
                )
                async for item in self.llm.stream_chat(messages, all_tools):
                    if item.type == "message.delta":
                        assistant_text += item.content
                        final_assistant_text += item.content
                        yield event("message.delta", session_id, run_id, content=item.content)
                    elif item.type == "tool_calls":
                        tool_calls = item.tool_calls
                        break
                    elif item.type == "message.done":
                        self.sessions.append(
                            session_id,
                            {"role": "assistant", "content": assistant_text},
                        )
                        yield event("message.done", session_id, run_id)
                        logger.info(
                            "Agent run finished: session_id=%s text=%s",
                            session_id,
                            final_assistant_text[:160],
                        )
                        yield event(
                            "run.finished",
                            session_id,
                            run_id,
                            final_text=final_assistant_text,
                        )
                        return
            except Exception as exc:  # noqa: BLE001
                logger.exception("LLM streaming failed for session_id=%s", session_id)
                yield event("run.error", session_id, run_id, error=str(exc))
                return

            if not tool_calls:
                self.sessions.append(session_id, {"role": "assistant", "content": assistant_text})
                yield event("message.done", session_id, run_id)
                logger.info(
                    "Agent run finished without tool calls: session_id=%s text=%s",
                    session_id,
                    final_assistant_text[:160],
                )
                yield event("run.finished", session_id, run_id, final_text=final_assistant_text)
                return

            assistant_tool_message = {
                "role": "assistant",
                "content": assistant_text or None,
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": json.dumps(call.arguments, ensure_ascii=False),
                        },
                    }
                    for call in tool_calls
                ],
            }
            loop_messages.append(assistant_tool_message)

            for call in tool_calls:
                tool_context = self._tool_context(session_id)
                yield event(
                    "tool.started",
                    session_id,
                    run_id,
                    tool=call.name,
                    arguments=call.arguments,
                )
                logger.info("Tool call started: session_id=%s tool=%s", session_id, call.name)
                result = await self._call_tool_safely(call.name, call.arguments, tool_context)
                self._apply_skill_state(session_id, result)
                self._apply_mcp_state(session_id, result)
                yield event(
                    "tool.finished" if result.ok else "tool.error",
                    session_id,
                    run_id,
                    tool=call.name,
                    ok=result.ok,
                    content=result.content,
                    data=result.data,
                )
                logger.info(
                    "Tool call finished: session_id=%s tool=%s ok=%s",
                    session_id,
                    call.name,
                    result.ok,
                )
                loop_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "name": call.name,
                        "content": result.content,
                    }
                )

        yield event(
            "run.error",
            session_id,
            run_id,
            error="Maximum tool iterations reached.",
        )

    async def _call_tool_safely(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext,
    ) -> ToolResult:
        try:
            return await self.tools.call_tool(name, arguments, context=context)
        except Exception as exc:  # noqa: BLE001
            return ToolResult(
                name=name,
                ok=False,
                content=f"Tool execution error: {exc}",
                data={"error_type": exc.__class__.__name__},
            )

    def _tool_context(self, session_id: str) -> ToolContext:
        return ToolContext(
            session_id=session_id,
            active_skills=frozenset(self.sessions.get_active_skills(session_id)),
            active_mcp_servers=frozenset(self.sessions.get_active_mcp_servers(session_id)),
        )

    def _apply_skill_state(self, session_id: str, result: ToolResult) -> None:
        action = str(result.data.get("skill_action") or "")
        skill_name = str(result.data.get("skill_name") or "")
        if not skill_name or not result.ok:
            return
        if action == "activate":
            self.sessions.activate_skill(session_id, skill_name)
        elif action == "deactivate":
            self.sessions.deactivate_skill(session_id, skill_name)

    def _apply_mcp_state(self, session_id: str, result: ToolResult) -> None:
        action = str(result.data.get("mcp_action") or "")
        server_name = str(result.data.get("server_name") or "")
        if not server_name or not result.ok:
            return
        if action == "activate":
            self.sessions.activate_mcp_server(session_id, server_name)
        elif action == "deactivate":
            self.sessions.deactivate_mcp_server(session_id, server_name)

    async def _maybe_run_debug_command(
        self,
        session_id: str,
        run_id: str,
        user_content: str,
    ) -> AsyncIterator[AgentEvent] | None:
        stripped = user_content.strip()
        if not stripped.startswith("/python"):
            return None

        async def stream() -> AsyncIterator[AgentEvent]:
            code = stripped.removeprefix("/python").strip()
            if not code:
                message = "Usage: /python print(1 + 1)"
                yield event("message.delta", session_id, run_id, content=message)
                yield event("message.done", session_id, run_id)
                yield event("run.finished", session_id, run_id, final_text=message)
                return

            yield event(
                "tool.started",
                session_id,
                run_id,
                tool="sandbox_python_run",
                arguments={"code": code},
            )
            result = await self._call_tool_safely(
                "sandbox_python_run",
                {"code": code},
                self._tool_context(session_id),
            )
            yield event(
                "tool.finished" if result.ok else "tool.error",
                session_id,
                run_id,
                tool="sandbox_python_run",
                ok=result.ok,
                content=result.content,
                data=result.data,
            )
            final_text = result.content
            self.sessions.append(session_id, {"role": "assistant", "content": final_text})
            yield event("message.delta", session_id, run_id, content=final_text)
            yield event("message.done", session_id, run_id)
            yield event("run.finished", session_id, run_id, final_text=final_text)

        return stream()


def _context_assembly(
    *,
    profile: str,
    prompt_message_count: int,
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
) -> dict[str, Any]:
    memory_start = prompt_message_count
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
        "prompt_message_count": prompt_message_count,
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
