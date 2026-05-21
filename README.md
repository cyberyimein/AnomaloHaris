# Anomalo

Anomalo is a personal FastAPI AI agent host for browser chat today and ESP32 hardware later.

The runtime is event based: the agent emits message deltas, tool start/result events, errors, and run lifecycle events. WebSocket streams those events directly, while REST can either collect them or return newline-delimited streaming JSON.

## Features

- OpenAI SDK compatible LLM client with OpenRouter defaults.
- WebSocket chat at `/ws/chat/{session_id}`.
- REST chat at `/api/chat` and streaming REST at `/api/chat/stream`.
- Tool registry with fixed core tools, runtime skills, MCP server config, and Docker Python sandbox.
- YAML-managed system-level prompt profiles.
- Simple `AGENTS.md` memory uploaded from the development frontend.
- Dev frontend panel that shows the JSON payload prepared for the LLM request.
- Skill and MCP management APIs.
- Static FastAPI frontend at `/`.
- STT/TTS provider stubs for later audio integration.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open http://localhost:8000.

Without `OPENROUTER_API_KEY`, the app runs in local dev mode and returns a mock assistant response. Set the key in `.env` to use OpenRouter.

## Prompts

System-level prompts live in `config/prompts.yaml`. The runtime reads the configured profile on
each chat run, so edits to the YAML are picked up without restarting the app.

```yaml
profiles:
  default:
    messages:
      - id: anomalo_identity
        role: system
        content: |
          You are Anomalo...
```

Set `ANOMALO_PROMPT_PROFILE` in `.env` to switch profiles. The development frontend shows the
configured prompt profile on load, then replaces it with the exact JSON request payload prepared
for the LLM whenever a chat run reaches the model call.

## Agent Memory

Upload `AGENTS.md` from the development frontend to save simple personal-agent memory at
`config/AGENTS.md`. The runtime reads this file on every run and inserts it as a system message
between the YAML prompt profile and session history. The Context Assembly panel shows the
`AGENTS.md memory` segment when it is present.

## Python Sandbox

Build the optional Python tool image:

```bash
docker build -t anomalo-python:latest docker/python
```

The tool runs with no network, CPU/memory limits, read-only container filesystem, and an execution timeout.

## Skill Layout

Each skill lives under `skills/{skill_name}`:

```text
skills/
  calculator/
    SKILL.md
    tools.py
```

`SKILL.md` follows the Anthropic-style skill format with YAML frontmatter:

```md
---
name: calculator
description: Deterministic arithmetic and tiny math smoke tests.
---

Instructions for the skill go here.
```

`tools.py` is optional. When present, public Python functions are auto-discovered as tools from their function signatures and docstrings. Function arguments are passed as keyword args.

## MCP

MCP servers are configured in `config/mcp_servers.yaml`. The management API can add or toggle server configs. Install MCP support with `pip install -e ".[mcp]"`. If the optional `mcp` package is installed, configured servers can expose tools through the registry.

MCP loading is session-scoped and on demand. By default the model only sees the MCP catalog plus `mcp_activate` and `mcp_deactivate`. A server's actual tool schemas are only loaded after that server is activated for the current session, either from the frontend session picker or by calling `mcp_activate`. This keeps large MCP tool packs out of the prompt until they are needed.


## Management APIs

Skill and MCP management endpoints are localhost-only by default. If you need to manage them remotely, set `ANOMALO_ADMIN_TOKEN` and send it as `X-Anomalo-Admin-Token` or `Authorization: Bearer <token>`. Keep MCP commands restricted to trusted local use; MCP server configs can start local processes.

MCP stdio operations use `MCP_TIMEOUT_SECONDS` to avoid hanging `/api/tools` or chat runs when a server does not answer.
