import asyncio
import hashlib
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from app.tools.base import ToolContext, ToolProvider, ToolResult, ToolSpec, ensure_tool_name

ACTIVATE_MCP_TOOL_NAME = "mcp_activate"
DEACTIVATE_MCP_TOOL_NAME = "mcp_deactivate"
MCP_ROUTER_SOURCE = "mcp-router"


@dataclass(frozen=True)
class MCPServerDefinition:
    name: str
    description: str
    enabled: bool
    transport: str
    protocol: str
    command: str
    args: tuple[str, ...]
    env: dict[str, str]
    url: str


@dataclass(frozen=True)
class MCPToolDefinition:
    public_name: str
    original_name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class MCPConnectionInfo:
    protocol_version: str
    protocol_era: str
    transport: str


@dataclass(frozen=True)
class MCPToolCatalog:
    tools: tuple[Any, ...]
    ttl_ms: int
    connection: MCPConnectionInfo


@dataclass(frozen=True)
class MCPCallResponse:
    result: Any
    connection: MCPConnectionInfo


@dataclass(frozen=True)
class _MCPToolCacheEntry:
    config_key: str
    tools: tuple[MCPToolDefinition, ...]
    mapping: dict[str, str]
    expires_at: float


MCPClientFactory = Callable[[MCPServerDefinition, float], Any]


class MCPProvider(ToolProvider):
    def __init__(
        self,
        config_path: Path,
        timeout_seconds: float = 8.0,
        client_factory: MCPClientFactory | None = None,
    ) -> None:
        self.config_path = config_path
        self.timeout_seconds = timeout_seconds
        self._client_factory = client_factory or _open_mcp_client
        self._tool_cache: dict[str, _MCPToolCacheEntry] = {}
        self._connection_info: dict[str, MCPConnectionInfo] = {}

    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        if not _mcp_available():
            return []

        definitions = self._enabled_server_definitions()
        if not definitions:
            return []

        tools = _mcp_control_tools(list(definitions.values()))
        active_server_names = (
            list(definitions)
            if context is None
            else [name for name in sorted(context.active_mcp_servers) if name in definitions]
        )
        active_specs, _ = await self._list_tools_with_errors(
            active_server_names=active_server_names
        )
        tools.extend(active_specs)
        return tools

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext | None = None,
    ) -> ToolResult:
        if not _mcp_available():
            return ToolResult(
                name=name,
                ok=False,
                content="The optional Python package 'mcp' is not installed.",
            )

        definitions = self._enabled_server_definitions()

        if name == ACTIVATE_MCP_TOOL_NAME:
            return _activate_mcp_server(definitions, arguments, context)

        if name == DEACTIVATE_MCP_TOOL_NAME:
            return _deactivate_mcp_server(definitions, arguments, context)

        active_server_names = (
            set(definitions) if context is None else set(context.active_mcp_servers)
        )
        for definition in definitions.values():
            if not _tool_name_matches_server(definition.name, name):
                continue

            if definition.name not in active_server_names:
                return ToolResult(
                    name=name,
                    ok=False,
                    content=(
                        f"MCP server '{definition.name}' is not active. "
                        f"Call {ACTIVATE_MCP_TOOL_NAME} with server_name='{definition.name}' first."
                    ),
                )

            try:
                mapping = await self._tool_name_mapping(definition)
            except TimeoutError:
                return ToolResult(name=name, ok=False, content="MCP list_tools timed out.")
            except Exception as exc:  # noqa: BLE001
                return ToolResult(name=name, ok=False, content=f"MCP tool resolution error: {exc}")

            original_tool_name = mapping.get(name)
            if original_tool_name is None:
                return ToolResult(name=name, ok=False, content=f"MCP tool not found: {name}")

            try:
                result = await _call_mcp_server_tool(
                    definition,
                    original_tool_name,
                    arguments,
                    self.timeout_seconds,
                    self._client_factory,
                )
            except TimeoutError:
                return ToolResult(name=name, ok=False, content="MCP tool call timed out.")
            except Exception as exc:  # noqa: BLE001
                return ToolResult(name=name, ok=False, content=f"MCP tool error: {exc}")

            self._connection_info[definition.name] = result.connection
            return ToolResult(
                name=name,
                ok=not bool(getattr(result.result, "is_error", False)),
                content=_stringify_mcp_result(result.result),
                data=_mcp_result_data(result.result)
                | {
                    "original_tool_name": original_tool_name,
                    "mcp_server_name": definition.name,
                    "protocol_version": result.connection.protocol_version,
                    "protocol_era": result.connection.protocol_era,
                    "transport": result.connection.transport,
                },
            )

        return ToolResult(name=name, ok=False, content=f"MCP tool not found: {name}")

    async def status(self, context: ToolContext | None = None) -> dict[str, Any]:
        definitions = list(self._enabled_server_definitions().values())
        active_server_names = (
            [definition.name for definition in definitions]
            if context is None
            else [
                name
                for name in sorted(context.active_mcp_servers)
                if name in {d.name for d in definitions}
            ]
        )
        tools, errors = await self._list_tools_with_errors(active_server_names=active_server_names)
        return {
            "available": _mcp_available(),
            "active_server_names": active_server_names,
            "cached_servers": sorted(self._tool_cache),
            "servers": [
                _server_definition_payload(
                    definition,
                    active=definition.name in active_server_names,
                    error=errors.get(definition.name),
                    connection=self._connection_info.get(definition.name),
                )
                for definition in definitions
            ],
            "tools": [tool.model_dump() for tool in tools],
        }

    async def _list_tools_with_errors(
        self,
        active_server_names: list[str] | None = None,
    ) -> tuple[list[ToolSpec], dict[str, str]]:
        if not _mcp_available():
            return [], {}

        definitions = self._enabled_server_definitions()
        target_names = list(definitions) if active_server_names is None else active_server_names

        specs: list[ToolSpec] = []
        errors: dict[str, str] = {}
        for server_name in target_names:
            definition = definitions.get(server_name)
            if definition is None:
                continue
            try:
                server_tools = await self._server_tools(definition)
            except TimeoutError:
                errors[server_name] = "MCP list_tools timed out."
                continue
            except Exception as exc:  # noqa: BLE001
                errors[server_name] = str(exc)
                continue

            specs.extend(
                ToolSpec(
                    name=tool.public_name,
                    source=f"mcp:{ensure_tool_name(server_name)}",
                    description=tool.description,
                    parameters=tool.parameters,
                )
                for tool in server_tools
            )
        return specs, errors

    async def _tool_name_mapping(self, definition: MCPServerDefinition) -> dict[str, str]:
        cache_key = _server_cache_key(definition)
        cached = self._tool_cache.get(definition.name)
        if cached and cached.config_key == cache_key and cached.expires_at > time.monotonic():
            return dict(cached.mapping)
        await self._server_tools(definition)
        cached = self._tool_cache.get(definition.name)
        return {} if cached is None else dict(cached.mapping)

    async def _server_tools(self, definition: MCPServerDefinition) -> tuple[MCPToolDefinition, ...]:
        cache_key = _server_cache_key(definition)
        cached = self._tool_cache.get(definition.name)
        if cached and cached.config_key == cache_key and cached.expires_at > time.monotonic():
            return cached.tools

        catalog = await _list_mcp_server_tools(
            definition,
            self.timeout_seconds,
            self._client_factory,
        )
        discovered = tuple(
            MCPToolDefinition(
                public_name=_public_mcp_tool_name(
                    definition.name,
                    str(getattr(tool, "name", "tool")),
                ),
                original_name=str(getattr(tool, "name", "tool")),
                description=str(getattr(tool, "description", "") or ""),
                parameters=_tool_schema(tool),
            )
            for tool in catalog.tools
        )
        mapping = {tool.public_name: tool.original_name for tool in discovered}
        ttl_seconds = max(0.0, catalog.ttl_ms / 1000)
        self._tool_cache[definition.name] = _MCPToolCacheEntry(
            config_key=cache_key,
            tools=discovered,
            mapping=mapping,
            expires_at=time.monotonic() + ttl_seconds,
        )
        self._connection_info[definition.name] = catalog.connection
        return discovered

    def _enabled_server_definitions(self) -> dict[str, MCPServerDefinition]:
        return {
            definition.name: definition
            for definition in _load_server_definitions(self.config_path)
            if definition.enabled
        }


class MCPManager:
    def __init__(self, config_path: Path) -> None:
        self.config_path = config_path

    def list_servers(self) -> dict[str, Any]:
        return self._load_config().get("mcp_servers", {})

    def list_server_catalog(
        self,
        active_server_names: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        active = active_server_names or set()
        return [
            _server_definition_payload(definition, active=definition.name in active)
            for definition in _load_server_definitions(self.config_path)
        ]

    def catalog_message(self) -> dict[str, str] | None:
        definitions = [
            definition
            for definition in _load_server_definitions(self.config_path)
            if definition.enabled
        ]
        if not definitions:
            return None

        entries = [
            f"- {definition.name}: {definition.description or 'No description provided.'}"
            for definition in definitions
        ]
        return {
            "role": "system",
            "content": "\n".join(
                [
                    "Available MCP servers are large tool packs. Activate one only "
                    "when the request clearly needs it.",
                    f"Use {ACTIVATE_MCP_TOOL_NAME} before calling tools from a server, "
                    f"and {DEACTIVATE_MCP_TOOL_NAME} when the tool pack "
                    "is no longer needed.",
                    "Manual session MCP selection may already have activated some servers.",
                    "",
                    *entries,
                ]
            ),
        }

    def build_active_server_messages(self, active_server_names: set[str]) -> list[dict[str, str]]:
        definitions = {
            definition.name: definition
            for definition in _load_server_definitions(self.config_path)
            if definition.enabled
        }
        messages: list[dict[str, str]] = []
        for server_name in sorted(active_server_names):
            definition = definitions.get(server_name)
            if definition is None:
                continue
            messages.append(
                {
                    "role": "system",
                    "content": "\n".join(
                        [
                            f"Activated MCP server: {definition.name}",
                            f"Description: {definition.description or 'No description provided.'}",
                            "Only this server's tool schemas are currently loaded into context.",
                        ]
                    ),
                }
            )
        return messages

    def upsert_server(
        self,
        name: str,
        command: str = "",
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
        transport: str = "stdio",
        url: str = "",
        protocol: str = "auto",
        description: str = "",
        enabled: bool = True,
    ) -> dict[str, Any]:
        safe_name = ensure_tool_name(name)
        config = self._load_config()
        servers = config.setdefault("mcp_servers", {})
        servers[safe_name] = {
            "enabled": enabled,
            "description": description,
            "transport": transport,
            "protocol": protocol,
            "command": command,
            "args": args or [],
            "env": env or {},
            "url": url,
        }
        self._save_config(config)
        return servers[safe_name]

    def set_enabled(self, name: str, enabled: bool) -> dict[str, Any]:
        safe_name = ensure_tool_name(name)
        config = self._load_config()
        servers = config.setdefault("mcp_servers", {})
        if safe_name not in servers:
            msg = f"MCP server not found: {safe_name}"
            raise FileNotFoundError(msg)
        servers[safe_name]["enabled"] = enabled
        self._save_config(config)
        return servers[safe_name]

    def delete_server(self, name: str) -> None:
        safe_name = ensure_tool_name(name)
        config = self._load_config()
        servers = config.setdefault("mcp_servers", {})
        servers.pop(safe_name, None)
        self._save_config(config)

    def _load_config(self) -> dict[str, Any]:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.config_path.exists():
            self.config_path.write_text("mcp_servers: {}\n", encoding="utf-8")
        return yaml.safe_load(self.config_path.read_text(encoding="utf-8")) or {"mcp_servers": {}}

    def _save_config(self, config: dict[str, Any]) -> None:
        self.config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")


def _mcp_available() -> bool:
    try:
        import mcp  # noqa: F401
    except ImportError:
        return False
    return True


async def _list_mcp_server_tools(
    server: MCPServerDefinition,
    timeout_seconds: float,
    client_factory: MCPClientFactory,
) -> MCPToolCatalog:
    async with asyncio.timeout(timeout_seconds):
        async with client_factory(server, timeout_seconds) as client:
            result = await client.list_tools()
            ttl_ms = getattr(result, "ttl_ms", None)
            return MCPToolCatalog(
                tools=tuple(result.tools),
                ttl_ms=30_000 if ttl_ms is None else max(0, int(ttl_ms)),
                connection=_client_connection_info(client, server.transport),
            )


async def _call_mcp_server_tool(
    server: MCPServerDefinition,
    tool_name: str,
    arguments: dict[str, Any],
    timeout_seconds: float,
    client_factory: MCPClientFactory,
) -> MCPCallResponse:
    async with asyncio.timeout(timeout_seconds):
        async with client_factory(server, timeout_seconds) as client:
            result = await client.call_tool(tool_name, arguments)
            return MCPCallResponse(
                result=result,
                connection=_client_connection_info(client, server.transport),
            )


@asynccontextmanager
async def _open_mcp_client(
    server: MCPServerDefinition,
    timeout_seconds: float,
) -> AsyncIterator[Any]:
    from mcp import Client
    from mcp.client.stdio import StdioServerParameters, stdio_client
    from mcp_types import Implementation

    mode = _client_mode(server.protocol)
    target: Any
    if server.transport == "streamable_http":
        if not server.url:
            raise ValueError(f"MCP server '{server.name}' requires a URL")
        target = server.url
    elif server.transport == "stdio":
        if not server.command:
            raise ValueError(f"MCP server '{server.name}' requires a command")
        target = stdio_client(
            StdioServerParameters(
                command=server.command,
                args=list(server.args),
                env=dict(server.env),
            )
        )
    else:
        raise ValueError(f"Unsupported MCP transport: {server.transport}")

    client = Client(
        target,
        mode=mode,
        read_timeout_seconds=timeout_seconds,
        client_info=Implementation(name="anomalo", version="0.1.0"),
    )
    async with client:
        yield client


def _client_mode(protocol: str) -> str:
    normalized = protocol.strip().lower()
    if normalized in {"", "auto"}:
        return "auto"
    if normalized == "legacy":
        return "legacy"
    if normalized in {"modern", "2026-07-28"}:
        return "2026-07-28"
    raise ValueError(f"Unsupported MCP protocol mode: {protocol}")


def _client_connection_info(client: Any, transport: str) -> MCPConnectionInfo:
    from mcp_types.version import MODERN_PROTOCOL_VERSIONS

    protocol_version = str(client.protocol_version)
    return MCPConnectionInfo(
        protocol_version=protocol_version,
        protocol_era="modern" if protocol_version in MODERN_PROTOCOL_VERSIONS else "legacy",
        transport=transport,
    )


def _public_mcp_tool_name(server_name: str, original_tool_name: str) -> str:
    safe_server = ensure_tool_name(server_name)[:20]
    safe_tool = ensure_tool_name(original_tool_name)
    digest = hashlib.sha1(f"{server_name}:{original_tool_name}".encode()).hexdigest()[:8]
    suffix = f"_{digest}"
    prefix = f"mcp_{safe_server}_"
    available = max(1, 64 - len(prefix) - len(suffix))
    return ensure_tool_name(f"{prefix}{safe_tool[:available]}{suffix}")


def _tool_schema(tool: Any) -> dict[str, Any]:
    schema = getattr(tool, "inputSchema", None) or getattr(tool, "input_schema", None)
    return schema or {"type": "object", "properties": {}, "additionalProperties": True}


def _stringify_mcp_result(result: Any) -> str:
    content = getattr(result, "content", None)
    if content:
        parts = []
        for item in content:
            text = getattr(item, "text", None)
            if text:
                parts.append(text)
            else:
                parts.append(str(item))
        return "\n".join(parts)
    return str(result)


def _mcp_result_data(result: Any) -> dict[str, Any]:
    structured = getattr(result, "structured_content", None)
    meta = getattr(result, "meta", None)
    data: dict[str, Any] = {"raw": str(result)}
    if structured is not None:
        data["structured_content"] = structured
    if meta:
        data["meta"] = dict(meta)
    return data


def _load_server_definitions(config_path: Path) -> list[MCPServerDefinition]:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    if not config_path.exists():
        config_path.write_text("mcp_servers: {}\n", encoding="utf-8")
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {"mcp_servers": {}}
    servers = config.get("mcp_servers", {})
    definitions: list[MCPServerDefinition] = []
    for name, raw_server in servers.items():
        if not isinstance(raw_server, dict):
            continue
        safe_name = ensure_tool_name(str(name))
        definitions.append(
            MCPServerDefinition(
                name=safe_name,
                description=str(raw_server.get("description") or "").strip(),
                enabled=bool(raw_server.get("enabled", True)),
                transport=_normalized_transport(raw_server),
                protocol=str(raw_server.get("protocol") or "auto").strip().lower(),
                command=str(raw_server.get("command") or ""),
                args=tuple(str(arg) for arg in raw_server.get("args", [])),
                env={str(key): str(value) for key, value in raw_server.get("env", {}).items()},
                url=str(raw_server.get("url") or "").strip(),
            )
        )
    return definitions


def _server_definition_payload(
    definition: MCPServerDefinition,
    *,
    active: bool,
    error: str | None = None,
    connection: MCPConnectionInfo | None = None,
) -> dict[str, Any]:
    return {
        "name": definition.name,
        "description": definition.description,
        "enabled": definition.enabled,
        "active": active,
        "transport": definition.transport,
        "protocol": definition.protocol,
        "command": definition.command,
        "args": list(definition.args),
        "url": definition.url,
        "protocol_version": connection.protocol_version if connection else None,
        "protocol_era": connection.protocol_era if connection else None,
        "error": error,
    }


def _mcp_control_tools(definitions: list[MCPServerDefinition]) -> list[ToolSpec]:
    server_names = [definition.name for definition in definitions]
    server_choices = ", ".join(
        f"{definition.name}: {definition.description or 'No description provided.'}"
        for definition in definitions
    )
    return [
        ToolSpec(
            name=ACTIVATE_MCP_TOOL_NAME,
            source=MCP_ROUTER_SOURCE,
            description=(
                "Activate an MCP server so its tool pack is loaded into the current session. "
                f"Available servers: {server_choices}"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "server_name": {
                        "type": "string",
                        "enum": server_names,
                        "description": "Machine name of the MCP server to activate.",
                    }
                },
                "required": ["server_name"],
                "additionalProperties": False,
            },
        ),
        ToolSpec(
            name=DEACTIVATE_MCP_TOOL_NAME,
            source=MCP_ROUTER_SOURCE,
            description="Deactivate an MCP server and remove its tool pack from the session.",
            parameters={
                "type": "object",
                "properties": {
                    "server_name": {
                        "type": "string",
                        "enum": server_names,
                        "description": "Machine name of the MCP server to deactivate.",
                    }
                },
                "required": ["server_name"],
                "additionalProperties": False,
            },
        ),
    ]


def _activate_mcp_server(
    definitions: dict[str, MCPServerDefinition],
    arguments: dict[str, Any],
    context: ToolContext | None,
) -> ToolResult:
    server_name = ensure_tool_name(str(arguments.get("server_name") or ""))
    definition = definitions.get(server_name)
    if definition is None:
        return ToolResult(
            name=ACTIVATE_MCP_TOOL_NAME, ok=False, content=f"Unknown MCP server: {server_name}"
        )

    already_active = server_name in (set(context.active_mcp_servers) if context else set())
    state_text = "already active" if already_active else "activated"
    return ToolResult(
        name=ACTIVATE_MCP_TOOL_NAME,
        content=(
            f"MCP server '{definition.name}' {state_text}. "
            "Its tool pack will be loaded in the next model turn."
        ),
        data={
            "mcp_action": "activate",
            "server_name": definition.name,
            "already_active": already_active,
        },
    )


def _deactivate_mcp_server(
    definitions: dict[str, MCPServerDefinition],
    arguments: dict[str, Any],
    context: ToolContext | None,
) -> ToolResult:
    server_name = ensure_tool_name(str(arguments.get("server_name") or ""))
    definition = definitions.get(server_name)
    if definition is None:
        return ToolResult(
            name=DEACTIVATE_MCP_TOOL_NAME, ok=False, content=f"Unknown MCP server: {server_name}"
        )

    was_active = server_name in (set(context.active_mcp_servers) if context else set())
    return ToolResult(
        name=DEACTIVATE_MCP_TOOL_NAME,
        content=(
            f"MCP server '{definition.name}' {'deactivated' if was_active else 'was not active'}."
        ),
        data={
            "mcp_action": "deactivate",
            "server_name": definition.name,
            "was_active": was_active,
        },
    )


def _server_payload(definition: MCPServerDefinition) -> dict[str, Any]:
    return {
        "transport": definition.transport,
        "protocol": definition.protocol,
        "command": definition.command,
        "args": list(definition.args),
        "env": dict(definition.env),
        "url": definition.url,
    }


def _server_cache_key(definition: MCPServerDefinition) -> str:
    raw = yaml.safe_dump(_server_payload(definition), sort_keys=True)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _tool_name_matches_server(server_name: str, tool_name: str) -> bool:
    safe_server = ensure_tool_name(server_name)[:20]
    return tool_name.startswith(f"mcp_{safe_server}_")


def _normalized_transport(raw_server: dict[str, Any]) -> str:
    explicit = str(raw_server.get("transport") or "").strip().lower()
    if explicit:
        return explicit
    return "streamable_http" if raw_server.get("url") else "stdio"
