import json

import pytest
from app.tools.local import CoreToolProvider


@pytest.mark.asyncio
async def test_core_convert_time_converts_new_york_dst_to_utc() -> None:
    provider = CoreToolProvider()

    result = await provider.call_tool(
        "core_convert_time",
        {
            "datetime": "2026-09-16T14:00:00",
            "from_timezone": "America/New_York",
            "to_timezone": "UTC",
        },
    )

    assert result.ok is True
    assert result.data["converted_iso"] == "2026-09-16T18:00:00+00:00"
    assert result.data["utc_iso"] == "2026-09-16T18:00:00+00:00"
    assert json.loads(result.content)["converted_iso"] == "2026-09-16T18:00:00+00:00"


@pytest.mark.asyncio
async def test_core_convert_time_uses_input_offset_without_source_timezone() -> None:
    provider = CoreToolProvider()

    result = await provider.call_tool(
        "core_convert_time",
        {
            "datetime": "2026-09-16T14:00:00-04:00",
            "to_timezone": "Asia/Tokyo",
        },
    )

    assert result.ok is True
    assert result.data["converted_iso"] == "2026-09-17T03:00:00+09:00"


@pytest.mark.asyncio
async def test_core_convert_time_rejects_naive_input_without_source_timezone() -> None:
    provider = CoreToolProvider()

    result = await provider.call_tool(
        "core_convert_time",
        {"datetime": "2026-09-16T14:00:00", "to_timezone": "UTC"},
    )

    assert result.ok is False
    assert "from_timezone is required" in result.content


@pytest.mark.asyncio
async def test_core_convert_time_rejects_nonexistent_local_time() -> None:
    provider = CoreToolProvider()

    result = await provider.call_tool(
        "core_convert_time",
        {
            "datetime": "2026-03-08T02:30:00",
            "from_timezone": "America/New_York",
            "to_timezone": "UTC",
        },
    )

    assert result.ok is False
    assert "does not exist" in result.content


@pytest.mark.asyncio
async def test_core_convert_time_rejects_invalid_fold() -> None:
    provider = CoreToolProvider()

    result = await provider.call_tool(
        "core_convert_time",
        {
            "datetime": "2026-11-01T01:30:00",
            "from_timezone": "America/New_York",
            "fold": "later",
        },
    )

    assert result.ok is False
    assert result.content == "fold must be 0 or 1"


@pytest.mark.asyncio
async def test_core_convert_time_is_published_with_timezone_schema() -> None:
    provider = CoreToolProvider()

    tools = {tool.name: tool for tool in await provider.list_tools()}

    assert "core_convert_time" in tools
    parameters = tools["core_convert_time"].parameters
    assert parameters["required"] == ["datetime"]
    assert parameters["properties"]["from_timezone"]["type"] == "string"
    assert parameters["properties"]["to_timezone"]["default"] == "UTC"
