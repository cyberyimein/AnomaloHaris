from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_title: str = Field(default="Anomalo", alias="ANOMALO_APP_TITLE")
    site_url: str = Field(default="http://localhost:8000", alias="ANOMALO_SITE_URL")

    openrouter_api_key: str | None = Field(default=None, alias="OPENROUTER_API_KEY")
    openai_base_url: str = Field(default="https://openrouter.ai/api/v1", alias="OPENAI_BASE_URL")
    openrouter_model: str = Field(default="openai/gpt-4o-mini", alias="OPENROUTER_MODEL")
    llm_temperature: float = Field(default=0.4, alias="LLM_TEMPERATURE")
    max_tool_iterations: int = Field(default=5, alias="MAX_TOOL_ITERATIONS")
    admin_token: str | None = Field(default=None, alias="ANOMALO_ADMIN_TOKEN")
    mcp_timeout_seconds: float = Field(default=8.0, alias="MCP_TIMEOUT_SECONDS")
    prompt_profile: str = Field(default="default", alias="ANOMALO_PROMPT_PROFILE")
    local_font_dir: Path | None = Field(default=None, alias="ANOMALO_LOCAL_FONT_DIR")
    audio_stt_provider: str = Field(default="faster_whisper", alias="ANOMALO_AUDIO_STT_PROVIDER")
    audio_tts_provider: str = Field(default="piper_plus", alias="ANOMALO_AUDIO_TTS_PROVIDER")
    audio_default_input_language: str | None = Field(
        default=None,
        alias="ANOMALO_AUDIO_DEFAULT_INPUT_LANGUAGE",
    )
    audio_default_output_language: str = Field(
        default="en",
        alias="ANOMALO_AUDIO_DEFAULT_OUTPUT_LANGUAGE",
    )
    audio_stt_model: str = Field(default="tiny", alias="ANOMALO_AUDIO_STT_MODEL")
    audio_stt_device: str = Field(default="auto", alias="ANOMALO_AUDIO_STT_DEVICE")
    audio_stt_compute_type: str = Field(
        default="int8",
        alias="ANOMALO_AUDIO_STT_COMPUTE_TYPE",
    )
    audio_stt_beam_size: int = Field(default=1, alias="ANOMALO_AUDIO_STT_BEAM_SIZE")
    audio_stt_vad_filter: bool = Field(default=True, alias="ANOMALO_AUDIO_STT_VAD_FILTER")
    audio_stt_initial_prompt: str | None = Field(
        default=None,
        alias="ANOMALO_AUDIO_STT_INITIAL_PROMPT",
    )
    audio_tts_module: str = Field(default="piper", alias="ANOMALO_AUDIO_TTS_MODULE")
    audio_tts_default_voice: str | None = Field(
        default=None,
        alias="ANOMALO_AUDIO_TTS_DEFAULT_VOICE",
    )
    audio_tts_default_voice_en: str | None = Field(
        default=None,
        alias="ANOMALO_AUDIO_TTS_DEFAULT_VOICE_EN",
    )
    audio_tts_default_voice_zh: str | None = Field(
        default=None,
        alias="ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH",
    )
    audio_tts_kokoro_speed: float = Field(
        default=1.0,
        alias="ANOMALO_AUDIO_TTS_KOKORO_SPEED",
    )
    audio_tts_cosyvoice_model_dir: str | None = Field(
        default=None,
        alias="ANOMALO_AUDIO_TTS_COSYVOICE_MODEL_DIR",
    )
    audio_tts_cosyvoice_repo_dir: str | None = Field(
        default=None,
        alias="ANOMALO_AUDIO_TTS_COSYVOICE_REPO_DIR",
    )
    buddy_transport: str = Field(default="serial", alias="ANOMALO_BUDDY_TRANSPORT")
    buddy_serial_port: str | None = Field(default=None, alias="ANOMALO_BUDDY_SERIAL_PORT")
    buddy_baud_rate: int = Field(default=115200, alias="ANOMALO_BUDDY_BAUD_RATE")
    buddy_host_name: str | None = Field(default=None, alias="ANOMALO_BUDDY_HOST_NAME")
    buddy_tcp_host: str = Field(default="0.0.0.0", alias="ANOMALO_BUDDY_TCP_HOST")
    buddy_tcp_port: int = Field(default=8787, alias="ANOMALO_BUDDY_TCP_PORT")
    buddy_tcp_client_ip: str | None = Field(default=None, alias="ANOMALO_BUDDY_TCP_CLIENT_IP")
    buddy_event_buffer_size: int = Field(default=200, alias="ANOMALO_BUDDY_EVENT_BUFFER_SIZE")
    copilot_buddy_approval_timeout_seconds: float = Field(
        default=90.0,
        alias="ANOMALO_COPILOT_BUDDY_APPROVAL_TIMEOUT_SECONDS",
    )
    copilot_buddy_permission_bridge_enabled: bool = Field(
        default=False,
        alias="ANOMALO_COPILOT_BUDDY_PERMISSION_BRIDGE_ENABLED",
    )

    python_sandbox_image: str = Field(
        default="anomalo-python:latest",
        alias="PYTHON_SANDBOX_IMAGE",
    )
    python_sandbox_timeout_seconds: int = Field(
        default=10,
        alias="PYTHON_SANDBOX_TIMEOUT_SECONDS",
    )
    python_sandbox_max_output_chars: int = Field(
        default=12000,
        alias="PYTHON_SANDBOX_MAX_OUTPUT_CHARS",
    )

    config_dir: Path = PROJECT_ROOT / "config"
    skills_dir: Path = PROJECT_ROOT / "skills"
    frontend_dir: Path = PROJECT_ROOT / "app" / "frontend"
    static_dir: Path = PROJECT_ROOT / "app" / "static"
    artifacts_dir: Path = PROJECT_ROOT / "artifacts"
    project_root: Path = PROJECT_ROOT

    @property
    def frontend_assets_dir(self) -> Path:
        return self.frontend_dir / "assets"

    @property
    def mcp_config_path(self) -> Path:
        return self.config_dir / "mcp_servers.yaml"

    @property
    def prompts_config_path(self) -> Path:
        return self.config_dir / "prompts.yaml"

    @property
    def agent_memory_path(self) -> Path:
        return self.config_dir / "AGENTS.md"

    @property
    def audio_model_dir(self) -> Path:
        return self.artifacts_dir / "audio-models"

    def default_tts_voice(self, language: str | None = None) -> str | None:
        if language == "zh" and self.audio_tts_default_voice_zh:
            return self.audio_tts_default_voice_zh
        if language == "en" and self.audio_tts_default_voice_en:
            return self.audio_tts_default_voice_en
        return self.audio_tts_default_voice


@lru_cache
def get_settings() -> Settings:
    return Settings()
