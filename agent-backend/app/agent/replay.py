"""Replay model and deterministic tools for contract and module tests."""

from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from app.llm.openai_client import LLMStreamEvent, LLMToolCall
from app.tools.base import ToolContext, ToolProvider, ToolResult, ToolSpec


@dataclass(frozen=True)
class ReplayStep:
    """One deterministic streamed model response."""

    events: tuple[LLMStreamEvent, ...]

    @classmethod
    def from_events(cls, events: Iterable[LLMStreamEvent]) -> "ReplayStep":
        return cls(tuple(events))


class ReplayModel:
    """A small ModelAdapter-shaped fake that never performs network I/O."""

    def __init__(
        self,
        steps: Iterable[ReplayStep],
        *,
        completions: Iterable[str] = (),
        model: str = "replay-model",
    ) -> None:
        self.model = model
        self.steps = list(steps)
        self.completions = list(completions)
        self.stream_calls: list[dict[str, Any]] = []
        self.complete_calls: list[dict[str, Any]] = []

    def request_payload(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        response_format: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "tools": tools,
        }
        if response_format is not None:
            payload["response_format"] = response_format
        return payload

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ):
        self.stream_calls.append({"messages": messages, "tools": tools})
        if not self.steps:
            raise AssertionError("ReplayModel has no streamed step left")
        for item in self.steps.pop(0).events:
            yield item

    async def complete_chat(
        self,
        messages: list[dict[str, Any]],
        *,
        response_format: dict[str, Any] | None = None,
    ) -> str:
        self.complete_calls.append({"messages": messages, "response_format": response_format})
        if not self.completions:
            raise AssertionError("ReplayModel has no completion left")
        return self.completions.pop(0)


ToolHandler = Callable[
    [dict[str, Any], ToolContext | None],
    ToolResult | str | Awaitable[ToolResult | str],
]


@dataclass
class DeterministicToolProvider(ToolProvider):
    """ToolProvider whose definitions and results are fully supplied by a test."""

    definitions: list[ToolSpec]
    handlers: Mapping[str, ToolHandler] = field(default_factory=dict)
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        del context
        return list(self.definitions)

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext | None = None,
    ) -> ToolResult:
        self.calls.append({"name": name, "arguments": arguments, "context": context})
        handler = self.handlers.get(name)
        if handler is None:
            return ToolResult(name=name, ok=False, content=f"No deterministic result for {name}.")
        value = handler(arguments, context)
        if hasattr(value, "__await__"):
            value = await value
        if isinstance(value, ToolResult):
            return value
        return ToolResult(name=name, content=str(value))


def replay_tool_call(
    call_id: str,
    name: str,
    arguments: dict[str, Any] | None = None,
) -> LLMStreamEvent:
    return LLMStreamEvent(
        type="tool_calls",
        tool_calls=[LLMToolCall(id=call_id, name=name, arguments=arguments or {})],
    )
