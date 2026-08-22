from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.runtime_switch import host_command, normalize_runtime_impl  # noqa: E402, I001


REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    runtime = normalize_runtime_impl(os.environ.get("ANOMALO_RUNTIME_IMPL"))
    requested_host = os.environ.get("HOST", "127.0.0.1")
    public_host = requested_host not in {"127.0.0.1", "::1", "localhost"}
    host = requested_host
    if (
        os.environ.get("ANOMALO_ENV") == "production"
        and public_host
        and os.environ.get("ANOMALO_ACKNOWLEDGE_PUBLIC_HOST") != "true"
    ):
        host = "127.0.0.1"
    command = host_command(
        runtime,
        repo_root=REPO_ROOT,
        python_executable=sys.executable,
        node_entry=(
            Path(os.environ["ANOMALO_NODE_HOST_ENTRY"])
            if os.environ.get("ANOMALO_NODE_HOST_ENTRY")
            else None
        ),
        node_executable=os.environ.get("ANOMALO_NODE_EXECUTABLE"),
        host=host,
        port=int(os.environ.get("PORT", "8000")),
    )
    if runtime == "node" and not Path(command[1]).exists():
        raise RuntimeError(
            f"Node Host entrypoint does not exist: {command[1]}. Build apps/node-host first "
            "or set ANOMALO_NODE_HOST_ENTRY."
        )
    os.execvpe(command[0], command, os.environ.copy())


if __name__ == "__main__":
    main()
