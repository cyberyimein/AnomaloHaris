import asyncio

import pytest
from app.api import manage
from app.api.manage import MCPServerRequest, ModelUpdateRequest
from app.config import Settings
from app.runtime_config import RuntimeModelStore
from pydantic import ValidationError


def test_mcp_server_request_accepts_supported_transports() -> None:
    stdio = MCPServerRequest(name="local", command="python")
    http = MCPServerRequest(
        name="fruitspy",
        transport="streamable_http",
        protocol="modern",
        url="http://fruitspy.test/mcp",
    )

    assert stdio.transport == "stdio"
    assert http.protocol == "modern"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("transport", "websocket"),
        ("protocol", "future"),
    ],
)
def test_mcp_server_request_rejects_unsupported_modes(field: str, value: str) -> None:
    request = {"name": "fruitspy", "command": "python", field: value}

    with pytest.raises(ValidationError):
        MCPServerRequest.model_validate(request)


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "local", "transport": "stdio"},
        {"name": "fruitspy", "transport": "streamable_http"},
    ],
)
def test_mcp_server_request_requires_transport_target(payload: dict[str, str]) -> None:
    with pytest.raises(ValidationError, match="required"):
        MCPServerRequest.model_validate(payload)


def test_model_update_request_trims_model_identifier() -> None:
    request = ModelUpdateRequest(model="  deepseek/deepseek-v4-flash-0731  ")

    assert request.model == "deepseek/deepseek-v4-flash-0731"


def test_runtime_model_store_round_trips_model(tmp_path) -> None:
    store = RuntimeModelStore(tmp_path / "runtime-settings.json")

    saved = store.save("deepseek/deepseek-v4-flash-0731")
    loaded = store.load()

    assert loaded == saved
    assert loaded is not None
    assert loaded.model == "deepseek/deepseek-v4-flash-0731"


def test_update_model_settings_persists_and_updates_runtime(monkeypatch, tmp_path) -> None:
    settings = Settings(_env_file=None, ANOMALO_DATA_DIR=tmp_path, OPENROUTER_MODEL="old/model")

    class FakeRuntime:
        def __init__(self) -> None:
            self.updated_model = None

        def update_model(self, model: str) -> None:
            self.updated_model = model

    runtime = FakeRuntime()
    monkeypatch.setattr(manage, "get_settings", lambda: settings)
    monkeypatch.setattr(manage, "get_agent_runtime", lambda: runtime)

    response = asyncio.run(manage.update_model_settings(ModelUpdateRequest(model="new/model")))

    assert response["model"] == "new/model"
    assert response["source"] == "runtime"
    assert runtime.updated_model == "new/model"
    assert RuntimeModelStore(settings.runtime_model_path).load().model == "new/model"
