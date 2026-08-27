# Urus → AnomaloHaris scheduled-event retrieval

For the registered Workflow Runtime integration, use
[`urus-workflow.md`](./urus-workflow.md). This document remains the contract for
calling the standalone `scheduled-event-investigator@1` Preset Model through the
compute API.

Urus should call the published Preset Model through the compute API. The old
`/api/agents/{agent}/chat` endpoint is not part of the interface.

## Model

Use the exact model reference:

```text
scheduled-event-investigator@1
```

This built-in model is immutable and has only these tools:

- `web_search`
- `web_fetch`
- `core_get_time`
- `core_convert_time`

It has the Urus scheduled-event prompt, bootstrapped `Asia/Tokyo` and
`America/New_York` clocks, and no Python, browser, Buddy, MCP, filesystem, or
general-purpose plugin capability.

## Request

Call `POST /v1/chat/completions` with the Urus service token. The management
token (`X-AnomaloHaris-Admin-Token`) is not used for this integration.

```http
POST /v1/chat/completions
Authorization: Bearer <URUS_ANOMALOHARIS_SERVICE_TOKEN>
Content-Type: application/json
Idempotency-Key: <unique-request-key>
```

```json
{
  "model": "scheduled-event-investigator@1",
  "stream": false,
  "metadata": {
    "session_id": "urus-scheduled-<stable-operation-id>"
  },
  "messages": [
    {
      "role": "user",
      "content": "<scheduled-event discovery or result-verification request>"
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "scheduled_event_response",
      "strict": true,
      "schema": <operation-specific JSON Schema object>
    }
  }
}
```

`response_format` is the only request-level override enabled for this preset;
the provider, prompt, plugins, tools, temperature, and retrieval policy remain
controlled by the immutable model. Urus should send one user message and put
the operation-specific schema in `json_schema.schema`.

## Response

For a successful non-streaming request, parse the JSON string at
`choices[0].message.content`:

```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "model": "scheduled-event-investigator@1",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "<JSON string matching the supplied schema>"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

Use the HTTP status and `error_code` for failures. A session is bound to the
model reference on its first request; do not reuse a session ID for a different
Preset Model.
