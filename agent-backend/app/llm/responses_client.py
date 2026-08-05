from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import Settings


class ResponsesSearchError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class ResponsesSearchResult:
    text: str
    citations: list[dict[str, str]] = field(default_factory=list)
    search_calls: list[dict[str, Any]] = field(default_factory=list)
    response_id: str | None = None
    model: str | None = None


class OpenRouterResponsesClient:
    def __init__(
        self,
        settings: Settings,
        *,
        model: str,
        timeout_seconds: float | None = None,
    ) -> None:
        self.settings = settings
        self.model = model
        self.timeout_seconds = timeout_seconds or settings.search_mode_timeout_seconds

    async def search(
        self,
        query: str,
        *,
        tool_type: str,
        max_results: int = 5,
    ) -> ResponsesSearchResult:
        if not self.settings.openrouter_api_key:
            raise ResponsesSearchError(
                "OPENROUTER_API_KEY is not configured.",
                code="missing_api_key",
            )

        if tool_type != "web_search_preview":
            raise ResponsesSearchError(
                f"Unsupported Responses API search tool: {tool_type}",
                code="unsupported_tool",
            )
        tool: dict[str, Any] = {"type": tool_type}

        payload = {
            "model": self.model,
            "input": query,
            "tools": [tool],
            "max_tool_calls": max(1, min(int(max_results), 5)),
            "max_output_tokens": 2400,
        }
        headers = {
            "Authorization": f"Bearer {self.settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": self.settings.site_url,
            "X-Title": self.settings.app_title,
        }
        url = f"{self.settings.openai_base_url.rstrip('/')}/responses"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise ResponsesSearchError(
                f"Responses API request failed: {exc}",
                code="transport_error",
            ) from exc

        try:
            data = response.json()
        except ValueError as exc:
            raise ResponsesSearchError(
                f"Responses API returned invalid JSON (HTTP {response.status_code}).",
                code="invalid_response",
                status_code=response.status_code,
            ) from exc

        if not isinstance(data, dict):
            raise ResponsesSearchError(
                f"Responses API returned an invalid payload (HTTP {response.status_code}).",
                code="invalid_response",
                status_code=response.status_code,
            )

        error = data.get("error")
        if not response.is_success or isinstance(error, dict):
            error = error if isinstance(error, dict) else {}
            message = str(error.get("message") or f"HTTP {response.status_code}")
            raise ResponsesSearchError(
                message,
                code=str(error.get("code") or "responses_api_error"),
                status_code=response.status_code,
            )

        return _parse_search_response(data)


def _parse_search_response(data: dict[str, Any]) -> ResponsesSearchResult:
    text_parts: list[str] = []
    citations: list[dict[str, str]] = []
    search_calls: list[dict[str, Any]] = []

    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type") or "")
        if item_type == "web_search_call":
            action = item.get("action") if isinstance(item.get("action"), dict) else {}
            search_calls.append(
                {
                    "type": item_type,
                    "status": item.get("status"),
                    "query": action.get("query"),
                }
            )
        if item_type in {"output_text", "text"} and item.get("text"):
            text_parts.append(str(item["text"]))
        for content in item.get("content") or []:
            if not isinstance(content, dict):
                continue
            content_type = str(content.get("type") or "")
            if content_type in {"output_text", "text"} and content.get("text"):
                text_parts.append(str(content["text"]))
            for annotation in content.get("annotations") or []:
                citation = _citation_from_annotation(annotation)
                if citation and citation["url"] not in {item["url"] for item in citations}:
                    citations.append(citation)

    if not text_parts and data.get("output_text"):
        text_parts.append(str(data["output_text"]))

    return ResponsesSearchResult(
        text="\n".join(part.strip() for part in text_parts if part.strip()).strip(),
        citations=citations,
        search_calls=search_calls,
        response_id=str(data.get("id") or "") or None,
        model=str(data.get("model") or "") or None,
    )


def _citation_from_annotation(annotation: Any) -> dict[str, str] | None:
    if not isinstance(annotation, dict):
        return None
    nested = annotation.get("url_citation")
    if not isinstance(nested, dict):
        nested = {}
    url = str(annotation.get("url") or nested.get("url") or "").strip()
    if not url:
        return None
    title = str(annotation.get("title") or nested.get("title") or "").strip()
    if not title:
        title = urlparse(url).netloc or url
    content = str(annotation.get("content") or nested.get("content") or "").strip()
    citation = {"url": url, "title": title}
    if content:
        citation["snippet"] = content
    return citation
