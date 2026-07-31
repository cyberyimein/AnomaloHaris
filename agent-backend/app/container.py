from functools import lru_cache

from buddy_backend.audio_bridge import BuddyAudioBridge
from buddy_backend.codex_projection import CodexBuddyProjection
from buddy_backend.gateway import BuddyGateway
from buddy_backend.tools import BuddyToolProvider
from buddy_backend.vision import BuddyVisionService

from app.agent.runtime import AgentRuntime
from app.agent.session import SessionStore
from app.audio.base import TextToSpeechProvider
from app.audio.providers import (
    CosyVoiceTTSProvider,
    FasterWhisperSTTProvider,
    KokoroTTSProvider,
    MacOSSayTTSProvider,
    PiperPlusTTSProvider,
)
from app.audio.service import VoiceService
from app.config import get_settings
from app.llm.openai_client import OpenAIChatClient
from app.tools.local import CoreToolProvider
from app.tools.mcp_provider import MCPManager, MCPProvider
from app.tools.python_sandbox import PythonSandboxProvider
from app.tools.registry import ToolRegistry
from app.tools.skills import SkillManager, SkillProvider
from app.tools.web import WebToolProvider


@lru_cache
def get_session_store() -> SessionStore:
    return SessionStore(get_settings().session_db_path)


@lru_cache
def get_tool_registry() -> ToolRegistry:
    settings = get_settings()
    return ToolRegistry(
        providers=[
            CoreToolProvider(),
            WebToolProvider(settings),
            BuddyToolProvider(get_buddy_gateway()),
            PythonSandboxProvider(settings),
            SkillProvider(settings.skill_dirs),
            MCPProvider(settings.mcp_config_path, settings.mcp_timeout_seconds),
        ]
    )


@lru_cache
def get_llm_client() -> OpenAIChatClient:
    return OpenAIChatClient(get_settings())


@lru_cache
def get_agent_runtime() -> AgentRuntime:
    return AgentRuntime(
        settings=get_settings(),
        sessions=get_session_store(),
        skills=get_skill_manager(),
        mcp=get_mcp_manager(),
        tools=get_tool_registry(),
        llm=get_llm_client(),
    )


@lru_cache
def get_skill_manager() -> SkillManager:
    settings = get_settings()
    return SkillManager(settings.skills_dir, extra_skill_dirs=(settings.buddy_skills_dir,))


@lru_cache
def get_mcp_manager() -> MCPManager:
    return MCPManager(get_settings().mcp_config_path)


@lru_cache
def get_buddy_gateway() -> BuddyGateway:
    return BuddyGateway(get_settings())


@lru_cache
def get_codex_buddy_projection() -> CodexBuddyProjection:
    settings = get_settings()
    return CodexBuddyProjection(
        get_buddy_gateway(),
        approval_timeout_seconds=settings.copilot_buddy_approval_timeout_seconds,
        permission_bridge_enabled=settings.copilot_buddy_permission_bridge_enabled,
    )


@lru_cache
def get_stt_provider() -> FasterWhisperSTTProvider:
    settings = get_settings()
    if settings.audio_stt_provider != "faster_whisper":
        msg = f"Unsupported STT provider: {settings.audio_stt_provider}"
        raise ValueError(msg)
    return FasterWhisperSTTProvider(settings)


@lru_cache
def get_tts_provider() -> TextToSpeechProvider:
    settings = get_settings()
    if settings.audio_tts_provider == "piper_plus":
        return PiperPlusTTSProvider(settings)
    if settings.audio_tts_provider == "kokoro":
        return KokoroTTSProvider(settings)
    if settings.audio_tts_provider == "cosyvoice":
        return CosyVoiceTTSProvider(settings)
    if settings.audio_tts_provider == "say":
        return MacOSSayTTSProvider(settings)
    msg = f"Unsupported TTS provider: {settings.audio_tts_provider}"
    raise ValueError(msg)


@lru_cache
def get_voice_service() -> VoiceService:
    return VoiceService(
        settings=get_settings(),
        runtime=get_agent_runtime(),
        buddy=get_buddy_gateway(),
        stt=get_stt_provider(),
        tts=get_tts_provider(),
    )


@lru_cache
def get_buddy_audio_bridge() -> BuddyAudioBridge:
    return BuddyAudioBridge(
        get_settings(),
        gateway=get_buddy_gateway(),
        voice=get_voice_service(),
    )


@lru_cache
def get_buddy_vision_service() -> BuddyVisionService:
    return BuddyVisionService(
        get_settings(),
        gateway=get_buddy_gateway(),
    )
