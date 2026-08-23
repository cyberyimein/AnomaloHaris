# FruitSpy Python sandbox API contract

Status: implemented by the Node Host adapter.

AnomaloHaris treats FruitSpy as an external, authenticated capability service. The production
container does not install Python and does not launch a Python worker.

## Configuration

```dotenv
PYTHON_SANDBOX_ENABLED=true
PYTHON_SANDBOX_TIMEOUT_SECONDS=10
FRUITSPY_PYTHON_TOOL_BASE_URL=http://host.docker.internal:8848
FRUITSPY_PYTHON_TOOL_API_PATH=/api/v1/tools/python
FRUITSPY_PYTHON_TOOL_TOKEN=replace-me
FRUITSPY_PYTHON_TOOL_STATUS_TIMEOUT_SECONDS=2
```

The base URL must be reachable from the AnomaloHaris process/container. Tokens are sent only as
Bearer credentials to the configured FruitSpy origin.

## Readiness

```http
GET /api/v1/tools/python
Authorization: Bearer <token>
Accept: application/json
```

The tool is published only when the response is HTTP 200 and contains `{"ready": true}`. A
recommended response also includes `state`, `version`, and a bounded diagnostic `message`.

## Execution

```http
POST /api/v1/tools/python/executions
Authorization: Bearer <token>
Idempotency-Key: <uuid>
Content-Type: application/json
Accept: application/json
```

```json
{
  "code": "print(1 + 1)",
  "timeout_ms": 10000,
  "artifacts": [{"path": "plot.png", "media_type": "image/png"}]
}
```

FruitSpy should return a bounded JSON object such as:

```json
{
  "ok": true,
  "status": "completed",
  "exit_code": 0,
  "stdout": "2\n",
  "stderr": "",
  "content": "2",
  "truncated": false,
  "duration_ms": 120,
  "execution_id": "exec_01J...",
  "artifacts": []
}
```

For failures, use a non-2xx status where possible and return:

```json
{
  "ok": false,
  "error": {
    "code": "execution_timeout",
    "message": "Execution exceeded its timeout.",
    "retryable": false
  }
}
```

The Node Host retries only retryable, HTTP 429, and HTTP 503 failures, up to two retries, using
the same idempotency key. It caps execution timeouts at 60 seconds and response bodies at 2 MB.

## Artifacts

FruitSpy may return artifact descriptors with a relative or same-origin URL:

```json
{
  "name": "plot.png",
  "media_type": "image/png",
  "download_url": "/api/v1/tools/python/executions/exec_01J.../artifacts/plot.png"
}
```

The Node Host accepts only safe single-component names, same-origin URLs below the configured API
path, and files up to 2 MB. It downloads them with the FruitSpy Bearer token, caches them below
`ANOMALO_DATA_DIR/artifacts/python/<execution_id>/`, and exposes signed, session-bound local URLs in
the tool result as `/api/artifacts/python/<execution_id>/<name>?session_id=...&artifact_token=...`.
Only raster image types are served inline; all other artifact types are returned as inert downloads
with `X-Content-Type-Options: nosniff`.

FruitSpy remains responsible for process isolation, filesystem policy, network egress policy,
package availability, resource quotas, and cleanup of its own execution sandboxes.
