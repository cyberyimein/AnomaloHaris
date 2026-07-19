import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from app.config import Settings
from app.tools import web
from app.tools.web import (
    DUCKDUCKGO_HTML_URL,
    FETCH_TOOL_NAME,
    SEARCH_TOOL_NAME,
    HttpResponse,
    WebToolProvider,
    _request,
)


def settings(**values: object) -> Settings:
    return Settings(_env_file=None, **values)


@pytest.mark.asyncio
async def test_web_tools_are_published_without_an_api_key() -> None:
    provider = WebToolProvider(settings())

    tools = await provider.list_tools()

    assert [tool.name for tool in tools] == [SEARCH_TOOL_NAME, FETCH_TOOL_NAME]


@pytest.mark.asyncio
async def test_duckduckgo_html_search_returns_structured_results_and_caches() -> None:
    calls: list[str] = []
    html = """
    <html><body>
      <div class="result results_links">
        <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">
          Example documentation
        </a></h2>
        <a class="result__snippet">A useful <b>documentation</b> result.</a>
      </div>
    </body></html>
    """

    def requester(url: str, **kwargs: object) -> HttpResponse:
        calls.append(url)
        assert url == DUCKDUCKGO_HTML_URL
        assert kwargs["method"] == "POST"
        return HttpResponse(
            status=200,
            headers={"content-type": "text/html; charset=utf-8"},
            body=html.encode(),
            url=url,
        )

    provider = WebToolProvider(settings(), requester=requester)
    first = await provider.call_tool(SEARCH_TOOL_NAME, {"query": "example docs", "count": 5})
    second = await provider.call_tool(SEARCH_TOOL_NAME, {"query": "example docs", "count": 5})

    assert first.ok is True
    assert first.data["provider"] == "duckduckgo_html"
    assert first.data["results"] == [
        {
            "title": "Example documentation",
            "url": "https://example.com/doc",
            "snippet": "A useful documentation result.",
        }
    ]
    assert second.data["cached"] is True
    assert calls == [DUCKDUCKGO_HTML_URL]


@pytest.mark.asyncio
async def test_direct_fetch_converts_html_to_markdown_and_paginates() -> None:
    html = """
    <html>
      <head><title>Example page</title><style>hidden</style></head>
      <body><nav>navigation</nav><main>
        <h1>Heading</h1><p>This is <strong>readable</strong> text.</p>
        <a href="https://example.com/next">Next page</a>
      </main><script>alert(1)</script></body>
    </html>
    """

    def requester(url: str, **kwargs: object) -> HttpResponse:
        assert kwargs["validate_target"] is True
        return HttpResponse(
            status=200,
            headers={"content-type": "text/html; charset=utf-8"},
            body=html.encode(),
            url=url,
        )

    provider = WebToolProvider(
        settings(web_fetch_provider="direct", web_fetch_max_chars=1000),
        requester=requester,
    )
    result = await provider.call_tool(
        FETCH_TOOL_NAME,
        {"url": "https://93.184.216.34/page", "max_chars": 1000},
    )

    assert result.ok is True
    assert result.data["provider"] == "direct"
    assert result.data["title"] == "Example page"
    assert result.data["truncated"] is False
    assert "# Heading" in result.content
    assert "**readable**" in result.content
    assert "navigation" not in result.content
    assert "alert(1)" not in result.content


@pytest.mark.asyncio
async def test_auto_fetch_uses_fruitspy_for_a_dynamic_page() -> None:
    calls: list[str] = []

    def requester(url: str, **kwargs: object) -> HttpResponse:
        calls.append(url)
        if url == "https://93.184.216.34/app":
            return HttpResponse(
                status=200,
                headers={"content-type": "text/html"},
                body=b'<html><body><main>Loading...</main><div id="__nuxt"></div></body></html>',
                url=url,
            )
        payload = {
            "ok": True,
            "url": "https://93.184.216.34/app",
            "final_url": "https://93.184.216.34/app",
            "title": "Rendered app",
            "markdown": "# Rendered\n\nDynamic content.",
            "status_code": 200,
            "rendered": True,
        }
        assert kwargs["validate_target"] is False
        assert kwargs["headers"]["Authorization"] == "Bearer shared-token"  # type: ignore[index]
        return HttpResponse(
            status=200,
            headers={"content-type": "application/json"},
            body=json.dumps(payload).encode(),
            url=url,
        )

    provider = WebToolProvider(
        settings(
            web_fetch_provider="auto",
            fruitspy_crawl_api_base_url="",
            fruitspy_python_tool_base_url="http://fruitspy.test:8848",
            fruitspy_python_tool_token="shared-token",
        ),
        requester=requester,
    )
    result = await provider.call_tool(FETCH_TOOL_NAME, {"url": "https://93.184.216.34/app"})

    assert result.ok is True
    assert result.data["provider"] == "crawl4ai"
    assert result.data["rendered"] is True
    assert result.data["fallback_from"] == "direct"
    assert "# Rendered" in result.content
    assert calls == [
        "https://93.184.216.34/app",
        "http://fruitspy.test:8848/api/v1/tools/crawl",
    ]


@pytest.mark.asyncio
async def test_fetch_rejects_private_network_targets_before_requesting() -> None:
    called = False

    def requester(url: str, **kwargs: object) -> HttpResponse:
        nonlocal called
        called = True
        raise AssertionError(f"unexpected request: {url}, {kwargs}")

    provider = WebToolProvider(settings(), requester=requester)
    result = await provider.call_tool(FETCH_TOOL_NAME, {"url": "http://127.0.0.1/admin"})

    assert result.ok is False
    assert "non-public address" in result.content
    assert called is False


@pytest.mark.asyncio
async def test_crawl4ai_preserves_outer_failure_envelope() -> None:
    def requester(url: str, **kwargs: object) -> HttpResponse:
        del kwargs
        return HttpResponse(
            status=200,
            headers={"content-type": "application/json"},
            body=json.dumps(
                {
                    "ok": False,
                    "error": {"code": "render_failed", "message": "browser crashed"},
                    "data": {
                        "markdown": "# Partial result",
                        "final_url": "https://93.184.216.34/page",
                    },
                }
            ).encode(),
            url=url,
        )

    provider = WebToolProvider(
        settings(
            web_fetch_provider="crawl4ai",
            fruitspy_crawl_api_base_url="http://fruitspy.test:8848",
        ),
        requester=requester,
    )

    result = await provider.call_tool(
        FETCH_TOOL_NAME,
        {"url": "https://93.184.216.34/page"},
    )

    assert result.ok is False
    assert "browser crashed" in result.content
    assert "Partial result" not in result.content


def test_request_connects_to_the_validated_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append((self.path, self.headers.get("Host")))
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"pinned")

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    real_create_connection = socket.create_connection
    real_getaddrinfo = socket.getaddrinfo
    connected_addresses: list[tuple[str, int]] = []

    def getaddrinfo(
        host: str,
        requested_port: int,
        *args: object,
        **kwargs: object,
    ) -> list[tuple[int, int, int, str, tuple[str, int]]]:
        if host == "127.0.0.1":
            return real_getaddrinfo(host, requested_port, *args, **kwargs)
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                ("93.184.216.34", requested_port),
            )
        ]

    def create_connection(
        address: tuple[str, int],
        timeout: float,
        source_address: tuple[str, int] | None,
    ) -> socket.socket:
        connected_addresses.append(address)
        return real_create_connection(
            ("127.0.0.1", address[1]),
            timeout,
            source_address,
        )

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    monkeypatch.setattr(socket, "create_connection", create_connection)
    try:
        response = _request(
            f"http://public.test:{port}/docs?q=agent",
            method="GET",
            headers={"User-Agent": "test"},
            timeout=2,
            max_bytes=1024,
            validate_target=True,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    assert response.body == b"pinned"
    assert connected_addresses == [("93.184.216.34", port)]
    assert requests == [("/docs?q=agent", f"public.test:{port}")]


def test_request_rejects_cross_origin_authenticated_redirect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request_count = 0

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            nonlocal request_count
            request_count += 1
            self.send_response(302)
            self.send_header(
                "Location",
                f"http://other.test:{self.server.server_address[1]}/secret",
            )
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    real_getaddrinfo = socket.getaddrinfo

    def getaddrinfo(
        host: str,
        requested_port: int,
        *args: object,
        **kwargs: object,
    ) -> list[tuple[int, int, int, str, tuple[str, int]]]:
        if host == "127.0.0.1":
            return real_getaddrinfo(host, requested_port, *args, **kwargs)
        return [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                ("127.0.0.1", requested_port),
            )
        ]

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    try:
        with pytest.raises(OSError, match="Authenticated redirect changed origin"):
            _request(
                f"http://fruitspy.test:{port}/crawl",
                method="GET",
                headers={"Authorization": "Bearer secret"},
                timeout=2,
                max_bytes=1024,
                validate_target=False,
            )
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    assert request_count == 1


def test_request_timeout_is_shared_across_redirects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 100.0
    opened = 0

    class RedirectResponse:
        status = 302
        reason = "Found"

        def getheaders(self) -> list[tuple[str, str]]:
            return [("Location", "/again")]

        def close(self) -> None:
            return None

    class Connection:
        sock = None

        def close(self) -> None:
            return None

    def monotonic() -> float:
        return now

    def resolve(url: str, *, require_public: bool) -> web._ResolvedUrl:
        del require_public
        return web._ResolvedUrl(
            parsed=web.urllib.parse.urlsplit(url),
            hostname="public.test",
            port=80,
            addresses=("93.184.216.34",),
        )

    def open_response(
        resolved: web._ResolvedUrl,
        *,
        method: str,
        data: bytes | None,
        headers: dict[str, str],
        deadline: float,
    ) -> tuple[RedirectResponse, Connection]:
        nonlocal now, opened
        del resolved, method, data, headers
        web._remaining_timeout(deadline)
        opened += 1
        now += 0.4
        return RedirectResponse(), Connection()

    monkeypatch.setattr(web.time, "monotonic", monotonic)
    monkeypatch.setattr(web, "_resolve_url", resolve)
    monkeypatch.setattr(web, "_open_response", open_response)

    with pytest.raises(TimeoutError, match="Request timed out"):
        _request(
            "http://public.test/start",
            method="GET",
            headers={},
            timeout=1,
            max_bytes=1024,
            validate_target=True,
        )

    assert opened == 3
