# Anomalo

Anomalo is a local Node.js/TypeScript AI compute center. It exposes versioned Preset Models, OpenAI-compatible calls, native run events, and a Vue control panel so other local agents can share one provider and tool runtime.

> [!IMPORTANT]
> Anomalo is an experimental personal project, not a hardened multi-user service. Keep it on a trusted network unless you add authentication and deployment controls appropriate for your environment.

## Why this project exists

Anomalo has three primary goals:

1. **Learn and track modern agent-harness techniques.** The project is a hands-on laboratory for streaming agent runtimes, tool calling, context assembly, prompt profiles, memory, skills, MCP, sandboxed execution, and human approval flows. Its purpose is to turn new agent patterns into working code that can be inspected and understood.
2. **Keep hardware integrations optional.** Buddy, audio, and vision are not part of the Node Host core. If retained, they must be installed as explicit capability plugins or run as external services.
3. **Keep the system extensible for focused research agents.** Domain-specific workflows should live in dedicated agents and services rather than expanding Anomalo's core control panel.

These goals share one runtime: agent-harness experiments can be tested through the browser, embodied through StackChan, and applied to a concrete research domain instead of remaining isolated demos.

## What is implemented today

- Streams agent lifecycle, message, and tool events over WebSocket or REST.
- Uses an OpenAI SDK-compatible client with OpenRouter defaults and a local mock mode.
- Loads prompt profiles, `AGENTS.md` memory, skills, and MCP catalogs at runtime.
- Provides a Vue dashboard for chat, context inspection, Preset Models, and plugin capability status.
- Loads explicitly allowlisted Pi-like Node plugins in the Host or isolated child processes.
- Includes OpenAI-compatible and Anomalo-native APIs with usage, idempotency, and management routes.
- Keeps hardware protocol notes and optional plugin seams outside the Node production image.

## Repository layout

```text
.
├── apps/node-host/  Node.js Host, AgentCore, Provider, Session, and PluginHost
├── packages/        contracts and shared TypeScript packages
├── agent-backend/   runtime resources, deployment files, and the committed frontend bundle
├── buddy-backend/   optional Buddy plugin reference (not part of Node production)
├── frontend/        Vue 3 and Vite source
├── .env.example     Shared runtime configuration template
└── docs/            architecture, migration, and optional-capability design docs
```

The production frontend build is committed under `agent-backend/app/frontend/` so the Node Host can serve the application without a separate frontend process. The production Docker image contains only Node artifacts and trusted resource files.

## Requirements

- Node.js 22+ and npm
- Optional OpenRouter-compatible provider credentials
- Optional separately deployed capability plugins or services

## Quick start

Clone the repository and create your local configuration:

```bash
git clone <your-fork-or-repository-url>
cd Anomalo
cp .env.example .env
```

Install the workspace dependencies and build the Node Host plus frontend:

```bash
npm install
npm run build --workspaces
```

Start the Node Host from the repository root:

```bash
node apps/node-host/dist/main.js
```

Open <http://127.0.0.1:8000>.

Without `OPENROUTER_API_KEY`, Anomalo uses a deterministic mock response. Add an OpenRouter key to the untracked `.env` file to enable model calls:

```dotenv
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=openai/gpt-4o-mini
```

Never commit `.env` or another file containing real credentials.

## Frontend development

Install the workspace dependencies from the repository root so the frontend can
resolve `@anomalo/contracts`:

```bash
npm install
```

Start the Node Host first, then run Vite in another terminal:

```bash
npm --prefix frontend run dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/api`, `/ws`, `/health`, `/fonts`, and `/static` to the backend on port `8000` by default. Set `ANOMALO_BACKEND_URL` when the backend uses a different origin.

To refresh the frontend bundle committed for the Node Host:

```bash
npm --prefix frontend run build
```

The build replaces `agent-backend/app/frontend/`; review and commit the generated asset changes together with the source changes.

## Configuration

All runtime configuration comes from the root `.env`. The most commonly used variables are:

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Enables live LLM requests | unset (mock mode) |
| `OPENROUTER_MANAGEMENT_API_KEY` | Enables the credits widget | unset |
| `OPENAI_BASE_URL` | OpenAI-compatible API base URL | OpenRouter |
| `OPENROUTER_MODEL` | Model identifier | `openai/gpt-4o-mini` |
| `ANOMALO_SEARCH_MODE` | Default retrieval mode for new sessions: `native`, `subagent`, or `diy` | `diy` |
| `WEB_RESEARCH_SUBAGENT_MODEL` | Fixed model used by the retrieval subagent | `deepseek/deepseek-v4-flash-0731` |
| `SEARCH_MODE_TIMEOUT_SECONDS` | Timeout for Responses API retrieval calls | `90` |
| `MAX_TOOL_ITERATIONS` | Maximum model/tool loop iterations per run | `50` |
| `AGENT_RUN_TIMEOUT_SECONDS` | Maximum wall-clock duration for one resumable run | `600` |
| `ANOMALO_ADMIN_TOKEN` | Authorizes remote management requests | unset |
| `ANOMALO_SESSION_SCHEMA` | Session adapter schema | `v2` |
| `ANOMALO_PI_EXTENSIONS_ENABLED` | Enable the configured trusted Pi extensions | `false` |
| `ANOMALO_PLUGIN_CONFIG` | Explicit plugin allowlist | `./agent-backend/config/plugins.yaml` |
| `ANOMALO_PLUGIN_TIMEOUT_MS` | Plugin hook/tool timeout | `30000` |
| `ANOMALO_AGENT_PROMPT_PROFILE` | Default prompt profile | `agent` |
| `WEB_TOOLS_ENABLED` | Publishes DuckDuckGo search and Markdown fetch tools | `true` |
| `ANOMALO_DATA_DIR` | Persistent SQLite data directory | `./data` |

See [`.env.example`](.env.example) for the complete template. Empty optional values are intentionally safe to commit.

### Optional capability plugins

The Node Host deliberately does not expose built-in Buddy, audio, or vision
routes. A capability plugin must be explicitly installed and allowlisted, may
declare metadata such as `buddy` or `vision`, and owns its transport/tool
implementation. Deprecated capabilities should remain disabled instead of
being reintroduced into the Host core.

## Agent runtime

Anomalo assembles each model request from:

1. A prompt profile from `agent-backend/config/prompts.yaml`.
2. Optional personal memory from `agent-backend/config/AGENTS.md`.
3. Activated skills and MCP server instructions.
4. Session history and available tool schemas.

The runtime emits typed events for run start and finish, LLM requests, streamed message deltas, tool calls, tool results, and errors. The browser UI exposes this context for debugging.

The Agent Inspector's **Web Activity** panel records `web_search` and `web_fetch` calls for the
current session, including DuckDuckGo result lists, fetch backend and timing metadata, and returned
Markdown. `GET /api/sessions/{session_id}/web-traces` exposes the same in-memory trace data for
development and evaluation. Direct fetch rejects private and local targets; JavaScript-rendered
pages require a separately deployed capability plugin or external service.

### Chat endpoints

- `WS /ws/chat/{session_id}` — bidirectional event streaming.
- `POST /api/chat` — collected JSON response.
- `POST /api/chat/stream` — newline-delimited streaming JSON.

The browser bridge is an optional connected-client capability. A client must send
`client.hello` with `agent_profile: "browser_operator"` and the browser capability list before the
server returns `client.ready`. Browser tool calls are then emitted as `browser.tool.call` events;
the client returns `browser.tool.result` with the matching `session_id`, `run_id`, and
`tool_call_id`. The browser tool wait deadline defaults to 60 seconds and is configurable with
`BROWSER_TOOL_TIMEOUT_SECONDS`.

HTTP callers can request a structured final answer with the OpenAI-compatible
`response_format` field. The tool-calling loop remains streamed internally; Anomalo runs a
non-streaming finalizer, validates its response, and returns the parsed value in `output`.

```json
{
  "message": "Summarize the FOMC decision in one or two sentences.",
  "session_id": "news-session-1",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "fomc_summary",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {"summary": {"type": "string"}},
        "required": ["summary"],
        "additionalProperties": false
      }
    }
  }
}
```

Omit `response_format` for the existing plain-text behavior. Supported types are `text`,
`json_object`, and `json_schema`. A paused run stores this contract in its SQLite checkpoint and
reuses it on resume.

### Preset Models

The **Preset Models** tab creates immutable, versioned Agent capability bundles. A Preset Model
fixes the prompt, plugin set, provider model, tool policy, and runtime limits; callers select it
with an explicit `name@version` such as `anomalo@1` or `fomc-brief@3`. Definitions are stored in
`ANOMALO_DATA_DIR/preset-models.sqlite3`. Management requests use
`GET/POST /api/manage/preset-models` plus the versioned `validate`, `publish`, and `retire` routes
and require `ANOMALO_ADMIN_TOKEN`.

The default chat entry point resolves `ANOMALO_DEFAULT_PRESET_MODEL` (default `anomalo@1`).
External services can use the collected compatibility route or the native compute API; neither
route permits callers to override the Preset Model prompt, plugins, provider model, or tool list.

The OpenAI-compatible payload uses the fixed Preset Model reference:

```json
{
  "model": "fomc-brief@3",
  "messages": [
    { "role": "user", "content": "Summarize the latest FOMC decision." }
  ],
  "stream": false
}
```

External applications can invoke a versioned Preset Model. The OpenAI-compatible endpoint returns
a standard chat completion; the native run endpoint returns the full event list and `final_text`.

```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H 'Authorization: Bearer <service-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "fomc-brief@3",
    "messages": [{"role": "user", "content": "Summarize the latest FOMC decision in one or two sentences."}],
    "metadata": {"session_id": "fomc-task-2026-08-03"},
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "fomc_summary",
        "strict": true,
        "schema": {
          "type": "object",
          "properties": {"summary": {"type": "string"}},
          "required": ["summary"],
          "additionalProperties": false
        }
      }
    }
  }'
```

Use `POST /api/preset-models/{name}/versions/{version}/runs/stream` for native NDJSON events.
The legacy `POST /api/agents/{id-or-name}/chat` aliases remain only for compatibility and resolve
to a versioned Preset Model. Put an authenticated reverse proxy in front of any non-local deployment.

### Prompt profiles and memory

Edit `agent-backend/config/prompts.yaml` to add or update system prompt profiles. The file is read for each run, so prompt changes do not require a server restart.

The development UI can upload an `AGENTS.md` file as local agent memory. It is stored at `agent-backend/config/AGENTS.md`, which is intentionally ignored by Git because it may contain personal information.

### Skills

Node Host skills live under `agent-backend/skills/`. Each skill contains a `SKILL.md` file with
YAML frontmatter and instructions. Buddy plugin skills and executable hardware integrations are
not loaded by the Node runtime; a capability plugin owns them explicitly.

```text
agent-backend/skills/calculator/
└── SKILL.md
```

Skills are activated per session and included in the run context snapshot.

### MCP catalog

Node Host reads `agent-backend/config/mcp_servers.yaml` and the corresponding markdown
instructions, exposes the catalog through `/api/mcp`, and snapshots active instructions per run.
Actual MCP transport/client implementations belong in an explicitly installed plugin or an
external service; the core image does not install a Python MCP SDK or launch arbitrary MCP
processes. Never commit secrets inside the YAML file.

```yaml
mcp_servers:
  room_climate:
    enabled: true
    description: Optional plugin-owned MCP capability
```

Remote MCP URLs, subprocess commands, and hardware transports are trusted-code configuration and
remain outside the Node Host core.

## Retired Python and hardware integrations

The former Python Host, audio, vision, and Codex hook runtime have been removed. Buddy protocol notes
and an optional Python gateway reference remain under `buddy-backend/`; they are not imported by the
Node Host, copied into the production image, or started by deployment scripts. If any capability
returns, package it as an explicitly allowlisted plugin or external service with its own lifecycle
and security boundary.

## Apple Container deployment

The production image builds the Vue frontend and serves it from the Node Host. It contains Node
artifacts plus trusted prompt, skill, and MCP resource files; it does not install Python or expose
the legacy Buddy port. Build an OCI archive with Apple Container:

```bash
agent-backend/scripts/build_apple_container_image.sh
```

The script writes the archive and metadata under the ignored `agent-backend/artifacts/container-images/` directory. Deploy with a private environment file:

```bash
cp agent-backend/deploy/anomalo.container.env.example \
  agent-backend/deploy/anomalo.container.env

REMOTE=user@your-host.example \
ENV_FILE=agent-backend/deploy/anomalo.container.env \
  agent-backend/scripts/deploy_apple_container.sh \
  agent-backend/artifacts/container-images/anomalo-<tag>-linux-arm64.env
```

The private deployment environment file is ignored by Git. Review both scripts and adapt the network, storage, SSH, and host-loopback settings to your machine before running them.
Before deployment, set `ANOMALO_SERVICE_TOKEN` and the separate `ANOMALO_ADMIN_TOKEN` to different long random secrets. The production image listens on `0.0.0.0` only with explicit acknowledgement and refuses to start without both tokens; compute callers send the service token as a Bearer token, while the dashboard sends the admin token only to management routes.

The deployment script mounts `REMOTE_DATA_DIR` from the deployment host to `/data` in the container. Session history and Stop/Resume checkpoints are stored in `/data/sessions.sqlite3`; Preset Models are stored in `/data/preset-models.sqlite3`; usage, idempotency reservations, and Native Run events are stored in `/data/compute.sqlite3`. Keep this directory on persistent host storage and do not delete it when replacing the container. By default it is `.anomalo/anomalo-data` under the remote user's home; set `REMOTE_STORAGE_ROOT` or `REMOTE_DATA_DIR` to an explicit host path when needed.

## Tests and linting

Run the Node workspace checks:

```bash
npm install
npm run build --workspaces
npm --prefix apps/node-host test
npm --prefix frontend test
```

The Node tests cover the agent lifecycle, API routes, provider tool serialization, Preset Models,
plugin loading, browser bridge, resources, and frontend projections. Python and hardware tests
remain historical reference checks and are not required to start the Node production image.

## Security notes

- Keep all credentials in the ignored root `.env` or a secret manager.
- Set a strong `ANOMALO_ADMIN_TOKEN` before allowing non-loopback management requests.
- The current application does not provide complete user authentication for chat, memory, session, prompt, or credits endpoints. Put an authenticated reverse proxy or equivalent access control in front of any non-local deployment.
- Loopback checks can be affected by reverse proxies. Do not assume they provide end-user authentication.
- Plugins are trusted local code or isolated child processes and must be explicitly allowlisted.
- External capability services must enforce their own authentication and network boundary.
- Generated reports, audio captures, uploaded memory, artifacts, local fonts, and model files are ignored and should remain outside Git.
- If a secret has ever been committed, removing it from the latest commit is not enough: rotate it and clean the Git history before publishing.

## Project status

Anomalo is developed as a personal system and may change without backward-compatibility guarantees. Issues and pull requests are welcome after the repository is published, but expect hardware- and environment-specific setup for the optional integrations.

## License

This repository currently does not include an open-source license. Until a license is added, the source is publicly visible but remains under the copyright holder's default rights. Choose and add a license before inviting reuse or contributions.
