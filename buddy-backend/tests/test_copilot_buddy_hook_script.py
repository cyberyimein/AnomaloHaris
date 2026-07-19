import importlib.util
from pathlib import Path


def _load_hook_module():  # type: ignore[no-untyped-def]
    script = Path(__file__).parents[1] / "scripts" / "copilot_buddy_hook.py"
    spec = importlib.util.spec_from_file_location("copilot_buddy_hook_script", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_permission_timeout_accepts_codex_event_casing() -> None:
    hook = _load_hook_module()
    env = {"ANOMALO_COPILOT_BUDDY_APPROVAL_TIMEOUT_SECONDS": "90"}

    assert hook._timeout_seconds("PermissionRequest", env) == 95.0
    assert hook._timeout_seconds("permissionRequest", env) == 95.0
