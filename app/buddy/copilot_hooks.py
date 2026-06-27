from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from typing import Any

from app.buddy import BuddyConnectionError, BuddyGateway

_TEXT_LIMIT = 72


class CopilotHookError(ValueError):
    """Raised when a Copilot hook payload cannot be handled."""


class CopilotHookService:
    def __init__(
        self,
        gateway: BuddyGateway,
        *,
        approval_timeout_seconds: float = 90.0,
        permission_bridge_enabled: bool = False,
    ) -> None:
        self._gateway = gateway
        self._approval_timeout_seconds = approval_timeout_seconds
        self._permission_bridge_enabled = permission_bridge_enabled

    def handle_event(self, event_name: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        normalized = _normalize_event_name(event_name)
        if normalized == "userPromptSubmitted":
            return self._handle_user_prompt_submitted(payload)
        if normalized == "preToolUse":
            return self._handle_pre_tool_use(payload)
        if normalized == "permissionRequest":
            return self._handle_permission_request(payload)
        if normalized == "notification":
            return self._handle_notification(payload)
        if normalized == "agentStop":
            return self._set_state("done", "reply ready")
        if normalized == "sessionEnd":
            return self._handle_session_end(payload)
        if normalized == "errorOccurred":
            return self._handle_error_occurred(payload)
        raise CopilotHookError(f"Unsupported Copilot hook event: {event_name}")

    def _handle_user_prompt_submitted(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        prompt = _compact_text(_string_value(payload, "prompt"), fallback="working")
        return self._set_state("coding", prompt)

    def _handle_pre_tool_use(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        tool_name = _string_value(payload, "toolName", "tool_name")
        if not tool_name:
            return {}
        detail = _tool_detail(payload)
        text = f"{tool_name}: {detail}" if detail else tool_name
        return self._set_state("coding", _compact_text(text, fallback=tool_name))

    def _handle_permission_request(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not self._permission_bridge_enabled:
            return {}
        if not self._gateway.is_connected():
            return {}

        prompt = _permission_prompt(payload)
        request_id = _request_id(payload, prompt)
        try:
            response = self._gateway.request_approval(
                request_id,
                prompt,
                timeout_seconds=self._approval_timeout_seconds,
            )
        except BuddyConnectionError:
            return {}

        choice = _string_value(response, "payload.choice", "choice").lower()
        if choice == "approve":
            self._set_state("coding", "continuing")
            return {"behavior": "allow"}
        if choice == "deny":
            self._set_state("done", "denied")
            return {
                "behavior": "deny",
                "message": "Buddy denied the permission request.",
            }
        return {}

    def _handle_notification(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        notification_type = _string_value(
            payload,
            "notification_type",
            "notificationType",
        )
        if notification_type != "permission_prompt":
            return {}

        text = _compact_text(
            _string_value(payload, "title", "message"),
            fallback="approval needed",
        )
        return self._set_state("approval", text)

    def _handle_session_end(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        reason = _string_value(payload, "reason").replace("_", " ")
        if reason == "error":
            return self._set_state("error", "session error")
        return self._set_state("idle", _compact_text(reason, fallback="idle"))

    def _handle_error_occurred(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        message = _compact_text(
            _string_value(payload, "error.message", "error", "message"),
            fallback="agent error",
        )
        return self._set_state("error", message)

    def _set_state(self, state: str, text: str | None = None) -> dict[str, Any]:
        try:
            self._gateway.set_state(state, text)
        except BuddyConnectionError:
            return {}
        return {}


def _normalize_event_name(event_name: str) -> str:
    normalized = event_name.strip()
    alias = {
        "UserPromptSubmit": "userPromptSubmitted",
        "PreToolUse": "preToolUse",
        "PermissionRequest": "permissionRequest",
        "Notification": "notification",
        "Stop": "agentStop",
        "SessionEnd": "sessionEnd",
        "ErrorOccurred": "errorOccurred",
    }.get(normalized)
    return alias or normalized


def _permission_prompt(payload: Mapping[str, Any]) -> str:
    tool_name = _string_value(payload, "toolName", "tool_name", fallback="tool")
    detail = _tool_detail(payload)
    prefix = f"Allow {tool_name}"
    if detail:
        return _compact_text(f"{prefix}: {detail}", fallback=prefix) or prefix
    permission_kind = _string_value(
        payload,
        "permissionRequest.kind",
        "permission_request.kind",
    )
    if permission_kind:
        return _compact_text(f"{prefix} ({permission_kind})", fallback=prefix) or prefix
    return prefix


def _tool_detail(payload: Mapping[str, Any]) -> str:
    tool_args = _value(payload, "toolArgs", "tool_input", "permissionRequest.toolArgs")
    if isinstance(tool_args, Mapping):
        return _string_value(
            tool_args,
            "command",
            "path",
            "pattern",
            "description",
            "url",
            "prompt",
        )
    if tool_args is not None:
        return _stringify(tool_args)
    return ""


def _request_id(payload: Mapping[str, Any], prompt: str) -> str:
    explicit = _string_value(payload, "requestId", "request_id")
    if explicit:
        return _slugify(explicit)

    session_id = _string_value(payload, "sessionId", "session_id", fallback="copilot")
    timestamp = _string_value(payload, "timestamp")
    digest = hashlib.sha1(f"{session_id}:{timestamp}:{prompt}".encode()).hexdigest()[:10]
    return f"{_slugify(session_id, fallback='copilot')}-{digest}"


def _value(payload: Mapping[str, Any], *paths: str) -> Any:
    for path in paths:
        current: Any = payload
        found = True
        for part in path.split("."):
            if not isinstance(current, Mapping) or part not in current:
                found = False
                break
            current = current[part]
        if found and current is not None:
            return current
    return None


def _string_value(payload: Mapping[str, Any], *paths: str, fallback: str = "") -> str:
    value = _value(payload, *paths)
    if value is None:
        return fallback
    return _stringify(value)


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return " ".join(value.split())
    return " ".join(str(value).split())


def _compact_text(
    text: str | None,
    *,
    fallback: str | None = None,
    limit: int = _TEXT_LIMIT,
) -> str | None:
    normalized = _stringify(text or fallback or "")
    if not normalized:
        return None
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 3].rstrip()}..."


def _slugify(value: str, *, fallback: str = "request") -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-").lower()
    return normalized[:40] or fallback
