from app.api.security import require_management_access
from app.config import Settings
from app.main import create_app
from buddy_backend.vision import BuddyFaceBox, BuddyVisionImage, BuddyVisionService
from buddy_backend.vision_api import require_buddy_vision_frame_access
from fastapi.testclient import TestClient


class FakeFaceDetector:
    provider = "fake_blazeface"

    def __init__(self, faces: list[BuddyFaceBox]) -> None:
        self.faces = faces

    def detect(self, image: BuddyVisionImage) -> list[BuddyFaceBox]:
        del image
        return self.faces


class FakeBuddyGateway:
    def __init__(self, *, connected: bool = True) -> None:
        self.connected = connected
        self.commands: list[str] = []

    def is_connected(self) -> bool:
        return self.connected

    def send_raw_command(self, command: str) -> dict[str, object]:
        self.commands.append(command)
        return {"command": command, "connected": self.connected}


class FakeBuddyAudioBridge:
    def start(self) -> None:
        return

    def stop(self) -> None:
        return


def test_buddy_vision_service_lazily_loads_detector_and_pauses_roaming() -> None:
    gateway = FakeBuddyGateway(connected=True)
    factory_calls = 0

    def detector_factory() -> FakeFaceDetector:
        nonlocal factory_calls
        factory_calls += 1
        return FakeFaceDetector([BuddyFaceBox(x=10, y=20, width=40, height=50, score=0.82)])

    service = BuddyVisionService(
        Settings(ANOMALO_BUDDY_VISION_ENABLED=True),
        gateway=gateway,  # type: ignore[arg-type]
        detector_factory=detector_factory,
        image_decoder=lambda _: BuddyVisionImage(pixels=object(), width=320, height=240),
    )

    assert service.status()["detector_loaded"] is False
    assert factory_calls == 0

    result = service.detect_image(b"image-bytes", apply_buddy_action=True)

    assert result["face_detected"] is True
    assert result["provider"] == "fake_blazeface"
    assert result["detector_loaded"] is True
    assert factory_calls == 1
    assert gateway.commands == [
        "ROAM PAUSE 300000",
        "HOME",
        "CB idle person nearby",
    ]


def test_buddy_vision_service_filters_low_confidence_candidates() -> None:
    gateway = FakeBuddyGateway(connected=True)
    service = BuddyVisionService(
        Settings(ANOMALO_BUDDY_VISION_ENABLED=True),
        gateway=gateway,  # type: ignore[arg-type]
        detector_factory=lambda: FakeFaceDetector(
            [BuddyFaceBox(x=10, y=20, width=40, height=50, score=0.2)]
        ),
        image_decoder=lambda _: BuddyVisionImage(pixels=object(), width=320, height=240),
    )

    result = service.detect_image(
        b"image-bytes",
        apply_buddy_action=True,
        min_confidence=0.5,
    )

    assert result["face_detected"] is False
    assert result["candidate_count"] == 1
    assert result["faces"] == []
    assert gateway.commands == []


def test_buddy_vision_detect_endpoint_uses_uploaded_image(monkeypatch) -> None:
    service = FakeVisionService()
    monkeypatch.setattr("buddy_backend.vision_api.get_buddy_vision_service", lambda: service)
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    app = create_app()
    app.dependency_overrides[require_management_access] = lambda: None
    client = TestClient(app)

    response = client.post(
        "/api/buddy/vision/detect",
        data={"apply_buddy_action": "true", "min_confidence": "0.6"},
        files={"file": ("frame.jpg", b"fake-image", "image/jpeg")},
    )

    assert response.status_code == 200
    assert response.json()["face_detected"] is True
    assert service.calls == [
        {
            "image_bytes": b"fake-image",
            "apply_buddy_action": True,
            "min_confidence": 0.6,
        }
    ]


def test_buddy_vision_frame_endpoint_applies_buddy_action_by_default(monkeypatch) -> None:
    service = FakeVisionService()
    monkeypatch.setattr("buddy_backend.vision_api.get_buddy_vision_service", lambda: service)
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    app = create_app()
    app.dependency_overrides[require_buddy_vision_frame_access] = lambda: None
    client = TestClient(app)

    response = client.post(
        "/api/buddy/vision/frame",
        files={"file": ("frame.jpg", b"fake-image", "image/jpeg")},
    )

    assert response.status_code == 200
    assert service.calls[0]["apply_buddy_action"] is True


def test_buddy_vision_frame_endpoint_accepts_frame_token(monkeypatch) -> None:
    service = FakeVisionService()
    monkeypatch.setattr("buddy_backend.vision_api.get_buddy_vision_service", lambda: service)
    monkeypatch.setattr(
        "buddy_backend.vision_api.get_settings",
        lambda: Settings(ANOMALO_BUDDY_VISION_FRAME_TOKEN="frame-token"),
    )
    monkeypatch.setattr("app.main.get_buddy_gateway", lambda: FakeBuddyGateway())
    monkeypatch.setattr("app.main.get_buddy_audio_bridge", lambda: FakeBuddyAudioBridge())
    client = TestClient(create_app())

    response = client.post(
        "/api/buddy/vision/frame",
        headers={"X-Anomalo-Buddy-Vision-Token": "frame-token"},
        files={"file": ("frame.jpg", b"fake-image", "image/jpeg")},
    )

    assert response.status_code == 200
    assert service.calls[0]["image_bytes"] == b"fake-image"


class FakeVisionService:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def status(self) -> dict[str, object]:
        return {"detector_loaded": False}

    def detect_image(
        self,
        image_bytes: bytes,
        *,
        apply_buddy_action: bool = False,
        min_confidence: float | None = None,
    ) -> dict[str, object]:
        self.calls.append(
            {
                "image_bytes": image_bytes,
                "apply_buddy_action": apply_buddy_action,
                "min_confidence": min_confidence,
            }
        )
        return {
            "face_detected": True,
            "faces": [{"x": 1, "y": 2, "width": 3, "height": 4, "score": 0.9}],
            "provider": "fake_blazeface",
            "detector_loaded": True,
        }
