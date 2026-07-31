import json
import sqlite3
import threading
from copy import deepcopy
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass
class SessionCheckpoint:
    messages: list[dict[str, Any]]
    run_id: str
    prompt_profile: str
    user_content: str
    iteration: int
    reason: str = "stopped"


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
            self._connection.execute("PRAGMA journal_mode = WAL")
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
                updated_at TEXT NOT NULL
            )
            """
        )
        self._connection.commit()

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
            if row["checkpoint_json"]:
                self._checkpoints[session_id] = SessionCheckpoint(
                    **json.loads(row["checkpoint_json"])
                )
            else:
                self._checkpoints.pop(session_id, None)
        self._loaded_sessions.add(session_id)

    def _persist(self, session_id: str) -> None:
        checkpoint = self._checkpoints.get(session_id)
        self._connection.execute(
            """
            INSERT INTO sessions (
                session_id,
                messages_json,
                active_skills_json,
                active_mcp_servers_json,
                web_traces_json,
                checkpoint_json,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                messages_json = excluded.messages_json,
                active_skills_json = excluded.active_skills_json,
                active_mcp_servers_json = excluded.active_mcp_servers_json,
                web_traces_json = excluded.web_traces_json,
                checkpoint_json = excluded.checkpoint_json,
                updated_at = excluded.updated_at
            """,
            (
                session_id,
                json.dumps(self._messages[session_id], ensure_ascii=False),
                json.dumps(sorted(self._active_skills[session_id]), ensure_ascii=False),
                json.dumps(sorted(self._active_mcp_servers[session_id]), ensure_ascii=False),
                json.dumps(self._web_traces[session_id], ensure_ascii=False),
                json.dumps(asdict(checkpoint), ensure_ascii=False) if checkpoint else None,
                datetime.now(UTC).isoformat(),
            ),
        )
        self._connection.commit()

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
