from collections import defaultdict
from copy import deepcopy
from typing import Any


class SessionStore:
    def __init__(self) -> None:
        self._messages: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._active_skills: dict[str, set[str]] = defaultdict(set)
        self._active_mcp_servers: dict[str, set[str]] = defaultdict(set)

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        return deepcopy(self._messages[session_id])

    def append(self, session_id: str, message: dict[str, Any]) -> None:
        self._messages[session_id].append(deepcopy(message))

    def get_active_skills(self, session_id: str) -> set[str]:
        return set(self._active_skills[session_id])

    def set_active_skills(self, session_id: str, skill_names: list[str] | set[str]) -> None:
        self._active_skills[session_id] = {str(skill_name) for skill_name in skill_names}

    def activate_skill(self, session_id: str, skill_name: str) -> None:
        self._active_skills[session_id].add(str(skill_name))

    def deactivate_skill(self, session_id: str, skill_name: str) -> None:
        self._active_skills[session_id].discard(str(skill_name))

    def get_active_mcp_servers(self, session_id: str) -> set[str]:
        return set(self._active_mcp_servers[session_id])

    def set_active_mcp_servers(self, session_id: str, server_names: list[str] | set[str]) -> None:
        self._active_mcp_servers[session_id] = {str(server_name) for server_name in server_names}

    def activate_mcp_server(self, session_id: str, server_name: str) -> None:
        self._active_mcp_servers[session_id].add(str(server_name))

    def deactivate_mcp_server(self, session_id: str, server_name: str) -> None:
        self._active_mcp_servers[session_id].discard(str(server_name))

    def replace(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        self._messages[session_id] = deepcopy(messages)

    def clear(self, session_id: str) -> None:
        self._messages.pop(session_id, None)
        self._active_skills.pop(session_id, None)
        self._active_mcp_servers.pop(session_id, None)

