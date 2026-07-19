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
        self._detector_factory = detector_factory or (lambda: _create_face_detector(settings))
        self._image_decoder = image_decoder or self._decode_image
        self._detector: BuddyFaceDetector | None = None
        self._last_detection: dict[str, Any] | None = None
        self._roam_paused_by_vision = False
        self._enabled = settings.buddy_vision_enabled

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self._enabled,
            "configured_enabled": self.settings.buddy_vision_enabled,
            "active": self._detector is not None and self._enabled,
            "provider": self.settings.buddy_vision_provider,
            "detector_loaded": self._detector is not None,
            "score_threshold": self.settings.buddy_vision_score_threshold,
            "pause_ms": self.settings.buddy_vision_pause_ms,
            "look": {
                "enabled": self.settings.buddy_vision_look_enabled,
                "max_yaw_degrees": self.settings.buddy_vision_look_max_yaw_degrees,
                "max_pitch_degrees": self.settings.buddy_vision_look_max_pitch_degrees,
                "center_yaw": self.settings.buddy_vision_look_center_yaw,
                "center_pitch": self.settings.buddy_vision_look_center_pitch,
                "speed": self.settings.buddy_vision_look_speed,
                "deadband": self.settings.buddy_vision_look_deadband,
                "invert_x": self.settings.buddy_vision_look_invert_x,
                "invert_y": self.settings.buddy_vision_look_invert_y,
            },
            "last_detection": self._last_detection,
        }

    def start(self) -> dict[str, Any]:
        if not self._enabled:
            raise BuddyVisionConfigurationError(
                "Buddy vision is disabled. Enable Vision before starting face detection."
            )
        self._get_detector()
        return self.status()

    def stop(self) -> dict[str, Any]:
        self._detector = None
        return self.status()

    def enable(self) -> dict[str, Any]:
        if not self.settings.buddy_vision_enabled:
            raise BuddyVisionConfigurationError(
                "Buddy vision is unavailable. Set ANOMALO_BUDDY_VISION_ENABLED=true."
            )
        self._enabled = True
        return self.status()

    def disable(self) -> dict[str, Any]:
        self._detector = None
        self._enabled = False
        return self.status()

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
        action = None
        if apply_buddy_action:
            action = (
                self._apply_face_detected_action(faces, image)
                if face_detected
                else self._apply_no_face_action()
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
        if not self._enabled:
            raise BuddyVisionConfigurationError(
                "Buddy vision is disabled. Enable Vision before uploading frames."
            )
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

    def _apply_face_detected_action(
        self,
        faces: list[BuddyFaceBox],
        image: BuddyVisionImage,
    ) -> dict[str, Any]:
        if not self.settings.buddy_vision_enabled:
            return {"applied": False, "reason": "buddy vision actions are disabled"}
        if not self.gateway.is_connected():
            return {"applied": False, "reason": "Buddy is not connected"}

        pause_ms = self.settings.buddy_vision_pause_ms
        look = self._look_command(faces, image)
        commands = [f"ROAM PAUSE {pause_ms}"]
        if look["command"]:
            commands.append(str(look["command"]))
        commands.append("CB idle person nearby")
        sent_commands: list[str] = []
        try:
            for command in commands:
                self.gateway.send_raw_command(command)
                sent_commands.append(command)
        except BuddyConnectionError as exc:
            return {"applied": False, "commands": sent_commands, "error": str(exc)}
        self._roam_paused_by_vision = True
        return {
            "applied": True,
            "commands": sent_commands,
            "pause_ms": pause_ms,
            "look": look,
        }

    def _apply_no_face_action(self) -> dict[str, Any]:
        if not self.settings.buddy_vision_enabled:
            return {"applied": False, "reason": "buddy vision actions are disabled"}
        if not self._roam_paused_by_vision:
            return {"applied": False, "reason": "roam was not paused by vision"}
        if not self.gateway.is_connected():
            return {"applied": False, "reason": "Buddy is not connected"}

        command = "ROAM RESUME"
        try:
            self.gateway.send_raw_command(command)
        except BuddyConnectionError as exc:
            return {"applied": False, "commands": [], "error": str(exc)}
        self._roam_paused_by_vision = False
        return {"applied": True, "commands": [command]}

    def _look_command(
        self,
        faces: list[BuddyFaceBox],
        image: BuddyVisionImage,
    ) -> dict[str, Any]:
        if not self.settings.buddy_vision_look_enabled:
            return {"applied": False, "reason": "look is disabled", "command": None}
        if not faces:
            return {"applied": False, "reason": "no face target", "command": None}
        if image.width <= 0 or image.height <= 0:
            return {"applied": False, "reason": "invalid image size", "command": None}

        target = max(faces, key=lambda face: (face.width * face.height, face.score))
        center_x = target.x + target.width / 2
        center_y = target.y + target.height / 2
        offset_x = (center_x - image.width / 2) / (image.width / 2)
        offset_y = (center_y - image.height / 2) / (image.height / 2)

        yaw_axis = -offset_x if self.settings.buddy_vision_look_invert_x else offset_x
        pitch_axis = offset_y if self.settings.buddy_vision_look_invert_y else -offset_y
        deadband = max(0.0, min(1.0, self.settings.buddy_vision_look_deadband))
        if abs(yaw_axis) < deadband:
            yaw_axis = 0.0
        if abs(pitch_axis) < deadband:
            pitch_axis = 0.0

        max_yaw_units = max(0, int(round(self.settings.buddy_vision_look_max_yaw_degrees * 10)))
        max_pitch_units = max(
            0,
            int(round(self.settings.buddy_vision_look_max_pitch_degrees * 10)),
        )
        yaw_delta = int(round(_clamp_axis(yaw_axis) * max_yaw_units))
        pitch_delta = int(round(_clamp_axis(pitch_axis) * max_pitch_units))
        yaw = int(self.settings.buddy_vision_look_center_yaw) + yaw_delta
        pitch = int(self.settings.buddy_vision_look_center_pitch) + pitch_delta
        speed = max(0, int(self.settings.buddy_vision_look_speed))
        command = f"LOOK {yaw} {pitch} {speed}" if yaw_delta or pitch_delta else None
        return {
            "applied": command is not None,
            "command": command,
            "yaw": yaw,
            "pitch": pitch,
            "yaw_delta": yaw_delta,
            "pitch_delta": pitch_delta,
            "speed": speed,
            "offset_x": round(offset_x, 4),
            "offset_y": round(offset_y, 4),
            "target_face": target.as_dict(),
        }


class _MediaPipeBlazeFaceDetector:
    provider = "mediapipe_blazeface_full_range"

    def __init__(self, settings: Settings) -> None:
        try:
            import mediapipe as mp
        except ImportError as exc:
            raise BuddyVisionConfigurationError(
                "Buddy vision requires MediaPipe BlazeFace. Install with "
                "`pip install mediapipe` in the Anomalo environment, or use "
                "`ANOMALO_BUDDY_VISION_PROVIDER=opencv_haar`."
            ) from exc

        if _normalize_provider(settings.buddy_vision_provider) != "mediapipe_blazeface":
            raise BuddyVisionConfigurationError(
                f"Unsupported Buddy vision provider: {settings.buddy_vision_provider}"
            )

        try:
            face_detection = mp.solutions.face_detection
        except AttributeError as exc:
            raise BuddyVisionConfigurationError(
                "Installed MediaPipe does not expose the legacy BlazeFace API. Use "
                "`ANOMALO_BUDDY_VISION_PROVIDER=opencv_haar`, or install a MediaPipe "
                "version that still provides `mediapipe.solutions.face_detection`."
            ) from exc

        try:
            self._face_detection = face_detection.FaceDetection(
                model_selection=settings.buddy_vision_model_selection,
                min_detection_confidence=settings.buddy_vision_detector_min_confidence,
            )
        except Exception as exc:  # noqa: BLE001
            raise BuddyVisionConfigurationError(
                "Failed to initialize MediaPipe BlazeFace. Use "
                "`ANOMALO_BUDDY_VISION_PROVIDER=opencv_haar` for the low-power "
                "server-side detector."
            ) from exc

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


class _OpenCvHaarFaceDetector:
    provider = "opencv_haar"
    _cascade_files = (
        "haarcascade_frontalface_default.xml",
        "haarcascade_frontalface_alt2.xml",
        "haarcascade_profileface.xml",
    )

    def __init__(self, settings: Settings) -> None:
        del settings
        try:
            import cv2
        except ImportError as exc:
            raise BuddyVisionConfigurationError(
                "Buddy vision requires OpenCV for the opencv_haar provider. Install with "
                '`pip install -e ".[vision]"` in the Anomalo environment.'
            ) from exc

        classifiers = []
        for cascade_file in self._cascade_files:
            cascade_path = cv2.data.haarcascades + cascade_file
            classifier = cv2.CascadeClassifier(cascade_path)
            if not classifier.empty():
                classifiers.append((cascade_file, classifier))
        if not classifiers:
            raise BuddyVisionConfigurationError(
                f"Failed to load OpenCV face cascades from: {cv2.data.haarcascades}"
            )
        self._cv2 = cv2
        self._classifiers = classifiers

    def detect(self, image: BuddyVisionImage) -> list[BuddyFaceBox]:
        gray = self._cv2.cvtColor(image.pixels, self._cv2.COLOR_RGB2GRAY)
        scan_gray, scan_scale = self._scaled_scan_image(gray, image)
        min_size = max(24, min(scan_gray.shape[:2]) // 18)
        faces = self._detect_with_parameters(
            scan_gray,
            scan_scale,
            image,
            min_size=min_size,
            min_neighbors=3,
            scale_factor=1.06,
            score=1.0,
        )
        if faces:
            return _dedupe_faces(faces)

        relaxed_min_size = max(18, min(scan_gray.shape[:2]) // 24)
        relaxed_faces = self._detect_with_parameters(
            scan_gray,
            scan_scale,
            image,
            min_size=relaxed_min_size,
            min_neighbors=1,
            scale_factor=1.03,
            score=0.5,
        )
        return _dedupe_faces(relaxed_faces)

    def _detect_with_parameters(
        self,
        scan_gray: Any,
        scan_scale: float,
        image: BuddyVisionImage,
        *,
        min_size: int,
        min_neighbors: int,
        scale_factor: float,
        score: float,
    ) -> list[BuddyFaceBox]:
        faces: list[BuddyFaceBox] = []
        for scan_image, mirrored in (
            (scan_gray, False),
            (self._cv2.flip(scan_gray, 1), True),
        ):
            for _name, classifier in self._classifiers:
                rectangles = classifier.detectMultiScale(
                    scan_image,
                    scaleFactor=scale_factor,
                    minNeighbors=min_neighbors,
                    minSize=(min_size, min_size),
                )
                faces.extend(
                    self._face_box_from_scaled_rect(
                        rectangle,
                        scan_scale,
                        image,
                        mirrored=mirrored,
                        score=score,
                    )
                    for rectangle in rectangles
                )
        return [face for face in faces if face.width > 0 and face.height > 0]

    def _scaled_scan_image(
        self,
        gray: Any,
        image: BuddyVisionImage,
    ) -> tuple[Any, float]:
        min_dimension = min(image.width, image.height)
        if min_dimension < 180:
            scale = 3.0
        elif min_dimension < 320:
            scale = 2.0
        else:
            scale = 1.0
        if scale == 1.0:
            return gray, scale
        resized = self._cv2.resize(
            gray,
            None,
            fx=scale,
            fy=scale,
            interpolation=self._cv2.INTER_LINEAR,
        )
        return resized, scale

    def _face_box_from_scaled_rect(
        self,
        rectangle: Any,
        scan_scale: float,
        image: BuddyVisionImage,
        *,
        mirrored: bool,
        score: float,
    ) -> BuddyFaceBox:
        x, y, width, height = rectangle
        scaled_x = int(round(float(x) / scan_scale))
        scaled_y = int(round(float(y) / scan_scale))
        scaled_width = int(round(float(width) / scan_scale))
        scaled_height = int(round(float(height) / scan_scale))
        if mirrored:
            scaled_x = image.width - scaled_x - scaled_width
        x_min = max(0, min(image.width, scaled_x))
        y_min = max(0, min(image.height, scaled_y))
        x_max = max(0, min(image.width, scaled_x + scaled_width))
        y_max = max(0, min(image.height, scaled_y + scaled_height))
        return BuddyFaceBox(
            x=x_min,
            y=y_min,
            width=x_max - x_min,
            height=y_max - y_min,
            score=score,
        )


def _create_face_detector(settings: Settings) -> BuddyFaceDetector:
    provider = _normalize_provider(settings.buddy_vision_provider)
    if provider == "opencv_haar":
        return _OpenCvHaarFaceDetector(settings)
    if provider == "mediapipe_blazeface":
        return _MediaPipeBlazeFaceDetector(settings)
    raise BuddyVisionConfigurationError(
        "Unsupported Buddy vision provider: "
        f"{settings.buddy_vision_provider}. Supported providers: opencv_haar, "
        "mediapipe_blazeface."
    )


def _normalize_provider(provider: str) -> str:
    return provider.strip().lower()


def _dedupe_faces(faces: list[BuddyFaceBox]) -> list[BuddyFaceBox]:
    ordered_faces = sorted(faces, key=lambda face: face.width * face.height, reverse=True)
    kept: list[BuddyFaceBox] = []
    for face in ordered_faces:
        if all(_intersection_over_union(face, existing) < 0.35 for existing in kept):
            kept.append(face)
    return kept


def _intersection_over_union(left: BuddyFaceBox, right: BuddyFaceBox) -> float:
    left_x2 = left.x + left.width
    left_y2 = left.y + left.height
    right_x2 = right.x + right.width
    right_y2 = right.y + right.height
    intersection_width = max(0, min(left_x2, right_x2) - max(left.x, right.x))
    intersection_height = max(0, min(left_y2, right_y2) - max(left.y, right.y))
    intersection = intersection_width * intersection_height
    if intersection <= 0:
        return 0.0
    left_area = left.width * left.height
    right_area = right.width * right.height
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _clamp_axis(value: float) -> float:
    return max(-1.0, min(1.0, value))
