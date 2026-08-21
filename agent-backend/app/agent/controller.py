"""Process-local Agent Run ownership and stop coordination."""

from typing import Any


class RunController:
    """Own the one-active-run-per-session invariant for the Python Host."""

    def __init__(self) -> None:
        self._active_runs: dict[str, Any] = {}

    def claim(self, session_id: str, state: Any) -> bool:
        if session_id in self._active_runs:
            return False
        self._active_runs[session_id] = state
        return True

    def request_stop(self, session_id: str, *, reason: str = "user_stop") -> str | None:
        state = self._active_runs.get(session_id)
        if state is None:
            return None
        state.stop_requested = True
        state.stop_reason = reason
        return str(state.run_id)

    def is_active(self, session_id: str) -> bool:
        return session_id in self._active_runs

    def release(self, session_id: str, state: Any) -> None:
        if self._active_runs.get(session_id) is state:
            self._active_runs.pop(session_id, None)

