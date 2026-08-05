import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path


@dataclass(frozen=True)
class ModelOverride:
    model: str
    updated_at: str


class RuntimeModelStore:
    """Persist the model selected from the deployed management UI."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> ModelOverride | None:
        if not self.path.is_file():
            return None
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            model = str(payload.get("openrouter_model", "")).strip()
            updated_at = str(payload.get("updated_at", "")).strip()
        except (OSError, TypeError, ValueError, AttributeError):
            return None
        if not model:
            return None
        return ModelOverride(model=model, updated_at=updated_at or "")

    def save(self, model: str) -> ModelOverride:
        normalized_model = model.strip()
        if not normalized_model:
            raise ValueError("Model cannot be blank.")

        updated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        payload = {
            "openrouter_model": normalized_model,
            "updated_at": updated_at,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.path.with_name(f".{self.path.name}.tmp")
        temporary_path.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(self.path)
        return ModelOverride(model=normalized_model, updated_at=updated_at)
