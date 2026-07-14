import asyncio
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from app.config import Settings
from app.tools.base import ToolContext, ToolProvider, ToolResult, ToolSpec

FRUITSPY_PYTHON_API_PREFIX = "/api/v1/tools/python"
ARTIFACT_COMPONENT_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class HttpJsonResponse:
    status_code: int
    payload: dict[str, Any]
    headers: dict[str, str]
    text: str


class PythonSandboxProvider(ToolProvider):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def list_tools(self, context: ToolContext | None = None) -> list[ToolSpec]:
        if not self.settings.python_sandbox_enabled:
            return []
        status_payload, status_error = await self._fruitspy_status()
        if (
            status_error
            or not self.settings.fruitspy_python_tool_token
            or not bool(status_payload.get("ready"))
        ):
            return []
        return [
            ToolSpec(
                name="sandbox_python_run",
                source="sandbox",
                description=(
                    "Run short Python code in a locked-down Python sandbox for math, "
                    "calculation, data checks, or plotting. Print final answers to stdout."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "Python code to execute. Print final answers to stdout.",
                        },
                        "timeout_ms": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "Optional execution timeout in milliseconds.",
                        },
                        "artifacts": {
                            "type": "array",
                            "maxItems": 4,
                            "description": (
                                "Optional files written under /tmp to collect as artifacts."
                            ),
                            "items": {
                                "type": "object",
                                "properties": {
                                    "path": {
                                        "type": "string",
                                        "pattern": r"^[A-Za-z0-9_.-]{1,128}$",
                                        "description": (
                                            "Single filename under /tmp, such as plot.png."
                                        ),
                                    },
                                    "media_type": {
                                        "type": "string",
                                        "description": "Artifact media type, such as image/png.",
                                    },
                                },
                                "required": ["path"],
                                "additionalProperties": False,
                            },
                        }
                    },
                    "required": ["code"],
                    "additionalProperties": False,
                },
            )
        ]

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        context: ToolContext | None = None,
    ) -> ToolResult:
        if name != "sandbox_python_run":
            return ToolResult(name=name, ok=False, content=f"Unknown sandbox tool: {name}")
        if not self.settings.python_sandbox_enabled:
            return ToolResult(
                name=name,
                ok=False,
                content="Python sandbox is disabled for this deployment.",
            )

        code = str(arguments.get("code", ""))
        if not code.strip():
            return ToolResult(name=name, ok=False, content="No Python code provided.")

        return await self._call_fruitspy_tool(name, code, arguments)

    async def _call_fruitspy_tool(
        self,
        name: str,
        code: str,
        arguments: dict[str, Any],
    ) -> ToolResult:
        token = self.settings.fruitspy_python_tool_token
        if not token:
            return ToolResult(
                name=name,
                ok=False,
                content="FruitSpy Python tool token is not configured.",
            )

        status_payload, status_error = await self._fruitspy_status()
        if status_error:
            return ToolResult(
                name=name,
                ok=False,
                content=f"FruitSpy Python tool status check failed: {status_error}",
                data={"backend": "fruitspy"},
            )
        if not bool(status_payload.get("ready")):
            state = str(status_payload.get("state") or "unknown")
            error = status_payload.get("error")
            detail = f" state={state}"
            if error:
                detail += f" error={error}"
            return ToolResult(
                name=name,
                ok=False,
                content=f"FruitSpy Python tool is not ready.{detail}",
                data={"backend": "fruitspy", "status": status_payload},
            )

        timeout_ms = _requested_timeout_ms(
            arguments.get("timeout_ms"),
            self.settings.python_sandbox_timeout_seconds,
        )
        body: dict[str, Any] = {"code": code, "timeout_ms": timeout_ms}
        artifacts = _requested_artifacts(arguments.get("artifacts"))
        if artifacts:
            body["artifacts"] = artifacts

        request_id = str(uuid4())
        url = self._fruitspy_url("/executions")
        http_timeout = timeout_ms / 1000 + 2
        headers = {
            "Authorization": f"Bearer {token}",
            "Idempotency-Key": request_id,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        attempts = 0
        while True:
            attempts += 1
            try:
                response = await asyncio.to_thread(
                    _http_json_request,
                    "POST",
                    url,
                    headers,
                    body,
                    http_timeout,
                )
            except Exception as exc:  # noqa: BLE001
                return ToolResult(
                    name=name,
                    ok=False,
                    content=f"FruitSpy Python tool request failed: {exc}",
                    data={"backend": "fruitspy", "request_id": request_id},
                )

            if response.status_code == 200:
                payload = response.payload
                payload["artifacts"] = await asyncio.to_thread(
                    self._cache_fruitspy_artifacts,
                    payload,
                )
                return _fruitspy_execution_result(name, payload)

            error = _fruitspy_error(response)
            if _fruitspy_retryable(error) and attempts < 3:
                await asyncio.sleep(_fruitspy_retry_delay(response.headers, attempts))
                continue

            return ToolResult(
                name=name,
                ok=False,
                content=_fruitspy_error_content(response),
                data={
                    "backend": "fruitspy",
                    "request_id": request_id,
                    "http_status": response.status_code,
                    "error": error,
                },
            )

    async def status(self, context: ToolContext | None = None) -> dict[str, Any]:
        if not self.settings.python_sandbox_enabled:
            return {
                "enabled": False,
                "backend": "fruitspy",
                "base_url": self.settings.fruitspy_python_tool_base_url,
                "token_configured": bool(self.settings.fruitspy_python_tool_token),
                "fruitspy_status": {},
                "fruitspy_status_error": None,
                "tools": [],
            }
        tools = await self.list_tools(context=context)
        status_payload, status_error = await self._fruitspy_status()
        return {
            "enabled": self.settings.python_sandbox_enabled,
            "backend": "fruitspy",
            "base_url": self.settings.fruitspy_python_tool_base_url,
            "token_configured": bool(self.settings.fruitspy_python_tool_token),
            "fruitspy_status": status_payload,
            "fruitspy_status_error": status_error,
            "tools": [tool.model_dump() for tool in tools],
        }

    async def _fruitspy_status(self) -> tuple[dict[str, Any], str | None]:
        try:
            response = await asyncio.to_thread(
                _http_json_request,
                "GET",
                self._fruitspy_url(""),
                {"Accept": "application/json"},
                None,
                self.settings.fruitspy_python_tool_status_timeout_seconds,
            )
        except Exception as exc:  # noqa: BLE001
            return {}, str(exc)
        if response.status_code != 200:
            return response.payload, _fruitspy_error_content(response)
        return response.payload, None

    def _fruitspy_url(self, suffix: str) -> str:
        base_url = self.settings.fruitspy_python_tool_base_url.rstrip("/")
        path = FRUITSPY_PYTHON_API_PREFIX + suffix
        return urllib.parse.urljoin(base_url + "/", path.lstrip("/"))

    def _cache_fruitspy_artifacts(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        execution_id = str(payload.get("execution_id") or "")
        if not ARTIFACT_COMPONENT_PATTERN.fullmatch(execution_id):
            return []

        cached: list[dict[str, Any]] = []
        token = self.settings.fruitspy_python_tool_token or ""
        for raw_artifact in payload.get("artifacts") or []:
            if not isinstance(raw_artifact, dict):
                continue
            name = str(raw_artifact.get("name") or "")
            download_url = str(raw_artifact.get("download_url") or "")
            if not ARTIFACT_COMPONENT_PATTERN.fullmatch(name) or not download_url:
                continue
            try:
                content = _http_bytes_request(
                    self._fruitspy_artifact_url(download_url),
                    {"Authorization": f"Bearer {token}", "Accept": "*/*"},
                    self.settings.python_sandbox_timeout_seconds + 2,
                    MAX_ARTIFACT_BYTES,
                )
                artifact_dir = self.settings.artifacts_dir / "python" / execution_id
                artifact_dir.mkdir(parents=True, exist_ok=True)
                target = artifact_dir / name
                temporary = artifact_dir / f".{name}.part"
                temporary.write_bytes(content)
                temporary.replace(target)
            except Exception as exc:  # noqa: BLE001
                errors = payload.setdefault("artifact_errors", [])
                if isinstance(errors, list):
                    errors.append({"path": name, "reason": f"download_failed: {exc}"})
                continue

            artifact = {key: value for key, value in raw_artifact.items() if key != "download_url"}
            artifact["url"] = f"/api/artifacts/python/{execution_id}/{name}"
            cached.append(artifact)
        return cached

    def _fruitspy_artifact_url(self, download_url: str) -> str:
        parsed = urllib.parse.urlparse(download_url)
        if parsed.scheme or parsed.netloc or not parsed.path.startswith(
            f"{FRUITSPY_PYTHON_API_PREFIX}/executions/"
        ):
            raise ValueError("FruitSpy returned an invalid artifact download URL")
        base_url = self.settings.fruitspy_python_tool_base_url.rstrip("/")
        return urllib.parse.urljoin(base_url + "/", download_url.lstrip("/"))


def _limit_output(stdout: str, stderr: str, max_chars: int) -> str:
    parts = []
    if stdout:
        parts.append(f"stdout:\n{stdout}")
    if stderr:
        parts.append(f"stderr:\n{stderr}")
    text = "\n\n".join(parts) or "No output."
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n... output truncated ..."


def _http_json_request(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any] | None,
    timeout_seconds: float,
) -> HttpJsonResponse:
    encoded_body = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=encoded_body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            text = response.read().decode("utf-8", errors="replace")
            return HttpJsonResponse(
                status_code=response.status,
                payload=_parse_json_object(text),
                headers={str(key): str(value) for key, value in response.headers.items()},
                text=text,
            )
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return HttpJsonResponse(
            status_code=exc.code,
            payload=_parse_json_object(text),
            headers={str(key): str(value) for key, value in exc.headers.items()},
            text=text,
        )


def _parse_json_object(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _http_bytes_request(
    url: str,
    headers: dict[str, str],
    timeout_seconds: float,
    max_bytes: int,
) -> bytes:
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        content = response.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise ValueError("Artifact exceeds the Anomalo download limit")
    return content


def _requested_timeout_ms(raw_value: Any, default_timeout_seconds: int) -> int:
    if raw_value is None:
        return max(1, int(default_timeout_seconds * 1000))
    try:
        return max(1, int(raw_value))
    except (TypeError, ValueError):
        return max(1, int(default_timeout_seconds * 1000))


def _requested_artifacts(raw_value: Any) -> list[dict[str, str]]:
    if not isinstance(raw_value, list):
        return []

    artifacts: list[dict[str, str]] = []
    for item in raw_value[:4]:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        artifact = {"path": path}
        media_type = str(item.get("media_type") or "").strip()
        if media_type:
            artifact["media_type"] = media_type
        artifacts.append(artifact)
    return artifacts


def _fruitspy_execution_result(name: str, payload: dict[str, Any]) -> ToolResult:
    stdout = str(payload.get("stdout") or "")
    stderr = str(payload.get("stderr") or "")
    content = str(payload.get("content") or _limit_output(stdout, stderr, 12000))
    return ToolResult(
        name=name,
        ok=bool(payload.get("ok")),
        content=content,
        data={
            "backend": "fruitspy",
            "status": payload.get("status"),
            "exit_code": payload.get("exit_code"),
            "stdout": stdout,
            "stderr": stderr,
            "truncated": payload.get("truncated"),
            "image": payload.get("image"),
            "duration_ms": payload.get("duration_ms"),
            "execution_id": payload.get("execution_id"),
            "request_id": payload.get("request_id"),
            "artifacts": payload.get("artifacts") or [],
            "artifact_errors": payload.get("artifact_errors") or [],
        },
    )


def _fruitspy_error(response: HttpJsonResponse) -> dict[str, Any]:
    error = response.payload.get("error")
    return error if isinstance(error, dict) else {}


def _fruitspy_retryable(error: dict[str, Any]) -> bool:
    return bool(error.get("retryable"))


def _fruitspy_retry_delay(headers: dict[str, str], attempt: int) -> float:
    retry_after = headers.get("Retry-After") or headers.get("retry-after")
    if retry_after:
        try:
            return max(0.0, min(float(retry_after), 2.0))
        except ValueError:
            pass
    return min(0.25 * attempt, 1.0)


def _fruitspy_error_content(response: HttpJsonResponse) -> str:
    error = _fruitspy_error(response)
    if error:
        code = error.get("code") or response.status_code
        message = error.get("message") or response.text
        return f"FruitSpy Python tool failed ({code}): {message}"

    detail = response.payload.get("detail")
    if detail:
        return f"FruitSpy Python tool failed ({response.status_code}): {detail}"

    text = response.text.strip()
    if len(text) > 1000:
        text = text[:1000] + "\n... response truncated ..."
    return f"FruitSpy Python tool failed ({response.status_code}): {text or 'No response body.'}"
