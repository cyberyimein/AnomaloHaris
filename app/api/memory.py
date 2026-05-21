from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.agent.memory import MAX_MEMORY_BYTES, read_agent_memory, save_agent_memory
from app.config import get_settings

router = APIRouter(prefix="/api", tags=["memory"])


@router.get("/memory")
async def memory() -> dict[str, Any]:
    return read_agent_memory(get_settings().agent_memory_path)


@router.post("/memory/upload")
async def upload_memory(file: UploadFile = File(...)) -> dict[str, Any]:
    raw = await file.read()
    if len(raw) > MAX_MEMORY_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"AGENTS.md is too large. Limit is {MAX_MEMORY_BYTES} bytes.",
        )

    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="AGENTS.md must be UTF-8 text.",
        ) from exc

    try:
        return save_agent_memory(get_settings().agent_memory_path, content)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
