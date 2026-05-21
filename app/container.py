from functools import lru_cache

from app.agent.runtime import AgentRuntime
from app.agent.session import SessionStore
from app.config import get_settings
from app.llm.openai_client import OpenAIChatClient
from app.tools.local import CoreToolProvider
from app.tools.mcp_provider import MCPManager, MCPProvider
from app.tools.python_sandbox import PythonSandboxProvider
from app.tools.registry import ToolRegistry
from app.tools.skills import SkillManager, SkillProvider


@lru_cache
def get_session_store() -> SessionStore:
    return SessionStore()


@lru_cache
def get_tool_registry() -> ToolRegistry:
    settings = get_settings()
    return ToolRegistry(
        providers=[
            CoreToolProvider(),
            PythonSandboxProvider(settings),
            SkillProvider(settings.skills_dir),
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
    return SkillManager(get_settings().skills_dir)


@lru_cache
def get_mcp_manager() -> MCPManager:
    return MCPManager(get_settings().mcp_config_path)

