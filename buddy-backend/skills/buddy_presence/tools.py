from buddy_backend.skill_api import (
    cue_led as _cue_led,
)
from buddy_backend.skill_api import (
    look as _look,
)
from buddy_backend.skill_api import (
    set_presence as _set_presence,
)
from buddy_backend.skill_api import (
    set_status_text as _set_status_text,
)


def set_presence(state: str, text: str | None = None) -> str:
    """Set Buddy to a high-level visual state with optional short status text."""
    return _set_presence(state=state, text=text)


def set_status_text(text: str) -> str:
    """Update Buddy's short bottom status text without changing the visual state."""
    return _set_status_text(text=text)


def cue_led(r: int, g: int, b: int, ms: int = 800) -> str:
    """Show a temporary LED color cue on Buddy."""
    return _cue_led(r=r, g=g, b=b, ms=ms)


def look(yaw: int, pitch: int, speed: int | None = None) -> str:
    """Aim Buddy's head toward a target yaw and pitch."""
    return _look(yaw=yaw, pitch=pitch, speed=speed)
