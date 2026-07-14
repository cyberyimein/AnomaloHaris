from asyncio import CancelledError, Event
from types import SimpleNamespace

import pytest
from app import main as app_main


class FakeGateway:
    def __init__(self) -> None:
        self.connect_calls = 0
        self.disconnect_calls = 0

    def connect(self) -> dict[str, object]:
        self.connect_calls += 1
        return {"connected": True}

    def disconnect(self) -> dict[str, object]:
        self.disconnect_calls += 1
        return {"connected": False}


class FakeBuddyAudioBridge:
    def __init__(self) -> None:
        self.start_calls = 0
        self.stop_calls = 0

    def start(self) -> None:
        self.start_calls += 1

    def stop(self) -> None:
        self.stop_calls += 1


@pytest.mark.asyncio
async def test_lifespan_skips_buddy_audio_ai_bridge_by_default(monkeypatch) -> None:
    gateway = FakeGateway()

    monkeypatch.setattr(
        app_main,
        "get_settings",
        lambda: SimpleNamespace(buddy_transport="tcp", buddy_audio_ai_enabled=False),
    )
    monkeypatch.setattr(app_main, "get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr(
        app_main,
        "get_buddy_audio_bridge",
        lambda: (_ for _ in ()).throw(AssertionError("audio bridge should stay disabled")),
    )

    async with app_main._lifespan(object()):
        assert gateway.connect_calls == 1

    assert gateway.disconnect_calls == 1


@pytest.mark.asyncio
async def test_lifespan_starts_buddy_audio_ai_bridge_when_enabled(monkeypatch) -> None:
    gateway = FakeGateway()
    audio_bridge = FakeBuddyAudioBridge()

    monkeypatch.setattr(
        app_main,
        "get_settings",
        lambda: SimpleNamespace(buddy_transport="serial", buddy_audio_ai_enabled=True),
    )
    monkeypatch.setattr(app_main, "get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr(app_main, "get_buddy_audio_bridge", lambda: audio_bridge)

    async with app_main._lifespan(object()):
        assert gateway.connect_calls == 0
        assert audio_bridge.start_calls == 1

    assert audio_bridge.stop_calls == 1
    assert gateway.disconnect_calls == 1


@pytest.mark.asyncio
async def test_lifespan_runs_stock_scheduler_only_in_production(monkeypatch) -> None:
    gateway = FakeGateway()
    scheduler_started = Event()
    scheduler_stopped = Event()

    async def fake_stock_scheduler() -> None:
        scheduler_started.set()
        try:
            await Event().wait()
        except CancelledError:
            scheduler_stopped.set()
            raise

    monkeypatch.setattr(
        app_main,
        "get_settings",
        lambda: SimpleNamespace(
            buddy_transport="serial",
            buddy_audio_ai_enabled=False,
            is_production=True,
            stock_schedule_enabled=True,
        ),
    )
    monkeypatch.setattr(app_main, "get_buddy_gateway", lambda: gateway)
    monkeypatch.setattr(app_main.stocks, "run_stock_scheduler", fake_stock_scheduler)

    async with app_main._lifespan(object()):
        await scheduler_started.wait()

    assert scheduler_stopped.is_set()
    assert gateway.disconnect_calls == 1
