from ipaddress import ip_address

from fastapi import HTTPException, Request, status

from app.config import get_settings


async def require_management_access(request: Request) -> None:
    if _is_loopback_client(request):
        return

    settings = get_settings()
    if settings.admin_token and _request_token(request) == settings.admin_token:
        return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Management API requires localhost access or a valid admin token.",
    )


def _is_loopback_client(request: Request) -> bool:
    host = request.client.host if request.client else ""
    if host == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def _request_token(request: Request) -> str | None:
    header_token = request.headers.get("x-anomalo-admin-token")
    if header_token:
        return header_token

    authorization = request.headers.get("authorization") or ""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() == "bearer" and token:
        return token.strip()
    return None
