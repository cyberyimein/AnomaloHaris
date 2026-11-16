#!/usr/bin/env python3
"""Fetch and save the StackChan's authenticated, read-only debug snapshot."""

import argparse
import ast
import base64
import binascii
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_URL = "http://192.168.31.78:8080"
SNAPSHOT_PATH = "/v1/debug/snapshot"
REQUEST_TIMEOUT_SECONDS = 90
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class SnapshotError(Exception):
    """An expected configuration or API error safe to show in the CLI."""


def read_config_token(config_path):
    """Read a literal BUDDY_DEVICE_TOKEN assignment without executing config.py."""
    try:
        source = Path(config_path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise SnapshotError("Could not read the selected config file") from error

    try:
        module = ast.parse(source, filename=str(config_path))
    except SyntaxError as error:
        raise SnapshotError("The selected config file is not valid Python") from error

    token = None
    for statement in module.body:
        assignments = []
        if isinstance(statement, ast.Assign):
            if any(isinstance(target, ast.Name) and target.id == "BUDDY_DEVICE_TOKEN"
                   for target in statement.targets):
                assignments.append(statement.value)
        elif (isinstance(statement, ast.AnnAssign)
              and isinstance(statement.target, ast.Name)
              and statement.target.id == "BUDDY_DEVICE_TOKEN"):
            assignments.append(statement.value)

        for value_node in assignments:
            try:
                value = ast.literal_eval(value_node)
            except (ValueError, TypeError, SyntaxError):
                continue
            if isinstance(value, str):
                token = value

    if not token:
        raise SnapshotError("The config file must define BUDDY_DEVICE_TOKEN as a non-empty string literal")
    return token


def resolve_token(config_path=None):
    token = os.environ.get("BUDDY_DEVICE_TOKEN")
    if token:
        return token
    if config_path:
        return read_config_token(config_path)
    raise SnapshotError("Set BUDDY_DEVICE_TOKEN or provide --config with a local config.py")


def build_snapshot_url(base_url):
    parts = urllib.parse.urlsplit(base_url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise SnapshotError("--url must be an HTTP or HTTPS base URL")

    path = parts.path.rstrip("/")
    if not path.endswith(SNAPSHOT_PATH):
        path = f"{path}{SNAPSHOT_PATH}"
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


def fetch_snapshot(url, token):
    request = urllib.request.Request(
        build_snapshot_url(url),
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        raise SnapshotError(f"Buddy API returned HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SnapshotError("Could not connect to the Buddy debug API") from None

    try:
        snapshot = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SnapshotError("Buddy debug API returned invalid JSON") from None
    if not isinstance(snapshot, dict):
        raise SnapshotError("Buddy debug API response must be a JSON object")
    return snapshot


def redact_secret(value, token):
    if isinstance(value, str):
        return value.replace(token, "[redacted]") if token else value
    if isinstance(value, list):
        return [redact_secret(item, token) for item in value]
    if isinstance(value, dict):
        return {
            redact_secret(key, token): redact_secret(item, token)
            for key, item in value.items()
        }
    return value


def write_snapshot(snapshot, output_dir, token):
    output_dir = Path(output_dir)
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        snapshot_path = output_dir / "snapshot.json"
        snapshot_path.write_text(
            json.dumps(redact_secret(snapshot, token), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError as error:
        raise SnapshotError("Could not save snapshot.json to the output directory") from error
    return snapshot_path


def write_screen_image(snapshot, output_dir):
    display = snapshot.get("display")
    if not isinstance(display, dict) or display.get("available") is not True:
        return None

    image = display.get("image")
    if not isinstance(image, dict):
        return None
    if image.get("mimeType") != "image/png" or not isinstance(image.get("data"), str):
        return None

    try:
        image_bytes = base64.b64decode(image["data"], validate=True)
    except (ValueError, binascii.Error):
        raise SnapshotError("Buddy debug API returned invalid base64 screen data") from None
    if not image_bytes.startswith(PNG_SIGNATURE):
        raise SnapshotError("Buddy debug API screen data is not a PNG image")

    image_path = Path(output_dir) / "screen.png"
    try:
        image_path.write_bytes(image_bytes)
    except OSError as error:
        raise SnapshotError("Could not save screen.png to the output directory") from error
    return image_path


def mode_from_snapshot(snapshot):
    status = snapshot.get("status")
    if not isinstance(status, dict):
        return "unknown"
    state = status.get("state")
    if isinstance(state, dict) and isinstance(state.get("mode"), str):
        return state["mode"]
    if isinstance(status.get("mode"), str):
        return status["mode"]
    return "unknown"


def display_errors(snapshot):
    errors = []
    status = snapshot.get("status")
    if isinstance(status, dict):
        status_error = status.get("error")
        if status_error:
            errors.append(f"status: {status_error}")
        state = status.get("state")
        if isinstance(state, dict) and state.get("error"):
            errors.append(f"status: {state['error']}")

    display = snapshot.get("display")
    renderer = display.get("renderer") if isinstance(display, dict) else None
    if isinstance(renderer, dict) and renderer.get("error"):
        errors.append(f"renderer: {renderer['error']}")
    return errors


def summarize(snapshot, snapshot_path, image_path, token):
    display = snapshot.get("display")
    if not isinstance(display, dict):
        display = {}
    available = display.get("available") is True
    source = redact_secret(display.get("source") or "unknown", token)
    touch = snapshot.get("touch")
    if not isinstance(touch, dict):
        touch = {}
    levels = redact_secret(json.dumps(touch.get("levels"), ensure_ascii=False), token)
    polled = redact_secret(json.dumps(touch.get("lastPolledZones"), ensure_ascii=False), token)
    errors = [redact_secret(error, token) for error in display_errors(snapshot)]

    print(f"Snapshot: {snapshot_path}")
    print(f"Display: {'available' if available else 'unavailable'}")
    print(f"Source: {source}")
    print(f"Mode: {redact_secret(mode_from_snapshot(snapshot), token)}")
    print(f"Touch: levels {levels}; last polled zones {polled}")
    print(f"Error: {'; '.join(errors) if errors else 'none'}")
    if image_path:
        print(f"Screen: {image_path}")
    elif not available:
        print("Screen: not saved because the display is unavailable")
    else:
        print("Screen: no PNG image was included in the snapshot")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL, help="Buddy device base URL")
    parser.add_argument("--output", required=True, help="Directory for snapshot.json and screen.png")
    parser.add_argument("--config", help="Local Python config file containing a literal BUDDY_DEVICE_TOKEN")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        token = resolve_token(args.config)
        snapshot = fetch_snapshot(args.url, token)
        snapshot_path = write_snapshot(snapshot, args.output, token)
        image_path = write_screen_image(snapshot, args.output)
        summarize(snapshot, snapshot_path, image_path, token)
    except SnapshotError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
