from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from io import BytesIO
from typing import Any, Protocol

from app.config import Settings

from buddy_backend.gateway import BuddyConnectionError, BuddyGateway


class BuddyVisionConfigurationError(RuntimeError):
    """Raised when Buddy vision dependencies or settings are unavailable."""


class BuddyVisionProcessingError(RuntimeError):
    """Raised when an uploaded image cannot be processed."""


@dataclass(frozen=True)
class BuddyVisionImage:
    pixels: Any
    width: int
    height: int


@dataclass(frozen=True)
class BuddyFaceBox:
    x: int
    y: int
    width: int
    height: int
    score: float

    def as_dict(self) -> dict[str, int | float]:
        return asdict(self)


class BuddyFaceDetector(Protocol):
    provider: str

    def detect(self, image: BuddyVisionImage) -> list[BuddyFaceBox]:
        """Return candidate face boxes for an RGB image."""


class BuddyVisionService:
    def __init__(
        self,
        settings: Settings,
        *,
        gateway: BuddyGateway,
        detector_factory: Callable[[], BuddyFaceDetector] | None = None,
        image_decoder: Callable[[bytes], BuddyVisionImage] | None = None,
    ) -> None:
        self.settings = settings
        self.gateway = gateway
        self._detector_factory = detector_factory or (
            lambda: _MediaPipeBlazeFaceDetector(settings)
        )
        self._image_decoder = image_decoder or self._decode_image
        self._detector: BuddyFaceDetector | None = None
        self._last_detection: dict[str, Any] | None = None

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.settings.buddy_vision_enabled,
            "provider": self.settings.buddy_vision_provider,
            "detector_loaded": self._detector is not None,
            "score_threshold": self.settings.buddy_vision_score_threshold,
            "pause_ms": self.settings.buddy_vision_pause_ms,
            "last_detection": self._last_detection,
        }

    def detect_image(
        self,
        image_bytes: bytes,
        *,
        apply_buddy_action: bool = False,
        min_confidence: float | None = None,
    ) -> dict[str, Any]:
        if not image_bytes:
            raise BuddyVisionProcessingError("Buddy vision image payload must not be empty.")
        if len(image_bytes) > self.settings.buddy_vision_max_upload_bytes:
            raise BuddyVisionProcessingError(
                "Buddy vision image payload exceeds "
                f"{self.settings.buddy_vision_max_upload_bytes} bytes."
            )

        threshold = (
            min_confidence
            if min_confidence is not None
            else self.settings.buddy_vision_score_threshold
        )
        if threshold < 0 or threshold > 1:
            raise BuddyVisionProcessingError("Buddy vision min_confidence must be between 0 and 1.")

        image = self._image_decoder(image_bytes)
        detector = self._get_detector()
        started = time.perf_counter()
        candidates = detector.detect(image)
        inference_ms = round((time.perf_counter() - started) * 1000, 2)
        faces = [face for face in candidates if face.score >= threshold]
        face_detected = bool(faces)
        action = (
            self._apply_face_detected_action()
            if apply_buddy_action and face_detected
            else None
        )

        result = {
            "face_detected": face_detected,
            "faces": [face.as_dict() for face in faces],
            "candidate_count": len(candidates),
            "provider": detector.provider,
            "detector_loaded": True,
            "score_threshold": threshold,
            "image": {"width": image.width, "height": image.height},
            "inference_ms": inference_ms,
            "action": action,
        }
        self._last_detection = result
        return result

    def _get_detector(self) -> BuddyFaceDetector:
        if self._detector is None:
            self._detector = self._detector_factory()
        return self._detector

    def _decode_image(self, image_bytes: bytes) -> BuddyVisionImage:
        try:
            import numpy as np
            from PIL import Image
        except ImportError as exc:
            raise BuddyVisionConfigurationError(
                "Buddy vision requires optional dependencies. Install with "
                '`pip install -e ".[vision]"` in the Anomalo environment.'
            ) from exc

        try:
            with Image.open(BytesIO(image_bytes)) as image:
                rgb_image = image.convert("RGB")
                max_dimension = self.settings.buddy_vision_max_image_dimension
                if max(rgb_image.size) > max_dimension:
                    rgb_image.thumbnail((max_dimension, max_dimension))
                pixels = np.ascontiguousarray(np.asarray(rgb_image))
                return BuddyVisionImage(
                    pixels=pixels,
                    width=int(rgb_image.width),
                    height=int(rgb_image.height),
                )
        except Exception as exc:  # noqa: BLE001
            raise BuddyVisionProcessingError(f"Failed to decode Buddy vision image: {exc}") from exc

    def _apply_face_detected_action(self) -> dict[str, Any]:
        if not self.settings.buddy_vision_enabled:
            return {"applied": False, "reason": "buddy vision actions are disabled"}
        if not self.gateway.is_connected():
            return {"applied": False, "reason": "Buddy is not connected"}

        pause_ms = self.settings.buddy_vision_pause_ms
        commands = [
            f"ROAM PAUSE {pause_ms}",
            "HOME",
            "CB idle person nearby",
        ]
        sent_commands: list[str] = []
        try:
            for command in commands:
                self.gateway.send_raw_command(command)
                sent_commands.append(command)
        except BuddyConnectionError as exc:
            return {"applied": False, "commands": sent_commands, "error": str(exc)}
        return {"applied": True, "commands": sent_commands, "pause_ms": pause_ms}


class _MediaPipeBlazeFaceDetector:
    provider = "mediapipe_blazeface_full_range"

    def __init__(self, settings: Settings) -> None:
        try:
            import mediapipe as mp
        except ImportError as exc:
            raise BuddyVisionConfigurationError(
                "Buddy vision requires MediaPipe BlazeFace. Install with "
                '`pip install -e ".[vision]"` in the Anomalo environment.'
            ) from exc

        if settings.buddy_vision_provider != "mediapipe_blazeface":
            raise BuddyVisionConfigurationError(
                f"Unsupported Buddy vision provider: {settings.buddy_vision_provider}"
            )

        self._face_detection = mp.solutions.face_detection.FaceDetection(
            model_selection=settings.buddy_vision_model_selection,
            min_detection_confidence=settings.buddy_vision_detector_min_confidence,
        )

    def detect(self, image: BuddyVisionImage) -> list[BuddyFaceBox]:
        results = self._face_detection.process(image.pixels)
        detections = results.detections or []
        faces: list[BuddyFaceBox] = []
        for detection in detections:
            relative_box = detection.location_data.relative_bounding_box
            score = float(detection.score[0]) if detection.score else 0.0
            x_min = _clamp(float(relative_box.xmin))
            y_min = _clamp(float(relative_box.ymin))
            x_max = _clamp(float(relative_box.xmin + relative_box.width))
            y_max = _clamp(float(relative_box.ymin + relative_box.height))
            width = max(0, int(round((x_max - x_min) * image.width)))
            height = max(0, int(round((y_max - y_min) * image.height)))
            if width <= 0 or height <= 0:
                continue
            faces.append(
                BuddyFaceBox(
                    x=int(round(x_min * image.width)),
                    y=int(round(y_min * image.height)),
                    width=width,
                    height=height,
                    score=score,
                )
            )
        return faces


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))
