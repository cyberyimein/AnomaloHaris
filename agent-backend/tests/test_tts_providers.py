import asyncio
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

from app.audio.base import AudioConfigurationError
from app.audio.providers import (
    CosyVoiceTTSProvider,
    KokoroTTSProvider,
    MacOSSayTTSProvider,
    _piper_config_path,
)
from app.config import Settings


def test_piper_config_path_accepts_sibling_config(tmp_path: Path) -> None:
    model_path = tmp_path / "voice.onnx"
    model_path.write_bytes(b"")
    config_path = tmp_path / "config.json"
    config_path.write_text("{}", encoding="utf-8")

    assert _piper_config_path(model_path) == config_path


def test_macos_say_provider_returns_wav(monkeypatch, tmp_path: Path) -> None:
    del tmp_path

    def fake_run(  # type: ignore[no-untyped-def]
        command,
        capture_output,
        text,
        cwd,
        env,
        check,
    ):
        del capture_output, text, cwd, env, check
        output_path = Path(command[4])
        output_path.write_bytes(b"FORM\x00\x00\x00\x00AIFF")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    provider = MacOSSayTTSProvider(Settings(ANOMALO_AUDIO_TTS_DEFAULT_VOICE_EN="Samantha"))

    result = asyncio.run(provider.synthesize(text="hello", language="en"))

    assert result.provider == "say"
    assert result.voice == "Samantha"
    assert result.format == "aiff"
    assert result.mime_type == "audio/aiff"
    assert result.sample_rate_hz is None
    assert result.audio_bytes.startswith(b"FORM")


def test_cosyvoice_provider_requires_model_dir() -> None:
    provider = CosyVoiceTTSProvider(Settings(ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH="中文女"))

    with pytest.raises(AudioConfigurationError, match="ANOMALO_AUDIO_TTS_COSYVOICE_MODEL_DIR"):
        asyncio.run(provider.synthesize(text="你好", language="zh"))


def test_cosyvoice_provider_uses_sft_model(monkeypatch, tmp_path: Path) -> None:
    model_dir = tmp_path / "CosyVoice-300M-SFT"
    model_dir.mkdir()

    calls: dict[str, object] = {}

    class FakeModel:
        sample_rate = 22050

        def list_available_spks(self) -> list[str]:
            return ["中文女"]

        def inference_sft(self, text: str, speaker: str, stream: bool = False):  # noqa: FBT002
            calls["text"] = text
            calls["speaker"] = speaker
            calls["stream"] = stream
            return [{"tts_speech": "chunk-a"}, {"tts_speech": "chunk-b"}]

    cosyvoice_module = ModuleType("cosyvoice.cli.cosyvoice")

    def fake_auto_model(*, model: str) -> FakeModel:
        calls["model"] = model
        return FakeModel()

    cosyvoice_module.AutoModel = fake_auto_model

    torch_module = ModuleType("torch")
    torch_module.cat = lambda chunks, dim=-1: ("joined", list(chunks), dim)

    torchaudio_module = ModuleType("torchaudio")

    def fake_save(path: str, speech: object, sample_rate_hz: int) -> None:
        calls["speech"] = speech
        calls["sample_rate_hz"] = sample_rate_hz
        Path(path).write_bytes(b"RIFFdemo")

    torchaudio_module.save = fake_save

    monkeypatch.setitem(sys.modules, "cosyvoice", ModuleType("cosyvoice"))
    monkeypatch.setitem(sys.modules, "cosyvoice.cli", ModuleType("cosyvoice.cli"))
    monkeypatch.setitem(sys.modules, "cosyvoice.cli.cosyvoice", cosyvoice_module)
    monkeypatch.setitem(sys.modules, "torch", torch_module)
    monkeypatch.setitem(sys.modules, "torchaudio", torchaudio_module)

    provider = CosyVoiceTTSProvider(
        Settings(
            ANOMALO_AUDIO_TTS_COSYVOICE_MODEL_DIR=str(model_dir),
            ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH="中文女",
        )
    )

    result = asyncio.run(provider.synthesize(text="你好世界", language="zh"))

    assert calls["model"] == str(model_dir)
    assert calls["text"] == "你好世界"
    assert calls["speaker"] == "中文女"
    assert calls["stream"] is False
    assert calls["speech"] == ("joined", ["chunk-a", "chunk-b"], -1)
    assert calls["sample_rate_hz"] == 22050
    assert result.provider == "cosyvoice"
    assert result.voice == "中文女"
    assert result.format == "wav"
    assert result.mime_type == "audio/wav"
    assert result.audio_bytes.startswith(b"RIFF")


def test_kokoro_provider_requires_voice() -> None:
    provider = KokoroTTSProvider(Settings(ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH=""))

    with pytest.raises(AudioConfigurationError, match="No Kokoro voice"):
        asyncio.run(provider.synthesize(text="你好", language="zh"))


def test_kokoro_provider_generates_wav(monkeypatch) -> None:
    calls: dict[str, object] = {}

    class FakePipeline:
        def __call__(self, text: str, voice: str, speed: float, split_pattern: str):  # noqa: FBT001
            calls["text"] = text
            calls["voice"] = voice
            calls["speed"] = speed
            calls["split_pattern"] = split_pattern
            return [
                ("gs-1", "ps-1", ["a"]),
                ("gs-2", "ps-2", ["b"]),
            ]

    kokoro_module = ModuleType("kokoro")

    def fake_pipeline(*, lang_code: str) -> FakePipeline:
        calls["lang_code"] = lang_code
        return FakePipeline()

    kokoro_module.KPipeline = fake_pipeline

    numpy_module = ModuleType("numpy")
    numpy_module.concatenate = lambda chunks: sum((list(chunk) for chunk in chunks), [])

    soundfile_module = ModuleType("soundfile")

    def fake_write(path: str, audio: object, sample_rate_hz: int) -> None:
        calls["audio"] = audio
        calls["sample_rate_hz"] = sample_rate_hz
        Path(path).write_bytes(b"RIFFdemo")

    soundfile_module.write = fake_write

    monkeypatch.setitem(sys.modules, "kokoro", kokoro_module)
    monkeypatch.setitem(sys.modules, "numpy", numpy_module)
    monkeypatch.setitem(sys.modules, "soundfile", soundfile_module)
    monkeypatch.setattr(sys, "version_info", (3, 12, 9))

    provider = KokoroTTSProvider(
        Settings(
            ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH="zf_xiaoxiao",
            ANOMALO_AUDIO_TTS_KOKORO_SPEED="1.2",
        )
    )

    result = asyncio.run(provider.synthesize(text="你好世界", language="zh"))

    assert calls["lang_code"] == "z"
    assert calls["text"] == "你好世界"
    assert calls["voice"] == "zf_xiaoxiao"
    assert calls["speed"] == 1.2
    assert calls["split_pattern"] == r"\n+"
    assert calls["audio"] == ["a", "b"]
    assert calls["sample_rate_hz"] == 24000
    assert result.provider == "kokoro"
    assert result.voice == "zf_xiaoxiao"
    assert result.format == "wav"
    assert result.mime_type == "audio/wav"
    assert result.audio_bytes.startswith(b"RIFF")
