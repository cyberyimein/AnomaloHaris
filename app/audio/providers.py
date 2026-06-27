from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from types import ModuleType
from typing import Any

from app.audio.base import (
    AudioConfigurationError,
    AudioProcessingError,
    SpeechToTextProvider,
    SynthesisResult,
    TextToSpeechProvider,
    TranscriptionResult,
    normalize_language_code,
)
from app.config import Settings


class FasterWhisperSTTProvider(SpeechToTextProvider):
    name = "faster_whisper"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model: Any | None = None

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
        del content_type
        if not audio_bytes:
            raise AudioProcessingError("Audio payload is empty.")
        return await asyncio.to_thread(
            self._transcribe_sync,
            audio_bytes,
            filename,
            normalize_language_code(language),
            prompt,
            vad_filter,
        )

    def _transcribe_sync(
        self,
        audio_bytes: bytes,
        filename: str | None,
        language: str | None,
        prompt: str | None,
        vad_filter: bool | None,
    ) -> TranscriptionResult:
        model = self._load_model()
        suffix = Path(filename or "input.wav").suffix or ".wav"
        temp_path: Path | None = None
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(audio_bytes)
            temp_path = Path(handle.name)

        try:
            segments, info = model.transcribe(
                str(temp_path),
                language=language,
                initial_prompt=prompt or self.settings.audio_stt_initial_prompt or None,
                beam_size=self.settings.audio_stt_beam_size,
                vad_filter=self.settings.audio_stt_vad_filter if vad_filter is None else vad_filter,
                condition_on_previous_text=False,
            )
            parts = [segment.text.strip() for segment in segments]
            text = " ".join(part for part in parts if part).strip()
            if not text:
                raise AudioProcessingError("Speech-to-text returned an empty transcript.")
            detected_language = normalize_language_code(getattr(info, "language", None)) or language
            duration = getattr(info, "duration", None)
            language_probability = getattr(info, "language_probability", None)
            metadata: dict[str, str | float | int | bool | None] = {
                "model": self.settings.audio_stt_model
            }
            if language_probability is not None:
                metadata["language_probability"] = float(language_probability)
            return TranscriptionResult(
                text=text,
                language=detected_language,
                provider=self.name,
                duration_seconds=float(duration) if duration is not None else None,
                metadata=metadata,
            )
        except AudioProcessingError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise AudioProcessingError(f"Speech-to-text failed: {exc}") from exc
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise AudioConfigurationError(
                "STT provider 'faster_whisper' requires the optional audio dependencies. "
                "Install them with `pip install -e \".[audio]\"`."
            ) from exc

        self._model = WhisperModel(
            self.settings.audio_stt_model,
            device=self.settings.audio_stt_device,
            compute_type=self.settings.audio_stt_compute_type,
            download_root=str(self.settings.audio_model_dir),
        )
        return self._model


class PiperPlusTTSProvider(TextToSpeechProvider):
    name = "piper_plus"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def synthesize(
        self,
        *,
        text: str,
        language: str | None = None,
        voice: str | None = None,
    ) -> SynthesisResult:
        if not text.strip():
            raise AudioProcessingError("Text-to-speech requires non-empty text.")
        return await asyncio.to_thread(self._synthesize_sync, text, language, voice)

    def _synthesize_sync(
        self,
        text: str,
        language: str | None,
        voice: str | None,
    ) -> SynthesisResult:
        selected_language = normalize_language_code(language)
        selected_voice = voice or self.settings.default_tts_voice(selected_language)
        if not selected_voice:
            raise AudioConfigurationError(
                "No Piper voice/model is configured. Set ANOMALO_AUDIO_TTS_DEFAULT_VOICE "
                "or a language-specific default voice."
            )

        _ensure_piper_language_support(selected_language)
        self.settings.audio_model_dir.mkdir(parents=True, exist_ok=True)
        model_path, config_path = self._resolve_piper_model(selected_voice)
        temp_output: Path | None = None
        with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as handle:
            temp_output = Path(handle.name)

        command = [
            sys.executable,
            "-m",
            self.settings.audio_tts_module,
            "--model",
            str(model_path),
            "-f",
            str(temp_output),
            text,
        ]
        if config_path is not None:
            command.extend(["--config", str(config_path)])

        try:
            self._run_piper_command(command, error_prefix="Text-to-speech failed")
            audio_bytes = temp_output.read_bytes()
            sample_rate_hz = _wave_sample_rate(temp_output)
            return SynthesisResult(
                audio_bytes=audio_bytes,
                format="wav",
                mime_type="audio/wav",
                provider=self.name,
                language=selected_language,
                voice=selected_voice,
                sample_rate_hz=sample_rate_hz,
                metadata={"model_path": str(model_path), "module": self.settings.audio_tts_module},
            )
        finally:
            temp_output.unlink(missing_ok=True)

    def _resolve_piper_model(self, selected_voice: str) -> tuple[Path, Path | None]:
        candidate = Path(selected_voice).expanduser()
        if candidate.exists():
            return candidate, _piper_config_path(candidate)

        self._run_piper_command(
            [
                sys.executable,
                "-m",
                self.settings.audio_tts_module,
                "--download-model",
                selected_voice,
                "--download-dir",
                str(self.settings.audio_model_dir),
            ],
            error_prefix="Piper model download failed",
        )
        matches = sorted(self.settings.audio_model_dir.rglob(f"{selected_voice}.onnx"))
        if not matches:
            raise AudioConfigurationError(
                f"Piper model '{selected_voice}' was not found after download. "
                "Set ANOMALO_AUDIO_TTS_DEFAULT_VOICE* to a valid model name or local .onnx path."
            )
        model_path = matches[0]
        return model_path, _piper_config_path(model_path)

    def _run_piper_command(self, command: list[str], *, error_prefix: str) -> None:
        env = dict(os.environ)
        env.setdefault("PIPER_CACHE_DIR", str(self.settings.audio_model_dir))
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            cwd=str(self.settings.project_root),
            env=env,
            check=False,
        )
        if completed.returncode == 0:
            return

        stderr = completed.stderr.strip() or completed.stdout.strip() or "unknown error"
        if "No module named" in stderr:
            raise AudioConfigurationError(
                "TTS provider 'piper_plus' requires the optional audio dependencies. "
                "Install them with `pip install -e \".[audio]\"`."
            )
        raise AudioProcessingError(f"{error_prefix}: {stderr}")


class MacOSSayTTSProvider(TextToSpeechProvider):
    name = "say"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def synthesize(
        self,
        *,
        text: str,
        language: str | None = None,
        voice: str | None = None,
    ) -> SynthesisResult:
        if not text.strip():
            raise AudioProcessingError("Text-to-speech requires non-empty text.")
        return await asyncio.to_thread(self._synthesize_sync, text, language, voice)

    def _synthesize_sync(
        self,
        text: str,
        language: str | None,
        voice: str | None,
    ) -> SynthesisResult:
        if sys.platform != "darwin":
            raise AudioConfigurationError("TTS provider 'say' is only available on macOS.")

        selected_language = normalize_language_code(language)
        selected_voice = voice or self.settings.default_tts_voice(selected_language)
        if not selected_voice:
            raise AudioConfigurationError(
                "No macOS say voice is configured. Set ANOMALO_AUDIO_TTS_DEFAULT_VOICE "
                "or a language-specific default voice."
            )

        temp_output: Path | None = None
        with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as handle:
            temp_output = Path(handle.name)

        command = [
            "say",
            "-v",
            selected_voice,
            "-o",
            str(temp_output),
            text,
        ]
        try:
            _run_command(
                command,
                cwd=self.settings.project_root,
                error_prefix="Text-to-speech failed",
                missing_dependency_message=(
                    "TTS provider 'say' requires the macOS `say` command, which was not found."
                ),
            )
            audio_bytes = temp_output.read_bytes()
            return SynthesisResult(
                audio_bytes=audio_bytes,
                format="aiff",
                mime_type="audio/aiff",
                provider=self.name,
                language=selected_language,
                voice=selected_voice,
                sample_rate_hz=None,
                metadata={"command": "say"},
            )
        finally:
            temp_output.unlink(missing_ok=True)


class KokoroTTSProvider(TextToSpeechProvider):
    name = "kokoro"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._pipelines: dict[str, Any] = {}
        self._numpy: ModuleType | None = None
        self._soundfile: ModuleType | None = None

    async def synthesize(
        self,
        *,
        text: str,
        language: str | None = None,
        voice: str | None = None,
    ) -> SynthesisResult:
        if not text.strip():
            raise AudioProcessingError("Text-to-speech requires non-empty text.")
        return await asyncio.to_thread(self._synthesize_sync, text, language, voice)

    def _synthesize_sync(
        self,
        text: str,
        language: str | None,
        voice: str | None,
    ) -> SynthesisResult:
        selected_language = normalize_language_code(language)
        selected_voice = voice or self.settings.default_tts_voice(selected_language)
        if not selected_voice:
            raise AudioConfigurationError(
                "No Kokoro voice is configured. Set ANOMALO_AUDIO_TTS_DEFAULT_VOICE "
                "or a language-specific default voice."
            )

        lang_code = _kokoro_lang_code(selected_language, selected_voice)
        pipeline = self._load_pipeline(lang_code)

        try:
            chunks = [
                audio
                for _, _, audio in pipeline(
                    text,
                    voice=selected_voice,
                    speed=self.settings.audio_tts_kokoro_speed,
                    split_pattern=r"\n+",
                )
            ]
        except (OSError, RuntimeError, ValueError) as exc:
            raise AudioProcessingError(f"Text-to-speech failed: {exc}") from exc
        if not chunks:
            raise AudioProcessingError("Kokoro returned no audio frames.")

        assert self._numpy is not None
        assert self._soundfile is not None
        audio = chunks[0] if len(chunks) == 1 else self._numpy.concatenate(chunks)
        sample_rate_hz = 24000

        temp_output: Path | None = None
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            temp_output = Path(handle.name)

        try:
            self._soundfile.write(str(temp_output), audio, sample_rate_hz)
            return SynthesisResult(
                audio_bytes=temp_output.read_bytes(),
                format="wav",
                mime_type="audio/wav",
                provider=self.name,
                language=selected_language,
                voice=selected_voice,
                sample_rate_hz=sample_rate_hz,
                metadata={
                    "lang_code": lang_code,
                    "speed": self.settings.audio_tts_kokoro_speed,
                    "voice": selected_voice,
                },
            )
        except (OSError, RuntimeError, ValueError) as exc:
            raise AudioProcessingError(f"Text-to-speech failed: {exc}") from exc
        finally:
            temp_output.unlink(missing_ok=True)

    def _load_pipeline(self, lang_code: str) -> Any:
        if lang_code in self._pipelines:
            return self._pipelines[lang_code]
        if sys.version_info >= (3, 13):
            raise AudioConfigurationError(
                "TTS provider 'kokoro' currently requires Python 3.12 or lower. "
                "This environment is running a newer interpreter."
            )

        try:
            import numpy
            import soundfile
            from kokoro import KPipeline
        except ImportError as exc:
            raise AudioConfigurationError(
                "TTS provider 'kokoro' requires the optional audio dependencies. "
                "Install them with `pip install -e \".[audio]\"`."
            ) from exc

        pipeline = KPipeline(lang_code=lang_code)
        self._pipelines[lang_code] = pipeline
        self._numpy = numpy
        self._soundfile = soundfile
        return pipeline


class CosyVoiceTTSProvider(TextToSpeechProvider):
    name = "cosyvoice"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model: Any | None = None
        self._torch: ModuleType | None = None
        self._torchaudio: ModuleType | None = None

    async def synthesize(
        self,
        *,
        text: str,
        language: str | None = None,
        voice: str | None = None,
    ) -> SynthesisResult:
        if not text.strip():
            raise AudioProcessingError("Text-to-speech requires non-empty text.")
        return await asyncio.to_thread(self._synthesize_sync, text, language, voice)

    def _synthesize_sync(
        self,
        text: str,
        language: str | None,
        voice: str | None,
    ) -> SynthesisResult:
        selected_language = normalize_language_code(language)
        selected_voice = voice or self.settings.default_tts_voice(selected_language)
        if not selected_voice:
            raise AudioConfigurationError(
                "No CosyVoice speaker is configured. Set ANOMALO_AUDIO_TTS_DEFAULT_VOICE "
                "or a language-specific default voice."
            )

        model_dir = self._cosyvoice_model_dir()
        mode = _detect_cosyvoice_mode(model_dir)
        if mode != "sft":
            raise AudioConfigurationError(
                "TTS provider 'cosyvoice' currently supports single-speaker SFT models only. "
                "For a low-compute fixed voice, point ANOMALO_AUDIO_TTS_COSYVOICE_MODEL_DIR at "
                "a CosyVoice-300M-SFT checkout or export."
            )

        model = self._load_model(model_dir)
        available_speakers = getattr(model, "list_available_spks", lambda: [])()
        if available_speakers and selected_voice not in set(available_speakers):
            speaker_preview = ", ".join(str(item) for item in available_speakers[:5])
            raise AudioConfigurationError(
                f"CosyVoice speaker '{selected_voice}' is not available in {model_dir.name}. "
                f"Available speakers: {speaker_preview}"
            )

        try:
            chunks = [
                chunk.get("tts_speech")
                for chunk in model.inference_sft(text, selected_voice, stream=False)
                if chunk.get("tts_speech") is not None
            ]
        except (OSError, RuntimeError, ValueError) as exc:
            raise AudioProcessingError(f"Text-to-speech failed: {exc}") from exc
        if not chunks:
            raise AudioProcessingError("CosyVoice returned no audio frames.")

        assert self._torch is not None
        assert self._torchaudio is not None
        speech = chunks[0] if len(chunks) == 1 else self._torch.cat(chunks, dim=-1)
        sample_rate_hz = int(getattr(model, "sample_rate", 0) or 0) or None
        if sample_rate_hz is None:
            raise AudioProcessingError("CosyVoice did not report an output sample rate.")

        temp_output: Path | None = None
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            temp_output = Path(handle.name)

        try:
            self._torchaudio.save(str(temp_output), speech, sample_rate_hz)
            return SynthesisResult(
                audio_bytes=temp_output.read_bytes(),
                format="wav",
                mime_type="audio/wav",
                provider=self.name,
                language=selected_language,
                voice=selected_voice,
                sample_rate_hz=sample_rate_hz,
                metadata={
                    "model_dir": str(model_dir),
                    "mode": mode,
                    "speaker": selected_voice,
                },
            )
        except (OSError, RuntimeError, ValueError) as exc:
            raise AudioProcessingError(f"Text-to-speech failed: {exc}") from exc
        finally:
            temp_output.unlink(missing_ok=True)

    def _cosyvoice_model_dir(self) -> Path:
        model_dir_value = self.settings.audio_tts_cosyvoice_model_dir
        if not model_dir_value:
            raise AudioConfigurationError(
                "TTS provider 'cosyvoice' requires ANOMALO_AUDIO_TTS_COSYVOICE_MODEL_DIR."
            )
        model_dir = Path(model_dir_value).expanduser()
        if not model_dir.exists():
            raise AudioConfigurationError(f"CosyVoice model directory does not exist: {model_dir}")
        return model_dir

    def _load_model(self, model_dir: Path) -> Any:
        if self._model is not None:
            return self._model

        _ensure_cosyvoice_repo_on_sys_path(self.settings.audio_tts_cosyvoice_repo_dir)
        try:
            import torch
            import torchaudio
            from cosyvoice.cli.cosyvoice import AutoModel
        except ImportError as exc:
            raise AudioConfigurationError(
                "TTS provider 'cosyvoice' requires a CosyVoice runtime. Install the CosyVoice "
                "project and its dependencies, or set ANOMALO_AUDIO_TTS_COSYVOICE_REPO_DIR to "
                "a local CosyVoice checkout."
            ) from exc

        self._model = AutoModel(model=str(model_dir))
        self._torch = torch
        self._torchaudio = torchaudio
        return self._model


def _wave_sample_rate(path: Path) -> int | None:
    try:
        with wave.open(str(path), "rb") as handle:
            return handle.getframerate()
    except (wave.Error, FileNotFoundError):
        return None


def _piper_config_path(model_path: Path) -> Path | None:
    direct = model_path.with_suffix(model_path.suffix + ".json")
    if direct.exists():
        return direct
    sibling_config = model_path.with_name("config.json")
    if sibling_config.exists():
        return sibling_config
    return None


def _ensure_piper_language_support(language: str | None) -> None:
    if language != "en":
        return

    try:
        import nltk
    except ImportError as exc:
        raise AudioConfigurationError(
            "English Piper phonemization requires nltk. Reinstall the audio dependencies."
        ) from exc

    resources = [
        ("taggers/averaged_perceptron_tagger_eng/", "averaged_perceptron_tagger_eng"),
        ("taggers/averaged_perceptron_tagger/", "averaged_perceptron_tagger"),
        ("corpora/cmudict", "cmudict"),
    ]
    for resource_path, resource_name in resources:
        try:
            nltk.data.find(resource_path)
        except LookupError as exc:
            downloaded = nltk.download(resource_name, quiet=True)
            if not downloaded:
                raise AudioConfigurationError(
                    f"Failed to download required nltk resource: {resource_name}"
                ) from exc


def _detect_cosyvoice_mode(model_dir: Path) -> str:
    model_name = model_dir.name.lower()
    if "sft" in model_name:
        return "sft"
    if "instruct" in model_name:
        return "instruct"
    return "base"


def _ensure_cosyvoice_repo_on_sys_path(repo_dir_value: str | None) -> None:
    if not repo_dir_value:
        return
    repo_dir = Path(repo_dir_value).expanduser()
    if not repo_dir.exists():
        raise AudioConfigurationError(f"CosyVoice repository directory does not exist: {repo_dir}")

    search_paths = [repo_dir, repo_dir / "third_party" / "Matcha-TTS"]
    for path in search_paths:
        path_str = str(path)
        if path.exists() and path_str not in sys.path:
            sys.path.insert(0, path_str)


def _kokoro_lang_code(language: str | None, voice: str) -> str:
    voice_lang_code = _kokoro_voice_lang_code(voice)
    if voice_lang_code is not None:
        return voice_lang_code
    if language == "zh":
        return "z"
    if language == "en":
        return "a"
    raise AudioConfigurationError(
        f"Unsupported Kokoro language/voice combination: language={language!r}, voice={voice!r}. "
        "Use a Kokoro voice such as zf_xiaoxiao for Chinese or af_heart for English."
    )


def _kokoro_voice_lang_code(voice: str) -> str | None:
    for prefix, lang_code in (
        ("af_", "a"),
        ("am_", "a"),
        ("bf_", "b"),
        ("bm_", "b"),
        ("ef_", "e"),
        ("em_", "e"),
        ("ff_", "f"),
        ("hf_", "h"),
        ("hm_", "h"),
        ("if_", "i"),
        ("im_", "i"),
        ("jf_", "j"),
        ("jm_", "j"),
        ("pf_", "p"),
        ("pm_", "p"),
        ("zf_", "z"),
        ("zm_", "z"),
    ):
        if voice.startswith(prefix):
            return lang_code
    return None


def _run_command(
    command: list[str],
    *,
    cwd: Path,
    error_prefix: str,
    missing_dependency_message: str,
    env: dict[str, str] | None = None,
) -> None:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            cwd=str(cwd),
            env=env,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AudioConfigurationError(missing_dependency_message) from exc

    if completed.returncode == 0:
        return

    stderr = completed.stderr.strip() or completed.stdout.strip() or "unknown error"
    raise AudioProcessingError(f"{error_prefix}: {stderr}")
