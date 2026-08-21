from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.runtime_switch import host_command, normalize_runtime_impl


REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    runtime = normalize_runtime_impl(os.environ.get("ANOMALO_RUNTIME_IMPL"))
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
    )
    if runtime == "node" and not Path(command[1]).exists():
        raise RuntimeError(
            f"Node Host entrypoint does not exist: {command[1]}. Build apps/node-host first "
            "or set ANOMALO_NODE_HOST_ENTRY."
        )
    os.execvpe(command[0], command, os.environ.copy())


if __name__ == "__main__":
    main()
