from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import uuid4

from app.agent.events import AgentEvent
from app.agent.runtime import AgentRuntime
from app.audio import AudioConfigurationError
from app.audio.base import (
    AudioProcessingError,
    SpeechToTextProvider,
    SynthesisResult,
    TextToSpeechProvider,
    TranscriptionResult,
    infer_text_language,
    normalize_language_code,
    sanitize_tts_text,
)
from app.config import Settings

if TYPE_CHECKING:
    from app.buddy.gateway import BuddyGateway


@dataclass(frozen=True)
class VoiceChatResult:
    session_id: str
    transcript: TranscriptionResult
    final_text: str
    output_language: str | None
    reply_audio: SynthesisResult | None
    events: list[AgentEvent]


class VoiceService:
    def __init__(
        self,
        *,
        settings: Settings,
        runtime: AgentRuntime,
        buddy: BuddyGateway | None,
        stt: SpeechToTextProvider,
        tts: TextToSpeechProvider,
    ) -> None:
        self.settings = settings
        self.runtime = runtime
        self.buddy = buddy
        self.stt = stt
        self.tts = tts

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
        requested_language = normalize_language_code(language) or normalize_language_code(
            self.settings.audio_default_input_language
        )
        return await self.stt.transcribe(
            audio_bytes=audio_bytes,
            filename=filename,
            content_type=content_type,
            language=requested_language,
            prompt=prompt,
            vad_filter=vad_filter,
        )

    async def synthesize(
        self,
        *,
        text: str,
        language: str | None = None,
        voice: str | None = None,
    ) -> SynthesisResult:
        selected_language = (
            normalize_language_code(language)
            or infer_text_language(text)
            or normalize_language_code(self.settings.audio_default_output_language)
        )
        sanitized_text = sanitize_tts_text(text)
        if not sanitized_text:
            raise AudioProcessingError("Text-to-speech text became empty after sanitization.")

        result = await self.tts.synthesize(
            text=sanitized_text,
            language=selected_language,
            voice=voice,
        )
        if sanitized_text == text:
            return result

        metadata = dict(result.metadata)
        metadata["text_sanitized"] = True
        metadata["original_text_length"] = len(text)
        metadata["synthesized_text_length"] = len(sanitized_text)
        return SynthesisResult(
            audio_bytes=result.audio_bytes,
            format=result.format,
            mime_type=result.mime_type,
            provider=result.provider,
            language=result.language,
            voice=result.voice,
            sample_rate_hz=result.sample_rate_hz,
            metadata=metadata,
        )

    async def run_text(
        self,
        *,
        text: str,
        session_id: str | None = None,
        prompt_profile: str | None = None,
    ) -> tuple[str, list[AgentEvent]]:
        actual_session_id = session_id or f"session_{uuid4().hex}"
        return await self._run_agent(
            actual_session_id,
            text,
            prompt_profile=prompt_profile or self.settings.buddy_prompt_profile,
        )

    async def chat(
        self,
        *,
        audio_bytes: bytes,
        filename: str | None = None,
        content_type: str | None = None,
        session_id: str | None = None,
        input_language: str | None = None,
        output_language: str | None = None,
        voice: str | None = None,
        prompt: str | None = None,
        prompt_profile: str | None = None,
        include_audio: bool = True,
        sync_buddy: bool = False,
    ) -> VoiceChatResult:
        if sync_buddy:
            await self._buddy_state("thinking", "transcribing")
        actual_session_id = session_id or f"session_{uuid4().hex}"
        try:
            transcript = await self.transcribe(
                audio_bytes=audio_bytes,
                filename=filename,
                content_type=content_type,
                language=input_language,
                prompt=prompt,
            )
            if sync_buddy:
                await self._buddy_state("thinking", "asking model")
            final_text, events = await self._run_agent(
                actual_session_id,
                transcript.text,
                prompt_profile=prompt_profile or self.settings.buddy_prompt_profile,
            )
            resolved_output_language = (
                normalize_language_code(output_language)
                or infer_text_language(final_text)
                or transcript.language
                or normalize_language_code(self.settings.audio_default_output_language)
            )
            reply_audio = None
            if include_audio and final_text.strip():
                if sync_buddy:
                    await self._buddy_state("speaking", "playing answer")
                reply_audio = await self.synthesize(
                    text=final_text,
                    language=resolved_output_language,
                    voice=voice,
                )
            if sync_buddy:
                await self._buddy_state("idle", "ready")
            return VoiceChatResult(
                session_id=actual_session_id,
                transcript=transcript,
                final_text=final_text,
                output_language=resolved_output_language,
                reply_audio=reply_audio,
                events=events,
            )
        except Exception as exc:
            if sync_buddy:
                await self._buddy_state("error", str(exc)[:64], require_connection=False)
            raise

    async def _run_agent(
        self,
        session_id: str,
        message: str,
        *,
        prompt_profile: str,
    ) -> tuple[str, list[AgentEvent]]:
        events: list[AgentEvent] = []
        final_text = ""
        async for item in self.runtime.run(session_id, message, prompt_profile=prompt_profile):
            events.append(item)
            if item.type == "run.finished":
                final_text = str(item.data.get("final_text") or "")
        return final_text, events

    async def _buddy_state(
        self,
        state: str,
        text: str,
        *,
        require_connection: bool = True,
    ) -> None:
        if self.buddy is None:
            if require_connection:
                raise AudioConfigurationError("Buddy gateway is not available.")
            return
        if require_connection and not self.buddy.is_connected():
            raise AudioConfigurationError("Buddy is not connected.")
        if not require_connection and not self.buddy.is_connected():
            return
        await asyncio.to_thread(self.buddy.set_state, state, text)
