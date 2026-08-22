"""Loopback Python Worker interface used by the Node Host during migration."""

from __future__ import annotations

import base64
import binascii
import os
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.container import (
    get_buddy_gateway,
    get_buddy_vision_service,
    get_stt_provider,
    get_tool_registry,
    get_tts_provider,
)
from app.tools.base import ToolContext


class WorkerContext(BaseModel):
    session_id: str | None = None
    run_id: str | None = None
    tool_call_id: str | None = None
    search_mode: str = "diy"
    model: str | None = None
    active_skills: list[str] = Field(default_factory=list)
    active_mcp_servers: list[str] = Field(default_factory=list)

    def as_tool_context(self) -> ToolContext:
        return ToolContext(
            session_id=self.session_id,
            run_id=self.run_id,
            tool_call_id=self.tool_call_id,
            search_mode=self.search_mode,
            model=self.model,
            active_skills=frozenset(self.active_skills),
            active_mcp_servers=frozenset(self.active_mcp_servers),
        )


class WorkerToolListRequest(BaseModel):
    context: WorkerContext = Field(default_factory=WorkerContext)


class WorkerToolCallRequest(BaseModel):
    request_id: str = ""
    session_id: str | None = None
    run_id: str | None = None
    tool_call_id: str | None = None
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    context: WorkerContext = Field(default_factory=WorkerContext)


class AudioTranscriptionRequest(BaseModel):
    audio_base64: str
    filename: str | None = None
    content_type: str | None = None
    language: str | None = None
    prompt: str | None = None
    vad_filter: bool | None = None


class AudioSynthesisRequest(BaseModel):
    text: str
    language: str | None = None
    voice: str | None = None


class VisionRequest(BaseModel):
    image_base64: str
    apply_buddy_action: bool = False
    min_confidence: float | None = None


async def require_worker_access(request: Request) -> None:
    configured_token = os.environ.get("ANOMALO_PYTHON_WORKER_TOKEN", "").strip()
    provided_token = request.headers.get("x-anomalo-worker-token", "")
    if configured_token and provided_token == configured_token:
        return
    client_host = request.client.host if request.client else ""
    if not configured_token and client_host in {"127.0.0.1", "::1", "localhost"}:
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Python Worker authentication failed.",
    )


app = FastAPI(title="Anomalo Python Worker")


@app.get("/internal/health")
async def health(_: None = Depends(require_worker_access)) -> dict[str, Any]:
    return {"status": "ok", "runtime": "python-worker", "capabilities": _capabilities()}


@app.get("/internal/capabilities")
async def capabilities(_: None = Depends(require_worker_access)) -> dict[str, Any]:
    return {"runtime": "python-worker", "capabilities": _capabilities()}


@app.post("/internal/tools/list")
async def list_tools(
    request: WorkerToolListRequest,
    _: None = Depends(require_worker_access),
) -> dict[str, Any]:
    tools = await get_tool_registry().list_tools(context=request.context.as_tool_context())
    return {"tools": [tool.model_dump() for tool in tools]}


@app.post("/internal/tools/call")
async def call_tool(
    request: WorkerToolCallRequest,
    _: None = Depends(require_worker_access),
) -> dict[str, Any]:
    context = request.context.model_copy(update={
        "session_id": request.session_id or request.context.session_id,
        "run_id": request.run_id or request.context.run_id,
        "tool_call_id": request.tool_call_id or request.context.tool_call_id,
    })
    try:
        result = await get_tool_registry().call_tool(
            request.tool,
            request.arguments,
            context=context.as_tool_context(),
        )
    except Exception as exc:  # Worker failures are normalized at the process boundary.
        return {
            "result": {
                "name": request.tool,
                "ok": False,
                "content": str(exc),
                "data": {"error_code": "worker_unavailable"},
            }
        }
    return {"request_id": request.request_id, "result": result.model_dump()}


@app.post("/internal/tools/status")
async def tool_status(
    request: WorkerToolListRequest,
    _: None = Depends(require_worker_access),
) -> dict[str, Any]:
    return {"statuses": await get_tool_registry().status(context=request.context.as_tool_context())}


@app.post("/internal/audio/transcribe")
async def transcribe(
    request: AudioTranscriptionRequest,
    _: None = Depends(require_worker_access),
) -> dict[str, Any]:
    audio = decode_base64(request.audio_base64, "audio_base64")
    result = await get_stt_provider().transcribe(
        audio_bytes=audio,
        filename=request.filename,
        content_type=request.content_type,
        language=request.language,
        prompt=request.prompt,
        vad_filter=request.vad_filter,
    )
    return {
        "text": result.text,
        "language": result.language,
        "provider": result.provider,
        "duration_seconds": result.duration_seconds,
        "metadata": result.metadata,
    }


@app.post("/internal/audio/synthesize")
async def synthesize(
    request: AudioSynthesisRequest,
    _: None = Depends(require_worker_access),
) -> dict[str, Any]:
    result = await get_tts_provider().synthesize(
        text=request.text,
        language=request.language,
        voice=request.voice,
    )
    return {
        "audio_base64": base64.b64encode(result.audio_bytes).decode("ascii"),
        "format": result.format,
        "mime_type": result.mime_type,
        "provider": result.provider,
        "language": result.language,
        "voice": result.voice,
        "sample_rate_hz": result.sample_rate_hz,
        "metadata": result.metadata,
    }


@app.post("/internal/vision/analyze")
async def analyze_vision(
    request: VisionRequest,
    _: None = Depends(require_worker_access),
) -> dict[str, Any]:
    image = decode_base64(request.image_base64, "image_base64")
    return get_buddy_vision_service().detect_image(
        image,
        apply_buddy_action=request.apply_buddy_action,
        min_confidence=request.min_confidence,
    )


@app.post("/internal/buddy/action")
async def buddy_action(
    request: dict[str, Any],
    _: None = Depends(require_worker_access),
) -> dict[str, Any]:
    gateway = get_buddy_gateway()
    action = str(request.get("action") or "").strip()
    if action == "state":
        return gateway.set_state(str(request.get("state") or ""), request.get("text"))
    if action == "text":
        return gateway.set_text(str(request.get("text") or ""))
    if action == "led":
        return gateway.set_led(
            int(request.get("r") or 0),
            int(request.get("g") or 0),
            int(request.get("b") or 0),
            request.get("ms"),
        )
    if action == "look":
        return gateway.look(
            int(request.get("yaw") or 0),
            int(request.get("pitch") or 0),
            request.get("speed"),
        )
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unknown Buddy action: {action}",
    )


def _capabilities() -> dict[str, bool]:
    return {"tools": True, "audio": True, "vision": True, "buddy": True}


def decode_base64(value: str, field: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field}.",
        ) from exc
