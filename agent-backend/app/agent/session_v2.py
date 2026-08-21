"""SQLite Session v2 adapter.

The v2 store keeps the conversation as an append-only entry chain and stores
run checkpoints separately.  The public methods intentionally mirror
``SessionStore`` so the Python runtime can switch schemas without changing
API handlers.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.agent.session import RESUME_PROMPT_MARKER, SessionCheckpoint
from app.search_modes import DEFAULT_SEARCH_MODE, SearchMode, normalize_search_mode

SESSION_V2_SCHEMA_VERSION = 2

SESSION_V2_SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled conversation',
  search_mode TEXT NOT NULL DEFAULT 'diy',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  active_leaf_entry_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_entries (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  parent_entry_id TEXT REFERENCES session_entries(entry_id) ON DELETE SET NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'compaction', 'system', 'event')),
  role TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_resources (
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  active_skills_json TEXT NOT NULL DEFAULT '[]',
  active_mcp_servers_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS session_web_traces (
  trace_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  run_id TEXT,
  tool_call_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished', 'error', 'stopped')),
  start_entry_id TEXT,
  last_entry_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS run_checkpoints (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_entries_session_created
  ON session_entries(session_id, created_at, entry_id);
CREATE INDEX IF NOT EXISTS idx_session_entries_parent
  ON session_entries(parent_entry_id);
CREATE INDEX IF NOT EXISTS idx_session_runs_session_started
  ON session_runs(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_checkpoints_session
  ON run_checkpoints(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_web_traces_session_created
  ON session_web_traces(session_id, created_at DESC);
"""


class SessionV2Store:
    """Persistent v2 session store with lazy migration from the v1 table."""

    def __init__(
        self,
        db_path: str | Path = ":memory:",
        *,
        default_search_mode: str = DEFAULT_SEARCH_MODE,
    ) -> None:
        self.db_path = str(db_path)
        self.default_search_mode: SearchMode = normalize_search_mode(default_search_mode)
        if self.db_path != ":memory:":
            Path(self.db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)

        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA busy_timeout = 5000")
        self._connection.execute("PRAGMA foreign_keys = ON")
        if self.db_path != ":memory:":
            self._connection.execute("PRAGMA journal_mode = DELETE")
        self._initialize_schema()

    def _initialize_schema(self) -> None:
        self._connection.executescript(SESSION_V2_SCHEMA)
        self._connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (SESSION_V2_SCHEMA_VERSION, _now()),
        )
        self._connection.commit()

    def _ensure_session(self, session_id: str) -> None:
        row = self._connection.execute(
            "SELECT session_id FROM agent_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            self._migrate_legacy_session(session_id)
            row = self._connection.execute(
                "SELECT session_id FROM agent_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            now = _now()
            self._connection.execute(
                "INSERT INTO agent_sessions(session_id, created_at, updated_at) VALUES (?, ?, ?)",
                (session_id, now, now),
            )
        self._connection.execute(
            "INSERT OR IGNORE INTO session_resources(session_id) VALUES (?)",
            (session_id,),
        )
        self._connection.commit()

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT session_id, title, search_mode, updated_at,
                       EXISTS(
                           SELECT 1 FROM run_checkpoints c
                           WHERE c.session_id = agent_sessions.session_id
                       ) AS can_resume,
                       active_leaf_entry_id
                FROM agent_sessions
                ORDER BY updated_at DESC
                """
            ).fetchall()
            summaries: list[dict[str, Any]] = []
            for row in rows:
                messages = self._message_chain(row["session_id"], row["active_leaf_entry_id"])
                count = len(_visible_session_messages(messages))
                if count <= 0:
                    continue
                summaries.append(
                    {
                        "session_id": row["session_id"],
                        "title": row["title"] or "Untitled conversation",
                        "message_count": count,
                        "updated_at": row["updated_at"],
                        "can_resume": bool(row["can_resume"]),
                    }
                )
            return summaries

    def get_session_snapshot(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT session_id, search_mode, updated_at, active_leaf_entry_id
                FROM agent_sessions WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                legacy = self._connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"
                ).fetchone()
                if legacy is None:
                    return None
                legacy_row = self._connection.execute(
                    "SELECT 1 FROM sessions WHERE session_id = ?", (session_id,)
                ).fetchone()
                if legacy_row is None:
                    return None
                self._ensure_session(session_id)
                row = self._connection.execute(
                    """
                    SELECT session_id, search_mode, updated_at, active_leaf_entry_id
                    FROM agent_sessions WHERE session_id = ?
                    """,
                    (session_id,),
                ).fetchone()
            checkpoint = self.get_checkpoint(session_id)
            messages = checkpoint.messages if checkpoint is not None else self._message_chain(
                session_id, row["active_leaf_entry_id"]
            )
            return {
                "session_id": session_id,
                "messages": deepcopy(messages),
                "updated_at": row["updated_at"],
                "can_resume": checkpoint is not None,
                "search_mode": normalize_search_mode(row["search_mode"] or self.default_search_mode),
            }

    def get_search_mode(self, session_id: str) -> SearchMode:
        with self._lock:
            self._ensure_session(session_id)
            row = self._connection.execute(
                "SELECT search_mode FROM agent_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
            return normalize_search_mode(row["search_mode"] or self.default_search_mode)

    def set_search_mode(self, session_id: str, mode: str) -> SearchMode:
        normalized = normalize_search_mode(mode)
        with self._lock:
            self._ensure_session(session_id)
            self._touch_session(session_id, search_mode=normalized)
            return normalized

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_session(session_id)
            row = self._session_row(session_id)
            return deepcopy(self._message_chain(session_id, row["active_leaf_entry_id"]))

    def append(self, session_id: str, message: dict[str, Any]) -> None:
        self.append_many(session_id, [message])

    def append_many(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        if not messages:
            return
        with self._lock, self._connection:
            self._ensure_session(session_id)
            parent = self._session_row(session_id)["active_leaf_entry_id"]
            for message in messages:
                entry_id = f"entry-{uuid4().hex}"
                role = message.get("role")
                created_at = _now()
                self._connection.execute(
                    """
                    INSERT INTO session_entries(
                        entry_id, session_id, parent_entry_id, kind, role, payload_json, created_at
                    ) VALUES (?, ?, ?, 'message', ?, ?, ?)
                    """,
                    (
                        entry_id,
                        session_id,
                        parent,
                        str(role) if isinstance(role, str) else None,
                        _json(message),
                        created_at,
                    ),
                )
                parent = entry_id
                if role == "user" and str(message.get("content") or "").strip():
                    self._connection.execute(
                        """
                        UPDATE agent_sessions
                        SET title = CASE
                            WHEN title = 'Untitled conversation' THEN substr(trim(?), 1, 120)
                            ELSE title
                        END
                        WHERE session_id = ?
                        """,
                        (str(message["content"]), session_id),
                    )
            self._touch_session(session_id, active_leaf_entry_id=parent)

    def get_active_skills(self, session_id: str) -> set[str]:
        with self._lock:
            self._ensure_session(session_id)
            row = self._connection.execute(
                "SELECT active_skills_json FROM session_resources WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            return set(_string_list(row["active_skills_json"] if row else "[]"))

    def set_active_skills(self, session_id: str, skill_names: list[str] | set[str]) -> None:
        with self._lock:
            self._ensure_session(session_id)
            self._connection.execute(
                "UPDATE session_resources SET active_skills_json = ? WHERE session_id = ?",
                (_json(sorted({str(value) for value in skill_names})), session_id),
            )
            self._connection.commit()

    def activate_skill(self, session_id: str, skill_name: str) -> None:
        self.set_active_skills(session_id, self.get_active_skills(session_id) | {str(skill_name)})

    def deactivate_skill(self, session_id: str, skill_name: str) -> None:
        self.set_active_skills(session_id, self.get_active_skills(session_id) - {str(skill_name)})

    def get_active_mcp_servers(self, session_id: str) -> set[str]:
        with self._lock:
            self._ensure_session(session_id)
            row = self._connection.execute(
                "SELECT active_mcp_servers_json FROM session_resources WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            return set(_string_list(row["active_mcp_servers_json"] if row else "[]"))

    def set_active_mcp_servers(self, session_id: str, server_names: list[str] | set[str]) -> None:
        with self._lock:
            self._ensure_session(session_id)
            self._connection.execute(
                "UPDATE session_resources SET active_mcp_servers_json = ? WHERE session_id = ?",
                (_json(sorted({str(value) for value in server_names})), session_id),
            )
            self._connection.commit()

    def activate_mcp_server(self, session_id: str, server_name: str) -> None:
        self.set_active_mcp_servers(session_id, self.get_active_mcp_servers(session_id) | {str(server_name)})

    def deactivate_mcp_server(self, session_id: str, server_name: str) -> None:
        self.set_active_mcp_servers(session_id, self.get_active_mcp_servers(session_id) - {str(server_name)})

    def replace(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            self._ensure_session(session_id)
            with self._connection:
                self._connection.execute(
                    "DELETE FROM session_entries WHERE session_id = ?", (session_id,)
                )
                self._connection.execute(
                    "UPDATE agent_sessions SET active_leaf_entry_id = NULL WHERE session_id = ?",
                    (session_id,),
                )
            self.append_many(session_id, deepcopy(messages))

    def save_checkpoint(
        self,
        session_id: str,
        messages: list[dict[str, Any]],
        *,
        run_id: str,
        prompt_profile: str,
        user_content: str,
        iteration: int,
        reason: str = "stopped",
        response_format: dict[str, Any] | None = None,
        bootstrap_context: list[dict[str, Any]] | None = None,
    ) -> None:
        with self._lock:
            self._ensure_session(session_id)
            now = _now()
            state = {
                "messages": deepcopy(messages),
                "prompt_profile": prompt_profile,
                "user_content": user_content,
                "bootstrap_context": deepcopy(bootstrap_context or []),
                **({"response_format": deepcopy(response_format)} if response_format is not None else {}),
            }
            with self._connection:
                self._connection.execute(
                    """
                    INSERT INTO session_runs(run_id, session_id, status, last_entry_id, config_json, started_at)
                    VALUES (?, ?, 'paused', (SELECT active_leaf_entry_id FROM agent_sessions WHERE session_id = ?), '{}', ?)
                    ON CONFLICT(run_id) DO UPDATE SET status = 'paused'
                    """,
                    (run_id, session_id, session_id, now),
                )
                self._connection.execute(
                    """
                    INSERT INTO run_checkpoints(
                        run_id, session_id, reason, iteration, state_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(run_id) DO UPDATE SET
                        reason = excluded.reason,
                        iteration = excluded.iteration,
                        state_json = excluded.state_json,
                        updated_at = excluded.updated_at
                    """,
                    (run_id, session_id, reason, iteration, _json(state), now, now),
                )
                self._touch_session(session_id)

    def get_checkpoint(self, session_id: str) -> SessionCheckpoint | None:
        with self._lock:
            self._ensure_session(session_id)
            row = self._connection.execute(
                """
                SELECT run_id, session_id, reason, iteration, state_json, created_at, updated_at
                FROM run_checkpoints WHERE session_id = ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (session_id,),
            ).fetchone()
            return _checkpoint_from_row(row) if row is not None else None

    def restore_checkpoint(self, session_id: str) -> SessionCheckpoint | None:
        with self._lock:
            checkpoint = self.get_checkpoint(session_id)
            if checkpoint is None:
                return None
            self.replace(session_id, checkpoint.messages)
            with self._connection:
                self._connection.execute(
                    "DELETE FROM run_checkpoints WHERE session_id = ?", (session_id,)
                )
            return checkpoint

    def has_checkpoint(self, session_id: str) -> bool:
        return self.get_checkpoint(session_id) is not None

    def clear_checkpoint(self, session_id: str) -> None:
        with self._lock:
            self._ensure_session(session_id)
            with self._connection:
                self._connection.execute(
                    "DELETE FROM run_checkpoints WHERE session_id = ?", (session_id,)
                )

    def get_web_traces(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_session(session_id)
            rows = self._connection.execute(
                """
                SELECT payload_json FROM session_web_traces
                WHERE session_id = ? ORDER BY created_at ASC, trace_id ASC
                """,
                (session_id,),
            ).fetchall()
            return [deepcopy(_object(row["payload_json"])) for row in rows]

    def append_web_trace(self, session_id: str, trace: dict[str, Any]) -> None:
        with self._lock:
            self._ensure_session(session_id)
            value = deepcopy(trace)
            value.setdefault("timestamp", _now())
            trace_id = str(value.get("id") or f"trace-{uuid4().hex}")
            with self._connection:
                self._connection.execute(
                    """
                    INSERT OR REPLACE INTO session_web_traces(
                        trace_id, session_id, run_id, tool_call_id, payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        trace_id,
                        session_id,
                        value.get("run_id"),
                        value.get("tool_call_id"),
                        _json(value),
                        str(value["timestamp"]),
                    ),
                )

    def clear(self, session_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "DELETE FROM agent_sessions WHERE session_id = ?", (session_id,)
            )

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _session_row(self, session_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if row is None:
            raise KeyError(session_id)
        return row

    def _touch_session(
        self,
        session_id: str,
        *,
        active_leaf_entry_id: str | None = None,
        search_mode: str | None = None,
    ) -> None:
        fields = ["updated_at = ?"]
        values: list[Any] = [_now()]
        if active_leaf_entry_id is not None:
            fields.append("active_leaf_entry_id = ?")
            values.append(active_leaf_entry_id)
        if search_mode is not None:
            fields.append("search_mode = ?")
            values.append(search_mode)
        values.append(session_id)
        self._connection.execute(
            f"UPDATE agent_sessions SET {', '.join(fields)} WHERE session_id = ?",
            values,
        )
        self._connection.commit()

    def _message_chain(self, session_id: str, leaf: str | None) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            """
            SELECT entry_id, parent_entry_id, kind, role, payload_json
            FROM session_entries WHERE session_id = ?
            """,
            (session_id,),
        ).fetchall()
        by_id = {str(row["entry_id"]): row for row in rows}
        current = leaf or (str(rows[-1]["entry_id"]) if rows else None)
        chain: list[sqlite3.Row] = []
        visited: set[str] = set()
        while current and current not in visited:
            visited.add(current)
            row = by_id.get(current)
            if row is None:
                break
            chain.append(row)
            current = row["parent_entry_id"]
        chain.reverse()
        visible: list[dict[str, Any]] = []
        for row in chain:
            payload = _object(row["payload_json"])
            if row["kind"] == "message" and isinstance(row["role"], str) and isinstance(payload.get("content"), str):
                visible.append(deepcopy(payload))
        return visible

    def _migrate_legacy_session(self, session_id: str) -> None:
        table = self._connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"
        ).fetchone()
        if table is None:
            return
        row = self._connection.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if row is None:
            return
        if self._connection.execute(
            "SELECT 1 FROM agent_sessions WHERE session_id = ?", (session_id,)
        ).fetchone():
            return
        now = str(row["updated_at"] or _now())
        messages = _array(row["messages_json"])
        checkpoint = _nullable_object(row["checkpoint_json"])
        with self._connection:
            self._connection.execute(
                """
                INSERT INTO agent_sessions(session_id, title, search_mode, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    str(row["title"] or _first_title(messages)),
                    str(row["search_mode"] or self.default_search_mode),
                    now,
                    now,
                ),
            )
            self._connection.execute(
                """
                INSERT INTO session_resources(session_id, active_skills_json, active_mcp_servers_json)
                VALUES (?, ?, ?)
                """,
                (
                    session_id,
                    _json(_string_list(row["active_skills_json"])),
                    _json(_string_list(row["active_mcp_servers_json"])),
                ),
            )
            parent: str | None = None
            for index, message in enumerate(messages):
                if not isinstance(message, dict):
                    continue
                entry_id = f"legacy-{uuid4().hex}-{index}"
                self._connection.execute(
                    """
                    INSERT INTO session_entries(
                        entry_id, session_id, parent_entry_id, kind, role, payload_json, created_at
                    ) VALUES (?, ?, ?, 'message', ?, ?, ?)
                    """,
                    (
                        entry_id,
                        session_id,
                        parent,
                        message.get("role") if isinstance(message.get("role"), str) else None,
                        _json(message),
                        now,
                    ),
                )
                parent = entry_id
            self._connection.execute(
                "UPDATE agent_sessions SET active_leaf_entry_id = ? WHERE session_id = ?",
                (parent, session_id),
            )
            if checkpoint is not None:
                run_id = str(checkpoint.get("run_id") or f"legacy-run-{session_id}")
                state = {
                    "messages": _array(checkpoint.get("messages")),
                    "prompt_profile": str(checkpoint.get("prompt_profile") or "agent"),
                    "user_content": str(checkpoint.get("user_content") or ""),
                    "bootstrap_context": _array(checkpoint.get("bootstrap_context")),
                    **(
                        {"response_format": deepcopy(checkpoint["response_format"])}
                        if checkpoint.get("response_format") is not None
                        else {}
                    ),
                }
                self._connection.execute(
                    """
                    INSERT INTO session_runs(run_id, session_id, status, last_entry_id, config_json, started_at)
                    VALUES (?, ?, 'paused', ?, '{}', ?)
                    """,
                    (run_id, session_id, parent, now),
                )
                self._connection.execute(
                    """
                    INSERT INTO run_checkpoints(
                        run_id, session_id, reason, iteration, state_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        session_id,
                        str(checkpoint.get("reason") or "stopped"),
                        int(checkpoint.get("iteration") or 0),
                        _json(state),
                        now,
                        now,
                    ),
                )
            for trace in _array(row["web_traces_json"]):
                if not isinstance(trace, dict):
                    continue
                trace_id = str(trace.get("id") or f"legacy-trace-{uuid4().hex}")
                self._connection.execute(
                    """
                    INSERT OR IGNORE INTO session_web_traces(
                        trace_id, session_id, run_id, tool_call_id, payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        trace_id,
                        session_id,
                        trace.get("run_id"),
                        trace.get("tool_call_id"),
                        _json(trace),
                        str(trace.get("timestamp") or now),
                    ),
                )


def _checkpoint_from_row(row: sqlite3.Row) -> SessionCheckpoint:
    state = _object(row["state_json"])
    messages = _array(state.get("messages") or state.get("loopMessages"))
    prompt_profile = str(state.get("prompt_profile") or state.get("promptProfile") or "agent")
    user_content = str(state.get("user_content") or state.get("originalUserContent") or "")
    bootstrap_context = _array(state.get("bootstrap_context") or state.get("bootstrapContext"))
    response_format = state.get("response_format") or state.get("responseFormat")
    return SessionCheckpoint(
        messages=[item for item in messages if isinstance(item, dict)],
        run_id=str(row["run_id"]),
        prompt_profile=prompt_profile,
        user_content=user_content,
        iteration=int(row["iteration"]),
        reason=str(row["reason"]),
        response_format=deepcopy(response_format) if isinstance(response_format, dict) else None,
        bootstrap_context=[item for item in bootstrap_context if isinstance(item, dict)],
    )


def _visible_session_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    visible: list[dict[str, str]] = []
    for message in messages:
        if message.get("role") not in {"user", "assistant"}:
            continue
        content = message.get("content")
        if not isinstance(content, str) or not content.strip() or content.startswith(RESUME_PROMPT_MARKER):
            continue
        visible.append({"role": str(message["role"]), "content": content})
    return visible


def _first_title(messages: list[Any]) -> str:
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "user":
            content = str(message.get("content") or "").strip()
            if content:
                return content[:120]
    return "Untitled conversation"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _nullable_object(value: Any) -> dict[str, Any] | None:
    if value in (None, ""):
        return None
    parsed = _object(value)
    return parsed or None


def _array(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _string_list(value: Any) -> list[str]:
    return [str(item) for item in _array(value) if isinstance(item, str)]
