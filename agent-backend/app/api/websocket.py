import asyncio
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.agents.browser_operator import (
    BROWSER_OPERATOR_ID,
    BROWSER_OPERATOR_PROFILE,
    BROWSER_TOOL_NAMES,
    BrowserRegistration,
)
from app.agents.store import PresetAgent
from app.container import (
    get_agent_runtime,
    get_browser_tool_broker,
    get_preset_agent_store,
    get_session_store,
)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/chat/{session_id}")
async def websocket_chat(websocket: WebSocket, session_id: str) -> None:
    bound_agent_id = get_preset_agent_store().get_bound_agent_id(session_id)
    if bound_agent_id is not None and bound_agent_id != BROWSER_OPERATOR_ID:
        await websocket.close(code=1008, reason="Preset agent sessions require the preset API.")
        return
    await websocket.accept()
    runtime = get_agent_runtime()
    broker = get_browser_tool_broker()
    active_task: asyncio.Task[None] | None = None
    active_run_id: str | None = None
    stopped_event_sent = False
    send_lock = asyncio.Lock()
    initialized = False
    browser_client_registered = False
    browser_registration: BrowserRegistration | None = None
    preset_agent: PresetAgent | None = None

    async def send_json(payload: dict[str, object]) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    async def send_client_error(message: str, *, error_code: str | None = None) -> None:
        payload: dict[str, object] = {"type": "client.error", "error": message}
        if error_code:
            payload["data"] = {"error_code": error_code}
        await send_json(payload)

    await send_json(
        {
            "type": "session.state",
            "session_id": session_id,
            "data": {
                "can_resume": runtime.has_checkpoint(session_id),
                "search_mode": get_session_store().get_search_mode(session_id),
                "preset_agent_id": get_preset_agent_store().get_bound_agent_id(session_id),
            },
        }
    )

    async def configure_client(payload: dict[str, Any]) -> bool:
        nonlocal initialized, browser_client_registered, browser_registration, preset_agent
        if initialized:
            await send_client_error("The client handshake has already completed.")
            return False
        if payload.get("session_id") not in {None, session_id}:
            await send_client_error("The client hello session_id does not match this connection.")
            return False
        data = payload.get("data")
        if not isinstance(data, dict):
            await send_client_error(
                "client.hello requires a data object.",
                error_code="invalid_hello",
            )
            return False
        profile = data.get("agent_profile")
        if profile != BROWSER_OPERATOR_PROFILE:
            await send_client_error(
                f"Unsupported agent profile: {profile or 'missing'}.",
                error_code="unsupported_agent_profile",
            )
            return False
        capabilities = data.get("capabilities")
        if not isinstance(capabilities, dict) or capabilities.get("browser_bridge") is not True:
            await send_client_error(
                "browser_operator requires a connected browser bridge.",
                error_code="browser_bridge_required",
            )
            return False
        advertised_tools = capabilities.get("browser_tools")
        if not isinstance(advertised_tools, list) or not set(BROWSER_TOOL_NAMES).issubset(
            {str(name) for name in advertised_tools}
        ):
            await send_client_error(
                "The browser bridge does not advertise the required browser tools.",
                error_code="browser_capabilities_incomplete",
            )
            return False

        candidate = get_preset_agent_store().get(BROWSER_OPERATOR_ID)
        if candidate is None:
            await send_client_error(
                "The browser_operator preset is not available on this server.",
                error_code="preset_unavailable",
            )
            return False
        if not get_preset_agent_store().bind_session(session_id, candidate.id):
            await send_client_error(
                "This session is already bound to a different preset agent.",
                error_code="preset_session_conflict",
            )
            return False

        preset_agent = candidate
        initialized = True
        browser_registration = broker.register(session_id, send_json)
        browser_client_registered = True
        await send_json(
            {
                "type": "client.ready",
                "session_id": session_id,
                "data": {
                    "agent_profile": BROWSER_OPERATOR_PROFILE,
                    "preset_agent": {
                        "id": candidate.id,
                        "name": candidate.name,
                    },
                    "browser_tools": list(BROWSER_TOOL_NAMES),
                    "requires_browser_bridge": True,
                },
            }
        )
        return True

    async def stream_run(
        content: str | None = None,
        *,
        resume: bool = False,
        search_mode: str | None = None,
    ) -> None:
        nonlocal active_run_id, stopped_event_sent
        active_run_id = None
        stopped_event_sent = False
        try:
            run_options: dict[str, Any] = {
                "resume": resume,
                "search_mode": search_mode,
            }
            if preset_agent is not None:
                sessions = get_session_store()
                skill_names = {
                    source.removeprefix("skill:")
                    for source in preset_agent.tool_sources.values()
                    if source.startswith("skill:")
                }
                mcp_server_names = {
                    source.removeprefix("mcp:")
                    for source in preset_agent.tool_sources.values()
                    if source.startswith("mcp:")
                }
                sessions.set_active_skills(session_id, skill_names)
                sessions.set_active_mcp_servers(session_id, mcp_server_names)
                run_options.update(
                    {
                        "system_prompt": preset_agent.system_prompt,
                        "allowed_tool_names": set(preset_agent.tool_names),
                        "bootstrap_tools": preset_agent.bootstrap_tools,
                        "model": preset_agent.model,
                        "temperature": preset_agent.temperature,
                        "search_mode": (
                            preset_agent.search_mode
                            if "web_search" in preset_agent.tool_names
                            else None
                        ),
                    }
                )
            else:
                run_options["search_mode"] = search_mode

            async for item in runtime.run(session_id, content, **run_options):
                active_run_id = item.run_id
                if item.type == "run.stopped":
                    stopped_event_sent = True
                await send_json(item.model_dump())
        except asyncio.CancelledError:
            raise

    async def cancel_active_run() -> None:
        nonlocal active_task
        if active_task is None or active_task.done():
            active_task = None
            return
        runtime.request_stop(session_id)
        await broker.cancel_session(
            session_id,
            run_id=active_run_id,
            reason="user_stop",
        )
        active_task.cancel()
        with suppress(asyncio.CancelledError):
            await active_task
        active_task = None

    async def start_run(
        *,
        content: str | None = None,
        resume: bool = False,
        search_mode: str | None = None,
    ) -> None:
        nonlocal active_task
        if active_task is not None and not active_task.done():
            await send_client_error("A run is already active for this session.")
            return
        active_task = asyncio.create_task(
            stream_run(content, resume=resume, search_mode=search_mode)
        )

    async def handle_browser_result(payload: dict[str, Any]) -> None:
        if preset_agent is None or not browser_client_registered:
            await send_client_error(
                "browser.tool.result is only valid after the browser_operator handshake.",
                error_code="browser_client_not_ready",
            )
            return
        if payload.get("session_id") not in {None, session_id}:
            await send_client_error("The browser result session_id does not match this connection.")
            return
        run_id = payload.get("run_id")
        data = payload.get("data")
        if not isinstance(run_id, str) or not run_id:
            await send_client_error(
                "browser.tool.result requires run_id.",
                error_code="invalid_result",
            )
            return
        if not isinstance(data, dict):
            await send_client_error(
                "browser.tool.result requires a data object.",
                error_code="invalid_result",
            )
            return
        tool_call_id = data.get("tool_call_id")
        status = data.get("status")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            await send_client_error(
                "browser.tool.result requires tool_call_id.",
                error_code="invalid_result",
            )
            return
        if status not in {"ok", "error"}:
            await send_client_error(
                "browser.tool.result has an invalid status.",
                error_code="invalid_result",
            )
            return
        result = data.get("result")
        error = data.get("error")
        if result is not None and not isinstance(result, dict):
            await send_client_error(
                "browser.tool.result.result must be an object.",
                error_code="invalid_result",
            )
            return
        if error is not None and not isinstance(error, dict):
            await send_client_error(
                "browser.tool.result.error must be an object.",
                error_code="invalid_result",
            )
            return
        if not broker.complete(
            session_id=session_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
            status=status,
            result=result,
            error=error,
        ):
            if (
                status == "error"
                and isinstance(error, dict)
                and error.get("code") in {"CANCELLED", "DEADLINE_EXCEEDED"}
            ):
                return
            await send_client_error(
                "No matching browser tool call is pending.",
                error_code="unknown_tool_call",
            )

    try:
        while True:
            payload = await websocket.receive_json()
            if not isinstance(payload, dict):
                await send_client_error("WebSocket messages must be JSON objects.")
                continue
            message_type = payload.get("type", "user.message")

            if not initialized:
                if message_type == "client.hello":
                    await configure_client(payload)
                    continue
                if get_preset_agent_store().get_bound_agent_id(session_id) is not None:
                    await send_client_error(
                        "This session belongs to a preset agent and requires client.hello.",
                        error_code="preset_handshake_required",
                    )
                    continue
                initialized = True

            if message_type == "client.hello":
                await send_client_error("The client handshake has already completed.")
                continue
            if message_type == "ping":
                await send_json({"type": "pong"})
                continue
            if message_type == "browser.tool.result":
                await handle_browser_result(payload)
                continue
            if message_type == "run.stop":
                if active_task is None or active_task.done():
                    await send_client_error("No active run to stop.")
                    active_task = None
                    continue
                await cancel_active_run()
                if not stopped_event_sent:
                    checkpointed = runtime.has_checkpoint(session_id)
                    await send_json(
                        {
                            "type": "run.stopped",
                            "session_id": session_id,
                            "run_id": active_run_id or "unknown",
                            "data": {
                                "reason": "user_stop",
                                "checkpointed": checkpointed,
                                "can_resume": checkpointed,
                            },
                        }
                    )
                continue
            if message_type == "run.resume":
                await start_run(
                    resume=True,
                    search_mode=(
                        str(payload["search_mode"])
                        if payload.get("search_mode") is not None
                        else None
                    ),
                )
                continue
            if message_type != "user.message":
                await send_client_error(f"Unsupported message type: {message_type}")
                continue

            content = str(payload.get("content") or "")
            if not content.strip():
                await send_client_error("Message content is required.")
                continue
            await start_run(
                content=content,
                search_mode=(
                    str(payload["search_mode"])
                    if payload.get("search_mode") is not None
                    else None
                ),
            )
    except WebSocketDisconnect:
        pass
    finally:
        if active_task is not None and not active_task.done():
            runtime.request_stop(session_id, reason="disconnect")
            await broker.cancel_session(
                session_id,
                run_id=active_run_id,
                reason="disconnect",
            )
            active_task.cancel()
            with suppress(asyncio.CancelledError):
                await active_task
        if browser_client_registered:
            await broker.unregister(session_id, registration=browser_registration)
