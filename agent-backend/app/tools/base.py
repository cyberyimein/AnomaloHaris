"""Compatibility re-export for the host-independent ToolProvider seam."""

from buddy_backend.tooling import (
    TOOL_NAME_PATTERN,
    ToolContext,
    ToolProvider,
    ToolResult,
    ToolSpec,
    call_maybe_async,
    ensure_tool_name,
)

__all__ = [
    "TOOL_NAME_PATTERN",
    "ToolContext",
    "ToolProvider",
    "ToolResult",
    "ToolSpec",
    "call_maybe_async",
    "ensure_tool_name",
]
