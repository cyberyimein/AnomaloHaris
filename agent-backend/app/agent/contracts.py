"""Shared JSON contract loading used by Python compatibility tests and tools."""

import json
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


def contracts_root() -> Path:
    """Return the repository's shared contracts directory."""
    return Path(__file__).resolve().parents[3] / "packages" / "contracts"


@cache
def load_schema(name: str) -> dict[str, Any]:
    path = contracts_root() / "schemas" / f"{name}.schema.json"
    with path.open(encoding="utf-8") as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise ValueError(f"Contract schema must be a JSON object: {path}")
    return value


def validate_payload(payload: Any, schema_name: str) -> list[str]:
    """Return stable validation messages; an empty list means the payload is valid."""
    validator = Draft202012Validator(load_schema(schema_name))
    return [error.message for error in sorted(validator.iter_errors(payload), key=str)]
