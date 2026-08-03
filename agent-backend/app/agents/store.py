from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4


@dataclass(frozen=True)
class PresetAgent:
    id: str
    name: str
    description: str
    ghost: str
    system_prompt: str
    model: str
    temperature: float
    tool_names: list[str]
    tool_sources: dict[str, str]
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


class PresetAgentStore:
    """SQLite-backed definitions for externally callable, reusable agents."""

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        self.db_path = str(db_path)
        if self.db_path != ":memory:":
            Path(self.db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self.db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA busy_timeout = 5000")
        if self.db_path != ":memory:":
            self._connection.execute("PRAGMA journal_mode = DELETE")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS preset_agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                ghost TEXT NOT NULL DEFAULT '👻',
                system_prompt TEXT NOT NULL,
                model TEXT NOT NULL,
                temperature REAL NOT NULL DEFAULT 0.4,
                tool_names_json TEXT NOT NULL DEFAULT '[]',
                tool_sources_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        columns = {
            str(row["name"])
            for row in self._connection.execute("PRAGMA table_info(preset_agents)").fetchall()
        }
        if "tool_sources_json" not in columns:
            self._connection.execute(
                "ALTER TABLE preset_agents ADD COLUMN tool_sources_json TEXT NOT NULL DEFAULT '{}'"
            )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS preset_agent_sessions (
                session_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        self._connection.commit()

    def list(self) -> list[PresetAgent]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM preset_agents ORDER BY name COLLATE NOCASE"
            ).fetchall()
            return [self._from_row(row) for row in rows]

    def get(self, agent_ref: str) -> PresetAgent | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM preset_agents WHERE id = ? LIMIT 1",
                (agent_ref,),
            ).fetchone()
            if row is None:
                row = self._connection.execute(
                    "SELECT * FROM preset_agents WHERE name = ? COLLATE NOCASE LIMIT 1",
                    (agent_ref,),
                ).fetchone()
            return self._from_row(row) if row is not None else None

    def bind_session(self, session_id: str, agent_id: str) -> bool:
        """Bind a conversation to one preset agent; return False on a conflicting binding."""
        with self._lock:
            row = self._connection.execute(
                "SELECT agent_id FROM preset_agent_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if row is not None:
                return str(row["agent_id"]) == agent_id
            self._connection.execute(
                """
                INSERT INTO preset_agent_sessions (session_id, agent_id, created_at)
                VALUES (?, ?, ?)
                """,
                (session_id, agent_id, datetime.now(UTC).isoformat()),
            )
            self._connection.commit()
            return True

    def get_bound_agent_id(self, session_id: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT agent_id FROM preset_agent_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            return str(row["agent_id"]) if row is not None else None

    def unbind_session(self, session_id: str) -> None:
        with self._lock:
            self._connection.execute(
                "DELETE FROM preset_agent_sessions WHERE session_id = ?",
                (session_id,),
            )
            self._connection.commit()

    def create(
        self,
        *,
        name: str,
        description: str,
        ghost: str,
        system_prompt: str,
        model: str,
        temperature: float,
        tool_names: list[str],
        tool_sources: dict[str, str] | None = None,
    ) -> PresetAgent:
        now = datetime.now(UTC).isoformat()
        agent = PresetAgent(
            id=f"agent_{uuid4().hex}",
            name=name.strip(),
            description=description.strip(),
            ghost=ghost.strip() or "👻",
            system_prompt=system_prompt.strip(),
            model=model.strip(),
            temperature=temperature,
            tool_names=list(dict.fromkeys(tool_names)),
            tool_sources=dict(tool_sources or {}),
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            try:
                self._connection.execute(
                    """
                    INSERT INTO preset_agents (
                        id, name, description, ghost, system_prompt, model, temperature,
                        tool_names_json, tool_sources_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        agent.id,
                        agent.name,
                        agent.description,
                        agent.ghost,
                        agent.system_prompt,
                        agent.model,
                        agent.temperature,
                        json.dumps(agent.tool_names),
                        json.dumps(agent.tool_sources),
                        agent.created_at,
                        agent.updated_at,
                    ),
                )
                self._connection.commit()
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"An agent named '{agent.name}' already exists.") from exc
        return agent

    def update(self, agent_id: str, **changes: object) -> PresetAgent:
        current = self.get(agent_id)
        if current is None or current.id != agent_id:
            raise KeyError(agent_id)
        values = current.as_dict()
        values.update(changes)
        values["name"] = str(values["name"]).strip()
        values["description"] = str(values["description"]).strip()
        values["ghost"] = str(values["ghost"]).strip() or "👻"
        values["system_prompt"] = str(values["system_prompt"]).strip()
        values["model"] = str(values["model"]).strip()
        values["temperature"] = float(values["temperature"])
        values["tool_names"] = list(dict.fromkeys(values["tool_names"]))
        values["tool_sources"] = dict(values["tool_sources"])
        values["updated_at"] = datetime.now(UTC).isoformat()
        updated = PresetAgent(**values)
        with self._lock:
            try:
                cursor = self._connection.execute(
                    """
                    UPDATE preset_agents SET name = ?, description = ?, ghost = ?,
                        system_prompt = ?, model = ?, temperature = ?, tool_names_json = ?,
                        tool_sources_json = ?, updated_at = ? WHERE id = ?
                    """,
                    (
                        updated.name,
                        updated.description,
                        updated.ghost,
                        updated.system_prompt,
                        updated.model,
                        updated.temperature,
                        json.dumps(updated.tool_names),
                        json.dumps(updated.tool_sources),
                        updated.updated_at,
                        agent_id,
                    ),
                )
                self._connection.commit()
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"An agent named '{updated.name}' already exists.") from exc
        if not cursor.rowcount:
            raise KeyError(agent_id)
        return updated

    def delete(self, agent_id: str) -> bool:
        with self._lock:
            cursor = self._connection.execute("DELETE FROM preset_agents WHERE id = ?", (agent_id,))
            self._connection.commit()
            return bool(cursor.rowcount)

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    @staticmethod
    def _from_row(row: sqlite3.Row) -> PresetAgent:
        return PresetAgent(
            id=str(row["id"]),
            name=str(row["name"]),
            description=str(row["description"]),
            ghost=str(row["ghost"]),
            system_prompt=str(row["system_prompt"]),
            model=str(row["model"]),
            temperature=float(row["temperature"]),
            tool_names=list(json.loads(row["tool_names_json"])),
            tool_sources=dict(json.loads(row["tool_sources_json"])),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
        )
