from app.agent.prompts import load_prompt_messages
from app.config import Settings


def test_agent_prompt_profile_is_not_buddy_identity() -> None:
    settings = Settings(ANOMALO_AGENT_PROMPT_PROFILE="agent")

    messages = load_prompt_messages(settings.prompts_config_path, settings.agent_prompt_profile)

    assert len(messages) == 1
    assert messages[0]["role"] == "system"
    assert "text-only" in messages[0]["content"]
    assert "Do not describe yourself as Buddy" in messages[0]["content"]
    assert "external device you control" in messages[0]["content"]


def test_buddy_voice_prompt_profile_loads() -> None:
    settings = Settings(ANOMALO_BUDDY_PROMPT_PROFILE="buddy_voice")

    messages = load_prompt_messages(settings.prompts_config_path, settings.buddy_prompt_profile)

    assert len(messages) == 1
    assert messages[0]["role"] == "system"
    assert "speaking through Buddy" in messages[0]["content"]
    assert "natural conversation" in messages[0]["content"]
