from buddy_backend.skill_api import request_approval as _request_approval


def request_approval(request_id: str, text: str, timeout_seconds: float = 30.0) -> str:
    """Ask for human approval on Buddy and wait for the tap or swipe response."""
    return _request_approval(
        request_id=request_id,
        text=text,
        timeout_seconds=timeout_seconds,
    )
