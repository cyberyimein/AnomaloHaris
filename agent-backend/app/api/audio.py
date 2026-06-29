import base64

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.agent.events import AgentEvent
from app.audio import AudioConfigurationError, AudioProcessingError
from app.audio.base import SynthesisResult
from app.container import get_voice_service

router = APIRouter(prefix="/api/audio", tags=["audio"])
AUDIO_UPLOAD = File(...)


class STTResponse(BaseModel):
    text: str
    language: str | None = None
    provider: str
    duration_seconds: float | None = None
    metadata: dict[str, str | float | int | bool | None] = Field(default_factory=dict)


class SynthesizedAudioResponse(BaseModel):
    audio_base64: str
    format: str
    mime_type: str
    provider: str
    language: str | None = None
    voice: str | None = None
    sample_rate_hz: int | None = None
    size_bytes: int
    metadata: dict[str, str | float | int | bool | None] = Field(default_factory=dict)


class TTSRequest(BaseModel):
    text: str
    voice: str | None = None
    language: str | None = None


class TTSResponse(BaseModel):
    text: str
    audio: SynthesizedAudioResponse


class VoiceChatResponse(BaseModel):
    session_id: str
    transcript: STTResponse
    final_text: str
    output_language: str | None = None
    reply_audio: SynthesizedAudioResponse | None = None
    events: list[AgentEvent] | None = None


@router.post("/stt")
async def speech_to_text(
    file: UploadFile = AUDIO_UPLOAD,
    language: str | None = Form(None),
    prompt: str | None = Form(None),
) -> STTResponse:
    try:
        payload = await file.read()
        result = await get_voice_service().transcribe(
            audio_bytes=payload,
            filename=file.filename,
            content_type=file.content_type,
            language=language,
            prompt=prompt,
        )
    except (AudioConfigurationError, AudioProcessingError, ValueError) as exc:
        raise _audio_http_error(exc) from exc
    return STTResponse(
        text=result.text,
        language=result.language,
        provider=result.provider,
        duration_seconds=result.duration_seconds,
        metadata=result.metadata,
    )


@router.post("/tts", response_model=TTSResponse)
async def text_to_speech(request: TTSRequest) -> TTSResponse:
    try:
        result = await get_voice_service().synthesize(
            text=request.text,
            language=request.language,
            voice=request.voice,
        )
    except (AudioConfigurationError, AudioProcessingError, ValueError) as exc:
        raise _audio_http_error(exc) from exc
    return TTSResponse(text=request.text, audio=_serialize_audio(result))


@router.post("/chat", response_model=VoiceChatResponse)
async def buddy_audio_chat(
    file: UploadFile = AUDIO_UPLOAD,
    session_id: str | None = Form(None),
    input_language: str | None = Form(None),
    output_language: str | None = Form(None),
    prompt: str | None = Form(None),
    voice: str | None = Form(None),
    include_audio: bool = Form(True),
    include_events: bool = Form(False),
    sync_buddy: bool = Form(False),
) -> VoiceChatResponse:
    try:
        payload = await file.read()
        result = await get_voice_service().chat(
            audio_bytes=payload,
            filename=file.filename,
            content_type=file.content_type,
            session_id=session_id,
            input_language=input_language,
            output_language=output_language,
            prompt=prompt,
            voice=voice,
            include_audio=include_audio,
            sync_buddy=sync_buddy,
        )
    except (AudioConfigurationError, AudioProcessingError, ValueError) as exc:
        raise _audio_http_error(exc) from exc
    return VoiceChatResponse(
        session_id=result.session_id,
        transcript=STTResponse(
            text=result.transcript.text,
            language=result.transcript.language,
            provider=result.transcript.provider,
            duration_seconds=result.transcript.duration_seconds,
            metadata=result.transcript.metadata,
        ),
        final_text=result.final_text,
        output_language=result.output_language,
        reply_audio=_serialize_audio(result.reply_audio) if result.reply_audio else None,
        events=result.events if include_events else None,
    )


def _serialize_audio(result: SynthesisResult) -> SynthesizedAudioResponse:
    return SynthesizedAudioResponse(
        audio_base64=base64.b64encode(result.audio_bytes).decode("ascii"),
        format=result.format,
        mime_type=result.mime_type,
        provider=result.provider,
        language=result.language,
        voice=result.voice,
        sample_rate_hz=result.sample_rate_hz,
        size_bytes=len(result.audio_bytes),
        metadata=result.metadata,
    )


def _audio_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, AudioConfigurationError):
        return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    if isinstance(exc, AudioProcessingError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
