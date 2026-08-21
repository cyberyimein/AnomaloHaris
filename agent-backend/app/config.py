from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.runtime_config import RuntimeModelStore
from app.search_modes import DEFAULT_SEARCH_MODE, DEFAULT_SUBAGENT_MODEL

AGENT_BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_BACKEND_ROOT.parent
BUDDY_BACKEND_ROOT = REPO_ROOT / "buddy-backend"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(
            AGENT_BACKEND_ROOT / "config" / "env.defaults",
            REPO_ROOT / ".env",
        ),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    app_title: str = Field(default="Anomalo", alias="ANOMALO_APP_TITLE")
    environment: str = Field(default="development", alias="ANOMALO_ENV")
    site_url: str = Field(default="http://localhost:8000", alias="ANOMALO_SITE_URL")
    runtime_impl: str = Field(default="python", alias="ANOMALO_RUNTIME_IMPL")
    session_schema: str = Field(default="v1", alias="ANOMALO_SESSION_SCHEMA")
    node_host_url: str = Field(default="http://127.0.0.1:8788", alias="ANOMALO_NODE_HOST_URL")

    openrouter_api_key: str | None = Field(default=None, alias="OPENROUTER_API_KEY")
    openrouter_management_api_key: str | None = Field(
        default=None,
        alias="OPENROUTER_MANAGEMENT_API_KEY",
    )
    openrouter_credits_cache_seconds: int = Field(
        default=0,
        alias="OPENROUTER_CREDITS_CACHE_SECONDS",
    )
    openrouter_credits_timeout_seconds: float = Field(
        default=8.0,
        alias="OPENROUTER_CREDITS_TIMEOUT_SECONDS",
    )
    openai_base_url: str = Field(default="https://openrouter.ai/api/v1", alias="OPENAI_BASE_URL")
    openrouter_model: str = Field(default="openai/gpt-4o-mini", alias="OPENROUTER_MODEL")
    default_search_mode: str = Field(default=DEFAULT_SEARCH_MODE, alias="ANOMALO_SEARCH_MODE")
    web_research_subagent_model: str = Field(
        default=DEFAULT_SUBAGENT_MODEL,
        alias="WEB_RESEARCH_SUBAGENT_MODEL",
    )
    search_mode_timeout_seconds: float = Field(
        default=90.0,
        gt=0,
        alias="SEARCH_MODE_TIMEOUT_SECONDS",
    )
    llm_temperature: float = Field(default=0.4, alias="LLM_TEMPERATURE")
    max_tool_iterations: int = Field(default=50, alias="MAX_TOOL_ITERATIONS")
    agent_run_timeout_seconds: float = Field(
        default=600.0,
        gt=0,
        alias="AGENT_RUN_TIMEOUT_SECONDS",
    )
    browser_tool_timeout_seconds: float = Field(
        default=60.0,
        gt=0,
        alias="BROWSER_TOOL_TIMEOUT_SECONDS",
    )
    admin_token: str | None = Field(default=None, alias="ANOMALO_ADMIN_TOKEN")
    mcp_timeout_seconds: float = Field(default=8.0, alias="MCP_TIMEOUT_SECONDS")
    agent_prompt_profile: str = Field(default="agent", alias="ANOMALO_AGENT_PROMPT_PROFILE")
    buddy_prompt_profile: str = Field(default="buddy_voice", alias="ANOMALO_BUDDY_PROMPT_PROFILE")
    prompt_profile: str | None = Field(default=None, alias="ANOMALO_PROMPT_PROFILE")
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
    buddy_audio_ai_enabled: bool = Field(
        default=False,
        alias="ANOMALO_BUDDY_AUDIO_AI_ENABLED",
    )
    buddy_audio_debug_storage: str = Field(
        default="auto",
        alias="ANOMALO_BUDDY_AUDIO_DEBUG_STORAGE",
    )
    buddy_vision_enabled: bool = Field(default=False, alias="ANOMALO_BUDDY_VISION_ENABLED")
    buddy_vision_provider: str = Field(
        default="opencv_haar",
        alias="ANOMALO_BUDDY_VISION_PROVIDER",
    )
    buddy_vision_model_selection: int = Field(
        default=1,
        alias="ANOMALO_BUDDY_VISION_MODEL_SELECTION",
    )
    buddy_vision_score_threshold: float = Field(
        default=0.45,
        alias="ANOMALO_BUDDY_VISION_SCORE_THRESHOLD",
    )
    buddy_vision_detector_min_confidence: float = Field(
        default=0.1,
        alias="ANOMALO_BUDDY_VISION_DETECTOR_MIN_CONFIDENCE",
    )
    buddy_vision_pause_ms: int = Field(default=0, alias="ANOMALO_BUDDY_VISION_PAUSE_MS")
    buddy_vision_look_enabled: bool = Field(
        default=True,
        alias="ANOMALO_BUDDY_VISION_LOOK_ENABLED",
    )
    buddy_vision_look_max_yaw_degrees: float = Field(
        default=25.0,
        alias="ANOMALO_BUDDY_VISION_LOOK_MAX_YAW_DEGREES",
    )
    buddy_vision_look_max_pitch_degrees: float = Field(
        default=12.0,
        alias="ANOMALO_BUDDY_VISION_LOOK_MAX_PITCH_DEGREES",
    )
    buddy_vision_look_center_yaw: int = Field(
        default=0,
        alias="ANOMALO_BUDDY_VISION_LOOK_CENTER_YAW",
    )
    buddy_vision_look_center_pitch: int = Field(
        default=260,
        alias="ANOMALO_BUDDY_VISION_LOOK_CENTER_PITCH",
    )
    buddy_vision_look_speed: int = Field(default=40, alias="ANOMALO_BUDDY_VISION_LOOK_SPEED")
    buddy_vision_look_deadband: float = Field(
        default=0.12,
        alias="ANOMALO_BUDDY_VISION_LOOK_DEADBAND",
    )
    buddy_vision_look_invert_x: bool = Field(
        default=False,
        alias="ANOMALO_BUDDY_VISION_LOOK_INVERT_X",
    )
    buddy_vision_look_invert_y: bool = Field(
        default=False,
        alias="ANOMALO_BUDDY_VISION_LOOK_INVERT_Y",
    )
    buddy_vision_frame_token: str | None = Field(
        default=None,
        alias="ANOMALO_BUDDY_VISION_FRAME_TOKEN",
    )
    buddy_vision_frame_client_ip: str | None = Field(
        default=None,
        alias="ANOMALO_BUDDY_VISION_FRAME_CLIENT_IP",
    )
    buddy_vision_max_upload_bytes: int = Field(
        default=2_000_000,
        alias="ANOMALO_BUDDY_VISION_MAX_UPLOAD_BYTES",
    )
    buddy_vision_max_image_dimension: int = Field(
        default=640,
        alias="ANOMALO_BUDDY_VISION_MAX_IMAGE_DIMENSION",
    )
    copilot_buddy_approval_timeout_seconds: float = Field(
        default=90.0,
        alias="ANOMALO_COPILOT_BUDDY_APPROVAL_TIMEOUT_SECONDS",
    )
    copilot_buddy_permission_bridge_enabled: bool = Field(
        default=False,
        alias="ANOMALO_COPILOT_BUDDY_PERMISSION_BRIDGE_ENABLED",
    )

    python_sandbox_enabled: bool = Field(default=True, alias="PYTHON_SANDBOX_ENABLED")
    python_sandbox_timeout_seconds: int = Field(
        default=10,
        alias="PYTHON_SANDBOX_TIMEOUT_SECONDS",
    )
    fruitspy_python_tool_base_url: str = Field(
        default="http://127.0.0.1:8848",
        alias="FRUITSPY_PYTHON_TOOL_BASE_URL",
    )
    fruitspy_python_tool_token: str | None = Field(
        default=None,
        alias="FRUITSPY_PYTHON_TOOL_TOKEN",
    )
    fruitspy_python_tool_status_timeout_seconds: float = Field(
        default=2.0,
        alias="FRUITSPY_PYTHON_TOOL_STATUS_TIMEOUT_SECONDS",
    )
    web_tools_enabled: bool = Field(default=True, alias="WEB_TOOLS_ENABLED")
    web_search_timeout_seconds: float = Field(
        default=8.0,
        alias="WEB_SEARCH_TIMEOUT_SECONDS",
    )
    web_search_cache_seconds: int = Field(
        default=300,
        alias="WEB_SEARCH_CACHE_SECONDS",
    )
    web_search_max_bytes: int = Field(
        default=1_000_000,
        alias="WEB_SEARCH_MAX_BYTES",
    )
    web_fetch_provider: str = Field(default="auto", alias="WEB_FETCH_PROVIDER")
    web_fetch_timeout_seconds: float = Field(
        default=30.0,
        alias="WEB_FETCH_TIMEOUT_SECONDS",
    )
    web_fetch_max_bytes: int = Field(
        default=2_000_000,
        alias="WEB_FETCH_MAX_BYTES",
    )
    web_fetch_max_chars: int = Field(
        default=30_000,
        alias="WEB_FETCH_MAX_CHARS",
    )
    web_user_agent: str = Field(
        default="Anomalo/0.1 (+local agent web tools)",
        alias="WEB_USER_AGENT",
    )
    fruitspy_crawl_api_base_url: str = Field(
        default="",
        alias="FRUITSPY_CRAWL_API_BASE_URL",
    )
    fruitspy_crawl_api_path: str = Field(
        default="/api/v1/tools/crawl",
        alias="FRUITSPY_CRAWL_API_PATH",
    )
    fruitspy_crawl_api_token: str | None = Field(
        default=None,
        alias="FRUITSPY_CRAWL_API_TOKEN",
    )
    data_dir: Path = Field(default=REPO_ROOT / "data", alias="ANOMALO_DATA_DIR")

    config_dir: Path = AGENT_BACKEND_ROOT / "config"
    skills_dir: Path = AGENT_BACKEND_ROOT / "skills"
    buddy_skills_dir: Path = BUDDY_BACKEND_ROOT / "skills"
    frontend_dir: Path = AGENT_BACKEND_ROOT / "app" / "frontend"
    static_dir: Path = AGENT_BACKEND_ROOT / "app" / "static"
    artifacts_dir: Path = AGENT_BACKEND_ROOT / "artifacts"
    project_root: Path = REPO_ROOT

    @property
    def skill_dirs(self) -> tuple[Path, ...]:
        return (self.skills_dir, self.buddy_skills_dir)

    @property
    def frontend_assets_dir(self) -> Path:
        return self.frontend_dir / "assets"

    @property
    def session_db_path(self) -> Path:
        return self.data_dir / "sessions.sqlite3"

    @property
    def preset_agent_db_path(self) -> Path:
        return self.data_dir / "preset-agents.sqlite3"

    @property
    def runtime_model_path(self) -> Path:
        return self.data_dir / "runtime-settings.json"

    @property
    def normalized_environment(self) -> str:
        return self.environment.strip().lower()

    @property
    def is_production(self) -> bool:
        return self.normalized_environment in {"prod", "production", "deploy", "deployment"}

    @property
    def should_persist_buddy_debug_audio(self) -> bool:
        mode = self.buddy_audio_debug_storage.strip().lower()
        if mode in {"1", "true", "yes", "on", "enabled"}:
            return True
        if mode in {"0", "false", "no", "off", "disabled"}:
            return False
        return not self.is_production

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
    settings = Settings()
    override = RuntimeModelStore(settings.runtime_model_path).load()
    if override is not None:
        settings.openrouter_model = override.model
    return settings
