"""Dependency-injection bridge from the host into the Buddy package."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from ipaddress import ip_address
from typing import Any

from fastapi import HTTPException, Request, status

GatewayFactory = Callable[[], Any]
SettingsFactory = Callable[[], Any]
AccessChecker = Callable[[Request], Awaitable[None]]

_gateway_factory: GatewayFactory | None = None
_settings_factory: SettingsFactory | None = None
_vision_factory: GatewayFactory | None = None
_projection_factory: GatewayFactory | None = None
_access_checker: AccessChecker | None = None


def configure_buddy_runtime(
    *,
    gateway: GatewayFactory,
    settings: SettingsFactory,
    vision: GatewayFactory,
    projection: GatewayFactory,
    access_checker: AccessChecker,
) -> None:
    global _gateway_factory, _settings_factory, _vision_factory, _projection_factory, _access_checker  # noqa: E501
    _gateway_factory = gateway
    _settings_factory = settings
    _vision_factory = vision
    _projection_factory = projection
    _access_checker = access_checker


def get_buddy_gateway() -> Any:
    if _gateway_factory is None:
        raise RuntimeError("Buddy runtime has not been configured by a Host.")
    return _gateway_factory()


def get_buddy_vision_service() -> Any:
    if _vision_factory is None:
        raise RuntimeError("Buddy vision runtime has not been configured by a Host.")
    return _vision_factory()


def get_codex_buddy_projection() -> Any:
    if _projection_factory is None:
        raise RuntimeError("Buddy projection runtime has not been configured by a Host.")
    return _projection_factory()


def get_buddy_settings() -> Any:
    if _settings_factory is None:
        raise RuntimeError("Buddy settings have not been configured by a Host.")
    return _settings_factory()


async def require_management_access(request: Request) -> None:
    if _access_checker is not None:
        override = request.app.dependency_overrides.get(_access_checker)
        if override is not None:
            result = override()
            if hasattr(result, "__await__"):
                await result
            return
    if _access_checker is not None:
        await _access_checker(request)
        return
    host = request.client.host if request.client else ""
    try:
        if host == "localhost" or ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Buddy management API requires Host authorization.",
    )
