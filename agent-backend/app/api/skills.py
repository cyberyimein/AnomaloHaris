from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.container import get_session_store, get_skill_manager

router = APIRouter(prefix="/api", tags=["skills"])


class SessionSkillsRequest(BaseModel):
    active_skills: list[str] = Field(default_factory=list)


@router.get("/sessions/{session_id}/skills")
async def session_skills(session_id: str) -> dict[str, Any]:
    active_skill_names = get_session_store().get_active_skills(session_id)
    return {
        "session_id": session_id,
        "active_skills": sorted(active_skill_names),
        "skills": get_skill_manager().list_skills(active_skill_names),
    }


@router.put("/sessions/{session_id}/skills")
async def set_session_skills(
    session_id: str,
    request: SessionSkillsRequest,
) -> dict[str, Any]:
    manager = get_skill_manager()
    skills = manager.list_skills()
    available = {str(skill["name"]): skill for skill in skills}

    normalized: list[str] = []
    for skill_name in request.active_skills:
        normalized_name = str(skill_name).strip()
        if normalized_name not in available:
            raise HTTPException(status_code=404, detail=f"Unknown skill: {normalized_name}")
        if not available[normalized_name].get("enabled", True):
            raise HTTPException(status_code=409, detail=f"Skill is disabled: {normalized_name}")
        normalized.append(normalized_name)

    get_session_store().set_active_skills(session_id, normalized)
    active_skill_names = get_session_store().get_active_skills(session_id)
    return {
        "session_id": session_id,
        "active_skills": sorted(active_skill_names),
        "skills": manager.list_skills(active_skill_names),
    }
