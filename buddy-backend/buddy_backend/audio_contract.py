"""Audio error types shared across the Buddy package and the Python worker."""


class AudioConfigurationError(RuntimeError):
    """Raised when a local audio provider is unavailable or misconfigured."""


class AudioProcessingError(RuntimeError):
    """Raised when audio input/output processing fails."""
