from __future__ import annotations

import hashlib
import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from buddy_backend import BuddyConnectionError

_TEXT_LIMIT = 72


class CodexRunState(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    WAITING_USER = "waiting_user"
    APPROVAL_REQUIRED = "approval_required"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class CodexRunSnapshot:
    session_id: str
    state: CodexRunState
    request_id: str | None = None
    last_order: float | None = None
    projection_delivered: bool = False


class BuddyProjectionGateway(Protocol):
    def is_connected(self) -> bool: ...

    def set_state(self, state: str, text: str | None = None) -> dict[str, Any]: ...

    def show_approval(self, request_id: str, text: str) -> dict[str, Any]: ...

    def request_approval(
        self,
        request_id: str,
        text: str,
        *,
        timeout_seconds: float = 30.0,
    ) -> dict[str, Any]: ...


class CodexProjectionError(ValueError):
    """Raised when a Codex hook event cannot be projected."""


class CodexBuddyProjection:
    """Own Codex run/approval lifecycle and project it onto Buddy presence."""

    def __init__(
        self,
        gateway: BuddyProjectionGateway,
        *,
        approval_timeout_seconds: float = 90.0,
        permission_bridge_enabled: bool = False,
    ) -> None:
        self._gateway = gateway
        self._approval_timeout_seconds = approval_timeout_seconds
        self._permission_bridge_enabled = permission_bridge_enabled
        self._runs: dict[str, CodexRunSnapshot] = {}
        self._lock = threading.RLock()

    def handle_event(self, event_name: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        normalized = _normalize_event_name(event_name)
        session_id = _session_id(payload)
        order = _event_order(payload)
        if not self._accept_event(session_id, order):
            return {}

        if normalized == "userPromptSubmitted":
            prompt = _compact_text(_string_value(payload, "prompt"), fallback="working")
            return self._transition(session_id, CodexRunState.RUNNING, prompt, order=order)
        if normalized == "preToolUse":
            return self._handle_pre_tool_use(session_id, payload, order)
        if normalized == "postToolUse":
            return self._handle_post_tool_use(session_id, payload, order)
        if normalized == "permissionRequest":
            return self._handle_permission_request(session_id, payload, order)
        if normalized == "notification":
            return self._handle_notification(session_id, payload, order)
        if normalized == "agentStop":
            return self._handle_agent_stop(session_id, payload, order)
        if normalized == "sessionEnd":
            return self._handle_session_end(session_id, payload, order)
        if normalized == "errorOccurred":
            message = _compact_text(
                _string_value(payload, "error.message", "error", "message"),
                fallback="agent error",
            )
            return self._transition(session_id, CodexRunState.FAILED, message, order=order)
        raise CodexProjectionError(f"Unsupported Codex hook event: {event_name}")

    def snapshot(self, session_id: str) -> CodexRunSnapshot:
        with self._lock:
            return self._runs.get(
                session_id,
                CodexRunSnapshot(session_id=session_id, state=CodexRunState.IDLE),
            )

    def _handle_pre_tool_use(
        self,
        session_id: str,
        payload: Mapping[str, Any],
        order: float | None,
    ) -> dict[str, Any]:
        tool_name = _string_value(payload, "toolName", "tool_name")
        if not tool_name:
            return {}
        detail = _tool_detail(payload)
        text = f"{tool_name}: {detail}" if detail else tool_name
        return self._transition(
            session_id,
            CodexRunState.RUNNING,
            _compact_text(text, fallback=tool_name),
            order=order,
        )

    def _handle_post_tool_use(
        self,
        session_id: str,
        payload: Mapping[str, Any],
        order: float | None,
    ) -> dict[str, Any]:
        tool_name = _string_value(payload, "toolName", "tool_name")
        text = f"{tool_name} complete" if tool_name else "continuing"
        return self._transition(session_id, CodexRunState.RUNNING, text, order=order)

    def _handle_permission_request(
        self,
        session_id: str,
        payload: Mapping[str, Any],
        order: float | None,
    ) -> dict[str, Any]:
        prompt = _permission_prompt(payload)
        request_id = _request_id(payload, prompt)
        if not self._permission_bridge_enabled:
            if _requires_user_action(payload):
                return self._show_approval(session_id, request_id, prompt, order)
            return self._transition(
                session_id,
                CodexRunState.RUNNING,
                "continuing",
                order=order,
            )
        if not self._gateway.is_connected():
            return {}

        self._record(
            session_id,
            CodexRunState.APPROVAL_REQUIRED,
            request_id=request_id,
            order=order,
        )
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
            self._transition(session_id, CodexRunState.RUNNING, "continuing", order=order)
            return {"behavior": "allow"}
        if choice == "deny":
            self._transition(session_id, CodexRunState.CANCELLED, "denied", order=order)
            return {
                "behavior": "deny",
                "message": "Buddy denied the permission request.",
            }
        self._transition(session_id, CodexRunState.RUNNING, "approval expired", order=order)
        return {}

    def _handle_notification(
        self,
        session_id: str,
        payload: Mapping[str, Any],
        order: float | None,
    ) -> dict[str, Any]:
        notification_type = _string_value(
            payload,
            "notification_type",
            "notificationType",
        ).lower()
        text = _compact_text(
            _string_value(payload, "title", "message"),
            fallback="waiting for input",
        )
        if notification_type == "permission_prompt":
            if not _requires_user_action(payload):
                return self._transition(
                    session_id,
                    CodexRunState.RUNNING,
                    "continuing",
                    order=order,
                )
            request_id = _request_id(payload, text or "approval needed")
            return self._show_approval(
                session_id,
                request_id,
                text or "approval needed",
                order,
            )
        if notification_type in {
            "idle_prompt",
            "user_input",
            "user_input_required",
            "waiting_user",
        }:
            return self._transition(
                session_id,
                CodexRunState.WAITING_USER,
                text,
                order=order,
            )
        return {}

    def _handle_agent_stop(
        self,
        session_id: str,
        payload: Mapping[str, Any],
        order: float | None,
    ) -> dict[str, Any]:
        reason = _string_value(payload, "reason").lower().replace("_", " ")
        if reason in {"cancelled", "canceled", "aborted", "user exit"}:
            return self._transition(
                session_id,
                CodexRunState.CANCELLED,
                _compact_text(reason, fallback="cancelled"),
                order=order,
            )
        return self._transition(
            session_id,
            CodexRunState.SUCCEEDED,
            "reply ready",
            order=order,
        )

    def _handle_session_end(
        self,
        session_id: str,
        payload: Mapping[str, Any],
        order: float | None,
    ) -> dict[str, Any]:
        reason = _string_value(payload, "reason").replace("_", " ")
        if reason == "error":
            return self._transition(
                session_id,
                CodexRunState.FAILED,
                "session error",
                order=order,
            )
        return self._transition(
            session_id,
            CodexRunState.IDLE,
            _compact_text(reason, fallback="idle"),
            order=order,
        )

    def _show_approval(
        self,
        session_id: str,
        request_id: str,
        text: str,
        order: float | None,
    ) -> dict[str, Any]:
        current = self.snapshot(session_id)
        if (
            current.state is CodexRunState.APPROVAL_REQUIRED
            and current.request_id == request_id
            and current.projection_delivered
        ):
            return {}
        self._record(
            session_id,
            CodexRunState.APPROVAL_REQUIRED,
            request_id=request_id,
            order=order,
            projection_delivered=False,
        )
        try:
            self._gateway.show_approval(request_id, text)
        except BuddyConnectionError:
            return {}
        self._record(
            session_id,
            CodexRunState.APPROVAL_REQUIRED,
            request_id=request_id,
            order=order,
            projection_delivered=True,
        )
        return {}

    def _transition(
        self,
        session_id: str,
        state: CodexRunState,
        text: str | None,
        *,
        order: float | None,
    ) -> dict[str, Any]:
        buddy_state = {
            CodexRunState.IDLE: "idle",
            CodexRunState.RUNNING: "coding",
            CodexRunState.WAITING_USER: "waiting_user",
            CodexRunState.SUCCEEDED: "done",
            CodexRunState.FAILED: "error",
            CodexRunState.CANCELLED: "idle",
        }.get(state)
        if buddy_state is None:
            raise CodexProjectionError(f"No Buddy projection for Codex state: {state}")
        self._record(
            session_id,
            state,
            order=order,
            projection_delivered=False,
        )
        try:
            self._gateway.set_state(buddy_state, text)
        except BuddyConnectionError:
            return {}
        self._record(
            session_id,
            state,
            order=order,
            projection_delivered=True,
        )
        return {}

    def _record(
        self,
        session_id: str,
        state: CodexRunState,
        *,
        request_id: str | None = None,
        order: float | None,
        projection_delivered: bool = False,
    ) -> None:
        with self._lock:
            previous = self._runs.get(session_id)
            self._runs[session_id] = CodexRunSnapshot(
                session_id=session_id,
                state=state,
                request_id=request_id,
                projection_delivered=projection_delivered,
                last_order=(
                    order if order is not None else (previous.last_order if previous else None)
                ),
            )

    def _accept_event(self, session_id: str, order: float | None) -> bool:
        if order is None:
            return True
        with self._lock:
            previous = self._runs.get(session_id)
            return previous is None or previous.last_order is None or order >= previous.last_order


def _normalize_event_name(event_name: str) -> str:
    normalized = event_name.strip()
    alias = {
        "UserPromptSubmit": "userPromptSubmitted",
        "PreToolUse": "preToolUse",
        "PostToolUse": "postToolUse",
        "PermissionRequest": "permissionRequest",
        "Notification": "notification",
        "Stop": "agentStop",
        "SessionEnd": "sessionEnd",
        "ErrorOccurred": "errorOccurred",
    }.get(normalized)
    return alias or normalized


def _session_id(payload: Mapping[str, Any]) -> str:
    return _slugify(
        _string_value(
            payload,
            "sessionId",
            "session_id",
            "threadId",
            "thread_id",
            fallback="codex",
        ),
        fallback="codex",
    )


def _event_order(payload: Mapping[str, Any]) -> float | None:
    raw = _value(payload, "sequence", "seq", "timestamp")
    if isinstance(raw, int | float):
        return float(raw)
    if isinstance(raw, str):
        try:
            return float(raw)
        except ValueError:
            return None
    return None


def _requires_user_action(payload: Mapping[str, Any]) -> bool:
    explicit = _value(
        payload,
        "requiresUserAction",
        "requires_user_action",
        "permissionRequest.requiresUserAction",
        "permission_request.requires_user_action",
    )
    if isinstance(explicit, bool):
        return explicit
    if isinstance(explicit, str):
        return explicit.strip().lower() in {"1", "true", "yes", "required"}

    status = _string_value(
        payload,
        "approval.status",
        "permissionRequest.status",
        "permission_request.status",
        "status",
    ).lower()
    return status in {"pending_user", "requires_user_action", "waiting_user"}


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
    explicit = _string_value(
        payload,
        "requestId",
        "request_id",
        "approval.request_id",
        "permissionRequest.id",
    )
    if explicit:
        return _slugify(explicit)
    session_id = _string_value(payload, "sessionId", "session_id", fallback="codex")
    timestamp = _string_value(payload, "timestamp")
    digest = hashlib.sha1(f"{session_id}:{timestamp}:{prompt}".encode()).hexdigest()[:10]
    return f"{_slugify(session_id, fallback='codex')}-{digest}"


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
    normalized = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip("-.")
    return normalized[:64] or fallback
