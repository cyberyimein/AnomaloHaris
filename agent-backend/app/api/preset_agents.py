from collections.abc import AsyncIterator
from copy import deepcopy
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from app.agent.events import AgentEvent
from app.agent.response_format import ResponseFormat
from app.agent.runtime import BOOTSTRAP_TOOL_NAMES
from app.agents.store import PresetAgent
from app.api.security import require_management_access
from app.config import get_settings
from app.container import (
    get_agent_runtime,
    get_preset_agent_store,
    get_session_store,
    get_tool_registry,
)

management_router = APIRouter(
    prefix="/api/manage/agents",
    tags=["preset-agents"],
    dependencies=[Depends(require_management_access)],
)
invocation_router = APIRouter(prefix="/api/agents", tags=["preset-agent-invocation"])


class BootstrapToolDefinition(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    arguments: dict[str, Any] = Field(default_factory=dict)
    result_key: str = Field(min_length=1, max_length=80)
    required: bool = True

    @field_validator("name", "result_key")
    @classmethod
    def normalize_identifier(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Value cannot be blank.")
        return cleaned


class PresetAgentDefinition(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    ghost: str = Field(default="👻", max_length=32)
    system_prompt: str = Field(min_length=1, max_length=50_000)
    model: str = Field(min_length=1, max_length=200)
    temperature: float = Field(default=0.4, ge=0, le=2)
    tool_names: list[str] = Field(default_factory=list, max_length=200)
    bootstrap_tools: list[BootstrapToolDefinition] = Field(default_factory=list, max_length=20)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Agent name cannot be blank.")
        if "/" in cleaned:
            raise ValueError("Agent names cannot contain '/'.")
        return cleaned

    @field_validator("system_prompt", "model")
    @classmethod
    def validate_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Value cannot be blank.")
        return value.strip()

    @field_validator("tool_names")
    @classmethod
    def normalize_tool_names(cls, value: list[str]) -> list[str]:
        names = [name.strip() for name in value if name.strip()]
        return list(dict.fromkeys(names))

    @model_validator(mode="after")
    def validate_bootstrap_result_keys(self) -> "PresetAgentDefinition":
        result_keys = [tool.result_key for tool in self.bootstrap_tools]
        if len(result_keys) != len(set(result_keys)):
            raise ValueError("Bootstrap result_key values must be unique.")
        unsupported = sorted(
            {tool.name for tool in self.bootstrap_tools} - BOOTSTRAP_TOOL_NAMES
        )
        if unsupported:
            raise ValueError(
                "Tools are not approved for bootstrap context: " + ", ".join(unsupported)
            )
        return self


class PresetAgentInvocation(BaseModel):
    message: str | None = None
    session_id: str | None = None
    resume: bool = False
    response_format: ResponseFormat | None = None

    @model_validator(mode="after")
    def validate_run_input(self) -> "PresetAgentInvocation":
        if self.resume and not self.session_id:
            raise ValueError("session_id is required when resume is true.")
        if not self.resume and not str(self.message or "").strip():
            raise ValueError("message is required when resume is false.")
        return self


class PresetAgentResponse(BaseModel):
    agent: dict[str, object]
    session_id: str
    events: list[AgentEvent]
    final_text: str = ""
    output: Any | None = None
    output_format: str = "text"


@invocation_router.get("")
async def list_invocable_preset_agents() -> dict[str, object]:
    """Return the safe metadata needed by chat clients to choose a preset."""
    return {
        "agents": [
            {
                "id": agent.id,
                "name": agent.name,
                "description": agent.description,
                "ghost": agent.ghost,
                "model": agent.model,
                "tool_count": len(agent.tool_names),
            }
            for agent in get_preset_agent_store().list()
        ]
    }


@management_router.get("")
async def list_preset_agents() -> dict[str, object]:
    settings = get_settings()
    return {
        "agents": [agent.as_dict() for agent in get_preset_agent_store().list()],
        "defaults": {
            "model": settings.openrouter_model,
            "temperature": settings.llm_temperature,
        },
    }


@management_router.post("", status_code=status.HTTP_201_CREATED)
async def create_preset_agent(request: PresetAgentDefinition) -> dict[str, object]:
    try:
        bootstrap_tools = [tool.model_dump() for tool in request.bootstrap_tools]
        agent = get_preset_agent_store().create(
            **request.model_dump(exclude={"bootstrap_tools"}),
            bootstrap_tools=bootstrap_tools,
            tool_sources=await _resolve_tool_sources(
                [*request.tool_names, *(tool.name for tool in request.bootstrap_tools)]
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"agent": agent.as_dict()}


@management_router.put("/{agent_id}")
async def update_preset_agent(
    agent_id: str,
    request: PresetAgentDefinition,
) -> dict[str, object]:
    try:
        bootstrap_tools = [tool.model_dump() for tool in request.bootstrap_tools]
        agent = get_preset_agent_store().update(
            agent_id,
            **request.model_dump(exclude={"bootstrap_tools"}),
            bootstrap_tools=bootstrap_tools,
            tool_sources=await _resolve_tool_sources(
                [*request.tool_names, *(tool.name for tool in request.bootstrap_tools)]
            ),
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Preset agent not found.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"agent": agent.as_dict()}


@management_router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_preset_agent(agent_id: str) -> Response:
    if not get_preset_agent_store().delete(agent_id):
        raise HTTPException(status_code=404, detail="Preset agent not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@invocation_router.post("/{agent_ref}/chat", response_model=PresetAgentResponse)
async def invoke_preset_agent(
    agent_ref: str,
    request: PresetAgentInvocation,
) -> PresetAgentResponse:
    agent = _get_agent_or_404(agent_ref)
    session_id = request.session_id or f"{agent.id}:session_{uuid4().hex}"
    _bind_session_or_409(session_id, agent)
    events: list[AgentEvent] = []
    final_text = ""
    output: Any | None = None
    output_format = "text"
    async for item in _run_agent(agent, session_id, request):
        public_item = _public_invocation_event(item)
        events.append(public_item)
        if item.type == "run.finished":
            final_text = str(item.data.get("final_text") or "")
            output = item.data.get("output")
            output_format = str(item.data.get("output_format") or "text")
    return PresetAgentResponse(
        agent={"id": agent.id, "name": agent.name},
        session_id=session_id,
        events=events,
        final_text=final_text,
        output=output,
        output_format=output_format,
    )


@invocation_router.post("/{agent_ref}/chat/stream")
async def stream_preset_agent(
    agent_ref: str,
    request: PresetAgentInvocation,
) -> StreamingResponse:
    agent = _get_agent_or_404(agent_ref)
    session_id = request.session_id or f"{agent.id}:session_{uuid4().hex}"
    _bind_session_or_409(session_id, agent)

    async def lines() -> AsyncIterator[str]:
        async for item in _run_agent(agent, session_id, request):
            yield _public_invocation_event(item).model_dump_json() + "\n"

    return StreamingResponse(
        lines(),
        media_type="application/x-ndjson",
        headers={"X-Anomalo-Session-Id": session_id, "X-Anomalo-Agent-Id": agent.id},
    )


def _get_agent_or_404(agent_ref: str) -> PresetAgent:
    agent = get_preset_agent_store().get(agent_ref)
    if agent is None:
        raise HTTPException(status_code=404, detail="Preset agent not found.")
    return agent


def _bind_session_or_409(session_id: str, agent: PresetAgent) -> None:
    if not get_preset_agent_store().bind_session(session_id, agent.id):
        raise HTTPException(
            status_code=409,
            detail="This session_id is already bound to a different preset agent.",
        )


async def _run_agent(
    agent: PresetAgent,
    session_id: str,
    request: PresetAgentInvocation,
) -> AsyncIterator[AgentEvent]:
    skill_names = {
        source.removeprefix("skill:")
        for source in agent.tool_sources.values()
        if source.startswith("skill:")
    }
    mcp_server_names = {
        source.removeprefix("mcp:")
        for source in agent.tool_sources.values()
        if source.startswith("mcp:")
    }
    sessions = get_session_store()
    sessions.set_active_skills(session_id, skill_names)
    sessions.set_active_mcp_servers(session_id, mcp_server_names)
    async for item in get_agent_runtime().run(
        session_id,
        request.message,
        resume=request.resume,
        response_format=request.response_format,
        system_prompt=agent.system_prompt,
        allowed_tool_names=set(agent.tool_names),
        bootstrap_tools=agent.bootstrap_tools,
        model=agent.model,
        temperature=agent.temperature,
    ):
        yield item


async def _resolve_tool_sources(tool_names: list[str]) -> dict[str, str]:
    if not tool_names:
        return {}
    specs = await get_tool_registry().list_tools(context=None)
    sources = {tool.name: tool.source for tool in specs}
    unknown = sorted(set(tool_names) - sources.keys())
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown or unavailable tools: {', '.join(unknown)}",
        )
    return {name: sources[name] for name in tool_names}


def _public_invocation_event(item: AgentEvent) -> AgentEvent:
    """Remove private prompt and tool-schema data from public invocation events."""
    if item.type != "llm.request":
        return item

    data = deepcopy(item.data)
    request = data.get("request")
    if isinstance(request, dict):
        safe_request: dict[str, Any] = {}
        for key in ("model", "temperature", "tool_choice", "response_format"):
            if key in request:
                safe_request[key] = deepcopy(request[key])
        tools = request.get("tools")
        if isinstance(tools, list):
            safe_request["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": str(tool.get("function", {}).get("name") or "unknown")
                    },
                }
                for tool in tools
                if isinstance(tool, dict)
            ]
        safe_request["messages"] = []
        data["request"] = safe_request

    context = data.get("context")
    if isinstance(context, dict):
        context.pop("active_skills", None)
        context.pop("active_mcp_servers", None)
    return item.model_copy(update={"data": data})
