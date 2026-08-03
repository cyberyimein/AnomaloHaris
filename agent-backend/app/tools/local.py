import json
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

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
            ToolSpec(
                name="core_convert_time",
                description=(
                    "Convert an ISO 8601 date-time between timezones deterministically. "
                    "Use this instead of Python for timezone or UTC conversion."
                ),
                source="core",
                parameters={
                    "type": "object",
                    "properties": {
                        "datetime": {
                            "type": "string",
                            "description": (
                                "ISO 8601 date-time. Include an offset, or provide "
                                "from_timezone for a local time."
                            ),
                        },
                        "from_timezone": {
                            "type": "string",
                            "description": (
                                "IANA timezone for an input without an offset, such as "
                                "America/New_York. Not needed when datetime has an offset."
                            ),
                        },
                        "to_timezone": {
                            "type": "string",
                            "description": "Target IANA timezone, such as UTC or Asia/Tokyo.",
                            "default": "UTC",
                        },
                        "fold": {
                            "type": "integer",
                            "description": (
                                "For an ambiguous local time at the end of daylight saving "
                                "time, use 0 for the first occurrence or 1 for the second."
                            ),
                            "minimum": 0,
                            "maximum": 1,
                            "default": 0,
                        },
                    },
                    "required": ["datetime"],
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

        if name == "core_convert_time":
            return _convert_time(arguments)

        return ToolResult(name=name, ok=False, content=f"Unknown core tool: {name}")


def _convert_time(arguments: dict[str, Any]) -> ToolResult:
    name = "core_convert_time"
    raw_datetime = str(arguments.get("datetime") or "").strip()
    if not raw_datetime:
        return ToolResult(name=name, ok=False, content="datetime is required")

    try:
        parsed = datetime.fromisoformat(raw_datetime.replace("Z", "+00:00"))
    except ValueError:
        return ToolResult(
            name=name,
            ok=False,
            content="datetime must be a valid ISO 8601 date-time",
        )

    target_name = str(arguments.get("to_timezone") or "UTC").strip()
    try:
        target_timezone = ZoneInfo(target_name)
    except (ZoneInfoNotFoundError, ValueError):
        return ToolResult(
            name=name,
            ok=False,
            content=f"Unknown target timezone: {target_name}",
        )

    source_name = str(arguments.get("from_timezone") or "").strip()
    try:
        fold = int(arguments.get("fold") or 0)
    except (TypeError, ValueError):
        return ToolResult(name=name, ok=False, content="fold must be 0 or 1")
    if fold not in {0, 1}:
        return ToolResult(name=name, ok=False, content="fold must be 0 or 1")

    if parsed.tzinfo is None:
        if not source_name:
            return ToolResult(
                name=name,
                ok=False,
                content="from_timezone is required when datetime has no UTC offset",
            )
        try:
            source_timezone = ZoneInfo(source_name)
        except (ZoneInfoNotFoundError, ValueError):
            return ToolResult(
                name=name,
                ok=False,
                content=f"Unknown source timezone: {source_name}",
            )
        source = parsed.replace(tzinfo=source_timezone, fold=fold)
        round_trip = source.astimezone(UTC).astimezone(source_timezone)
        if round_trip.replace(tzinfo=None) != parsed:
            return ToolResult(
                name=name,
                ok=False,
                content=(
                    f"Local time {raw_datetime} does not exist in {source_name} "
                    "because of a timezone offset transition"
                ),
            )
        resolved_source_name = source_name
    else:
        source = parsed
        resolved_source_name = str(parsed.tzinfo)

    converted = source.astimezone(target_timezone)
    utc_value = source.astimezone(UTC)
    data = {
        "input": raw_datetime,
        "source_timezone": resolved_source_name,
        "target_timezone": target_name,
        "source_iso": source.isoformat(),
        "converted_iso": converted.isoformat(),
        "utc_iso": utc_value.isoformat(),
        "unix_timestamp": source.timestamp(),
        "fold": source.fold,
    }
    return ToolResult(
        name=name,
        content=json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        data=data,
    )
