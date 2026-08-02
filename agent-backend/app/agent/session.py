import json
import sqlite3
import threading
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

RESUME_PROMPT_MARKER = "Continue the interrupted task from the saved context."


@dataclass
class SessionCheckpoint:
    messages: list[dict[str, Any]]
    run_id: str
    prompt_profile: str
    user_content: str
    iteration: int
    reason: str = "stopped"
    response_format: dict[str, Any] | None = None


class SessionStore:
    """Persistent session state backed by SQLite with a process-local read cache."""

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        self.db_path = str(db_path)
        if self.db_path != ":memory:":
            Path(self.db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)

        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA busy_timeout = 5000")
        self._connection.execute("PRAGMA foreign_keys = ON")
        if self.db_path != ":memory:":
            # The persistent data directory is bind-mounted into Apple Container via
            # virtiofs. DELETE journaling keeps the database self-contained on that
            # mount; WAL sidecars can be lost when a container is replaced.
            self._connection.execute("PRAGMA journal_mode = DELETE")
        self._connection.commit()
        self._initialize_schema()

        self._messages: dict[str, list[dict[str, Any]]] = {}
        self._active_skills: dict[str, set[str]] = {}
        self._active_mcp_servers: dict[str, set[str]] = {}
        self._web_traces: dict[str, list[dict[str, Any]]] = {}
        self._checkpoints: dict[str, SessionCheckpoint] = {}
        self._loaded_sessions: set[str] = set()

    def _initialize_schema(self) -> None:
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                messages_json TEXT NOT NULL DEFAULT '[]',
                active_skills_json TEXT NOT NULL DEFAULT '[]',
                active_mcp_servers_json TEXT NOT NULL DEFAULT '[]',
                web_traces_json TEXT NOT NULL DEFAULT '[]',
                checkpoint_json TEXT,
                title TEXT NOT NULL DEFAULT '',
                message_count INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            )
            """
        )
        columns = {
            row["name"]
            for row in self._connection.execute("PRAGMA table_info(sessions)").fetchall()
        }
        if "title" not in columns:
            self._connection.execute(
                "ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''"
            )
        if "message_count" not in columns:
            self._connection.execute(
                "ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0"
            )
        self._backfill_session_metadata()
        self._connection.commit()

    def _backfill_session_metadata(self) -> None:
        rows = self._connection.execute(
            """
            SELECT session_id, messages_json, checkpoint_json, title, message_count
            FROM sessions
            """
        ).fetchall()
        for row in rows:
            if row["title"] and row["message_count"]:
                continue
            messages = _json_list(row["messages_json"])
            checkpoint = _checkpoint_from_json(row["checkpoint_json"])
            conversation_messages = checkpoint.messages if checkpoint is not None else messages
            title, message_count = _session_summary(conversation_messages)
            self._connection.execute(
                """
                UPDATE sessions
                SET title = ?, message_count = ?
                WHERE session_id = ?
                """,
                (title, message_count, row["session_id"]),
            )

    def _ensure_loaded(self, session_id: str) -> None:
        if session_id in self._loaded_sessions:
            return

        row = self._connection.execute(
            """
            SELECT messages_json, active_skills_json, active_mcp_servers_json,
                   web_traces_json, checkpoint_json
            FROM sessions
            WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            self._messages[session_id] = []
            self._active_skills[session_id] = set()
            self._active_mcp_servers[session_id] = set()
            self._web_traces[session_id] = []
            self._checkpoints.pop(session_id, None)
        else:
            self._messages[session_id] = _json_list(row["messages_json"])
            self._active_skills[session_id] = set(_json_list(row["active_skills_json"]))
            self._active_mcp_servers[session_id] = set(
                _json_list(row["active_mcp_servers_json"])
            )
            self._web_traces[session_id] = _json_list(row["web_traces_json"])
            checkpoint = _checkpoint_from_json(row["checkpoint_json"])
            if checkpoint is not None:
                self._checkpoints[session_id] = checkpoint
            else:
                self._checkpoints.pop(session_id, None)
        self._loaded_sessions.add(session_id)

    def _persist(self, session_id: str) -> None:
        checkpoint = self._checkpoints.get(session_id)
        conversation_messages = (
            checkpoint.messages if checkpoint is not None else self._messages[session_id]
        )
        title, message_count = _session_summary(conversation_messages)
        self._connection.execute(
            """
            INSERT INTO sessions (
                session_id,
                messages_json,
                active_skills_json,
                active_mcp_servers_json,
                web_traces_json,
                checkpoint_json,
                title,
                message_count,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                messages_json = excluded.messages_json,
                active_skills_json = excluded.active_skills_json,
                active_mcp_servers_json = excluded.active_mcp_servers_json,
                web_traces_json = excluded.web_traces_json,
                checkpoint_json = excluded.checkpoint_json,
                title = excluded.title,
                message_count = excluded.message_count,
                updated_at = excluded.updated_at
            """,
            (
                session_id,
                json.dumps(self._messages[session_id], ensure_ascii=False),
                json.dumps(sorted(self._active_skills[session_id]), ensure_ascii=False),
                json.dumps(sorted(self._active_mcp_servers[session_id]), ensure_ascii=False),
                json.dumps(self._web_traces[session_id], ensure_ascii=False),
                json.dumps(asdict(checkpoint), ensure_ascii=False) if checkpoint else None,
                title,
                message_count,
                datetime.now(UTC).isoformat(),
            ),
        )
        self._connection.commit()

    def list_sessions(self) -> list[dict[str, Any]]:
        """Return persisted conversations ordered by most recent activity."""
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT session_id, title, message_count, checkpoint_json, updated_at
                FROM sessions
                ORDER BY updated_at DESC
                """
            ).fetchall()
            summaries: list[dict[str, Any]] = []
            for row in rows:
                if row["message_count"] <= 0:
                    continue
                summaries.append(
                    {
                        "session_id": row["session_id"],
                        "title": row["title"] or "Untitled conversation",
                        "message_count": row["message_count"],
                        "updated_at": row["updated_at"],
                        "can_resume": row["checkpoint_json"] is not None,
                    }
                )
            return summaries

    def get_session_snapshot(self, session_id: str) -> dict[str, Any] | None:
        """Return the latest persisted message chain, including a paused checkpoint."""
        with self._lock:
            row = self._connection.execute(
                """
                SELECT updated_at
                FROM sessions
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                return None
            self._ensure_loaded(session_id)
            checkpoint = self._checkpoints.get(session_id)
            messages = checkpoint.messages if checkpoint is not None else self._messages[session_id]
            return {
                "session_id": session_id,
                "messages": deepcopy(messages),
                "updated_at": row["updated_at"],
                "can_resume": checkpoint is not None,
            }

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_loaded(session_id)
            return deepcopy(self._messages[session_id])

    def append(self, session_id: str, message: dict[str, Any]) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._messages[session_id].append(deepcopy(message))
            self._persist(session_id)

    def append_many(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._messages[session_id].extend(deepcopy(messages))
            self._persist(session_id)

    def get_active_skills(self, session_id: str) -> set[str]:
        with self._lock:
            self._ensure_loaded(session_id)
            return set(self._active_skills[session_id])

    def set_active_skills(self, session_id: str, skill_names: list[str] | set[str]) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._active_skills[session_id] = {str(skill_name) for skill_name in skill_names}
            self._persist(session_id)

    def activate_skill(self, session_id: str, skill_name: str) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._active_skills[session_id].add(str(skill_name))
            self._persist(session_id)

    def deactivate_skill(self, session_id: str, skill_name: str) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._active_skills[session_id].discard(str(skill_name))
            self._persist(session_id)

    def get_active_mcp_servers(self, session_id: str) -> set[str]:
        with self._lock:
            self._ensure_loaded(session_id)
            return set(self._active_mcp_servers[session_id])

    def set_active_mcp_servers(self, session_id: str, server_names: list[str] | set[str]) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._active_mcp_servers[session_id] = {
                str(server_name) for server_name in server_names
            }
            self._persist(session_id)

    def activate_mcp_server(self, session_id: str, server_name: str) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._active_mcp_servers[session_id].add(str(server_name))
            self._persist(session_id)

    def deactivate_mcp_server(self, session_id: str, server_name: str) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._active_mcp_servers[session_id].discard(str(server_name))
            self._persist(session_id)

    def replace(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._messages[session_id] = deepcopy(messages)
            self._persist(session_id)

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
    ) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            self._checkpoints[session_id] = SessionCheckpoint(
                messages=deepcopy(messages),
                run_id=run_id,
                prompt_profile=prompt_profile,
                user_content=user_content,
                iteration=iteration,
                reason=reason,
                response_format=deepcopy(response_format),
            )
            self._persist(session_id)

    def get_checkpoint(self, session_id: str) -> SessionCheckpoint | None:
        with self._lock:
            self._ensure_loaded(session_id)
            checkpoint = self._checkpoints.get(session_id)
            return deepcopy(checkpoint) if checkpoint is not None else None

    def restore_checkpoint(self, session_id: str) -> SessionCheckpoint | None:
        with self._lock:
            self._ensure_loaded(session_id)
            checkpoint = self._checkpoints.pop(session_id, None)
            if checkpoint is None:
                return None
            self._messages[session_id] = deepcopy(checkpoint.messages)
            self._persist(session_id)
            return deepcopy(checkpoint)

    def has_checkpoint(self, session_id: str) -> bool:
        with self._lock:
            self._ensure_loaded(session_id)
            return session_id in self._checkpoints

    def clear_checkpoint(self, session_id: str) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            if self._checkpoints.pop(session_id, None) is not None:
                self._persist(session_id)

    def get_web_traces(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_loaded(session_id)
            return deepcopy(self._web_traces[session_id])

    def append_web_trace(self, session_id: str, trace: dict[str, Any]) -> None:
        with self._lock:
            self._ensure_loaded(session_id)
            value = deepcopy(trace)
            value.setdefault("timestamp", datetime.now(UTC).isoformat())
            traces = self._web_traces[session_id]
            traces.append(value)
            if len(traces) > 100:
                del traces[:-100]
            self._persist(session_id)

    def clear(self, session_id: str) -> None:
        with self._lock:
            self._messages.pop(session_id, None)
            self._active_skills.pop(session_id, None)
            self._active_mcp_servers.pop(session_id, None)
            self._web_traces.pop(session_id, None)
            self._checkpoints.pop(session_id, None)
            self._loaded_sessions.discard(session_id)
            self._connection.execute(
                "DELETE FROM sessions WHERE session_id = ?",
                (session_id,),
            )
            self._connection.commit()

    def close(self) -> None:
        with self._lock:
            self._connection.close()


def _json_list(value: str) -> list[Any]:
    parsed = json.loads(value)
    if not isinstance(parsed, list):
        raise ValueError("SessionStore JSON column must contain a list")
    return parsed


def _checkpoint_from_json(value: str | None) -> SessionCheckpoint | None:
    if not value:
        return None
    return SessionCheckpoint(**json.loads(value))


def _visible_session_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only renderable user/assistant messages for history summaries."""
    visible: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") not in {"user", "assistant"}:
            continue
        content = message.get("content")
        if (
            not isinstance(content, str)
            or not content.strip()
            or content.startswith(RESUME_PROMPT_MARKER)
        ):
            continue
        visible.append({"role": message["role"], "content": content})
    return visible


def _session_summary(messages: list[dict[str, Any]]) -> tuple[str, int]:
    visible_messages = _visible_session_messages(messages)
    title = next(
        (
            str(message.get("content") or "").strip()
            for message in visible_messages
            if message.get("role") == "user" and str(message.get("content") or "").strip()
        ),
        "Untitled conversation",
    )
    return title[:120], len(visible_messages)
