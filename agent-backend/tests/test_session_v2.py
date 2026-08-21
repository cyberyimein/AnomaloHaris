from app.agent.session import SessionStore
from app.agent.session_v2 import SessionV2Store


def test_session_v2_persists_the_legacy_session_api(tmp_path) -> None:
    db_path = tmp_path / "sessions.sqlite3"
    store = SessionV2Store(db_path)
    store.append_many(
        "session-v2",
        [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "tool", "tool_call_id": "call-1", "content": "tool result"},
        ],
    )
    store.set_active_skills("session-v2", {"skill-a"})
    store.set_active_mcp_servers("session-v2", {"mcp-a"})
    store.append_web_trace("session-v2", {"id": "trace-1", "content": "result"})
    store.save_checkpoint(
        "session-v2",
        [{"role": "user", "content": "hello"}],
        run_id="run-v2",
        prompt_profile="agent",
        user_content="hello",
        iteration=2,
        reason="user_stop",
        bootstrap_context=[{"key": "time", "result": "now"}],
    )

    assert store.get_messages("session-v2")[-1]["role"] == "tool"
    assert store.get_active_skills("session-v2") == {"skill-a"}
    assert store.get_active_mcp_servers("session-v2") == {"mcp-a"}
    assert store.get_web_traces("session-v2")[0]["id"] == "trace-1"
    checkpoint = store.get_checkpoint("session-v2")
    assert checkpoint is not None
    assert checkpoint.run_id == "run-v2"
    assert checkpoint.bootstrap_context == [{"key": "time", "result": "now"}]
    assert store.get_session_snapshot("session-v2")["can_resume"] is True
    assert store.list_sessions()[0]["message_count"] == 2
    store.close()


def test_session_v2_lazily_migrates_v1_database(tmp_path) -> None:
    db_path = tmp_path / "legacy.sqlite3"
    legacy = SessionStore(db_path)
    legacy.append("legacy", {"role": "user", "content": "legacy message"})
    legacy.set_active_skills("legacy", {"calculator"})
    legacy.save_checkpoint(
        "legacy",
        [{"role": "user", "content": "legacy message"}],
        run_id="legacy-run",
        prompt_profile="agent",
        user_content="legacy message",
        iteration=1,
    )
    legacy.close()

    migrated = SessionV2Store(db_path)
    assert migrated.get_messages("legacy") == [{"role": "user", "content": "legacy message"}]
    assert migrated.get_active_skills("legacy") == {"calculator"}
    checkpoint = migrated.get_checkpoint("legacy")
    assert checkpoint is not None
    assert checkpoint.run_id == "legacy-run"
    migrated.close()
