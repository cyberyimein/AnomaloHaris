from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from app.api.security import require_management_access
from app.container import get_mcp_manager, get_skill_manager

router = APIRouter(
    prefix="/api",
    tags=["management"],
    dependencies=[Depends(require_management_access)],
)


class SkillCreateRequest(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True


class EnabledRequest(BaseModel):
    enabled: bool


class MCPServerRequest(BaseModel):
    name: str
    description: str = ""
    transport: Literal["stdio", "streamable_http"] = "stdio"
    protocol: Literal["auto", "modern", "legacy"] = "auto"
    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str = ""
    enabled: bool = True

    @model_validator(mode="after")
    def validate_transport_target(self) -> "MCPServerRequest":
        if self.transport == "stdio" and not self.command.strip():
            raise ValueError("command is required for stdio MCP servers")
        if self.transport == "streamable_http" and not self.url.strip():
            raise ValueError("url is required for streamable_http MCP servers")
        return self


@router.get("/skills")
async def list_skills() -> dict[str, Any]:
    return {"skills": get_skill_manager().list_skills()}


@router.post("/skills")
async def create_skill(request: SkillCreateRequest) -> dict[str, Any]:
    try:
        skill = get_skill_manager().create_skill(
            request.name,
            description=request.description,
            enabled=request.enabled,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"skill": skill}


@router.patch("/skills/{name}")
async def set_skill_enabled(name: str, request: EnabledRequest) -> dict[str, Any]:
    try:
        skill = get_skill_manager().set_enabled(name, request.enabled)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"skill": skill}


@router.get("/mcp")
async def list_mcp_servers() -> dict[str, Any]:
    return {"mcp_servers": get_mcp_manager().list_servers()}


@router.post("/mcp")
async def upsert_mcp_server(request: MCPServerRequest) -> dict[str, Any]:
    server = get_mcp_manager().upsert_server(
        request.name,
        command=request.command,
        args=request.args,
        env=request.env,
        transport=request.transport,
        url=request.url,
        protocol=request.protocol,
        description=request.description,
        enabled=request.enabled,
    )
    return {"server": server}


@router.patch("/mcp/{name}")
async def set_mcp_enabled(name: str, request: EnabledRequest) -> dict[str, Any]:
    try:
        server = get_mcp_manager().set_enabled(name, request.enabled)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"server": server}


@router.delete("/mcp/{name}")
async def delete_mcp_server(name: str) -> dict[str, str]:
    get_mcp_manager().delete_server(name)
    return {"status": "deleted"}
