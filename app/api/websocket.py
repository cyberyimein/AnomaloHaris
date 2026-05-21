from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.container import get_agent_runtime

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/chat/{session_id}")
async def websocket_chat(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    runtime = get_agent_runtime()
    try:
        while True:
            payload = await websocket.receive_json()
            message_type = payload.get("type", "user.message")
            if message_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if message_type != "user.message":
                await websocket.send_json(
                    {
                        "type": "client.error",
                        "error": f"Unsupported message type: {message_type}",
                    }
                )
                continue

            content = str(payload.get("content") or "")
            if not content.strip():
                await websocket.send_json(
                    {"type": "client.error", "error": "Message content is required."}
                )
                continue

            actual_session_id = session_id or f"session_{uuid4().hex}"
            async for item in runtime.run(actual_session_id, content):
                await websocket.send_json(item.model_dump())
    except WebSocketDisconnect:
        return

