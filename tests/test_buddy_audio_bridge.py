from __future__ import annotations

import asyncio
from pathlib import Path

from app.audio.base import AudioProcessingError, TranscriptionResult
from app.buddy.audio_bridge import (
    BuddyAudioBridge,
    _normalize_pcm16,
    _preprocess_pcm16,
    _select_buddy_transcript,
)
from app.buddy.gateway import BuddyAudioTurn
from app.config import Settings


class FakeGateway:
    def __init__(self) -> None:
        self.states: list[tuple[str, str]] = []
        self.sent_audio: list[bytes] = []

    def set_state(self, state: str, text: str) -> None:
        self.states.append((state, text))

    def send_audio_output(
        self,
        audio_bytes: bytes,
        *,
        sample_rate_hz: int = 24000,
        chunk_bytes: int = 960,
    ) -> dict[str, object]:
        del sample_rate_hz, chunk_bytes
        self.sent_audio.append(audio_bytes)
        return {"connected": True}


class EmptyTranscriptVoice:
    async def transcribe(self, **_: object):  # type: ignore[no-untyped-def]
        raise AudioProcessingError("Speech-to-text returned an empty transcript.")


class RetryChineseVoice:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def transcribe(self, **kwargs: object) -> TranscriptionResult:
        self.calls.append(kwargs)
        if len(self.calls) == 1:
            raise AudioProcessingError("Speech-to-text returned an empty transcript.")
        return TranscriptionResult(text="你好", language="zh", provider="fake_stt")


class GuardrailVoice:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def transcribe(self, **kwargs: object) -> TranscriptionResult:
        self.calls.append(kwargs)
        language = kwargs.get("language")
        if language is None:
            return TranscriptionResult(
                text="Криво-приво.",
                language="ru",
                provider="fake_stt",
                metadata={"language_probability": 0.14},
            )
        if language == "zh":
            return TranscriptionResult(
                text="你好啊",
                language="zh",
                provider="fake_stt",
                metadata={"language_probability": 0.51},
            )
        return TranscriptionResult(
            text="Let's do this.",
            language="en",
            provider="fake_stt",
            metadata={"language_probability": 0.42},
        )


class HallucinationVoice:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def transcribe(self, **kwargs: object) -> TranscriptionResult:
        self.calls.append(kwargs)
        language = kwargs.get("language")
        if language is None:
            return TranscriptionResult(
                text="Oh",
                language="en",
                provider="fake_stt",
                duration_seconds=1.84,
                metadata={"language_probability": 0.44},
            )
        if language == "zh":
            return TranscriptionResult(
                text="我认为你能够做得好 我认为你能够做得好",
                language="zh",
                provider="fake_stt",
                duration_seconds=1.84,
                metadata={"language_probability": 1.0},
            )
        return TranscriptionResult(
            text="Oh",
            language="en",
            provider="fake_stt",
            duration_seconds=1.84,
            metadata={"language_probability": 1.0},
        )


class ExplodingVoice:
    async def transcribe(self, **_: object):  # type: ignore[no-untyped-def]
        raise AssertionError("transcribe should not be called for too-quiet audio")


def test_buddy_audio_bridge_treats_empty_transcript_as_retryable(tmp_path: Path) -> None:
    gateway = FakeGateway()
    bridge = BuddyAudioBridge(
        Settings(),
        gateway=gateway,  # type: ignore[arg-type]
        voice=EmptyTranscriptVoice(),  # type: ignore[arg-type]
    )
    bridge.settings.artifacts_dir = tmp_path  # type: ignore[misc]

    bridge._process_turn(
        BuddyAudioTurn(
            audio_bytes=b"\x00\x00" * 320,
            sample_rate_hz=16000,
            channels=1,
            sample_width_bytes=2,
            frame_count=1,
        )
    )

    assert gateway.states == [
        ("thinking", "transcribing"),
        ("idle", "didn't catch that"),
    ]
    assert gateway.sent_audio == []


def test_buddy_audio_bridge_short_circuits_too_quiet_audio(tmp_path: Path) -> None:
    gateway = FakeGateway()
    bridge = BuddyAudioBridge(
        Settings(),
        gateway=gateway,  # type: ignore[arg-type]
        voice=ExplodingVoice(),  # type: ignore[arg-type]
    )
    bridge.settings.artifacts_dir = tmp_path  # type: ignore[misc]

    bridge._process_turn(
        BuddyAudioTurn(
            audio_bytes=b"\x10\x00" * (320 * 24),
            sample_rate_hz=16000,
            channels=1,
            sample_width_bytes=2,
            frame_count=24,
        )
    )

    assert gateway.states == [("idle", "mic too quiet")]


def test_buddy_audio_bridge_retries_empty_transcript_with_chinese_bias(tmp_path: Path) -> None:
    voice = RetryChineseVoice()
    bridge = BuddyAudioBridge(
        Settings(),
        gateway=FakeGateway(),  # type: ignore[arg-type]
        voice=voice,  # type: ignore[arg-type]
    )
    bridge.settings.artifacts_dir = tmp_path  # type: ignore[misc]

    result = asyncio.run(
        bridge._transcribe_turn(
            BuddyAudioTurn(
                audio_bytes=b"\x00\x00" * 320,
                sample_rate_hz=16000,
                channels=1,
                sample_width_bytes=2,
                frame_count=1,
            )
        )
    )

    assert result.text == "你好"
    assert voice.calls[0]["vad_filter"] is False
    assert voice.calls[0].get("language") is None
    assert voice.calls[1]["vad_filter"] is False
    assert voice.calls[1]["language"] == "zh"
    assert "prompt" not in voice.calls[1]


def test_normalize_pcm16_applies_gain_to_quiet_signal() -> None:
    audio_bytes = (500).to_bytes(2, "little", signed=True) * 8

    normalized, stats = _normalize_pcm16(audio_bytes)

    assert normalized != audio_bytes
    assert stats["peak_abs"] == 500
    assert stats["gain"] > 8.0


def test_preprocess_pcm16_changes_centered_signal_shape() -> None:
    audio_bytes = b"".join(
        sample.to_bytes(2, "little", signed=True)
        for sample in [100, 200, 300, 400, 500, 600, 700, 800]
    )

    processed = _preprocess_pcm16(audio_bytes)

    assert processed != audio_bytes


def test_buddy_audio_bridge_persists_debug_audio_files(tmp_path: Path) -> None:
    bridge = BuddyAudioBridge(
        Settings(),
        gateway=FakeGateway(),  # type: ignore[arg-type]
        voice=RetryChineseVoice(),  # type: ignore[arg-type]
    )
    bridge.settings.artifacts_dir = tmp_path  # type: ignore[misc]

    bridge._persist_debug_audio("sample.wav", b"RIFF")

    assert (tmp_path / "buddy-audio" / "sample.wav").read_bytes() == b"RIFF"


def test_buddy_audio_bridge_prefers_zh_over_unsupported_auto(tmp_path: Path) -> None:
    voice = GuardrailVoice()
    bridge = BuddyAudioBridge(
        Settings(),
        gateway=FakeGateway(),  # type: ignore[arg-type]
        voice=voice,  # type: ignore[arg-type]
    )
    bridge.settings.artifacts_dir = tmp_path  # type: ignore[misc]

    result = asyncio.run(
        bridge._transcribe_turn(
            BuddyAudioTurn(
                audio_bytes=b"\x00\x00" * 320,
                sample_rate_hz=16000,
                channels=1,
                sample_width_bytes=2,
                frame_count=1,
            )
        )
    )

    assert result.language == "zh"
    assert result.text == "你好啊"
    assert [call.get("language") for call in voice.calls] == [None, "zh", "en"]


def test_buddy_audio_bridge_rejects_hallucinated_short_candidates(tmp_path: Path) -> None:
    voice = HallucinationVoice()
    gateway = FakeGateway()
    bridge = BuddyAudioBridge(
        Settings(),
        gateway=gateway,  # type: ignore[arg-type]
        voice=voice,  # type: ignore[arg-type]
    )
    bridge.settings.artifacts_dir = tmp_path  # type: ignore[misc]

    bridge._process_turn(
        BuddyAudioTurn(
            audio_bytes=b"\x00\x00" * (320 * 4),
            sample_rate_hz=16000,
            channels=1,
            sample_width_bytes=2,
            frame_count=4,
        )
    )

    assert gateway.states == [
        ("thinking", "transcribing"),
        ("idle", "didn't catch that"),
    ]


def test_select_buddy_transcript_drops_low_quality_best_candidate() -> None:
    result = _select_buddy_transcript(
        None,
        TranscriptionResult(
            text="我认为你能够做得好 我认为你能够做得好",
            language="zh",
            provider="fake_stt",
            duration_seconds=1.84,
            metadata={"language_probability": 1.0},
        ),
        TranscriptionResult(
            text="Oh",
            language="en",
            provider="fake_stt",
            duration_seconds=1.84,
            metadata={"language_probability": 1.0},
        ),
    )

    assert result is None
