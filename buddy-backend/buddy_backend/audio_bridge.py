from __future__ import annotations

import asyncio
import io
import logging
import math
import subprocess
import sys
import tempfile
import threading
import wave
from array import array
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.audio.base import (
    AudioConfigurationError,
    AudioProcessingError,
    SynthesisResult,
    TranscriptionResult,
)
from app.audio.service import VoiceService
from app.config import Settings

from buddy_backend.gateway import BuddyAudioTurn, BuddyGateway

logger = logging.getLogger(__name__)


class BuddyAudioBridge:
    def __init__(
        self,
        settings: Settings,
        *,
        gateway: BuddyGateway,
        voice: VoiceService,
        output_sample_rate_hz: int = 24000,
        output_chunk_bytes: int = 960,
    ) -> None:
        self.settings = settings
        self.gateway = gateway
        self.voice = voice
        self.output_sample_rate_hz = output_sample_rate_hz
        self.output_chunk_bytes = output_chunk_bytes
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="anomalo-buddy-audio",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self._thread = None

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            turn = self.gateway.wait_for_audio_turn(timeout_seconds=0.25)
            if turn is None:
                continue
            self._process_turn(turn)

    def _process_turn(self, turn: BuddyAudioTurn) -> None:
        try:
            prepared_turn, stats = self._prepare_turn(turn)
            logger.info(
                "Buddy audio turn received: frames=%s bytes=%s "
                "sample_rate_hz=%s duration_ms=%.0f peak=%s rms=%s gain=%.2f",
                prepared_turn.frame_count,
                len(prepared_turn.audio_bytes),
                prepared_turn.sample_rate_hz,
                stats["duration_seconds"] * 1000,
                stats["peak_abs"],
                stats["rms_abs"],
                stats["gain"],
            )
            if _looks_like_missing_speech(stats):
                logger.warning(
                    "Buddy audio capture is too quiet for STT: peak=%s rms=%s duration_ms=%.0f",
                    stats["peak_abs"],
                    stats["rms_abs"],
                    stats["duration_seconds"] * 1000,
                )
                self.gateway.set_state("idle", "mic too quiet")
                return
            self.gateway.set_state("thinking", "transcribing")
            transcript = asyncio.run(self._transcribe_turn(prepared_turn))
            if not transcript.text.strip():
                logger.warning("Buddy transcript was empty after STT.")
                self.gateway.set_state("idle", "ready")
                return
            logger.info(
                "Buddy transcript: language=%s probability=%s text=%s",
                transcript.language,
                transcript.metadata.get("language_probability"),
                _truncate_for_log(transcript.text),
            )

            self.gateway.set_state("thinking", "asking model")
            final_text, _events = asyncio.run(
                self.voice.run_text(
                    text=transcript.text,
                    session_id=f"buddy_{uuid4().hex}",
                    prompt_profile=self.settings.buddy_prompt_profile,
                )
            )
            if not final_text.strip():
                logger.warning("Buddy LLM reply was empty.")
                self.gateway.set_state("idle", "ready")
                return
            logger.info("Buddy reply text: %s", _truncate_for_log(final_text))

            self.gateway.set_state("speaking", "playing answer")
            reply_audio = asyncio.run(self.voice.synthesize(text=final_text))
            buddy_audio = _convert_synthesis_to_buddy_pcm(
                reply_audio,
                sample_rate_hz=self.output_sample_rate_hz,
            )
            self.gateway.send_audio_output(
                buddy_audio,
                sample_rate_hz=self.output_sample_rate_hz,
                chunk_bytes=self.output_chunk_bytes,
            )
            logger.info(
                "Buddy audio output sent: provider=%s format=%s input_bytes=%s output_bytes=%s",
                reply_audio.provider,
                reply_audio.format,
                len(reply_audio.audio_bytes),
                len(buddy_audio),
            )
            self.gateway.set_state("idle", "ready")
        except AudioProcessingError as exc:
            try:
                if _is_empty_transcript_error(exc):
                    logger.warning("Buddy STT produced no transcript; returning to idle.")
                    self.gateway.set_state("idle", "didn't catch that")
                    return
                logger.exception("Buddy audio processing failed.")
                self.gateway.set_state("error", str(exc)[:64])
            except RuntimeError:
                return
        except (AudioConfigurationError, RuntimeError) as exc:
            try:
                logger.exception("Buddy audio bridge failed.")
                self.gateway.set_state("error", str(exc)[:64])
            except RuntimeError:
                return

    async def _transcribe_turn(self, turn: BuddyAudioTurn) -> TranscriptionResult:
        wav_bytes = _pcm16_to_wav_bytes(turn)
        self._persist_debug_audio("last_input_stt.wav", wav_bytes, archive=True)
        auto_result = await _safe_transcribe(
            self.voice,
            audio_bytes=wav_bytes,
            filename="buddy-input.wav",
            content_type="audio/wav",
            vad_filter=False,
        )
        if auto_result is not None and _is_supported_auto_result(auto_result):
            return auto_result
        if auto_result is not None:
            logger.warning(
                "Buddy STT auto result was unsupported or low-confidence: "
                "language=%s probability=%s text=%s",
                auto_result.language,
                auto_result.metadata.get("language_probability"),
                _truncate_for_log(auto_result.text),
            )
        else:
            logger.warning("Buddy STT empty on first pass; retrying with constrained languages.")

        zh_result = await _safe_transcribe(
            self.voice,
            audio_bytes=wav_bytes,
            filename="buddy-input.wav",
            content_type="audio/wav",
            language="zh",
            vad_filter=False,
        )
        en_result = await _safe_transcribe(
            self.voice,
            audio_bytes=wav_bytes,
            filename="buddy-input.wav",
            content_type="audio/wav",
            language="en",
            vad_filter=False,
        )
        _log_candidate("zh", zh_result)
        _log_candidate("en", en_result)
        selected = _select_buddy_transcript(auto_result, zh_result, en_result)
        if selected is not None:
            return selected
        raise AudioProcessingError("Speech-to-text returned an empty transcript.")

    def _prepare_turn(
        self,
        turn: BuddyAudioTurn,
    ) -> tuple[BuddyAudioTurn, dict[str, float | int]]:
        self._persist_debug_audio("last_input_raw.wav", _pcm16_to_wav_bytes(turn), archive=True)
        enhanced_audio = _preprocess_pcm16(turn.audio_bytes)
        normalized_audio, stats = _normalize_pcm16(enhanced_audio)
        prepared_turn = BuddyAudioTurn(
            audio_bytes=normalized_audio,
            sample_rate_hz=turn.sample_rate_hz,
            channels=turn.channels,
            sample_width_bytes=turn.sample_width_bytes,
            frame_count=turn.frame_count,
            started_at=turn.started_at,
            finished_at=turn.finished_at,
        )
        return prepared_turn, {
            **stats,
            "duration_seconds": len(turn.audio_bytes)
            / max(turn.sample_rate_hz * turn.channels * turn.sample_width_bytes, 1),
        }

    def _persist_debug_audio(
        self,
        filename: str,
        audio_bytes: bytes,
        *,
        archive: bool = False,
    ) -> None:
        if not self.settings.should_persist_buddy_debug_audio:
            return
        debug_dir = self.settings.artifacts_dir / "buddy-audio"
        debug_dir.mkdir(parents=True, exist_ok=True)
        target = debug_dir / filename
        target.write_bytes(audio_bytes)
        if archive:
            timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S-%f")
            archive_name = f"{target.stem}-{timestamp}{target.suffix}"
            (debug_dir / archive_name).write_bytes(audio_bytes)


async def _safe_transcribe(
    voice: VoiceService,
    **kwargs: object,
) -> TranscriptionResult | None:
    try:
        return await voice.transcribe(**kwargs)
    except AudioProcessingError as exc:
        if _is_empty_transcript_error(exc):
            return None
        raise


def _is_supported_auto_result(result: TranscriptionResult) -> bool:
    language = result.language
    probability = float(result.metadata.get("language_probability") or 0.0)
    if language not in {"en", "zh"}:
        return False
    return probability >= 0.55


def _log_candidate(label: str, result: TranscriptionResult | None) -> None:
    if result is None:
        logger.info("Buddy STT %s candidate: empty", label)
        return
    logger.info(
        "Buddy STT %s candidate: language=%s probability=%s text=%s",
        label,
        result.language,
        result.metadata.get("language_probability"),
        _truncate_for_log(result.text),
    )


def _select_buddy_transcript(
    auto_result: TranscriptionResult | None,
    zh_result: TranscriptionResult | None,
    en_result: TranscriptionResult | None,
) -> TranscriptionResult | None:
    candidates = [
        ("auto", auto_result),
        ("zh", zh_result),
        ("en", en_result),
    ]
    scored = [
        (_score_transcript_candidate(label, result), label, result)
        for label, result in candidates
        if result is not None and result.text.strip()
    ]
    if not scored:
        return None
    for score, label, result in scored:
        logger.info(
            "Buddy STT candidate score: label=%s score=%.2f text=%s",
            label,
            score,
            _truncate_for_log(result.text),
        )
    scored.sort(key=lambda item: item[0], reverse=True)
    best_score, _best_label, best_result = scored[0]
    if best_score < 22:
        return None
    return best_result


def _score_transcript_candidate(label: str, result: TranscriptionResult) -> float:
    text = result.text.strip()
    probability = float(result.metadata.get("language_probability") or 0.0)
    cjk_count = sum(1 for char in text if _is_cjk(char))
    latin_count = sum(1 for char in text if char.isascii() and char.isalpha())
    score = min(len(text), 40)
    if label == "zh":
        score += cjk_count * 2
        score -= latin_count * 2
        if cjk_count > 0:
            score += 25
    elif label == "en":
        score += latin_count * 1.5
        score -= cjk_count * 4
    else:
        score += probability * 20
        if result.language in {"en", "zh"}:
            score += 10
        else:
            score -= 50
    score -= _hallucination_penalty(text, result.duration_seconds, cjk_count, latin_count)
    return score


def _hallucination_penalty(
    text: str,
    duration_seconds: float | None,
    cjk_count: int,
    latin_count: int,
) -> float:
    normalized = "".join(text.split())
    if not normalized:
        return 100.0

    penalty = 0.0
    if _has_repeated_halves(normalized):
        penalty += 80.0

    unique_ratio = len(set(normalized)) / len(normalized)
    if len(normalized) >= 4 and unique_ratio < 0.5:
        penalty += 25.0

    if duration_seconds and duration_seconds > 0:
        if cjk_count and (cjk_count / duration_seconds) > 7.0:
            penalty += 25.0
        english_words = max(1, len(text.split())) if latin_count else 0
        if english_words and (english_words / duration_seconds) > 4.0:
            penalty += 20.0
    return penalty


def _has_repeated_halves(text: str) -> bool:
    if len(text) < 6 or len(text) % 2 != 0:
        return False
    midpoint = len(text) // 2
    return text[:midpoint] == text[midpoint:]


def _looks_like_missing_speech(stats: dict[str, float | int]) -> bool:
    peak_abs = int(stats.get("peak_abs") or 0)
    rms_abs = int(stats.get("rms_abs") or 0)
    duration_seconds = float(stats.get("duration_seconds") or 0.0)
    return duration_seconds >= 0.4 and peak_abs < 1200 and rms_abs < 120


def _is_cjk(char: str) -> bool:
    codepoint = ord(char)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
    )


def _pcm16_to_wav_bytes(turn: BuddyAudioTurn) -> bytes:
    payload = io.BytesIO()
    with wave.open(payload, "wb") as handle:
        handle.setnchannels(turn.channels)
        handle.setsampwidth(turn.sample_width_bytes)
        handle.setframerate(turn.sample_rate_hz)
        handle.writeframes(turn.audio_bytes)
    return payload.getvalue()


def _convert_synthesis_to_buddy_pcm(
    result: SynthesisResult,
    *,
    sample_rate_hz: int,
) -> bytes:
    if result.format == "wav":
        direct = _read_wav_pcm_frames(result.audio_bytes)
        if direct is not None:
            frame_rate_hz, channels, sample_width_bytes, pcm_bytes = direct
            if frame_rate_hz == sample_rate_hz and channels == 1 and sample_width_bytes == 2:
                return pcm_bytes

    input_suffix = _audio_suffix(result.format)
    with tempfile.NamedTemporaryFile(suffix=input_suffix, delete=False) as source_handle:
        source_path = Path(source_handle.name)
        source_handle.write(result.audio_bytes)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output_handle:
        output_path = Path(output_handle.name)

    try:
        completed = subprocess.run(
            [
                "afconvert",
                "-f",
                "WAVE",
                "-d",
                f"LEI16@{sample_rate_hz}",
                "-c",
                "1",
                str(source_path),
                str(output_path),
            ],
            capture_output=True,
            text=True,
            cwd=str(source_path.parent),
            check=False,
        )
        if completed.returncode != 0:
            stderr = completed.stderr.strip() or completed.stdout.strip() or "unknown error"
            raise AudioConfigurationError(f"afconvert failed while preparing Buddy audio: {stderr}")

        converted = output_path.read_bytes()
        wav_info = _read_wav_pcm_frames(converted)
        if wav_info is None:
            raise AudioConfigurationError("Converted Buddy output audio is not readable as WAV.")
        return wav_info[3]
    except FileNotFoundError as exc:
        raise AudioConfigurationError(
            "Buddy audio playback conversion requires macOS `afconvert`, which was not found."
        ) from exc
    finally:
        source_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)


def _read_wav_pcm_frames(audio_bytes: bytes) -> tuple[int, int, int, bytes] | None:
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as handle:
            return (
                handle.getframerate(),
                handle.getnchannels(),
                handle.getsampwidth(),
                handle.readframes(handle.getnframes()),
            )
    except wave.Error:
        return None


def _audio_suffix(audio_format: str) -> str:
    return {
        "wav": ".wav",
        "aiff": ".aiff",
        "caf": ".caf",
        "m4a": ".m4a",
    }.get(audio_format.lower(), ".bin")


def _is_empty_transcript_error(exc: AudioProcessingError) -> bool:
    return "empty transcript" in str(exc).lower()


def _normalize_pcm16(
    audio_bytes: bytes,
    *,
    target_peak: int = 24000,
    max_gain: float = 24.0,
) -> tuple[bytes, dict[str, float | int]]:
    samples = array("h")
    samples.frombytes(audio_bytes)
    if sys.byteorder != "little":
        samples.byteswap()

    if not samples:
        return audio_bytes, {"peak_abs": 0, "rms_abs": 0, "gain": 1.0}

    peak_abs = max(abs(sample) for sample in samples)
    mean_square = sum(sample * sample for sample in samples) / len(samples)
    rms_abs = int(math.sqrt(mean_square))
    gain = 1.0
    if 0 < peak_abs < target_peak:
        gain = min(max_gain, target_peak / peak_abs)
        for index, sample in enumerate(samples):
            amplified = int(round(sample * gain))
            samples[index] = max(-32768, min(32767, amplified))

    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes(), {"peak_abs": peak_abs, "rms_abs": rms_abs, "gain": gain}


def _preprocess_pcm16(audio_bytes: bytes, *, pre_emphasis: float = 0.97) -> bytes:
    samples = array("h")
    samples.frombytes(audio_bytes)
    if sys.byteorder != "little":
        samples.byteswap()

    if not samples:
        return audio_bytes

    mean = int(sum(samples) / len(samples))
    previous = 0
    for index, sample in enumerate(samples):
        centered = sample - mean
        emphasized = centered - int(pre_emphasis * previous)
        samples[index] = max(-32768, min(32767, emphasized))
        previous = centered

    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes()


def _truncate_for_log(text: str, *, max_chars: int = 160) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= max_chars:
        return normalized
    return normalized[: max_chars - 3] + "..."
