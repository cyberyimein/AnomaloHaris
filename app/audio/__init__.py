"""Local voice module for STT/TTS and buddy audio turns."""

from app.audio.base import (
    AudioConfigurationError,
    AudioProcessingError,
    SynthesisResult,
    TranscriptionResult,
    infer_text_language,
)
from app.audio.service import VoiceChatResult, VoiceService

__all__ = [
    "AudioConfigurationError",
    "AudioProcessingError",
    "SynthesisResult",
    "TranscriptionResult",
    "infer_text_language",
    "VoiceChatResult",
    "VoiceService",
]
