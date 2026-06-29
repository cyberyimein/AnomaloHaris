from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.tools.base import ToolContext, ToolProvider, ToolResult, ToolSpec


class CoreToolProvider(ToolProvider):
    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        return [
            ToolSpec(
                name="core_get_time",
                description="Get the current time for a timezone.",
                source="core",
                parameters={
                    "type": "object",
                    "properties": {
                        "timezone": {
                            "type": "string",
                            "description": "IANA timezone name, e.g. Asia/Tokyo or UTC.",
                            "default": "Asia/Tokyo",
                        }
                    },
                    "required": [],
                    "additionalProperties": False,
                },
            ),
            ToolSpec(
                name="core_echo",
                description="Echo a short diagnostic message. Useful for testing tools.",
                source="core",
                parameters={
                    "type": "object",
                    "properties": {
                        "message": {"type": "string", "description": "Message to echo."}
                    },
                    "required": ["message"],
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
        if name == "core_get_time":
            timezone = arguments.get("timezone") or "Asia/Tokyo"
            now = datetime.now(ZoneInfo(timezone))
            return ToolResult(
                name=name,
                content=now.isoformat(),
                data={"timezone": timezone, "iso": now.isoformat()},
            )

        if name == "core_echo":
            message = str(arguments.get("message", ""))
            return ToolResult(name=name, content=message, data={"message": message})

        return ToolResult(name=name, ok=False, content=f"Unknown core tool: {name}")

