import asyncio
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from typing import Any

from app.config import Settings
from app.search_modes import SEARCH_MODE_DIY
from app.tools.base import ToolContext, ToolProvider, ToolResult, ToolSpec

SEARCH_TOOL_NAME = "web_search"
FETCH_TOOL_NAME = "web_fetch"
DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/"
SUPPORTED_FETCH_CONTENT_TYPES = {
    "text/html",
    "text/markdown",
    "text/plain",
    "application/xhtml+xml",
}
REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes
    url: str


@dataclass(frozen=True)
class _ResolvedUrl:
    parsed: urllib.parse.SplitResult
    hostname: str
    port: int
    addresses: tuple[str, ...]


@dataclass
class _SearchResult:
    title: str = ""
    url: str = ""
    snippet: str = ""


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address: str, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout)
        self._address = address

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._address, self.port),
            self.timeout,
            self.source_address,
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, address: str, timeout: float) -> None:
        super().__init__(
            host,
            port,
            timeout=timeout,
            context=ssl.create_default_context(),
        )
        self._address = address

    def connect(self) -> None:
        sock = socket.create_connection(
            (self._address, self.port),
            self.timeout,
            self.source_address,
        )
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


class _DuckDuckGoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[_SearchResult] = []
        self._current: _SearchResult | None = None
        self._result_depth = 0
        self._capture: str | None = None
        self._capture_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key: value or "" for key, value in attrs}
        classes = set(attributes.get("class", "").split())
        if tag == "div" and "result" in classes and self._current is None:
            self._current = _SearchResult()
            self._result_depth = 1
            return
        if self._current is None:
            return
        if tag == "div":
            self._result_depth += 1
        if tag == "a" and "result__a" in classes:
            self._current.url = _normalize_duckduckgo_url(attributes.get("href", ""))
            self._capture = "title"
            self._capture_parts = []
        elif "result__snippet" in classes:
            self._capture = "snippet"
            self._capture_parts = []

    def handle_endtag(self, tag: str) -> None:
        if self._current is None:
            return
        if self._capture and tag in {"a", "div", "span"}:
            value = _clean_text(" ".join(self._capture_parts))
            setattr(self._current, self._capture, value)
            self._capture = None
            self._capture_parts = []
        if tag == "div":
            self._result_depth -= 1
            if self._result_depth == 0:
                if self._current.title and self._current.url:
                    self.results.append(self._current)
                self._current = None

    def handle_data(self, data: str) -> None:
        if self._capture:
            self._capture_parts.append(data)


class _MarkdownParser(HTMLParser):
    _ignored_tags = {"script", "style", "svg", "noscript", "template", "form"}
    _ignored_landmarks = {"nav", "footer"}
    _block_tags = {
        "article",
        "aside",
        "blockquote",
        "div",
        "dl",
        "figure",
        "figcaption",
        "main",
        "ol",
        "p",
        "section",
        "table",
        "ul",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self._ignored_depth = 0
        self._title_depth = 0
        self._pre_depth = 0
        self._link_stack: list[str] = []

    @property
    def title(self) -> str:
        return _clean_text(" ".join(self.title_parts))

    @property
    def markdown(self) -> str:
        value = "".join(self.parts)
        value = re.sub(r"[ \t]+\n", "\n", value)
        value = re.sub(r"\n[ \t]+", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        value = re.sub(r"[ \t]{2,}", " ", value)
        return value.strip()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key: value or "" for key, value in attrs}
        if tag in self._ignored_tags or tag in self._ignored_landmarks:
            self._ignored_depth += 1
            return
        if self._ignored_depth:
            return
        if tag == "title":
            self._title_depth += 1
        elif re.fullmatch(r"h[1-6]", tag):
            self._newline(2)
            self.parts.append(f"{'#' * int(tag[1])} ")
        elif tag in self._block_tags:
            self._newline(2)
        elif tag == "br":
            self._newline(1)
        elif tag == "li":
            self._newline(1)
            self.parts.append("- ")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag == "code" and not self._pre_depth:
            self.parts.append("`")
        elif tag == "pre":
            self._newline(2)
            self.parts.append("```\n")
            self._pre_depth += 1
        elif tag == "blockquote":
            self._newline(2)
            self.parts.append("> ")
        elif tag == "a":
            self._link_stack.append(attributes.get("href", ""))
            self.parts.append("[")
        elif tag == "img":
            alt = _clean_text(attributes.get("alt", ""))
            src = attributes.get("src", "")
            if alt and src:
                self.parts.append(f"![{alt}]({src})")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._ignored_tags or tag in self._ignored_landmarks:
            self._ignored_depth = max(0, self._ignored_depth - 1)
            return
        if self._ignored_depth:
            return
        if tag == "title":
            self._title_depth = max(0, self._title_depth - 1)
        elif re.fullmatch(r"h[1-6]", tag) or tag in self._block_tags:
            self._newline(2)
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag == "code" and not self._pre_depth:
            self.parts.append("`")
        elif tag == "pre":
            self._pre_depth = max(0, self._pre_depth - 1)
            self.parts.append("\n```")
            self._newline(2)
        elif tag == "a":
            href = self._link_stack.pop() if self._link_stack else ""
            self.parts.append(f"]({href})" if href else "]")

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        if self._title_depth:
            self.title_parts.append(data)
            return
        if self._pre_depth:
            self.parts.append(data)
            return
        value = re.sub(r"\s+", " ", unescape(data))
        if not value.strip():
            if self.parts and not self.parts[-1].endswith(("\n", " ")):
                self.parts.append(" ")
            return
        if self.parts and not self.parts[-1].endswith(("\n", " ", "[", "*", "`")):
            self.parts.append(" ")
        self.parts.append(value.strip())

    def _newline(self, count: int) -> None:
        current = "".join(self.parts[-2:])
        existing = len(current) - len(current.rstrip("\n"))
        if existing < count:
            self.parts.append("\n" * (count - existing))


Requester = Callable[..., HttpResponse]


class WebToolProvider(ToolProvider):
    def __init__(self, settings: Settings, requester: Requester | None = None) -> None:
        self.settings = settings
        self._requester = requester or _request
        self._search_cache: dict[str, tuple[float, list[dict[str, str]]]] = {}

    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        if not self.settings.web_tools_enabled:
            return []
        if context is not None and context.search_mode != SEARCH_MODE_DIY:
            return []
        return [
            ToolSpec(
                name=SEARCH_TOOL_NAME,
                description=(
                    "Search the public web with DuckDuckGo HTML. Returns titles, URLs, and "
                    "snippets. Use web_fetch to read promising results."
                ),
                source="web",
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query.",
                        },
                        "count": {
                            "type": "integer",
                            "description": "Number of results to return, from 1 to 10.",
                            "default": 5,
                            "minimum": 1,
                            "maximum": 10,
                        },
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
            ),
            ToolSpec(
                name=FETCH_TOOL_NAME,
                description=(
                    "Fetch a public HTTP(S) page and return Markdown. The configured backend can "
                    "use direct HTTP or Fruitspy Crawl4AI for JavaScript-rendered pages."
                ),
                source="web",
                parameters={
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Public HTTP or HTTPS URL.",
                        },
                        "max_chars": {
                            "type": "integer",
                            "description": "Maximum Markdown characters returned.",
                            "default": self.settings.web_fetch_max_chars,
                            "minimum": 1000,
                            "maximum": self.settings.web_fetch_max_chars,
                        },
                        "start_char": {
                            "type": "integer",
                            "description": "Character offset for continuing a truncated page.",
                            "default": 0,
                            "minimum": 0,
                        },
                    },
                    "required": ["url"],
                    "additionalProperties": False,
                },
            ),
        ]

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext | None = None,
    ) -> ToolResult:
        if context is not None and context.search_mode != SEARCH_MODE_DIY:
            return ToolResult(
                name=name,
                ok=False,
                content="DIY web tools are disabled while another retrieval mode is active.",
            )
        if name == SEARCH_TOOL_NAME:
            return await self._search(arguments)
        if name == FETCH_TOOL_NAME:
            return await self._fetch(arguments)
        return ToolResult(name=name, ok=False, content=f"Unknown web tool: {name}")

    async def _search(self, arguments: dict[str, Any]) -> ToolResult:
        query = str(arguments.get("query") or "").strip()
        if not query:
            return ToolResult(name=SEARCH_TOOL_NAME, ok=False, content="Search query is required.")
        count = max(1, min(int(arguments.get("count") or 5), 10))
        cache_key = f"{query.casefold()}:{count}"
        cached = self._search_cache.get(cache_key)
        if cached and time.monotonic() - cached[0] <= self.settings.web_search_cache_seconds:
            results = cached[1]
            return _search_result(query, results, duration_ms=0, cached=True)

        started = time.monotonic()
        try:
            results = await asyncio.to_thread(self._search_sync, query, count)
        except (OSError, ValueError) as exc:
            return ToolResult(
                name=SEARCH_TOOL_NAME,
                ok=False,
                content=f"Web search failed: {exc}",
                data={
                    "trace_kind": "web_search",
                    "provider": "duckduckgo_html",
                    "query": query,
                    "duration_ms": _elapsed_ms(started),
                    "results": [],
                },
            )
        self._search_cache[cache_key] = (time.monotonic(), results)
        if len(self._search_cache) > 128:
            oldest_key = min(self._search_cache, key=lambda key: self._search_cache[key][0])
            self._search_cache.pop(oldest_key, None)
        return _search_result(
            query,
            results,
            duration_ms=_elapsed_ms(started),
            cached=False,
        )

    def _search_sync(self, query: str, count: int) -> list[dict[str, str]]:
        body = urllib.parse.urlencode({"q": query}).encode("utf-8")
        response = self._requester(
            DUCKDUCKGO_HTML_URL,
            method="POST",
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": self.settings.web_user_agent,
            },
            timeout=self.settings.web_search_timeout_seconds,
            max_bytes=self.settings.web_search_max_bytes,
            validate_target=True,
        )
        if response.status != 200:
            raise OSError(f"DuckDuckGo returned HTTP {response.status}")
        parser = _DuckDuckGoParser()
        parser.feed(_decode_body(response.body, response.headers))
        results = [
            {"title": item.title, "url": item.url, "snippet": item.snippet}
            for item in parser.results[:count]
        ]
        if not results:
            page = _decode_body(response.body, response.headers).casefold()
            if "captcha" in page or "anomaly" in page or "unusual traffic" in page:
                raise OSError("DuckDuckGo challenged or rate-limited the request")
        return results

    async def _fetch(self, arguments: dict[str, Any]) -> ToolResult:
        url = str(arguments.get("url") or "").strip()
        if not url:
            return ToolResult(name=FETCH_TOOL_NAME, ok=False, content="URL is required.")
        try:
            await asyncio.to_thread(_validate_public_url, url)
        except ValueError as exc:
            return ToolResult(
                name=FETCH_TOOL_NAME,
                ok=False,
                content=f"URL rejected: {exc}",
                data={"trace_kind": "web_fetch", "requested_url": url},
            )
        max_chars = max(
            1000,
            min(
                int(arguments.get("max_chars") or self.settings.web_fetch_max_chars),
                self.settings.web_fetch_max_chars,
            ),
        )
        start_char = max(0, int(arguments.get("start_char") or 0))
        started = time.monotonic()
        provider = self.settings.web_fetch_provider.strip().lower()
        try:
            if provider == "direct":
                fetched = await asyncio.to_thread(self._fetch_direct, url)
            elif provider == "crawl4ai":
                fetched = await asyncio.to_thread(self._fetch_crawl4ai, url)
            elif provider == "auto":
                fetched = await asyncio.to_thread(self._fetch_auto, url)
            else:
                raise ValueError("WEB_FETCH_PROVIDER must be one of: auto, direct, crawl4ai")
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            return ToolResult(
                name=FETCH_TOOL_NAME,
                ok=False,
                content=f"Web fetch failed: {exc}",
                data={
                    "trace_kind": "web_fetch",
                    "provider": provider,
                    "requested_url": url,
                    "duration_ms": _elapsed_ms(started),
                },
            )

        markdown = str(fetched.pop("markdown", ""))
        fetched.pop("dynamic_candidate", None)
        page = markdown[start_char : start_char + max_chars]
        next_start = start_char + len(page)
        truncated = next_start < len(markdown)
        final_url = str(fetched.get("final_url") or url)
        title = str(fetched.get("title") or "")
        content = "\n".join(
            [
                f"Source: {final_url}",
                f"Title: {title or '(untitled)'}",
                f"Provider: {fetched.get('provider', provider)}",
                "",
                page,
            ]
        ).strip()
        data = {
            "trace_kind": "web_fetch",
            "requested_url": url,
            **fetched,
            "duration_ms": _elapsed_ms(started),
            "markdown_chars": len(markdown),
            "start_char": start_char,
            "returned_chars": len(page),
            "truncated": truncated,
            "next_start_char": next_start if truncated else None,
        }
        return ToolResult(name=FETCH_TOOL_NAME, content=content, data=data)

    def _fetch_auto(self, url: str) -> dict[str, Any]:
        direct: dict[str, Any] | None = None
        direct_error: Exception | None = None
        try:
            direct = self._fetch_direct(url)
        except (OSError, ValueError) as exc:
            direct_error = exc
        if direct is not None and not bool(direct.pop("dynamic_candidate", False)):
            return direct
        if self._crawl_api_base_url():
            try:
                crawled = self._fetch_crawl4ai(url)
                if direct is not None:
                    crawled["fallback_from"] = "direct"
                return crawled
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                if direct is not None:
                    direct["crawl4ai_error"] = str(exc)
                    return direct
                raise
        if direct is not None:
            return direct
        if direct_error is not None:
            raise direct_error
        raise OSError("No fetch backend is available")

    def _fetch_direct(self, url: str) -> dict[str, Any]:
        response = self._requester(
            url,
            method="GET",
            headers={"User-Agent": self.settings.web_user_agent},
            timeout=self.settings.web_fetch_timeout_seconds,
            max_bytes=self.settings.web_fetch_max_bytes,
            validate_target=True,
        )
        if response.status < 200 or response.status >= 300:
            raise OSError(f"Page returned HTTP {response.status}")
        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in SUPPORTED_FETCH_CONTENT_TYPES:
            raise ValueError(f"Unsupported content type: {content_type or 'unknown'}")
        text = _decode_body(response.body, response.headers)
        if content_type in {"text/html", "application/xhtml+xml"}:
            parser = _MarkdownParser()
            parser.feed(text)
            markdown = parser.markdown
            title = parser.title
            dynamic_candidate = _looks_dynamic(text, markdown)
        else:
            markdown = text.strip()
            title = ""
            dynamic_candidate = False
        if not markdown:
            raise OSError("Page contained no readable text")
        return {
            "provider": "direct",
            "final_url": response.url,
            "title": title,
            "status_code": response.status,
            "content_type": content_type,
            "content_bytes": len(response.body),
            "rendered": False,
            "dynamic_candidate": dynamic_candidate,
            "markdown": markdown,
        }

    def _fetch_crawl4ai(self, url: str) -> dict[str, Any]:
        base_url = self._crawl_api_base_url()
        if not base_url:
            raise OSError("Fruitspy Crawl4AI API is not configured")
        endpoint = urllib.parse.urljoin(
            base_url.rstrip("/") + "/",
            self.settings.fruitspy_crawl_api_path.lstrip("/"),
        )
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": self.settings.web_user_agent,
        }
        token = self.settings.fruitspy_crawl_api_token or self.settings.fruitspy_python_tool_token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        response = self._requester(
            endpoint,
            method="POST",
            data=json.dumps(
                {
                    "url": url,
                    "wait_for": None,
                    "timeout_ms": int(self.settings.web_fetch_timeout_seconds * 1000),
                }
            ).encode("utf-8"),
            headers=headers,
            timeout=self.settings.web_fetch_timeout_seconds + 2,
            max_bytes=self.settings.web_fetch_max_bytes,
            validate_target=False,
        )
        if response.status < 200 or response.status >= 300:
            raise OSError(f"Fruitspy Crawl4AI returned HTTP {response.status}")
        payload = json.loads(response.body.decode("utf-8"))
        if not isinstance(payload, dict):
            raise OSError("Fruitspy Crawl4AI returned an invalid response")
        if payload.get("ok") is False:
            raise OSError(_crawl_error(payload))
        if isinstance(payload.get("data"), dict):
            payload = payload["data"]
        if payload.get("ok") is False:
            raise OSError(_crawl_error(payload))
        markdown = str(payload.get("markdown") or "").strip()
        if not markdown:
            raise OSError("Fruitspy Crawl4AI returned no Markdown")
        final_url = str(payload.get("final_url") or payload.get("url") or url)
        _validate_public_url(final_url)
        return {
            "provider": "crawl4ai",
            "final_url": final_url,
            "title": str(payload.get("title") or ""),
            "status_code": int(payload.get("status_code") or response.status),
            "content_type": "text/markdown",
            "content_bytes": len(response.body),
            "rendered": bool(payload.get("rendered", True)),
            "markdown": markdown,
        }

    def _crawl_api_base_url(self) -> str:
        return (
            self.settings.fruitspy_crawl_api_base_url.strip()
            or self.settings.fruitspy_python_tool_base_url.strip()
        )


def _request(
    url: str,
    *,
    method: str,
    data: bytes | None = None,
    headers: dict[str, str],
    timeout: float,
    max_bytes: int,
    validate_target: bool,
) -> HttpResponse:
    deadline = time.monotonic() + timeout
    current_url = url
    current_method = method
    current_data = data
    for _ in range(6):
        resolved = _resolve_url(current_url, require_public=validate_target)
        response, connection = _open_response(
            resolved,
            method=current_method,
            data=current_data,
            headers=headers,
            deadline=deadline,
        )
        try:
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            if response.status in REDIRECT_STATUS_CODES:
                location = response_headers.get("location")
                if not location:
                    raise OSError(f"HTTP {response.status} redirect without Location")
                next_url = urllib.parse.urljoin(current_url, location)
                if _has_authorization(headers) and _origin(next_url) != _origin(current_url):
                    raise OSError("Authenticated redirect changed origin and was rejected")
                current_url = next_url
                if response.status == 303 or (
                    response.status in {301, 302} and current_method == "POST"
                ):
                    current_method = "GET"
                    current_data = None
                continue
            body = _read_response(response, connection, max_bytes, deadline)
            if response.status < 200 or response.status >= 300:
                detail = body[:512].decode("utf-8", errors="replace").strip()
                raise OSError(f"HTTP {response.status}: {detail or response.reason}")
            return HttpResponse(
                status=int(response.status),
                headers=response_headers,
                body=body,
                url=current_url,
            )
        finally:
            response.close()
            connection.close()
    raise OSError("Too many redirects")


def _open_response(
    resolved: _ResolvedUrl,
    *,
    method: str,
    data: bytes | None,
    headers: dict[str, str],
    deadline: float,
) -> tuple[http.client.HTTPResponse, http.client.HTTPConnection]:
    last_error: OSError | None = None
    target = resolved.parsed.path or "/"
    if resolved.parsed.query:
        target = f"{target}?{resolved.parsed.query}"
    for address in resolved.addresses:
        connection_class = (
            _PinnedHTTPSConnection if resolved.parsed.scheme == "https" else _PinnedHTTPConnection
        )
        connection = connection_class(
            resolved.hostname,
            resolved.port,
            address,
            _remaining_timeout(deadline),
        )
        try:
            connection.request(method, target, body=data, headers=headers)
            if connection.sock is not None:
                connection.sock.settimeout(_remaining_timeout(deadline))
            return connection.getresponse(), connection
        except (OSError, http.client.HTTPException) as exc:
            last_error = OSError(str(exc))
            connection.close()
    if last_error is not None:
        raise last_error
    raise OSError("hostname resolved without usable addresses")


def _read_response(
    response: http.client.HTTPResponse,
    connection: http.client.HTTPConnection,
    max_bytes: int,
    deadline: float,
) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        _set_response_timeout(response, connection, _remaining_timeout(deadline))
        chunk = response.read(min(64 * 1024, max_bytes + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > max_bytes:
            raise OSError(f"Response exceeds {max_bytes} bytes")
    return b"".join(chunks)


def _set_response_timeout(
    response: http.client.HTTPResponse,
    connection: http.client.HTTPConnection,
    timeout: float,
) -> None:
    sock = connection.sock
    if sock is None and response.fp is not None:
        sock = getattr(getattr(response.fp, "raw", None), "_sock", None)
    if sock is not None:
        sock.settimeout(timeout)


def _remaining_timeout(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Request timed out")
    return remaining


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urllib.parse.urlsplit(url)
    if not parsed.hostname:
        raise ValueError("URL must include a hostname")
    try:
        port = parsed.port or (443 if parsed.scheme.casefold() == "https" else 80)
    except ValueError as exc:
        raise ValueError("invalid URL port") from exc
    return parsed.scheme.casefold(), parsed.hostname.rstrip(".").casefold(), port


def _has_authorization(headers: dict[str, str]) -> bool:
    return any(key.casefold() == "authorization" for key in headers)


def _resolve_url(url: str, *, require_public: bool) -> _ResolvedUrl:
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.casefold()
    if scheme not in {"http", "https"}:
        raise ValueError("only http and https URLs are allowed")
    if not parsed.hostname:
        raise ValueError("URL must include a hostname")
    if parsed.username or parsed.password:
        raise ValueError("URLs containing credentials are not allowed")
    hostname = parsed.hostname.rstrip(".").casefold()
    if require_public and (hostname == "localhost" or hostname.endswith(".localhost")):
        raise ValueError("localhost is not allowed")
    try:
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError("invalid URL port") from exc
    try:
        resolved = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"hostname could not be resolved: {hostname}") from exc
    addresses: list[str] = []
    for address in resolved:
        value = address[4][0]
        if value not in addresses:
            addresses.append(value)
    if not addresses:
        raise ValueError(f"hostname could not be resolved: {hostname}")
    if require_public:
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if not ip.is_global:
                raise ValueError(f"non-public address is not allowed: {ip}")
    return _ResolvedUrl(
        parsed=parsed,
        hostname=hostname,
        port=port,
        addresses=tuple(addresses),
    )


def _validate_public_url(url: str) -> None:
    _resolve_url(url, require_public=True)


def _crawl_error(payload: dict[str, Any]) -> str:
    error = payload.get("error") or payload.get("detail") or "crawl failed"
    if isinstance(error, dict):
        return str(error.get("message") or error.get("code") or "crawl failed")
    return str(error)


def _decode_body(body: bytes, headers: dict[str, str]) -> str:
    content_type = headers.get("content-type", "")
    match = re.search(r"charset=([^\s;]+)", content_type, flags=re.IGNORECASE)
    charset = match.group(1).strip("\"'") if match else "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def _normalize_duckduckgo_url(url: str) -> str:
    absolute = urllib.parse.urljoin(DUCKDUCKGO_HTML_URL, unescape(url))
    parsed = urllib.parse.urlparse(absolute)
    if parsed.hostname and parsed.hostname.endswith("duckduckgo.com"):
        target = urllib.parse.parse_qs(parsed.query).get("uddg")
        if target:
            absolute = target[0]
            parsed = urllib.parse.urlparse(absolute)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    return absolute


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(value)).strip()


def _looks_dynamic(html: str, markdown: str) -> bool:
    lowered = html.casefold()
    markers = (
        "__next_data__",
        'id="__nuxt"',
        "you need to enable javascript",
        "javascript is required",
    )
    if any(marker in lowered for marker in markers):
        return True
    has_app_shell = bool(re.search(r"""id\s*=\s*["'](?:root|app|app-root)["']""", lowered))
    return len(markdown) < 300 and has_app_shell and "<script" in lowered


def _elapsed_ms(started: float) -> int:
    return max(0, round((time.monotonic() - started) * 1000))


def _search_result(
    query: str,
    results: list[dict[str, str]],
    *,
    duration_ms: int,
    cached: bool,
) -> ToolResult:
    if results:
        lines = [f"Search results for: {query}", ""]
        for index, result in enumerate(results, start=1):
            lines.append(f"{index}. [{result['title']}]({result['url']})")
            if result["snippet"]:
                lines.append(f"   {result['snippet']}")
        content = "\n".join(lines)
    else:
        content = f"No DuckDuckGo HTML results found for: {query}"
    return ToolResult(
        name=SEARCH_TOOL_NAME,
        content=content,
        data={
            "trace_kind": "web_search",
            "provider": "duckduckgo_html",
            "query": query,
            "duration_ms": duration_ms,
            "cached": cached,
            "result_count": len(results),
            "results": results,
        },
    )
