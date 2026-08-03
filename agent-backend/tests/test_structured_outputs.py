import json

import pytest
from app.agent.response_format import validate_final_output
from app.agent.runtime import AgentRuntime
from app.agent.session import SessionStore
from app.api.chat import ChatRequest
from app.config import Settings
from app.llm.openai_client import LLMStreamEvent, LLMToolCall, OpenAIChatClient
from app.tools.base import ToolResult
from pydantic import ValidationError

RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "news_summary",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
            "additionalProperties": False,
        },
    },
}


class FakeSkills:
    def skill_catalog_message(self):
        return None

    def build_active_skill_messages(self, names):
        del names
        return []


class FakeMcp:
    def catalog_message(self):
        return None

    def build_active_server_messages(self, names):
        del names
        return []


class ToolProvider:
    async def openai_tools(self, context):
        del context
        return [
            {
                "type": "function",
                "function": {
                    "name": "lookup_news",
                    "description": "Look up a news item",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]

    async def call_tool(self, name, arguments, *, context):
        del arguments, context
        return ToolResult(name=name, content="FOMC held rates steady.")


class StructuredLlm:
    def __init__(self, outputs: list[str]) -> None:
        self.outputs = list(outputs)
        self.stream_tools: list[list[dict[str, object]]] = []
        self.finalizer_calls: list[tuple[list[dict[str, object]], dict[str, object]]] = []
        self.request_payloads: list[dict[str, object]] = []

    def request_payload(self, messages, tools, *, response_format=None):
        payload = {"messages": messages, "tools": tools}
        if response_format is not None:
            payload["response_format"] = response_format
        self.request_payloads.append(payload)
        return payload.copy()

    async def stream_chat(self, messages, tools):
        del messages
        self.stream_tools.append(tools)
        if len(self.stream_tools) == 1:
            yield LLMStreamEvent(
                type="tool_calls",
                tool_calls=[
                    LLMToolCall(
                        id="call-news",
                        name="lookup_news",
                        arguments={},
                    )
                ],
            )
            return
        yield LLMStreamEvent(type="message.delta", content="unstructured draft")
        yield LLMStreamEvent(type="message.done")

    async def complete_chat(self, messages, *, response_format):
        self.finalizer_calls.append((messages, response_format))
        return self.outputs.pop(0)


class FailingFinalizerLlm(StructuredLlm):
    async def complete_chat(self, messages, *, response_format):
        self.finalizer_calls.append((messages, response_format))
        raise RuntimeError("temporary finalizer failure")


def make_runtime(llm: StructuredLlm) -> AgentRuntime:
    return AgentRuntime(
        settings=Settings(MAX_TOOL_ITERATIONS=3),
        sessions=SessionStore(),
        skills=FakeSkills(),
        mcp=FakeMcp(),
        tools=ToolProvider(),
        llm=llm,
    )


@pytest.mark.asyncio
async def test_tool_loop_uses_a_non_streaming_structured_finalizer() -> None:
    llm = StructuredLlm(['{"summary":"FOMC held rates steady."}'])
    runtime = make_runtime(llm)

    events = [
        item
        async for item in runtime.run(
            "structured-session",
            "Summarize the FOMC decision.",
            response_format=RESPONSE_FORMAT,
        )
    ]

    assert all(llm.stream_tools)
    assert len(llm.finalizer_calls) == 1
    finalizer_messages, finalizer_format = llm.finalizer_calls[0]
    assert finalizer_format == RESPONSE_FORMAT
    assert any(message.get("role") == "tool" for message in finalizer_messages)

    finalizer_request = llm.request_payloads[-1]
    assert finalizer_request["tools"] == []
    assert finalizer_request["response_format"] == RESPONSE_FORMAT
    assert not any(
        item.type == "message.delta" and item.data.get("content") == "unstructured draft"
        for item in events
    )

    finished = next(item for item in events if item.type == "run.finished")
    assert finished.data["output"] == {"summary": "FOMC held rates steady."}
    assert finished.data["output_format"] == "json_schema"
    assert finished.data["final_text"] == json.dumps(
        {"summary": "FOMC held rates steady."},
        separators=(",", ":"),
    )


@pytest.mark.asyncio
async def test_invalid_structured_output_is_retried_once() -> None:
    llm = StructuredLlm([
        '{"wrong":"field"}',
        '{"summary":"corrected"}',
    ])
    runtime = make_runtime(llm)

    events = [
        item
        async for item in runtime.run(
            "retry-session",
            "Summarize the decision.",
            response_format=RESPONSE_FORMAT,
        )
    ]

    assert len(llm.finalizer_calls) == 2
    assert "failed Anomalo validation" in llm.finalizer_calls[1][0][-1]["content"]
    assert events[-1].type == "run.finished"
    assert events[-1].data["output"] == {"summary": "corrected"}


@pytest.mark.asyncio
async def test_finalizer_failure_saves_a_resumable_checkpoint() -> None:
    llm = FailingFinalizerLlm([])
    runtime = make_runtime(llm)

    events = [
        item
        async for item in runtime.run(
            "finalizer-failure-session",
            "Summarize the decision.",
            response_format=RESPONSE_FORMAT,
        )
    ]

    failure = next(item for item in events if item.type == "run.error")
    assert failure.data["error_code"] == "finalizer_failed"
    assert failure.data["can_resume"] is True

    checkpoint = runtime.sessions.get_checkpoint("finalizer-failure-session")
    assert checkpoint is not None
    assert checkpoint.reason == "finalizer_error"
    assert checkpoint.response_format == RESPONSE_FORMAT
    assert any(message.get("role") == "tool" for message in checkpoint.messages)


def test_response_format_is_validated_at_the_api_boundary() -> None:
    request = ChatRequest(
        message="summarize",
        response_format=RESPONSE_FORMAT,
    )
    assert request.response_format is not None
    assert request.response_format.model_dump(mode="json", by_alias=True, exclude_none=True) == (
        RESPONSE_FORMAT
    )

    with pytest.raises(ValidationError):
        ChatRequest(
            message="summarize",
            response_format={"type": "json_schema"},
        )

    with pytest.raises(ValidationError, match="Only local JSON Schema references"):
        ChatRequest(
            message="summarize",
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "remote_schema",
                    "schema": {"$ref": "http://127.0.0.1/schema"},
                },
            },
        )


def test_checkpoint_persists_response_format(tmp_path) -> None:
    db_path = tmp_path / "sessions.sqlite3"
    first = SessionStore(db_path)
    first.save_checkpoint(
        "structured-session",
        [{"role": "user", "content": "summarize"}],
        run_id="run-1",
        prompt_profile="agent",
        user_content="summarize",
        iteration=1,
        response_format=RESPONSE_FORMAT,
    )
    first.close()

    second = SessionStore(db_path)
    checkpoint = second.get_checkpoint("structured-session")
    assert checkpoint is not None
    assert checkpoint.response_format == RESPONSE_FORMAT
    second.close()


def test_final_output_validation_rejects_wrong_shape() -> None:
    with pytest.raises(ValueError, match="does not match JSON Schema"):
        validate_final_output('{"wrong":"field"}', RESPONSE_FORMAT)


def test_openrouter_finalizer_payload_requires_structured_output_parameters() -> None:
    client = OpenAIChatClient(Settings(OPENROUTER_API_KEY="test-key"))

    payload = client.request_payload([], [], response_format=RESPONSE_FORMAT)

    assert payload["tools"] is None
    assert payload["tool_choice"] is None
    assert payload["response_format"] == RESPONSE_FORMAT
    assert "provider" not in payload
    assert payload["extra_body"] == {"provider": {"require_parameters": True}}
