import sys
from pathlib import Path

import pytest

from app.runtime_switch import UnsupportedRuntimeError, host_command, normalize_runtime_impl


def test_runtime_switch_defaults_to_python() -> None:
    assert normalize_runtime_impl(None) == "python"
    assert host_command(None, repo_root=Path(__file__).parents[2], python_executable=sys.executable)[:3] == [
        sys.executable,
        "-m",
        "uvicorn",
    ]


def test_runtime_switch_selects_node_entrypoint(tmp_path) -> None:
    entry = tmp_path / "main.js"
    entry.write_text("", encoding="utf-8")
    assert host_command(
        "node",
        repo_root=tmp_path,
        python_executable=sys.executable,
        node_executable="node-test",
        node_entry=entry,
    ) == ["node-test", str(entry)]


def test_runtime_switch_rejects_unknown_values() -> None:
    with pytest.raises(UnsupportedRuntimeError):
        normalize_runtime_impl("go")
