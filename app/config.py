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

    @property
    def mcp_config_path(self) -> Path:
        return self.config_dir / "mcp_servers.yaml"

    @property
    def prompts_config_path(self) -> Path:
        return self.config_dir / "prompts.yaml"

    @property
    def agent_memory_path(self) -> Path:
        return self.config_dir / "AGENTS.md"


@lru_cache
def get_settings() -> Settings:
    return Settings()
