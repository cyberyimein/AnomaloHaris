#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib import error, request


def main() -> int:
    event_name = sys.argv[1] if len(sys.argv) > 1 else ""
    if not event_name:
        sys.stdout.write("{}")
        return 0

    payload = _read_stdin_json()
    env = _merged_env()
    url = _endpoint_url(env, event_name)
    headers = {"content-type": "application/json"}
    token = (
        env.get("ANOMALO_COPILOT_HOOK_ADMIN_TOKEN")
        or env.get("ANOMALO_ADMIN_TOKEN")
        or ""
    ).strip()
    if token:
        headers["x-anomalo-admin-token"] = token

    req = request.Request(
        url,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=_timeout_seconds(event_name, env)) as response:
            body = response.read().decode("utf-8").strip()
    except (error.URLError, TimeoutError, OSError):
        sys.stdout.write("{}")
        return 0

    sys.stdout.write(_compact_json(body))
    return 0


def _read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _merged_env() -> dict[str, str]:
    merged = dict(_env_file_values())
    merged.update(os.environ)
    return merged


def _env_file_values() -> dict[str, str]:
    values: dict[str, str] = {}
    env_paths = (
        Path(__file__).resolve().parents[2] / ".env",
        Path.home() / ".config" / "anomalo" / "buddy-hook.env",
    )
    for env_path in env_paths:
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            values[key.strip()] = _strip_quotes(value.strip())
    return values


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _endpoint_url(env: dict[str, str], event_name: str) -> str:
    base_url = (
        env.get("ANOMALO_COPILOT_HOOK_BASE_URL")
        or env.get("ANOMALO_SITE_URL")
        or "http://127.0.0.1:8000"
    )
    return f"{base_url.rstrip('/')}/api/copilot/hooks/{event_name}"


def _timeout_seconds(event_name: str, env: dict[str, str]) -> float:
    if event_name.strip().lower() == "permissionrequest":
        return _float_env(env, "ANOMALO_COPILOT_BUDDY_APPROVAL_TIMEOUT_SECONDS", 90.0) + 5.0
    return 5.0


def _float_env(env: dict[str, str], key: str, default: float) -> float:
    raw = env.get(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _compact_json(body: str) -> str:
    if not body:
        return "{}"
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return "{}"
    if not isinstance(payload, dict):
        return "{}"
    return json.dumps(payload, separators=(",", ":"))


if __name__ == "__main__":
    raise SystemExit(main())
