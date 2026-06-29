import inspect
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field


TOOL_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


@dataclass(frozen=True)
class ToolContext:
    session_id: str | None = None
    active_skills: frozenset[str] = field(default_factory=frozenset)
    active_mcp_servers: frozenset[str] = field(default_factory=frozenset)


class ToolSpec(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any] = Field(
        default_factory=lambda: {"type": "object", "properties": {}}
    )
    source: str

    def as_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolResult(BaseModel):
    name: str
    content: str
    ok: bool = True
    data: dict[str, Any] = Field(default_factory=dict)


class ToolProvider(ABC):
    @abstractmethod
    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        raise NotImplementedError

    @abstractmethod
    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext | None = None,
    ) -> ToolResult:
        raise NotImplementedError

    async def status(self, context: ToolContext | None = None) -> dict[str, Any]:
        tools = await self.list_tools(context=context)
        return {"tools": [tool.model_dump() for tool in tools]}


def ensure_tool_name(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", name).strip("_")
    cleaned = cleaned[:64] or "tool"
    if not TOOL_NAME_PATTERN.match(cleaned):
        msg = f"Invalid tool name after normalization: {name!r}"
        raise ValueError(msg)
    return cleaned


async def call_maybe_async(func: Any, **kwargs: Any) -> Any:
    value = func(**kwargs)
    if inspect.isawaitable(value):
        return await value
    return value

