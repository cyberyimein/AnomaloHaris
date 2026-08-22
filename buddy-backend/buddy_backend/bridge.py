"""Dependency-injection bridge from the host into the Buddy package."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

GatewayFactory = Callable[[], Any]
SettingsFactory = Callable[[], Any]

_gateway_factory: GatewayFactory | None = None
_settings_factory: SettingsFactory | None = None


def configure_buddy_runtime(
    *,
    gateway: GatewayFactory,
    settings: SettingsFactory,
) -> None:
    global _gateway_factory, _settings_factory
    _gateway_factory = gateway
    _settings_factory = settings


def get_buddy_gateway() -> Any:
    if _gateway_factory is None:
        raise RuntimeError("Buddy runtime has not been configured by a Host.")
    return _gateway_factory()


def get_buddy_settings() -> Any:
    if _settings_factory is None:
        raise RuntimeError("Buddy settings have not been configured by a Host.")
    return _settings_factory()
