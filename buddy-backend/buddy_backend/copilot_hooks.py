from buddy_backend.codex_projection import CodexBuddyProjection, CodexProjectionError

# Compatibility aliases for callers that still import the old hook-oriented names.
CopilotHookService = CodexBuddyProjection
CopilotHookError = CodexProjectionError

__all__ = ["CopilotHookError", "CopilotHookService"]
