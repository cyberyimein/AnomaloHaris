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
