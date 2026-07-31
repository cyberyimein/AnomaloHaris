import asyncio
import json
from collections.abc import AsyncIterator
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from openai import AsyncOpenAI

from app.config import Settings


@dataclass
class LLMToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class LLMStreamEvent:
    type: str
    content: str = ""
    tool_calls: list[LLMToolCall] = field(default_factory=list)


class LLMStreamInterrupted(Exception):
    def __init__(self, content: str, tool_calls: list[LLMToolCall]) -> None:
        super().__init__("LLM stream interrupted")
        self.content = content
        self.tool_calls = tool_calls


class OpenAIChatClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = AsyncOpenAI(
            api_key=settings.openrouter_api_key or "missing",
            base_url=settings.openai_base_url,
            default_headers={
                "HTTP-Referer": settings.site_url,
                "X-Title": settings.app_title,
            },
        )

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> AsyncIterator[LLMStreamEvent]:
        if not self.settings.openrouter_api_key:
            async for item in self._mock_stream(messages):
                yield item
            return

        stream = await self.client.chat.completions.create(
            **self.request_payload(messages, tools),
            stream=True,
        )

        pending_tool_calls: dict[int, dict[str, str]] = {}
        assistant_content = ""
        try:
            async for chunk in stream:
                choice = chunk.choices[0]
                delta = choice.delta

                if delta.content:
                    assistant_content += delta.content
                    yield LLMStreamEvent(type="message.delta", content=delta.content)

                if delta.tool_calls:
                    for tool_delta in delta.tool_calls:
                        index = tool_delta.index
                        pending = pending_tool_calls.setdefault(
                            index,
                            {"id": "", "name": "", "arguments": ""},
                        )
                        if tool_delta.id:
                            pending["id"] += tool_delta.id
                        if tool_delta.function and tool_delta.function.name:
                            pending["name"] += tool_delta.function.name
                        if tool_delta.function and tool_delta.function.arguments:
                            pending["arguments"] += tool_delta.function.arguments

                if choice.finish_reason == "tool_calls":
                    yield LLMStreamEvent(
                        type="tool_calls",
                        tool_calls=_tool_calls_from_pending(pending_tool_calls),
                    )
                    return

                if choice.finish_reason in {"stop", "length", "content_filter"}:
                    yield LLMStreamEvent(type="message.done")
                    return
        except asyncio.CancelledError as exc:
            raise LLMStreamInterrupted(
                content=assistant_content,
                tool_calls=_tool_calls_from_pending(pending_tool_calls),
            ) from exc

    def request_payload(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return {
            "model": self.settings.openrouter_model,
            "messages": deepcopy(messages),
            "tools": deepcopy(tools) if tools else None,
            "tool_choice": "auto" if tools else None,
            "temperature": self.settings.llm_temperature,
        }

    async def _mock_stream(self, messages: list[dict[str, Any]]) -> AsyncIterator[LLMStreamEvent]:
        user_text = ""
        for message in reversed(messages):
            if message.get("role") == "user":
                user_text = str(message.get("content") or "")
                break

        text = (
            "Anomalo dev mode is running. Add OPENROUTER_API_KEY to .env to enable "
            f"OpenRouter. Last user message: {user_text}"
        )
        for word in text.split(" "):
            yield LLMStreamEvent(type="message.delta", content=word + " ")
        yield LLMStreamEvent(type="message.done")


def _parse_tool_arguments(raw: str) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}
    if isinstance(value, dict):
        return value
    return {"value": value}


def _tool_calls_from_pending(pending_tool_calls: dict[int, dict[str, str]]) -> list[LLMToolCall]:
    return [
        LLMToolCall(
            id=value["id"] or f"call_{index}",
            name=value["name"],
            arguments=_parse_tool_arguments(value["arguments"]),
        )
        for index, value in sorted(pending_tool_calls.items())
    ]
