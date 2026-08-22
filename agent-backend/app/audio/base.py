from __future__ import annotations

import re
import unicodedata
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from buddy_backend.audio_contract import AudioConfigurationError, AudioProcessingError

__all__ = ["AudioConfigurationError", "AudioProcessingError"]


def normalize_language_code(language: str | None) -> str | None:
    if language is None:
        return None
    cleaned = language.strip().lower().replace("_", "-")
    if not cleaned or cleaned == "auto":
        return None
    if cleaned.startswith("en"):
        return "en"
    if cleaned.startswith("zh"):
        return "zh"
    head = cleaned.split("-", maxsplit=1)[0]
    return head or None


def infer_text_language(text: str) -> str | None:
    if not text.strip():
        return None

    cjk_count = 0
    latin_count = 0
    for char in text:
        codepoint = ord(char)
        if _is_cjk(codepoint):
            cjk_count += 1
        elif char.isascii() and char.isalpha():
            latin_count += 1

    if cjk_count == 0 and latin_count == 0:
        return None
    if cjk_count >= latin_count:
        return "zh"
    return "en"


_TTS_CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
_TTS_INLINE_CODE_RE = re.compile(r"`[^`]*`")
_TTS_MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_TTS_URL_RE = re.compile(r"https?://\S+|www\.\S+")
_TTS_HTML_TAG_RE = re.compile(r"</?[^>]+>")
_TTS_SHORTCODE_RE = re.compile(r":[a-z0-9_+\-]+:", re.IGNORECASE)
_TTS_BULLET_PREFIX_RE = re.compile(r"^\s*(?:[-*+]|#{1,6}|>+)\s*", re.MULTILINE)
_TTS_EMOJI_RE = re.compile(
    "["
    "\U0000200D"
    "\U00002600-\U000027BF"
    "\U0000FE0F"
    "\U0001F1E6-\U0001F1FF"
    "\U0001F300-\U0001FAFF"
    "]"
)


def sanitize_tts_text(text: str) -> str:
    cleaned = _TTS_CODE_BLOCK_RE.sub(" ", text)
    cleaned = _TTS_MARKDOWN_LINK_RE.sub(r"\1", cleaned)
    cleaned = _TTS_INLINE_CODE_RE.sub(" ", cleaned)
    cleaned = _TTS_URL_RE.sub(" ", cleaned)
    cleaned = _TTS_HTML_TAG_RE.sub(" ", cleaned)
    cleaned = _TTS_SHORTCODE_RE.sub(" ", cleaned)
    cleaned = _TTS_BULLET_PREFIX_RE.sub("", cleaned)
    cleaned = re.sub(r"@(?=\w)", "", cleaned)
    cleaned = cleaned.replace("**", "").replace("__", "").replace("~~", "")
    cleaned = re.sub(r"[_/\\]+", " ", cleaned)
    cleaned = _TTS_EMOJI_RE.sub(" ", cleaned)
    cleaned = "".join(char if _is_tts_safe_character(char) else " " for char in cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str | None
    provider: str
    duration_seconds: float | None = None
    metadata: dict[str, str | float | int | bool | None] = field(default_factory=dict)


@dataclass(frozen=True)
class SynthesisResult:
    audio_bytes: bytes
    format: str
    mime_type: str
    provider: str
    language: str | None = None
    voice: str | None = None
    sample_rate_hz: int | None = None
    metadata: dict[str, str | float | int | bool | None] = field(default_factory=dict)


class SpeechToTextProvider(ABC):
    name: str

    @abstractmethod
    async def transcribe(
        self,
        *,
        audio_bytes: bytes,
        filename: str | None = None,
        content_type: str | None = None,
        language: str | None = None,
        prompt: str | None = None,
        vad_filter: bool | None = None,
    ) -> TranscriptionResult:
        raise NotImplementedError


class TextToSpeechProvider(ABC):
    name: str

    @abstractmethod
    async def synthesize(
        self,
        *,
        text: str,
        language: str | None = None,
        voice: str | None = None,
    ) -> SynthesisResult:
        raise NotImplementedError


def _is_cjk(codepoint: int) -> bool:
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
    )


def _is_tts_safe_character(char: str) -> bool:
    if char.isspace():
        return True
    category = unicodedata.category(char)
    return category[0] in {"L", "N", "P"}
