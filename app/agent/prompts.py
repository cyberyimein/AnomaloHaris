from pathlib import Path
from typing import Any

import yaml


SYSTEM_LEVEL_ROLES = {"system", "developer"}


class PromptConfigError(ValueError):
    pass


def load_prompt_messages(config_path: Path, profile: str) -> list[dict[str, str]]:
    data = _load_yaml(config_path)
    profiles = data.get("profiles")
    if not isinstance(profiles, dict):
        raise PromptConfigError(f"{config_path} must define a profiles mapping.")

    profile_config = profiles.get(profile)
    if not isinstance(profile_config, dict):
        available = ", ".join(sorted(str(name) for name in profiles)) or "none"
        raise PromptConfigError(
            f"Prompt profile '{profile}' was not found in {config_path}. "
            f"Available profiles: {available}."
        )

    raw_messages = profile_config.get("messages")
    if not isinstance(raw_messages, list):
        raise PromptConfigError(
            f"Prompt profile '{profile}' in {config_path} must define a messages list."
        )

    messages: list[dict[str, str]] = []
    for index, raw_message in enumerate(raw_messages, start=1):
        if not isinstance(raw_message, dict):
            raise PromptConfigError(
                f"Prompt message #{index} in profile '{profile}' must be a mapping."
            )
        if raw_message.get("enabled", True) is False:
            continue

        role = str(raw_message.get("role") or "system")
        if role not in SYSTEM_LEVEL_ROLES:
            raise PromptConfigError(
                f"Prompt message #{index} uses unsupported role '{role}'. "
                f"Use one of: {', '.join(sorted(SYSTEM_LEVEL_ROLES))}."
            )

        content = raw_message.get("content")
        if not isinstance(content, str) or not content.strip():
            message_id = raw_message.get("id") or f"#{index}"
            raise PromptConfigError(
                f"Prompt message {message_id!r} in profile '{profile}' must include content."
            )

        messages.append({"role": role, "content": content.strip()})

    if not messages:
        raise PromptConfigError(f"Prompt profile '{profile}' does not contain enabled messages.")
    return messages


def load_prompt_profile(config_path: Path, profile: str) -> dict[str, Any]:
    data = _load_yaml(config_path)
    messages = load_prompt_messages(config_path, profile)
    return {
        "version": data.get("version", 1),
        "profile": profile,
        "messages": messages,
    }


def _load_yaml(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        raise PromptConfigError(f"Prompt config file was not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as file:
        data = yaml.safe_load(file) or {}
    if not isinstance(data, dict):
        raise PromptConfigError(f"{config_path} must contain a YAML mapping.")
    return data
