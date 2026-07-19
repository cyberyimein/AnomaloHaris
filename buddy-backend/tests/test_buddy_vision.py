import pytest
from app.api.security import require_management_access
from app.config import Settings
from app.main import create_app
from buddy_backend.vision import (
    BuddyFaceBox,
    BuddyVisionConfigurationError,
    BuddyVisionImage,
    BuddyVisionService,
    _OpenCvHaarFaceDetector,
)
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


def test_buddy_vision_defaults_to_opencv_haar_provider() -> None:
    assert Settings().buddy_vision_provider == "opencv_haar"


def test_buddy_vision_rejects_unsupported_provider() -> None:
    service = BuddyVisionService(
        Settings(ANOMALO_BUDDY_VISION_PROVIDER="unknown_provider"),
        gateway=FakeBuddyGateway(),  # type: ignore[arg-type]
        image_decoder=lambda _: BuddyVisionImage(pixels=object(), width=320, height=240),
    )

    with pytest.raises(BuddyVisionConfigurationError, match="Unsupported Buddy vision provider"):
        service.detect_image(b"image-bytes")


def test_opencv_haar_detector_upscales_low_resolution_frames() -> None:
    import numpy as np

    class FakeCv2:
        COLOR_RGB2GRAY = 1
        INTER_LINEAR = 2

        def __init__(self) -> None:
            self.resize_calls: list[tuple[float, float]] = []
            self.flip_calls = 0

        def cvtColor(self, pixels: object, color: int) -> object:
            del pixels, color
            return np.zeros((120, 160), dtype=np.uint8)

        def resize(
            self,
            image: object,
            size: object,
            *,
            fx: float,
            fy: float,
            interpolation: int,
        ) -> object:
            del image, size, interpolation
            self.resize_calls.append((fx, fy))
            return np.zeros((360, 480), dtype=np.uint8)

        def flip(self, image: object, flip_code: int) -> object:
            del flip_code
            self.flip_calls += 1
            return image

    class FakeClassifier:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def detectMultiScale(
            self,
            image: object,
            **kwargs: object,
        ) -> list[tuple[int, int, int, int]]:
            self.calls.append({"shape": image.shape, **kwargs})  # type: ignore[attr-defined]
            return [(30, 45, 60, 60)] if len(self.calls) == 1 else []

    detector = _OpenCvHaarFaceDetector.__new__(_OpenCvHaarFaceDetector)
    fake_cv2 = FakeCv2()
    fake_classifier = FakeClassifier()
    detector._cv2 = fake_cv2
    detector._classifiers = [("fake.xml", fake_classifier)]

    faces = detector.detect(
        BuddyVisionImage(
            pixels=np.zeros((120, 160, 3), dtype=np.uint8),
            width=160,
            height=120,
        )
    )

    assert fake_cv2.resize_calls == [(3.0, 3.0)]
    assert fake_cv2.flip_calls == 1
    assert fake_classifier.calls[0]["shape"] == (360, 480)
    assert fake_classifier.calls[0]["minNeighbors"] == 3
    assert faces == [BuddyFaceBox(x=10, y=15, width=20, height=20, score=1.0)]


def test_opencv_haar_detector_uses_relaxed_scan_when_strict_scan_misses() -> None:
    import numpy as np

    class FakeCv2:
        COLOR_RGB2GRAY = 1
        INTER_LINEAR = 2

        def cvtColor(self, pixels: object, color: int) -> object:
            del pixels, color
            return np.zeros((120, 160), dtype=np.uint8)

        def resize(
            self,
            image: object,
            size: object,
            *,
            fx: float,
            fy: float,
            interpolation: int,
        ) -> object:
            del image, size, fx, fy, interpolation
            return np.zeros((360, 480), dtype=np.uint8)

        def flip(self, image: object, flip_code: int) -> object:
            del flip_code
            return image

    class FakeClassifier:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def detectMultiScale(
            self,
            image: object,
            **kwargs: object,
        ) -> list[tuple[int, int, int, int]]:
            del image
            self.calls.append(dict(kwargs))
            if kwargs["minNeighbors"] == 1 and len(self.calls) == 3:
                return [(30, 45, 60, 60)]
            return []

    detector = _OpenCvHaarFaceDetector.__new__(_OpenCvHaarFaceDetector)
    fake_classifier = FakeClassifier()
    detector._cv2 = FakeCv2()
    detector._classifiers = [("fake.xml", fake_classifier)]

    faces = detector.detect(
        BuddyVisionImage(
            pixels=np.zeros((120, 160, 3), dtype=np.uint8),
            width=160,
            height=120,
        )
    )

    assert [call["minNeighbors"] for call in fake_classifier.calls] == [3, 3, 1, 1]
    assert faces == [BuddyFaceBox(x=10, y=15, width=20, height=20, score=0.5)]


def test_buddy_vision_service_lazily_loads_detector_and_looks_at_face() -> None:
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
    assert service.status()["look"]["center_pitch"] == 260
    assert factory_calls == 0

    result = service.detect_image(b"image-bytes", apply_buddy_action=True)

    assert result["face_detected"] is True
    assert result["provider"] == "fake_blazeface"
    assert result["detector_loaded"] is True
    assert factory_calls == 1
    assert gateway.commands == [
        "ROAM PAUSE 0",
        "LOOK -203 335 40",
        "CB idle person nearby",
    ]
    assert result["action"]["look"]["applied"] is True
    assert result["action"]["look"]["yaw"] == -203
    assert result["action"]["look"]["pitch"] == 335
    assert result["action"]["look"]["yaw_delta"] == -203
    assert result["action"]["look"]["pitch_delta"] == 75


def test_buddy_vision_service_skips_look_when_face_is_centered() -> None:
    gateway = FakeBuddyGateway(connected=True)
    service = BuddyVisionService(
        Settings(ANOMALO_BUDDY_VISION_ENABLED=True),
        gateway=gateway,  # type: ignore[arg-type]
        detector_factory=lambda: FakeFaceDetector(
            [BuddyFaceBox(x=140, y=100, width=40, height=40, score=0.82)]
        ),
        image_decoder=lambda _: BuddyVisionImage(pixels=object(), width=320, height=240),
    )

    result = service.detect_image(b"image-bytes", apply_buddy_action=True)

    assert result["face_detected"] is True
    assert gateway.commands == [
        "ROAM PAUSE 0",
        "CB idle person nearby",
    ]
    assert result["action"]["look"]["applied"] is False
    assert result["action"]["look"]["yaw"] == 0
    assert result["action"]["look"]["pitch"] == 260


def test_buddy_vision_service_resumes_roam_when_face_disappears() -> None:
    gateway = FakeBuddyGateway(connected=True)
    detector = FakeFaceDetector([BuddyFaceBox(x=10, y=20, width=40, height=50, score=0.82)])
    service = BuddyVisionService(
        Settings(ANOMALO_BUDDY_VISION_ENABLED=True),
        gateway=gateway,  # type: ignore[arg-type]
        detector_factory=lambda: detector,
        image_decoder=lambda _: BuddyVisionImage(pixels=object(), width=320, height=240),
    )

    service.detect_image(b"image-bytes", apply_buddy_action=True)
    detector.faces = []
    gateway.commands.clear()

    result = service.detect_image(b"image-bytes", apply_buddy_action=True)

    assert result["face_detected"] is False
    assert gateway.commands == ["ROAM RESUME"]
    assert result["action"] == {"applied": True, "commands": ["ROAM RESUME"]}


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
