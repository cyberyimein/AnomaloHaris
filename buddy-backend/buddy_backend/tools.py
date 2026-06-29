from typing import Any

from app.tools.base import ToolContext, ToolProvider, ToolResult, ToolSpec

from buddy_backend import BuddyConfigurationError, BuddyConnectionError, BuddyGateway


class BuddyToolProvider(ToolProvider):
    def __init__(self, gateway: BuddyGateway) -> None:
        self.gateway = gateway

    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        del context
        return [
            ToolSpec(
                name="buddy_set_state",
                description="Update Buddy visual state over the Call Buddy protocol.",
                source="buddy",
                parameters={
                    "type": "object",
                    "properties": {
                        "state": {
                            "type": "string",
                            "enum": [
                                "connect",
                                "disconnect",
                                "idle",
                                "listening",
                                "thinking",
                                "speaking",
                                "stop",
                                "error",
                                "coding",
                                "done",
                            ],
                        },
                        "text": {"type": "string"},
                    },
                    "required": ["state"],
                    "additionalProperties": False,
                },
            ),
            ToolSpec(
                name="buddy_set_text",
                description="Set Buddy bottom status text without changing the visual state.",
                source="buddy",
                parameters={
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": False,
                },
            ),
            ToolSpec(
                name="buddy_request_approval",
                description=(
                    "Show an approval request on Buddy and wait for the tap/swipe response."
                ),
                source="buddy",
                parameters={
                    "type": "object",
                    "properties": {
                        "request_id": {"type": "string"},
                        "text": {"type": "string"},
                        "timeout_seconds": {"type": "number", "default": 30.0},
                    },
                    "required": ["request_id", "text"],
                    "additionalProperties": False,
                },
            ),
            ToolSpec(
                name="buddy_look",
                description="Move Buddy servos to a specific yaw/pitch/speed.",
                source="buddy",
                parameters={
                    "type": "object",
                    "properties": {
                        "yaw": {"type": "integer"},
                        "pitch": {"type": "integer"},
                        "speed": {"type": "integer"},
                    },
                    "required": ["yaw", "pitch"],
                    "additionalProperties": False,
                },
            ),
            ToolSpec(
                name="buddy_set_led",
                description="Set Buddy LED color for a short duration.",
                source="buddy",
                parameters={
                    "type": "object",
                    "properties": {
                        "r": {"type": "integer"},
                        "g": {"type": "integer"},
                        "b": {"type": "integer"},
                        "ms": {"type": "integer"},
                    },
                    "required": ["r", "g", "b"],
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
        del context
        try:
            if name == "buddy_set_state":
                text = (
                    str(arguments["text"])
                    if "text" in arguments and arguments["text"] is not None
                    else None
                )
                result = self.gateway.set_state(
                    str(arguments.get("state") or ""),
                    text,
                )
                return ToolResult(
                    name=name,
                    content=f"Buddy state updated to {arguments.get('state')}.",
                    data=result,
                )

            if name == "buddy_set_text":
                result = self.gateway.set_text(str(arguments.get("text") or ""))
                return ToolResult(name=name, content="Buddy text updated.", data=result)

            if name == "buddy_request_approval":
                result = self.gateway.request_approval(
                    str(arguments.get("request_id") or ""),
                    str(arguments.get("text") or ""),
                    timeout_seconds=float(arguments.get("timeout_seconds") or 30.0),
                )
                choice = result.get("payload", {}).get("choice")
                return ToolResult(
                    name=name,
                    content=f"Buddy approval response: {choice}",
                    data=result,
                )

            if name == "buddy_look":
                speed = (
                    int(arguments["speed"])
                    if "speed" in arguments and arguments["speed"] is not None
                    else None
                )
                result = self.gateway.look(
                    int(arguments.get("yaw") or 0),
                    int(arguments.get("pitch") or 0),
                    speed,
                )
                return ToolResult(name=name, content="Buddy moved.", data=result)

            if name == "buddy_set_led":
                duration_ms = (
                    int(arguments["ms"])
                    if "ms" in arguments and arguments["ms"] is not None
                    else None
                )
                result = self.gateway.set_led(
                    int(arguments.get("r") or 0),
                    int(arguments.get("g") or 0),
                    int(arguments.get("b") or 0),
                    duration_ms,
                )
                return ToolResult(name=name, content="Buddy LED updated.", data=result)
        except (BuddyConfigurationError, BuddyConnectionError, ValueError) as exc:
            return ToolResult(name=name, ok=False, content=str(exc))

        return ToolResult(name=name, ok=False, content=f"Unknown buddy tool: {name}")
