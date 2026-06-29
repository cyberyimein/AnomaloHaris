import base64

from fastapi.testclient import TestClient

from app.agent.events import event
from app.audio import AudioConfigurationError
from app.audio.base import SynthesisResult, TranscriptionResult
from app.audio.service import VoiceChatResult
from app.main import create_app


class FakeVoiceService:
    async def chat(self, **_: object) -> VoiceChatResult:
        events = [
            event(
                "run.finished",
                "session_test",
                "run_1",
                final_text="Turning on the lights.",
            )
        ]
        return VoiceChatResult(
            session_id="session_test",
            transcript=TranscriptionResult(
                text="turn on the lights",
                language="en",
                provider="fake_stt",
            ),
            final_text="Turning on the lights.",
            output_language="en",
            reply_audio=SynthesisResult(
                audio_bytes=b"\x00\x01",
                format="wav",
                mime_type="audio/wav",
                provider="fake_tts",
                language="en",
                voice="en-voice",
                sample_rate_hz=22050,
            ),
            events=events,
        )

    async def transcribe(self, **_: object) -> TranscriptionResult:
        return TranscriptionResult(text="hello", language="en", provider="fake_stt")

    async def synthesize(self, **_: object) -> SynthesisResult:
        return SynthesisResult(
            audio_bytes=b"\x02\x03",
            format="wav",
            mime_type="audio/wav",
            provider="fake_tts",
            language="en",
            voice="en-voice",
            sample_rate_hz=22050,
        )


class FakeBuddyGateway:
    def connect(self) -> dict[str, object]:
        return {"connected": False}

    def disconnect(self) -> dict[str, object]:
        return {"connected": False}


class FakeBuddyAudioBridge:
    def start(self) -> None:
        return

    def stop(self) -> None:
        return


def test_audio_chat_endpoint_returns_audio_and_events(monkeypatch) -> None:
    monkeypatch.setattr("app.api.audio.get_voice_service", lambda: FakeVoiceService())
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    client = TestClient(create_app())

    response = client.post(
        "/api/audio/chat",
        data={"include_events": "true"},
        files={"file": ("input.wav", b"RIFFdata", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == "session_test"
    assert payload["transcript"]["text"] == "turn on the lights"
    assert payload["final_text"] == "Turning on the lights."
    assert payload["reply_audio"]["audio_base64"] == base64.b64encode(b"\x00\x01").decode("ascii")
    assert payload["events"][0]["type"] == "run.finished"


def test_stt_endpoint_surfaces_configuration_errors(monkeypatch) -> None:
    class BrokenVoiceService(FakeVoiceService):
        async def transcribe(self, **_: object) -> TranscriptionResult:
            raise AudioConfigurationError("missing audio dependencies")

    monkeypatch.setattr("app.api.audio.get_voice_service", lambda: BrokenVoiceService())
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    client = TestClient(create_app())

    response = client.post(
        "/api/audio/stt",
        files={"file": ("input.wav", b"RIFFdata", "audio/wav")},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "missing audio dependencies"


def test_tts_endpoint_returns_base64_audio(monkeypatch) -> None:
    monkeypatch.setattr("app.api.audio.get_voice_service", lambda: FakeVoiceService())
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    client = TestClient(create_app())

    response = client.post("/api/audio/tts", json={"text": "hello there", "language": "en"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["text"] == "hello there"
    assert payload["audio"]["provider"] == "fake_tts"
    assert payload["audio"]["audio_base64"] == base64.b64encode(b"\x02\x03").decode("ascii")
