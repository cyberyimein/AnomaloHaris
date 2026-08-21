import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app.agent.context import ContextBuilder, ContextRequest
from app.agent.controller import RunController
from app.agent.core import (
    AgentCore,
    assistant_tool_message,
    requires_structured_finalizer,
)
from app.agent.events import AgentEvent, event, make_run_id
from app.agent.response_format import (
    ResponseFormatInput,
    normalize_response_format,
    response_format_type,
)
from app.agent.session import RESUME_PROMPT_MARKER, SessionStore
from app.config import Settings
from app.llm.openai_client import LLMStreamInterrupted, LLMToolCall, OpenAIChatClient
from app.search_modes import SearchMode, normalize_search_mode
from app.tools.base import ToolContext, ToolResult
from app.tools.mcp_provider import MCPManager
from app.tools.registry import ToolRegistry
from app.tools.skills import SkillManager

logger = logging.getLogger(__name__)
RESUME_PROMPT = (
    f"{RESUME_PROMPT_MARKER} Preserve completed work, "
    "recover from any interrupted tool call, and finish the user's request."
)
BOOTSTRAP_TOOL_TIMEOUT_SECONDS = 2.0
BOOTSTRAP_TOOL_NAMES = frozenset({"core_get_time"})


@dataclass
class _RunState:
    session_id: str
    run_id: str
    prompt_profile: str
    checkpoint_user_content: str
    history_messages: list[dict[str, Any]]
    current_user_message: dict[str, Any]
    system_prompt: str | None = None
    allowed_tool_names: frozenset[str] | None = None
    bootstrap_tools: list[dict[str, Any]] = field(default_factory=list)
    bootstrap_context: list[dict[str, Any]] = field(default_factory=list)
    llm: Any = None
    model: str = ""
    search_mode: SearchMode = "diy"
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
        self.context_builder = ContextBuilder(settings, sessions, skills, mcp, tools)
        self.run_controller = RunController()
        self.core = AgentCore(sessions)

    def update_model(self, model: str) -> None:
        """Switch the default LLM for future runs without interrupting active runs."""
        normalized_model = model.strip()
        if not normalized_model:
            raise ValueError("Model cannot be blank.")
        self.settings.openrouter_model = normalized_model
        configured = getattr(self.llm, "configured", None)
        if configured is None:
            self.llm.model = normalized_model
            return
        self.llm = configured(
            model=normalized_model,
            temperature=self.settings.llm_temperature,
        )

    def request_stop(self, session_id: str, *, reason: str = "user_stop") -> str | None:
        return self.run_controller.request_stop(session_id, reason=reason)

    def has_checkpoint(self, session_id: str) -> bool:
        return self.sessions.has_checkpoint(session_id)

    def has_active_run(self, session_id: str) -> bool:
        return self.run_controller.is_active(session_id)

    async def run(
        self,
        session_id: str,
        user_content: str | None = None,
        *,
        prompt_profile: str | None = None,
        resume: bool = False,
        response_format: ResponseFormatInput = None,
        system_prompt: str | None = None,
        allowed_tool_names: set[str] | frozenset[str] | None = None,
        bootstrap_tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        temperature: float | None = None,
        search_mode: str | None = None,
    ) -> AsyncIterator[AgentEvent]:
        run_id = make_run_id()
        if self.run_controller.is_active(session_id):
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

        try:
            requested_search_mode = (
                normalize_search_mode(search_mode) if search_mode is not None else None
            )
        except ValueError as exc:
            yield event(
                "run.error",
                session_id,
                run_id,
                error=str(exc),
                error_code="invalid_search_mode",
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

        effective_search_mode = requested_search_mode or self.sessions.get_search_mode(session_id)
        if requested_search_mode is not None:
            self.sessions.set_search_mode(session_id, requested_search_mode)

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
        configured_llm = self._configured_llm(model=model, temperature=temperature)
        active_model = str(
            getattr(configured_llm, "model", None) or model or self.settings.openrouter_model
        )
        state = _RunState(
            session_id=session_id,
            run_id=run_id,
            prompt_profile=profile_name,
            checkpoint_user_content=checkpoint_user_content,
            history_messages=history_messages,
            current_user_message=current_user_message,
            system_prompt=system_prompt.strip() if system_prompt else None,
            allowed_tool_names=(
                frozenset(allowed_tool_names) if allowed_tool_names is not None else None
            ),
            bootstrap_tools=list(bootstrap_tools or []),
            bootstrap_context=(
                list(checkpoint.bootstrap_context)
                if resume and checkpoint is not None
                else []
            ),
            llm=configured_llm,
            model=active_model,
            search_mode=effective_search_mode,
            final_response_format=final_response_format,
            iteration=checkpoint.iteration if resume and checkpoint is not None else 0,
        )
        if not self.run_controller.claim(session_id, state):
            yield event(
                "run.error",
                session_id,
                run_id,
                error="A run is already active for this session.",
            )
            return
        self.sessions.append(session_id, current_user_message)
        logger.info(
            "Agent run started: session_id=%s run_id=%s profile=%s resume=%s output=%s",
            session_id,
            run_id,
            profile_name,
            resume,
            response_format_type(final_response_format),
        )

        timeout_scope = asyncio.timeout(self.settings.agent_run_timeout_seconds)
        try:
            yield event(
                "run.started",
                session_id,
                run_id,
                resumed=resume,
                search_mode=state.search_mode,
                model=state.model,
            )
            async with timeout_scope:
                async for item in self._run(state, profile_name):
                    if item.type == "run.finished":
                        state.completed = True
                        if resume:
                            self.sessions.clear_checkpoint(session_id)
                    elif item.type == "run.error" and resume:
                        item.data.setdefault("can_resume", self.sessions.has_checkpoint(session_id))
                    yield item
        except TimeoutError:
            yield self._run_timeout_event(state)
        except LLMStreamInterrupted as exc:
            state.assistant_text = exc.content
            state.pending_tool_calls = exc.tool_calls
            if timeout_scope.expired():
                yield self._run_timeout_event(state)
                return
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
            self.run_controller.release(session_id, state)

    async def _run(self, state: _RunState, profile_name: str) -> AsyncIterator[AgentEvent]:
        if state.bootstrap_tools and not state.bootstrap_context:
            async for item in self._run_bootstrap_tools(state):
                yield item
            if state.completed:
                return

        debug_result = None
        if (
            state.allowed_tool_names is None
            or "sandbox_python_run" in state.allowed_tool_names
        ):
            debug_result = await self._maybe_run_debug_command(
                state.session_id,
                state.run_id,
                str(state.current_user_message["content"]),
            )
        if debug_result is not None:
            async for item in debug_result:
                yield item
            return

        context_snapshot = await self.context_builder.prepare(
            ContextRequest(
                session_id=state.session_id,
                prompt_profile=profile_name,
                system_prompt=state.system_prompt,
                search_mode=state.search_mode,
                model=state.model,
                allowed_tool_names=state.allowed_tool_names,
                bootstrap_context=state.bootstrap_context,
                history_messages=state.history_messages,
                current_user_message=state.current_user_message,
                loop_messages=[],
            )
        )

        while state.iteration < self.settings.max_tool_iterations:
            state.iteration += 1
            state.assistant_text = ""
            state.pending_tool_calls = []
            state.completed_tool_call_ids = set()
            state.active_tool_index = None
            state.tool_message_added = False
            built_context = context_snapshot.render(state.loop_messages)
            messages = built_context.messages
            all_tools = built_context.tools

            yield event(
                "llm.request",
                state.session_id,
                state.run_id,
                profile=profile_name,
                iteration=state.iteration,
                context=built_context.diagnostics,
                request=state.llm.request_payload(messages, all_tools),
            )

            tool_calls: list[LLMToolCall] = []
            async for item in state.llm.stream_chat(messages, all_tools):
                if item.type == "message.delta":
                    state.assistant_text += item.content
                    if not requires_structured_finalizer(state):
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
                if requires_structured_finalizer(state):
                    async for final_event in self._run_finalizer(state, profile_name):
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

            state.loop_messages.append(assistant_tool_message(tool_calls, state.assistant_text))
            state.tool_message_added = True
            for index, call in enumerate(tool_calls):
                state.active_tool_index = index
                tool_context = self._tool_context(
                    state.session_id,
                    run_id=state.run_id,
                    tool_call_id=call.id,
                    search_mode=state.search_mode,
                    model=state.model,
                )
                yield event(
                    "tool.started",
                    state.session_id,
                    state.run_id,
                    tool_call_id=call.id,
                    tool=call.name,
                    arguments=call.arguments,
                )
                logger.info("Tool call started: session_id=%s tool=%s", state.session_id, call.name)
                if (
                    state.allowed_tool_names is not None
                    and call.name not in state.allowed_tool_names
                ):
                    result = ToolResult(
                        name=call.name,
                        ok=False,
                        content=f"Tool is not enabled for this preset agent: {call.name}",
                    )
                else:
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

    async def _run_bootstrap_tools(self, state: _RunState) -> AsyncIterator[AgentEvent]:
        calls: list[tuple[str, str, dict[str, Any], bool]] = []
        for index, definition in enumerate(state.bootstrap_tools):
            name = str(definition.get("name") or "")
            result_key = str(definition.get("result_key") or name)
            arguments = dict(definition.get("arguments") or {})
            required = bool(definition.get("required", True))
            call_id = f"bootstrap-{state.run_id}-{index + 1}"
            calls.append((call_id, name, arguments, required))
            yield event(
                "tool.started",
                state.session_id,
                state.run_id,
                phase="bootstrap",
                tool_call_id=call_id,
                tool=name,
                result_key=result_key,
                arguments=arguments,
            )

        async def invoke(name: str, arguments: dict[str, Any]) -> ToolResult:
            if name not in BOOTSTRAP_TOOL_NAMES:
                return ToolResult(
                    name=name,
                    ok=False,
                    content=f"Tool is not approved for bootstrap context: {name}",
                )
            try:
                async with asyncio.timeout(BOOTSTRAP_TOOL_TIMEOUT_SECONDS):
                    return await self._call_tool_safely(
                        name,
                        arguments,
                        self._tool_context(
                            state.session_id,
                            search_mode=state.search_mode,
                            model=state.model,
                        ),
                    )
            except TimeoutError:
                return ToolResult(
                    name=name,
                    ok=False,
                    content=(
                        "Bootstrap tool exceeded its "
                        f"{BOOTSTRAP_TOOL_TIMEOUT_SECONDS:g}-second timeout."
                    ),
                )

        results = await asyncio.gather(
            *(invoke(name, arguments) for _, name, arguments, _ in calls)
        )
        required_failures: list[str] = []
        for definition, call, result in zip(state.bootstrap_tools, calls, results, strict=True):
            call_id, name, arguments, required = call
            result_key = str(definition.get("result_key") or name)
            yield event(
                "tool.finished" if result.ok else "tool.error",
                state.session_id,
                state.run_id,
                phase="bootstrap",
                tool_call_id=call_id,
                tool=name,
                result_key=result_key,
                ok=result.ok,
                content=result.content,
                data=result.data,
            )
            if result.ok:
                state.bootstrap_context.append(
                    {
                        "key": result_key,
                        "tool": name,
                        "arguments": arguments,
                        "result": result.content,
                    }
                )
            elif required:
                required_failures.append(f"{name} ({result_key}): {result.content}")

        if required_failures:
            state.completed = True
            yield event(
                "run.error",
                state.session_id,
                state.run_id,
                error="Required bootstrap tool failed: " + "; ".join(required_failures),
                error_code="bootstrap_failed",
            )

    async def _run_finalizer(
        self,
        state: _RunState,
        profile_name: str,
    ) -> AsyncIterator[AgentEvent]:
        async for item in self.core.run_finalizer(state, profile_name):
            yield item

    def _configured_llm(
        self,
        *,
        model: str | None,
        temperature: float | None,
    ) -> Any:
        if model is None and temperature is None:
            return self.llm
        configured = getattr(self.llm, "configured", None)
        if configured is None:
            return self.llm
        return configured(
            model=model or self.settings.openrouter_model,
            temperature=(
                self.settings.llm_temperature if temperature is None else temperature
            ),
        )

    def _run_timeout_event(self, state: _RunState) -> AgentEvent:
        state.stop_reason = "run_timeout"
        self._save_checkpoint(state)
        return event(
            "run.error",
            state.session_id,
            state.run_id,
            error=(
                "Agent run exceeded the configured timeout of "
                f"{self.settings.agent_run_timeout_seconds:g} seconds."
            ),
            error_code="run_timeout",
            can_resume=True,
        )

    def _persist_completed_response(self, state: _RunState, assistant_text: str) -> None:
        self.core.persist_completed_response(state, assistant_text)

    def _persist_loop_messages(self, state: _RunState) -> None:
        self.core.persist_loop_messages(state)

    def _save_checkpoint(self, state: _RunState) -> None:
        self.core.save_checkpoint(state)

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

    def _tool_context(
        self,
        session_id: str,
        *,
        run_id: str | None = None,
        tool_call_id: str | None = None,
        search_mode: str | None = None,
        model: str | None = None,
    ) -> ToolContext:
        return ToolContext(
            session_id=session_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
            active_skills=frozenset(self.sessions.get_active_skills(session_id)),
            active_mcp_servers=frozenset(self.sessions.get_active_mcp_servers(session_id)),
            search_mode=(
                normalize_search_mode(search_mode)
                if search_mode is not None
                else self.sessions.get_search_mode(session_id)
            ),
            model=model,
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
