import pytest
from app.api.manage import MCPServerRequest
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
