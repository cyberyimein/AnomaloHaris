import json
from pathlib import Path

from app.agent.contracts import validate_payload


FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "contracts"
    / "fixtures"
    / "agent-events.json"
)


def load_fixtures() -> dict[str, list[dict[str, object]]]:
    with FIXTURE_PATH.open(encoding="utf-8") as file:
        value = json.load(file)
    assert isinstance(value, dict)
    return value


def test_shared_event_fixtures_validate_in_python() -> None:
    fixtures = load_fixtures()
    assert set(fixtures) == {"normal_text", "tool_loop", "stopped", "structured", "legacy_python"}
    for name, events in fixtures.items():
        assert isinstance(events, list)
        for payload in events:
            assert validate_payload(payload, "agent-event") == [], (name, payload)


def test_golden_event_sequences_have_one_terminal_event() -> None:
    fixtures = load_fixtures()
    terminal_types = {"run.finished", "run.stopped", "run.error"}
    for name, events in fixtures.items():
        types = [str(event["type"]) for event in events]
        assert types[0] == "run.started", name
        assert sum(event_type in terminal_types for event_type in types) == 1, name
        assert types[-1] in terminal_types, name

        started = {
            str(event["data"]["tool_call_id"])
            for event in events
            if event["type"] == "tool.started"
        }
        finished = {
            str(event["data"]["tool_call_id"])
            for event in events
            if event["type"] in {"tool.finished", "tool.error"}
        }
        assert started == finished, name


def test_run_request_and_tool_fixtures_are_available_to_python_contract_tests() -> None:
    assert validate_payload({"message": "hello", "resume": False}, "run-request") == []
    assert (
        validate_payload(
            {
                "name": "deterministic_echo",
                "description": "Echo a deterministic value.",
                "parameters": {"type": "object"},
                "source": "test",
            },
            "tool",
        )
        == []
    )
