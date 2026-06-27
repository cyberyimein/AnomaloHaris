from app.agent.prompts import load_prompt_messages
from app.config import Settings


def test_buddy_voice_prompt_profile_loads() -> None:
    settings = Settings(ANOMALO_PROMPT_PROFILE="buddy_voice")

    messages = load_prompt_messages(settings.prompts_config_path, settings.prompt_profile)

    assert len(messages) == 1
    assert messages[0]["role"] == "system"
    assert "speaking through Buddy" in messages[0]["content"]
    assert "natural conversation" in messages[0]["content"]
