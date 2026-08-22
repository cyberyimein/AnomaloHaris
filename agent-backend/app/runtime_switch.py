"""Runtime selection shared by local and container host launchers."""

from __future__ import annotations

import shutil
from pathlib import Path


class UnsupportedRuntimeError(ValueError):
    pass


def normalize_runtime_impl(value: str | None) -> str:
    normalized = (value or "python").strip().lower()
    if normalized not in {"python", "node"}:
        raise UnsupportedRuntimeError(
            f"Unsupported ANOMALO_RUNTIME_IMPL={value!r}; expected 'python' or 'node'."
        )
    return normalized


def host_command(
    runtime_impl: str | None,
    *,
    repo_root: Path,
    python_executable: str,
    node_entry: Path | None = None,
    node_executable: str | None = None,
    host: str = "127.0.0.1",
    port: int = 8000,
) -> list[str]:
    runtime = normalize_runtime_impl(runtime_impl)
    if runtime == "python":
        return [
            python_executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            host,
            "--port",
            str(port),
        ]
    selected_node = node_executable or shutil.which("node") or "node"
    selected_entry = node_entry or repo_root / "apps" / "node-host" / "dist" / "main.js"
    return [selected_node, str(selected_entry)]
