"""Configuration loading with an optional PyYAML fast path.

The fallback parser intentionally supports only the small YAML subset used by
this project: nested mappings, scalar lists, and lists of mappings.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def load_yaml(path: Path) -> dict:
    try:
        import yaml  # type: ignore

        with path.open("r", encoding="utf-8") as handle:
            return yaml.safe_load(handle)
    except ModuleNotFoundError:
        return _parse_simple_yaml(path.read_text(encoding="utf-8"))


def _parse_simple_yaml(text: str) -> dict:
    lines = [
        (len(raw) - len(raw.lstrip(" ")), raw.strip())
        for raw in text.splitlines()
        if raw.strip() and not raw.lstrip().startswith("#")
    ]
    parsed, next_index = _parse_block(lines, 0, 0)
    if next_index != len(lines):
        raise ValueError("Unexpected trailing YAML content")
    if not isinstance(parsed, dict):
        raise ValueError("Top-level YAML content must be a mapping")
    return parsed


def _parse_block(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[Any, int]:
    if index >= len(lines):
        return {}, index

    current_indent, current = lines[index]
    if current_indent < indent:
        return {}, index
    if current.startswith("- "):
        return _parse_list(lines, index, current_indent)
    return _parse_mapping(lines, index, current_indent)


def _parse_mapping(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[dict, int]:
    result: dict[str, Any] = {}
    while index < len(lines):
        current_indent, current = lines[index]
        if current_indent < indent or current.startswith("- "):
            break
        if current_indent > indent:
            break

        key, value = _split_key_value(current)
        index += 1
        if value == "":
            nested, index = _parse_block(lines, index, indent + 2)
            result[key] = nested
        else:
            result[key] = _parse_scalar(value)

    return result, index


def _parse_list(lines: list[tuple[int, str]], index: int, indent: int) -> tuple[list, int]:
    result = []
    while index < len(lines):
        current_indent, current = lines[index]
        if current_indent != indent or not current.startswith("- "):
            break

        item_text = current[2:].strip()
        index += 1
        if item_text == "":
            item, index = _parse_block(lines, index, indent + 2)
            result.append(item)
        elif ":" in item_text:
            key, value = _split_key_value(item_text)
            item = {key: _parse_scalar(value)}
            if index < len(lines) and lines[index][0] > indent:
                extra, index = _parse_mapping(lines, index, indent + 2)
                item.update(extra)
            result.append(item)
        else:
            result.append(_parse_scalar(item_text))

    return result, index


def _split_key_value(text: str) -> tuple[str, str]:
    if ":" not in text:
        raise ValueError(f"Invalid YAML line: {text}")
    key, value = text.split(":", 1)
    return key.strip(), value.strip()


def _parse_scalar(value: str) -> Any:
    if value in {"null", "~"}:
        return None
    if value == "true":
        return True
    if value == "false":
        return False
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value
