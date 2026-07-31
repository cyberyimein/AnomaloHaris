from app.agent.session import SessionStore


def test_session_store_keeps_web_traces_isolated_and_clears_them() -> None:
    store = SessionStore()
    store.append_web_trace("one", {"id": "trace-1", "content": "result"})

    traces = store.get_web_traces("one")
    traces[0]["content"] = "changed"

    assert store.get_web_traces("one")[0]["content"] == "result"
    assert store.get_web_traces("two") == []
    assert store.get_web_traces("one")[0]["timestamp"]

    store.clear("one")
    assert store.get_web_traces("one") == []


def test_session_store_persists_messages_and_checkpoints_to_sqlite(tmp_path) -> None:
    db_path = tmp_path / "data" / "sessions.sqlite3"
    first = SessionStore(db_path)
    first.append("session-1", {"role": "user", "content": "hello"})
    first.set_active_skills("session-1", {"calculator"})
    first.save_checkpoint(
        "session-1",
        [{"role": "user", "content": "hello"}],
        run_id="run-1",
        prompt_profile="agent",
        user_content="hello",
        iteration=2,
        reason="user_stop",
    )
    first.close()

    second = SessionStore(db_path)
    assert second.get_messages("session-1") == [{"role": "user", "content": "hello"}]
    assert second.get_active_skills("session-1") == {"calculator"}
    checkpoint = second.get_checkpoint("session-1")
    assert checkpoint is not None
    assert checkpoint.run_id == "run-1"
    assert checkpoint.reason == "user_stop"

    restored = second.restore_checkpoint("session-1")
    assert restored is not None
    assert second.get_checkpoint("session-1") is None
    assert second.get_messages("session-1") == restored.messages
    second.close()
