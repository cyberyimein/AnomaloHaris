from typing import Any

from fastapi import APIRouter

from app.agent.prompts import load_prompt_profile
from app.config import get_settings

router = APIRouter(prefix="/api", tags=["prompts"])


@router.get("/prompts")
async def prompts() -> dict[str, Any]:
    settings = get_settings()
    profile = load_prompt_profile(settings.prompts_config_path, settings.prompt_profile)
    return {
        **profile,
        "config_path": str(settings.prompts_config_path),
    }
