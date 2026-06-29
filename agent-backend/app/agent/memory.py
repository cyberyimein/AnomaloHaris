from pathlib import Path


MAX_MEMORY_BYTES = 128 * 1024


def load_agent_memory_message(memory_path: Path) -> dict[str, str] | None:
    memory = read_agent_memory(memory_path)
    content = memory["content"].strip()
    if not content:
        return None
    return {
        "role": "system",
        "content": f"Agent memory from AGENTS.md:\n\n{content}",
    }


def read_agent_memory(memory_path: Path) -> dict[str, str | int | bool]:
    if not memory_path.exists():
        return {"exists": False, "path": str(memory_path), "content": "", "size_bytes": 0}

    content = memory_path.read_text(encoding="utf-8")
    return {
        "exists": True,
        "path": str(memory_path),
        "content": content,
        "size_bytes": memory_path.stat().st_size,
    }


def save_agent_memory(memory_path: Path, content: str) -> dict[str, str | int | bool]:
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_MEMORY_BYTES:
        msg = f"AGENTS.md is too large. Limit is {MAX_MEMORY_BYTES} bytes."
        raise ValueError(msg)

    memory_path.parent.mkdir(parents=True, exist_ok=True)
    memory_path.write_text(content, encoding="utf-8")
    return read_agent_memory(memory_path)
