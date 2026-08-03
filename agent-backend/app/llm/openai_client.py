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
    def __init__(
        self,
        settings: Settings,
        *,
        model: str | None = None,
        temperature: float | None = None,
    ) -> None:
        self.settings = settings
        self.model = model or settings.openrouter_model
        self.temperature = settings.llm_temperature if temperature is None else temperature
        self.client = AsyncOpenAI(
            api_key=settings.openrouter_api_key or "missing",
            base_url=settings.openai_base_url,
            default_headers={
                "HTTP-Referer": settings.site_url,
                "X-Title": settings.app_title,
            },
        )

    def configured(self, *, model: str, temperature: float) -> "OpenAIChatClient":
        return OpenAIChatClient(self.settings, model=model, temperature=temperature)

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

    async def complete_chat(
        self,
        messages: list[dict[str, Any]],
        *,
        response_format: dict[str, Any] | None = None,
    ) -> str:
        """Run a non-streaming completion for the final answer stage."""
        if not self.settings.openrouter_api_key:
            return self._mock_completion(messages, response_format)

        response = await self.client.chat.completions.create(
            **self.request_payload(messages, [], response_format=response_format),
            stream=False,
        )
        if not response.choices:
            raise RuntimeError("The model returned no completion choices")
        message = response.choices[0].message
        refusal = getattr(message, "refusal", None)
        if refusal:
            raise RuntimeError(f"The model refused the final response: {refusal}")
        content = message.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict)
            )
        return str(content or "")

    def request_payload(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        response_format: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": deepcopy(messages),
            "tools": deepcopy(tools) if tools else None,
            "tool_choice": "auto" if tools else None,
            "temperature": self.temperature,
        }
        if response_format is not None:
            payload["response_format"] = deepcopy(response_format)
            if "openrouter.ai" in str(self.settings.openai_base_url):
                # `provider` is an OpenRouter request-body extension, not a
                # parameter accepted by the OpenAI Python SDK method.
                payload["extra_body"] = {"provider": {"require_parameters": True}}
        return payload

    async def _mock_stream(self, messages: list[dict[str, Any]]) -> AsyncIterator[LLMStreamEvent]:
        text = self._mock_text(messages)
        for word in text.split(" "):
            yield LLMStreamEvent(type="message.delta", content=word + " ")
        yield LLMStreamEvent(type="message.done")

    def _mock_completion(
        self,
        messages: list[dict[str, Any]],
        response_format: dict[str, Any] | None,
    ) -> str:
        text = self._mock_text(messages)
        output_type = str((response_format or {}).get("type") or "text")
        if output_type == "json_schema":
            definition = (response_format or {}).get("json_schema") or {}
            schema = definition.get("schema") if isinstance(definition, dict) else {}
            return json.dumps(_mock_value_for_schema(schema, text), ensure_ascii=False)
        if output_type == "json_object":
            return json.dumps({"result": text}, ensure_ascii=False)
        return text

    def _mock_text(self, messages: list[dict[str, Any]]) -> str:
        user_text = ""
        for message in reversed(messages):
            if message.get("role") == "user":
                user_text = str(message.get("content") or "")
                break
        return (
            "Anomalo dev mode is running. Add OPENROUTER_API_KEY to .env to enable "
            f"OpenRouter. Last user message: {user_text}"
        )


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


def _mock_value_for_schema(schema: Any, fallback: str) -> Any:
    if not isinstance(schema, dict):
        return fallback
    if "const" in schema:
        return schema["const"]
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]

    schema_type = schema.get("type")
    if schema_type == "object" or "properties" in schema:
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            return {}
        required = schema.get("required")
        names = required if isinstance(required, list) else list(properties)
        return {
            str(name): _mock_value_for_schema(properties.get(name), fallback)
            for name in names
            if name in properties
        }
    if schema_type == "array":
        return []
    if schema_type == "string":
        return fallback
    if schema_type == "integer":
        return 0
    if schema_type == "number":
        return 0
    if schema_type == "boolean":
        return False
    if schema_type == "null":
        return None
    return fallback
