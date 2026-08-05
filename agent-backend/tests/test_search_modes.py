from dataclasses import dataclass
from typing import Any

import pytest
from app.agent.session import SessionStore
from app.api import sessions as sessions_api
from app.config import Settings
from app.llm.responses_client import (
    ResponsesSearchError,
    ResponsesSearchResult,
)
from app.search_modes import (
    SEARCH_MODE_DIY,
    SEARCH_MODE_NATIVE,
    SEARCH_MODE_SUBAGENT,
)
from app.tools.base import ToolContext
from app.tools.retrieval import RetrievalToolProvider
from app.tools.web import WebToolProvider


def settings(**values: object) -> Settings:
    return Settings(_env_file=None, openrouter_api_key="test-key", **values)


@dataclass
class FakeResponsesClient:
    model: str
    calls: list[dict[str, Any]]
    failure: ResponsesSearchError | None = None

    async def search(
        self,
        query: str,
        *,
        tool_type: str,
        max_results: int,
    ) -> ResponsesSearchResult:
        self.calls.append(
            {
                "model": self.model,
                "query": query,
                "tool_type": tool_type,
                "max_results": max_results,
            }
        )
        if self.failure is not None:
            raise self.failure
        return ResponsesSearchResult(
            text=f"Research from {self.model}.",
            citations=[{"title": "Example", "url": "https://example.com/source"}],
            search_calls=[{"type": "web_search_call", "status": "completed"}],
            response_id="resp-1",
            model=self.model,
        )


@pytest.mark.asyncio
async def test_native_and_subagent_use_standard_responses_search() -> None:
    calls: list[dict[str, Any]] = []

    def factory(configured_settings: Settings, model: str) -> FakeResponsesClient:
        del configured_settings
        return FakeResponsesClient(model=model, calls=calls)

    configured = settings(
        openrouter_model="provider/active-model",
        web_research_subagent_model="deepseek/deepseek-v4-flash-0731",
    )
    provider = RetrievalToolProvider(configured, client_factory=factory)

    native_tools = await provider.list_tools(
        ToolContext(search_mode=SEARCH_MODE_NATIVE, model="provider/active-model")
    )
    subagent_tools = await provider.list_tools(ToolContext(search_mode=SEARCH_MODE_SUBAGENT))
    diy_tools = await provider.list_tools(ToolContext(search_mode=SEARCH_MODE_DIY))

    assert [tool.name for tool in native_tools] == ["web_search"]
    assert [tool.name for tool in subagent_tools] == ["web_search"]
    assert diy_tools == []

    native_result = await provider.call_tool(
        "web_search",
        {"query": "native question", "count": 3},
        ToolContext(search_mode=SEARCH_MODE_NATIVE, model="provider/active-model"),
    )
    subagent_result = await provider.call_tool(
        "web_search",
        {"query": "subagent question", "count": 4},
        ToolContext(search_mode=SEARCH_MODE_SUBAGENT, model="provider/active-model"),
    )

    assert native_result.ok is True
    assert native_result.data["provider"] == "model_native_responses"
    assert native_result.data["search_mode"] == SEARCH_MODE_NATIVE
    assert subagent_result.ok is True
    assert subagent_result.data["provider"] == "responses_api_subagent"
    assert subagent_result.data["model"] == "deepseek/deepseek-v4-flash-0731"
    assert [call["tool_type"] for call in calls] == [
        "web_search_preview",
        "web_search_preview",
    ]
    assert calls[0]["model"] == "provider/active-model"
    assert calls[1]["model"] == "deepseek/deepseek-v4-flash-0731"
    assert "subagent question" in calls[1]["query"]


@pytest.mark.asyncio
async def test_native_failure_returns_capability_feedback() -> None:
    failure = ResponsesSearchError(
        "Tool is not supported for this model.",
        code="unsupported_tool",
        status_code=400,
    )

    def factory(configured_settings: Settings, model: str) -> FakeResponsesClient:
        del configured_settings
        return FakeResponsesClient(model=model, calls=[], failure=failure)

    provider = RetrievalToolProvider(settings(), client_factory=factory)
    result = await provider.call_tool(
        "web_search",
        {"query": "current question"},
        ToolContext(search_mode=SEARCH_MODE_NATIVE, model="provider/model"),
    )

    assert result.ok is False
    assert "unavailable" in result.content
    assert "switch" in result.content.lower()
    assert result.data["capability_status"] == "unavailable"
    assert result.data["error_code"] == "unsupported_tool"


@pytest.mark.asyncio
async def test_diy_provider_is_hidden_and_rejects_calls_in_other_modes() -> None:
    provider = WebToolProvider(settings())

    assert await provider.list_tools(ToolContext(search_mode=SEARCH_MODE_NATIVE)) == []
    result = await provider.call_tool(
        "web_search",
        {"query": "should not run"},
        ToolContext(search_mode=SEARCH_MODE_SUBAGENT),
    )

    assert result.ok is False
    assert "disabled" in result.content


def test_session_search_mode_is_persisted(tmp_path) -> None:
    db_path = tmp_path / "sessions.sqlite3"
    first = SessionStore(db_path, default_search_mode=SEARCH_MODE_NATIVE)

    assert first.get_search_mode("session-1") == SEARCH_MODE_NATIVE
    first.set_search_mode("session-1", SEARCH_MODE_SUBAGENT)
    first.append("session-1", {"role": "user", "content": "hello"})
    first.close()

    second = SessionStore(db_path, default_search_mode=SEARCH_MODE_DIY)
    assert second.get_search_mode("session-1") == SEARCH_MODE_SUBAGENT
    snapshot = second.get_session_snapshot("session-1")
    assert snapshot is not None
    assert snapshot["search_mode"] == SEARCH_MODE_SUBAGENT
    second.close()


@pytest.mark.asyncio
async def test_search_mode_api_reads_and_updates_a_session(monkeypatch) -> None:
    store = SessionStore()
    configured = settings(web_research_subagent_model="deepseek/deepseek-v4-flash-0731")

    class Runtime:
        def has_active_run(self, session_id: str) -> bool:
            del session_id
            return False

    monkeypatch.setattr(sessions_api, "get_session_store", lambda: store)
    monkeypatch.setattr(sessions_api, "get_agent_runtime", lambda: Runtime())
    monkeypatch.setattr(sessions_api, "get_settings", lambda: configured)

    initial = await sessions_api.get_search_mode("api-session")
    updated = await sessions_api.update_search_mode(
        "api-session",
        sessions_api.SearchModeUpdate(mode=SEARCH_MODE_NATIVE),
    )

    assert initial["mode"] == SEARCH_MODE_DIY
    assert updated["mode"] == SEARCH_MODE_NATIVE
    assert updated["subagent_model"] == "deepseek/deepseek-v4-flash-0731"
    assert [option["id"] for option in updated["modes"]] == [
        SEARCH_MODE_NATIVE,
        SEARCH_MODE_SUBAGENT,
        SEARCH_MODE_DIY,
    ]
    store.close()
