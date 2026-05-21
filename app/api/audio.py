from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

router = APIRouter(prefix="/api/audio", tags=["audio"])


class TTSRequest(BaseModel):
    text: str
    voice: str | None = None


@router.post("/stt")
async def speech_to_text(file: UploadFile) -> dict[str, str]:
    _ = file
    raise HTTPException(status_code=501, detail="STT provider is not configured yet.")


@router.post("/tts")
async def text_to_speech(request: TTSRequest) -> dict[str, str]:
    _ = request
    raise HTTPException(status_code=501, detail="TTS provider is not configured yet.")

