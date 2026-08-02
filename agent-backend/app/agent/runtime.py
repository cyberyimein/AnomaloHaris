import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app.agent.events import AgentEvent, event, make_run_id
from app.agent.memory import load_agent_memory_message
from app.agent.prompts import load_prompt_messages
from app.agent.response_format import (
    ResponseFormatInput,
    StructuredOutputValidationError,
    finalizer_instruction,
    normalize_response_format,
    response_format_type,
    validate_final_output,
)
from app.agent.session import RESUME_PROMPT_MARKER, SessionStore
from app.config import Settings
from app.llm.openai_client import LLMStreamInterrupted, LLMToolCall, OpenAIChatClient
from app.tools.base import ToolContext, ToolResult
from app.tools.mcp_provider import MCPManager
from app.tools.registry import ToolRegistry
from app.tools.skills import SkillManager

logger = logging.getLogger(__name__)
RESUME_PROMPT = (
    f"{RESUME_PROMPT_MARKER} Preserve completed work, "
    "recover from any interrupted tool call, and finish the user's request."
)


@dataclass
class _RunState:
    session_id: str
    run_id: str
    prompt_profile: str
    checkpoint_user_content: str
    history_messages: list[dict[str, Any]]
    current_user_message: dict[str, Any]
    final_response_format: dict[str, Any] | None = None
    final_output: Any = None
    iteration: int = 0
    loop_messages: list[dict[str, Any]] = field(default_factory=list)
    assistant_text: str = ""
    final_assistant_text: str = ""
    pending_tool_calls: list[LLMToolCall] = field(default_factory=list)
    completed_tool_call_ids: set[str] = field(default_factory=set)
    active_tool_index: int | None = None
    tool_message_added: bool = False
    stop_requested: bool = False
    stop_reason: str = "stopped"
    checkpoint_saved: bool = False
    completed: bool = False


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
        self._active_runs: dict[str, _RunState] = {}

    def request_stop(self, session_id: str, *, reason: str = "user_stop") -> str | None:
        state = self._active_runs.get(session_id)
        if state is None:
            return None
        state.stop_requested = True
        state.stop_reason = reason
        return state.run_id

    def has_checkpoint(self, session_id: str) -> bool:
        return self.sessions.has_checkpoint(session_id)

    def has_active_run(self, session_id: str) -> bool:
        return session_id in self._active_runs

    async def run(
        self,
        session_id: str,
        user_content: str | None = None,
        *,
        prompt_profile: str | None = None,
        resume: bool = False,
        response_format: ResponseFormatInput = None,
    ) -> AsyncIterator[AgentEvent]:
        run_id = make_run_id()
        if session_id in self._active_runs:
            yield event(
                "run.error",
                session_id,
                run_id,
                error="A run is already active for this session.",
            )
            return
        if not resume and not str(user_content or "").strip():
            yield event("run.error", session_id, run_id, error="Message content is required.")
            return

        try:
            requested_response_format = normalize_response_format(response_format)
        except ValueError as exc:
            yield event(
                "run.error",
                session_id,
                run_id,
                error=str(exc),
                error_code="invalid_response_format",
            )
            return

        checkpoint = self.sessions.get_checkpoint(session_id) if resume else None
        if resume and checkpoint is None:
            yield event(
                "run.error",
                session_id,
                run_id,
                error="No paused run is available for this session.",
            )
            return
        if not resume and self.sessions.has_checkpoint(session_id):
            yield event(
                "run.error",
                session_id,
                run_id,
                error=(
                    "A paused run exists for this session. "
                    "Resume it before sending a new message."
                ),
                can_resume=True,
            )
            return

        if (
            resume
            and response_format is not None
            and requested_response_format != (checkpoint.response_format if checkpoint else None)
        ):
            yield event(
                "run.error",
                session_id,
                run_id,
                error="The requested response_format does not match the paused run.",
                error_code="response_format_mismatch",
                can_resume=True,
            )
            return

        if checkpoint is not None:
            self.sessions.replace(session_id, checkpoint.messages)

        profile_name = prompt_profile or (
            checkpoint.prompt_profile
            if checkpoint is not None
            else self.settings.agent_prompt_profile
        )
        history_messages = self.sessions.get_messages(session_id)
        checkpoint_user_content = (
            checkpoint.user_content
            if resume and checkpoint is not None
            else str(user_content or "")
        )
        final_response_format = (
            checkpoint.response_format
            if resume and checkpoint is not None
            else requested_response_format
        )
        current_user_message = {
            "role": "user",
            "content": RESUME_PROMPT if resume else str(user_content or ""),
        }
        state = _RunState(
            session_id=session_id,
            run_id=run_id,
            prompt_profile=profile_name,
            checkpoint_user_content=checkpoint_user_content,
            history_messages=history_messages,
            current_user_message=current_user_message,
            final_response_format=final_response_format,
            iteration=checkpoint.iteration if resume and checkpoint is not None else 0,
        )
        self._active_runs[session_id] = state
        self.sessions.append(session_id, current_user_message)
        logger.info(
            "Agent run started: session_id=%s run_id=%s profile=%s resume=%s output=%s",
            session_id,
            run_id,
            profile_name,
            resume,
            response_format_type(final_response_format),
        )

        try:
            yield event("run.started", session_id, run_id, resumed=resume)
            async for item in self._run(state, profile_name):
                if item.type == "run.finished":
                    state.completed = True
                    if resume:
                        self.sessions.clear_checkpoint(session_id)
                elif item.type == "run.error" and resume:
                    item.data.setdefault("can_resume", self.sessions.has_checkpoint(session_id))
                yield item
        except LLMStreamInterrupted as exc:
            state.assistant_text = exc.content
            state.pending_tool_calls = exc.tool_calls
            self._save_checkpoint(state)
            yield event(
                "run.stopped",
                session_id,
                run_id,
                reason=state.stop_reason,
                checkpointed=True,
                can_resume=True,
            )
        except asyncio.CancelledError:
            self._save_checkpoint(state)
            yield event(
                "run.stopped",
                session_id,
                run_id,
                reason=state.stop_reason,
                checkpointed=True,
                can_resume=True,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Agent run failed for session_id=%s", session_id)
            state.completed = True
            yield event(
                "run.error",
                session_id,
                run_id,
                error=str(exc),
                can_resume=resume and self.sessions.has_checkpoint(session_id),
            )
        finally:
            if not state.completed and not state.checkpoint_saved:
                self._save_checkpoint(state)
            if self._active_runs.get(session_id) is state:
                self._active_runs.pop(session_id, None)

    async def _run(self, state: _RunState, profile_name: str) -> AsyncIterator[AgentEvent]:
        prompt_messages = load_prompt_messages(
            self.settings.prompts_config_path,
            profile_name,
        )
        memory_message = load_agent_memory_message(self.settings.agent_memory_path)
        memory_messages = [memory_message] if memory_message is not None else []
        skill_catalog_message = self.skills.skill_catalog_message()
        skill_catalog_messages = (
            [skill_catalog_message] if skill_catalog_message is not None else []
        )
        mcp_catalog_message = self.mcp.catalog_message()
        mcp_catalog_messages = [mcp_catalog_message] if mcp_catalog_message is not None else []

        debug_result = await self._maybe_run_debug_command(
            state.session_id,
            state.run_id,
            str(state.current_user_message["content"]),
        )
        if debug_result is not None:
            async for item in debug_result:
                yield item
            return

        while state.iteration <= self.settings.max_tool_iterations:
            state.iteration += 1
            state.assistant_text = ""
            state.pending_tool_calls = []
            state.completed_tool_call_ids = set()
            state.active_tool_index = None
            state.tool_message_added = False
            active_skill_names = self.sessions.get_active_skills(state.session_id)
            active_skill_messages = self.skills.build_active_skill_messages(active_skill_names)
            active_mcp_server_names = self.sessions.get_active_mcp_servers(state.session_id)
            active_mcp_messages = self.mcp.build_active_server_messages(active_mcp_server_names)
            messages = [
                *prompt_messages,
                *memory_messages,
                *skill_catalog_messages,
                *active_skill_messages,
                *mcp_catalog_messages,
                *active_mcp_messages,
                *state.history_messages,
                state.current_user_message,
                *state.loop_messages,
            ]
            all_tools = await self.tools.openai_tools(self._tool_context(state.session_id))
            current_user_message_index = (
                len(prompt_messages)
                + len(memory_messages)
                + len(skill_catalog_messages)
                + len(active_skill_messages)
                + len(mcp_catalog_messages)
                + len(active_mcp_messages)
                + len(state.history_messages)
            )

            yield event(
                "llm.request",
                state.session_id,
                state.run_id,
                profile=profile_name,
                iteration=state.iteration,
                context=_context_assembly(
                    profile=profile_name,
                    prompt_message_count=len(prompt_messages),
                    memory_message_count=len(memory_messages),
                    skill_catalog_message_count=len(skill_catalog_messages),
                    active_skill_message_count=len(active_skill_messages),
                    mcp_catalog_message_count=len(mcp_catalog_messages),
                    active_mcp_message_count=len(active_mcp_messages),
                    history_message_count=len(state.history_messages),
                    current_user_message_index=current_user_message_index,
                    total_message_count=len(messages),
                    tool_count=len(all_tools),
                    active_skills=sorted(active_skill_names),
                    active_mcp_servers=sorted(active_mcp_server_names),
                ),
                request=self.llm.request_payload(messages, all_tools),
            )

            tool_calls: list[LLMToolCall] = []
            async for item in self.llm.stream_chat(messages, all_tools):
                if item.type == "message.delta":
                    state.assistant_text += item.content
                    if not _requires_structured_finalizer(state):
                        state.final_assistant_text += item.content
                        yield event(
                            "message.delta",
                            state.session_id,
                            state.run_id,
                            content=item.content,
                        )
                elif item.type == "tool_calls":
                    tool_calls = item.tool_calls
                    state.pending_tool_calls = tool_calls
                    break
                elif item.type == "message.done":
                    break

            if not tool_calls:
                if _requires_structured_finalizer(state):
                    async for final_event in self._run_finalizer(state, messages, profile_name):
                        yield final_event
                    return
                self._persist_completed_response(state, state.assistant_text)
                yield event("message.done", state.session_id, state.run_id)
                state.completed = True
                yield event(
                    "run.finished",
                    state.session_id,
                    state.run_id,
                    final_text=state.final_assistant_text,
                )
                return

            state.loop_messages.append(_assistant_tool_message(tool_calls, state.assistant_text))
            state.tool_message_added = True
            for index, call in enumerate(tool_calls):
                state.active_tool_index = index
                tool_context = self._tool_context(state.session_id)
                yield event(
                    "tool.started",
                    state.session_id,
                    state.run_id,
                    tool_call_id=call.id,
                    tool=call.name,
                    arguments=call.arguments,
                )
                logger.info("Tool call started: session_id=%s tool=%s", state.session_id, call.name)
                result = await self._call_tool_safely(call.name, call.arguments, tool_context)
                self._apply_skill_state(state.session_id, result)
                self._apply_mcp_state(state.session_id, result)
                if result.data.get("trace_kind") in {"web_search", "web_fetch"}:
                    self.sessions.append_web_trace(
                        state.session_id,
                        {
                            "id": call.id,
                            "tool_call_id": call.id,
                            "run_id": state.run_id,
                            "tool": call.name,
                            "ok": result.ok,
                            "arguments": call.arguments,
                            "content": result.content,
                            "data": result.data,
                        },
                    )
                state.loop_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "name": call.name,
                        "content": result.content,
                    }
                )
                state.completed_tool_call_ids.add(call.id)
                yield event(
                    "tool.finished" if result.ok else "tool.error",
                    state.session_id,
                    state.run_id,
                    tool_call_id=call.id,
                    tool=call.name,
                    ok=result.ok,
                    content=result.content,
                    data=result.data,
                )
                logger.info(
                    "Tool call finished: session_id=%s tool=%s ok=%s",
                    state.session_id,
                    call.name,
                    result.ok,
                )

            state.pending_tool_calls = []
            state.completed_tool_call_ids = set()
            state.active_tool_index = None

        self._persist_loop_messages(state)
        state.completed = True
        yield event(
            "run.error",
            state.session_id,
            state.run_id,
            error="Maximum tool iterations reached.",
        )

    async def _run_finalizer(
        self,
        state: _RunState,
        messages: list[dict[str, Any]],
        profile_name: str,
    ) -> AsyncIterator[AgentEvent]:
        response_format = state.final_response_format
        if not _requires_structured_finalizer(state) or response_format is None:
            return

        validation_error: str | None = None
        final_text = ""
        final_output: Any = None
        finalizer_messages: list[dict[str, Any]] = [
            *messages,
            {"role": "user", "content": finalizer_instruction(response_format)},
        ]

        for attempt in range(2):
            if attempt:
                finalizer_messages = [
                    *messages,
                    {
                        "role": "user",
                        "content": finalizer_instruction(response_format),
                    },
                    {"role": "assistant", "content": final_text},
                    {
                        "role": "user",
                        "content": finalizer_instruction(response_format, validation_error),
                    },
                ]

            try:
                request = self.llm.request_payload(
                    finalizer_messages,
                    [],
                    response_format=response_format,
                )
            except Exception as exc:  # noqa: BLE001
                state.stop_reason = "finalizer_error"
                self._save_checkpoint(state)
                state.completed = True
                yield event(
                    "run.error",
                    state.session_id,
                    state.run_id,
                    error=str(exc),
                    error_code="finalizer_failed",
                    can_resume=True,
                )
                return
            yield event(
                "llm.request",
                state.session_id,
                state.run_id,
                profile=profile_name,
                iteration=state.iteration,
                phase="finalizer",
                attempt=attempt + 1,
                context={
                    "phase": "finalizer",
                    "total_message_count": len(finalizer_messages),
                    "tool_count": 0,
                },
                request=request,
            )

            try:
                final_text = await self.llm.complete_chat(
                    finalizer_messages,
                    response_format=response_format,
                )
            except Exception as exc:  # noqa: BLE001
                state.stop_reason = "finalizer_error"
                self._save_checkpoint(state)
                state.completed = True
                yield event(
                    "run.error",
                    state.session_id,
                    state.run_id,
                    error=str(exc),
                    error_code="finalizer_failed",
                    can_resume=True,
                )
                return
            try:
                final_output = validate_final_output(final_text, response_format)
            except StructuredOutputValidationError as exc:
                validation_error = str(exc)
                if attempt == 0:
                    continue
                self._persist_loop_messages(state)
                state.completed = True
                yield event(
                    "run.error",
                    state.session_id,
                    state.run_id,
                    error=validation_error,
                    error_code="structured_output_invalid",
                    output_format=response_format_type(response_format),
                )
                return
            break

        state.final_assistant_text = final_text
        state.final_output = final_output
        self._persist_completed_response(state, final_text)
        yield event("message.delta", state.session_id, state.run_id, content=final_text)
        yield event("message.done", state.session_id, state.run_id)
        state.completed = True
        yield event(
            "run.finished",
            state.session_id,
            state.run_id,
            final_text=final_text,
            output=final_output,
            output_format=response_format_type(response_format),
        )

    def _persist_completed_response(self, state: _RunState, assistant_text: str) -> None:
        self._persist_loop_messages(state)
        self.sessions.append(
            state.session_id,
            {"role": "assistant", "content": assistant_text},
        )

    def _persist_loop_messages(self, state: _RunState) -> None:
        if not state.loop_messages:
            return
        self.sessions.append_many(state.session_id, state.loop_messages)
        state.loop_messages = []

    def _save_checkpoint(self, state: _RunState) -> None:
        if state.checkpoint_saved:
            return
        messages = [*state.history_messages, state.current_user_message, *state.loop_messages]
        if state.pending_tool_calls and not state.tool_message_added:
            messages.append(_assistant_tool_message(state.pending_tool_calls, state.assistant_text))
            messages.extend(
                _recovery_tool_message(call, state.stop_reason, index)
                for index, call in enumerate(state.pending_tool_calls)
            )
        elif state.pending_tool_calls:
            messages.extend(
                _recovery_tool_message(call, state.stop_reason, index)
                for index, call in enumerate(state.pending_tool_calls)
                if call.id not in state.completed_tool_call_ids
            )
        elif (
            state.assistant_text
            and not state.tool_message_added
            and not _requires_structured_finalizer(state)
        ):
            messages.append({"role": "assistant", "content": state.assistant_text})

        self.sessions.save_checkpoint(
            state.session_id,
            messages,
            run_id=state.run_id,
            prompt_profile=state.prompt_profile,
            user_content=state.checkpoint_user_content,
            iteration=state.iteration,
            reason=state.stop_reason,
            response_format=state.final_response_format,
        )
        state.checkpoint_saved = True

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
            if not self.settings.python_sandbox_enabled:
                message = "Python sandbox is disabled for this deployment."
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


def _assistant_tool_message(
    tool_calls: list[LLMToolCall],
    content: str,
) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": content or None,
        "tool_calls": [
            {
                "id": call.id or f"call_{index}",
                "type": "function",
                "function": {
                    "name": call.name or "__interrupted_tool_call__",
                    "arguments": json.dumps(
                        call.arguments if isinstance(call.arguments, dict) else {},
                        ensure_ascii=False,
                    ),
                },
            }
            for index, call in enumerate(tool_calls)
        ],
    }


def _recovery_tool_message(call: LLMToolCall, reason: str, index: int = 0) -> dict[str, Any]:
    tool_id = call.id or f"call_{index}"
    tool_name = call.name or "__interrupted_tool_call__"
    return {
        "role": "tool",
        "tool_call_id": tool_id,
        "name": tool_name,
        "content": (
            "[recovery] This tool call was interrupted before a usable result was returned "
            f"(reason: {reason}). Do not assume it succeeded; retry it if needed."
        ),
    }


def _requires_structured_finalizer(state: _RunState) -> bool:
    return response_format_type(state.final_response_format) in {"json_object", "json_schema"}


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
