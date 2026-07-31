import asyncio
from contextlib import suppress

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.container import get_agent_runtime

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/chat/{session_id}")
async def websocket_chat(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    runtime = get_agent_runtime()
    active_task: asyncio.Task[None] | None = None
    active_run_id: str | None = None
    stopped_event_sent = False
    send_lock = asyncio.Lock()

    async def send_json(payload: dict[str, object]) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    if runtime.has_checkpoint(session_id):
        await send_json(
            {
                "type": "session.state",
                "session_id": session_id,
                "data": {"can_resume": True},
            }
        )

    async def stream_run(content: str | None = None, *, resume: bool = False) -> None:
        nonlocal active_run_id, stopped_event_sent
        active_run_id = None
        stopped_event_sent = False
        try:
            async for item in runtime.run(session_id, content, resume=resume):
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
        active_task.cancel()
        with suppress(asyncio.CancelledError):
            await active_task
        active_task = None

    try:
        while True:
            payload = await websocket.receive_json()
            message_type = payload.get("type", "user.message")
            if message_type == "ping":
                await send_json({"type": "pong"})
                continue
            if message_type == "run.stop":
                if active_task is None or active_task.done():
                    await send_json(
                        {
                            "type": "client.error",
                            "error": "No active run to stop.",
                        }
                    )
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
                if active_task is not None and not active_task.done():
                    await send_json(
                        {
                            "type": "client.error",
                            "error": "A run is already active for this session.",
                        }
                    )
                    continue
                active_task = asyncio.create_task(stream_run(resume=True))
                continue
            if message_type != "user.message":
                await send_json(
                    {
                        "type": "client.error",
                        "error": f"Unsupported message type: {message_type}",
                    }
                )
                continue

            content = str(payload.get("content") or "")
            if not content.strip():
                await send_json(
                    {"type": "client.error", "error": "Message content is required."}
                )
                continue

            if active_task is not None and not active_task.done():
                await send_json(
                    {
                        "type": "client.error",
                        "error": "A run is already active for this session.",
                    }
                )
                continue

            active_task = asyncio.create_task(stream_run(content))
    except WebSocketDisconnect:
        pass
    finally:
        if active_task is not None and not active_task.done():
            runtime.request_stop(session_id, reason="disconnect")
            active_task.cancel()
            with suppress(asyncio.CancelledError):
                await active_task
