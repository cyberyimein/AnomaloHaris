import pytest

from app.agent.events import event
from app.audio.base import AudioProcessingError, SynthesisResult, TranscriptionResult
from app.audio.service import VoiceService
from app.config import Settings


class FakeSTTProvider:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def transcribe(self, **kwargs: object) -> TranscriptionResult:
        self.calls.append(kwargs)
        return TranscriptionResult(
            text="你好，打开客厅灯",
            language="zh",
            provider="fake_stt",
            duration_seconds=1.2,
        )


class FakeTTSProvider:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def synthesize(self, **kwargs: object) -> SynthesisResult:
        self.calls.append(kwargs)
        return SynthesisResult(
            audio_bytes=b"wave",
            format="wav",
            mime_type="audio/wav",
            provider="fake_tts",
            language=str(kwargs.get("language") or ""),
            voice=kwargs.get("voice"),
            sample_rate_hz=16000,
        )


class FakeRuntime:
    def __init__(self) -> None:
        self.calls: list[dict[str, str | None]] = []

    async def run(
        self,
        session_id: str,
        user_content: str,
        *,
        prompt_profile: str | None = None,
    ):  # type: ignore[no-untyped-def]
        self.calls.append(
            {
                "session_id": session_id,
                "user_content": user_content,
                "prompt_profile": prompt_profile,
            }
        )
        yield event("run.started", session_id, "run_1")
        yield event("message.delta", session_id, "run_1", content="好的")
        yield event("run.finished", session_id, "run_1", final_text=f"已处理: {user_content}")


class FakeBuddyGateway:
    def __init__(self) -> None:
        self.states: list[tuple[str, str]] = []

    def is_connected(self) -> bool:
        return True

    def set_state(self, state: str, text: str) -> dict[str, str]:
        self.states.append((state, text))
        return {"state": state, "text": text}


@pytest.mark.asyncio
async def test_voice_service_uses_transcript_language_for_reply_audio() -> None:
    stt = FakeSTTProvider()
    tts = FakeTTSProvider()
    settings = Settings(
        audio_default_output_language="en",
        audio_tts_default_voice="fallback-voice",
        audio_tts_default_voice_zh="zh-voice",
    )
    runtime = FakeRuntime()
    service = VoiceService(settings=settings, runtime=runtime, buddy=None, stt=stt, tts=tts)

    result = await service.chat(
        audio_bytes=b"audio",
        filename="buddy.wav",
        session_id="session_voice",
        include_audio=True,
    )

    assert result.session_id == "session_voice"
    assert result.transcript.text == "你好，打开客厅灯"
    assert result.final_text == "已处理: 你好，打开客厅灯"
    assert runtime.calls[0]["prompt_profile"] == "buddy_voice"
    assert result.output_language == "zh"
    assert tts.calls[0]["language"] == "zh"
    assert tts.calls[0]["voice"] is None
    assert result.reply_audio is not None
    assert result.events[-1].type == "run.finished"


@pytest.mark.asyncio
async def test_voice_service_prefers_reply_text_language_for_audio() -> None:
    class EnglishReplyRuntime:
        async def run(
            self,
            session_id: str,
            user_content: str,
            *,
            prompt_profile: str | None = None,
        ):  # type: ignore[no-untyped-def]
            del prompt_profile
            del user_content
            yield event("run.finished", session_id, "run_2", final_text="Handled successfully.")

    stt = FakeSTTProvider()
    tts = FakeTTSProvider()
    service = VoiceService(
        settings=Settings(audio_default_output_language="zh"),
        runtime=EnglishReplyRuntime(),
        buddy=None,
        stt=stt,
        tts=tts,
    )

    result = await service.chat(audio_bytes=b"audio", include_audio=True)

    assert result.output_language == "en"
    assert tts.calls[0]["language"] == "en"


@pytest.mark.asyncio
async def test_voice_service_sanitizes_reply_text_before_audio() -> None:
    class MarkdownReplyRuntime:
        async def run(
            self,
            session_id: str,
            user_content: str,
            *,
            prompt_profile: str | None = None,
        ):  # type: ignore[no-untyped-def]
            del prompt_profile
            del session_id, user_content
            yield event(
                "run.finished",
                "session_md",
                "run_3",
                final_text="看这里 😂 [说明](https://example.com) `rm -rf`",
            )

    tts = FakeTTSProvider()
    service = VoiceService(
        settings=Settings(audio_default_output_language="zh"),
        runtime=MarkdownReplyRuntime(),
        buddy=None,
        stt=FakeSTTProvider(),
        tts=tts,
    )

    result = await service.chat(audio_bytes=b"audio", include_audio=True)

    assert tts.calls[0]["text"] == "看这里 说明"
    assert result.reply_audio is not None
    assert result.reply_audio.metadata["text_sanitized"] is True


@pytest.mark.asyncio
async def test_voice_service_rejects_text_that_becomes_empty_after_sanitization() -> None:
    service = VoiceService(
        settings=Settings(audio_default_output_language="zh"),
        runtime=FakeRuntime(),
        buddy=None,
        stt=FakeSTTProvider(),
        tts=FakeTTSProvider(),
    )

    with pytest.raises(AudioProcessingError, match="empty after sanitization"):
        await service.synthesize(text="😂 https://example.com", language="zh")


@pytest.mark.asyncio
async def test_voice_service_skips_audio_when_not_requested() -> None:
    stt = FakeSTTProvider()
    tts = FakeTTSProvider()
    service = VoiceService(
        settings=Settings(audio_default_output_language="en"),
        runtime=FakeRuntime(),
        buddy=None,
        stt=stt,
        tts=tts,
    )

    result = await service.chat(
        audio_bytes=b"audio",
        include_audio=False,
        output_language="en-US",
    )

    assert result.reply_audio is None
    assert result.output_language == "en"
    assert tts.calls == []


@pytest.mark.asyncio
async def test_voice_service_syncs_buddy_states_when_requested() -> None:
    stt = FakeSTTProvider()
    tts = FakeTTSProvider()
    buddy = FakeBuddyGateway()
    service = VoiceService(
        settings=Settings(audio_default_output_language="zh"),
        runtime=FakeRuntime(),
        buddy=buddy,
        stt=stt,
        tts=tts,
    )

    result = await service.chat(audio_bytes=b"audio", include_audio=True, sync_buddy=True)

    assert result.reply_audio is not None
    assert buddy.states == [
        ("thinking", "transcribing"),
        ("thinking", "asking model"),
        ("speaking", "playing answer"),
        ("idle", "ready"),
    ]
