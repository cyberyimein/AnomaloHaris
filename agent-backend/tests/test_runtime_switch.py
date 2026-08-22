import sys
from pathlib import Path

import pytest
from app.runtime_switch import UnsupportedRuntimeError, host_command, normalize_runtime_impl


def test_runtime_switch_defaults_to_python_until_node_api_parity() -> None:
    assert normalize_runtime_impl(None) == "python"
    command = host_command(
        None,
        repo_root=Path(__file__).parents[2],
        python_executable=sys.executable,
    )
    assert command[0] == sys.executable
    assert command[-4:] == ["--host", "127.0.0.1", "--port", "8000"]


def test_python_runtime_defaults_to_loopback_and_accepts_explicit_bind() -> None:
    command = host_command(
        "python",
        repo_root=Path(__file__).parents[2],
        python_executable=sys.executable,
    )
    assert command[-4:] == ["--host", "127.0.0.1", "--port", "8000"]
    public = host_command(
        "python",
        repo_root=Path(__file__).parents[2],
        python_executable=sys.executable,
        host="0.0.0.0",
        port=9000,
    )
    assert public[-4:] == ["--host", "0.0.0.0", "--port", "9000"]


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
