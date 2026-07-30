from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
import yaml
from app.tools.base import ToolContext
from app.tools.mcp_provider import (
    MCPManager,
    MCPProvider,
    MCPServerDefinition,
    _client_mode,
    _load_server_definitions,
)


class FakeMCPClient:
    def __init__(self, protocol_version: str = "2026-07-28") -> None:
        self.protocol_version = protocol_version
        self.list_calls = 0
        self.tool_calls: list[tuple[str, dict[str, Any]]] = []

    async def list_tools(self) -> SimpleNamespace:
        self.list_calls += 1
        tool = SimpleNamespace(
            name="get_room_climate",
            description="Read the current room climate.",
            input_schema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        )
        return SimpleNamespace(tools=[tool], ttl_ms=60_000)

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        self.tool_calls.append((name, arguments))
        return SimpleNamespace(
            content=[SimpleNamespace(text='{"available":true,"temperature_c":25.3}')],
            structured_content={"available": True, "temperature_c": 25.3},
            is_error=False,
            meta={"fruitspy/request_id": "test-1"},
        )


def _write_config(path, server: dict[str, Any]) -> None:
    path.write_text(
        yaml.safe_dump({"mcp_servers": {"fruitspy": server}}),
        encoding="utf-8",
    )


def test_protocol_mode_prefers_modern_and_allows_diagnostic_overrides() -> None:
    assert _client_mode("auto") == "auto"
    assert _client_mode("modern") == "2026-07-28"
    assert _client_mode("2026-07-28") == "2026-07-28"
    assert _client_mode("legacy") == "legacy"

    with pytest.raises(ValueError, match="Unsupported MCP protocol mode"):
        _client_mode("future")


def test_legacy_stdio_config_remains_compatible(tmp_path) -> None:
    config_path = tmp_path / "mcp_servers.yaml"
    _write_config(
        config_path,
        {
            "enabled": True,
            "description": "Legacy stdio server",
            "command": "python",
            "args": ["server.py"],
            "env": {"EXAMPLE": "1"},
        },
    )

    definitions = _load_server_definitions(config_path)

    assert definitions == [
        MCPServerDefinition(
            name="fruitspy",
            description="Legacy stdio server",
            enabled=True,
            transport="stdio",
            protocol="auto",
            command="python",
            args=("server.py",),
            env={"EXAMPLE": "1"},
            url="",
        )
    ]


def test_manager_persists_streamable_http_fields(tmp_path) -> None:
    config_path = tmp_path / "mcp_servers.yaml"
    manager = MCPManager(config_path)

    saved = manager.upsert_server(
        "fruitspy",
        transport="streamable_http",
        protocol="auto",
        url="http://127.0.0.1:8848/api/v1/tools/room-climate/mcp",
        description="Room climate",
    )

    assert saved["transport"] == "streamable_http"
    assert saved["protocol"] == "auto"
    assert saved["url"].endswith("/room-climate/mcp")
    catalog = manager.list_server_catalog()
    assert catalog[0]["transport"] == "streamable_http"
    assert catalog[0]["protocol_version"] is None


@pytest.mark.asyncio
async def test_provider_discovers_and_calls_http_tool_with_structured_content(tmp_path) -> None:
    config_path = tmp_path / "mcp_servers.yaml"
    _write_config(
        config_path,
        {
            "enabled": True,
            "transport": "streamable_http",
            "protocol": "auto",
            "url": "http://fruitspy.test/mcp",
        },
    )
    client = FakeMCPClient()
    opened: list[MCPServerDefinition] = []

    @asynccontextmanager
    async def client_factory(
        server: MCPServerDefinition,
        timeout_seconds: float,
    ):
        assert timeout_seconds == 2
        opened.append(server)
        yield client

    provider = MCPProvider(config_path, timeout_seconds=2, client_factory=client_factory)
    context = ToolContext(session_id="session-1", active_mcp_servers=frozenset({"fruitspy"}))

    tools = await provider.list_tools(context)
    climate_tool = next(tool for tool in tools if tool.source == "mcp:fruitspy")
    result = await provider.call_tool(climate_tool.name, {}, context)
    status = await provider.status(context)

    assert opened[0].transport == "streamable_http"
    assert client.list_calls == 1
    assert client.tool_calls == [("get_room_climate", {})]
    assert result.ok is True
    assert result.data["structured_content"]["temperature_c"] == 25.3
    assert result.data["meta"]["fruitspy/request_id"] == "test-1"
    assert result.data["protocol_version"] == "2026-07-28"
    assert result.data["protocol_era"] == "modern"
    assert status["servers"][0]["protocol_version"] == "2026-07-28"
    assert status["servers"][0]["protocol_era"] == "modern"


@pytest.mark.asyncio
async def test_provider_reports_negotiated_legacy_protocol(tmp_path) -> None:
    config_path = tmp_path / "mcp_servers.yaml"
    _write_config(
        config_path,
        {
            "enabled": True,
            "transport": "streamable_http",
            "protocol": "auto",
            "url": "http://fruitspy.test/mcp",
        },
    )
    client = FakeMCPClient(protocol_version="2025-11-25")

    @asynccontextmanager
    async def client_factory(server: MCPServerDefinition, timeout_seconds: float):
        yield client

    provider = MCPProvider(config_path, client_factory=client_factory)
    context = ToolContext(session_id="session-1", active_mcp_servers=frozenset({"fruitspy"}))

    tools = await provider.list_tools(context)
    climate_tool = next(tool for tool in tools if tool.source == "mcp:fruitspy")
    result = await provider.call_tool(climate_tool.name, {}, context)

    assert result.data["protocol_version"] == "2025-11-25"
    assert result.data["protocol_era"] == "legacy"
