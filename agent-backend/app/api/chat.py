from collections.abc import AsyncIterator
from typing import Any
from uuid import uuid4

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent.events import AgentEvent
from app.agent.response_format import ResponseFormat
from app.container import get_agent_runtime

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    input_type: str = "text"
    output_modes: list[str] = Field(default_factory=lambda: ["text"])
    response_format: ResponseFormat | None = None


class ChatResponse(BaseModel):
    session_id: str
    events: list[AgentEvent]
    final_text: str = ""
    output: Any | None = None
    output_format: str = "text"


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    session_id = request.session_id or f"session_{uuid4().hex}"
    events: list[AgentEvent] = []
    final_text = ""
    output: Any | None = None
    output_format = "text"
    async for item in get_agent_runtime().run(
        session_id,
        request.message,
        response_format=request.response_format,
    ):
        events.append(item)
        if item.type == "run.finished":
            final_text = str(item.data.get("final_text") or "")
            output = item.data.get("output")
            output_format = str(item.data.get("output_format") or "text")
    return ChatResponse(
        session_id=session_id,
        events=events,
        final_text=final_text,
        output=output,
        output_format=output_format,
    )


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    session_id = request.session_id or f"session_{uuid4().hex}"

    async def lines() -> AsyncIterator[str]:
        async for item in get_agent_runtime().run(
            session_id,
            request.message,
            response_format=request.response_format,
        ):
            yield item.model_dump_json() + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")
