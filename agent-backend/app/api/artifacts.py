import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import get_settings

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])

_COMPONENT_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


@router.get("/python/{execution_id}/{name}", response_class=FileResponse)
async def python_artifact(execution_id: str, name: str) -> FileResponse:
    if not _COMPONENT_PATTERN.fullmatch(execution_id) or not _COMPONENT_PATTERN.fullmatch(name):
        raise HTTPException(status_code=404, detail="Artifact not found.")

    artifact_path = get_settings().artifacts_dir / "python" / execution_id / name
    if not artifact_path.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found.")
    return FileResponse(
        artifact_path,
        filename=name,
        content_disposition_type="inline",
        headers={"Cache-Control": "private, max-age=3600"},
    )
