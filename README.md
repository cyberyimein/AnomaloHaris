# AnomaloHaris

AnomaloHaris is a local Node.js/TypeScript AI compute center. It exposes versioned Preset Models, OpenAI-compatible calls, native run events, and a Vue control panel so other local agents can share one provider and tool runtime.

> [!IMPORTANT]
> AnomaloHaris is an experimental personal project, not a hardened multi-user service. Keep it on a trusted network unless you add authentication and deployment controls appropriate for your environment.

## Why this project exists

AnomaloHaris has three primary goals:

1. **Learn and track modern agent-harness techniques.** The project is a hands-on laboratory for streaming agent runtimes, tool calling, context assembly, prompt profiles, memory, skills, MCP, sandboxed execution, and human approval flows. Its purpose is to turn new agent patterns into working code that can be inspected and understood.
2. **Keep hardware integrations optional.** Buddy, audio, and vision are not part of the Node Host core. If retained, they must be installed as explicit capability plugins or run as external services.
3. **Keep the system extensible for focused research agents.** Domain-specific workflows should live in dedicated agents and services rather than expanding AnomaloHaris's core control panel.

These goals share one runtime: agent-harness experiments can be tested through the browser, embodied through StackChan, and applied to a concrete research domain instead of remaining isolated demos.

## What is implemented today

- Streams agent lifecycle, message, and tool events over WebSocket or REST.
- Uses an OpenAI SDK-compatible client with OpenRouter defaults and a local mock mode.
- Loads prompt profiles, `AGENTS.md` memory, skills, and MCP catalogs at runtime.
- Provides a Vue dashboard for chat, context inspection, Preset Models, plugin capability status, and an admin-only Buddy control tab.
- Loads explicitly allowlisted Pi-like Node plugins in the Host or isolated child processes.
- Includes OpenAI-compatible and AnomaloHaris-native APIs with usage, idempotency, and management routes.
- Keeps hardware protocol notes and optional plugin seams outside the Node production image.

## Repository layout

```text
.
├── apps/node-host/  Node.js Host, AgentCore, Provider, Session, and PluginHost
├── packages/        contracts and shared TypeScript packages
├── runtime-bundle/   runtime resources, deployment files, and the committed frontend bundle
├── apps/buddy-service/ Node.js Buddy device service, Hook Relay, and approvals
├── buddy-backend/   firmware/protocol reference only
├── frontend/        Vue 3 and Vite source
├── .env.example     Shared runtime configuration template
└── docs/            architecture, migration, and optional-capability design docs
```

The production frontend build is committed under `runtime-bundle/app/frontend/` so the Node Host can serve the application without a separate frontend process. The production Docker image contains only Node artifacts and trusted resource files.

## Requirements

- Node.js 22+ and npm
- Optional OpenRouter-compatible provider credentials
- Optional separately deployed capability plugins or services

## Quick start

Clone the repository and create your local configuration:

```bash
git clone <your-fork-or-repository-url>
cd AnomaloHaris
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

Without `OPENROUTER_API_KEY`, AnomaloHaris uses a deterministic mock response. Add an OpenRouter key to the untracked `.env` file to enable model calls:

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

The build replaces `runtime-bundle/app/frontend/`; review and commit the generated asset changes together with the source changes.

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
| `PYTHON_SANDBOX_ENABLED` | Enables the external FruitSpy Python tool | `true` |
| `PYTHON_SANDBOX_TIMEOUT_SECONDS` | Default timeout for one FruitSpy execution | `10` |
| `FRUITSPY_PYTHON_TOOL_BASE_URL` | Base URL of the external FruitSpy Python service | unset |
| `FRUITSPY_PYTHON_TOOL_API_PATH` | FruitSpy Python API path | `/api/v1/tools/python` |
| `FRUITSPY_PYTHON_TOOL_TOKEN` | Bearer token for FruitSpy | unset |
| `FRUITSPY_PYTHON_TOOL_STATUS_TIMEOUT_SECONDS` | FruitSpy readiness-check timeout | `2` |
| `ANOMALO_ARTIFACT_SECRET` | Stable secret for signed browser-readable artifact URLs | unset (ephemeral) |
| `MAX_TOOL_ITERATIONS` | Maximum model/tool loop iterations per run | `50` |
| `AGENT_RUN_TIMEOUT_SECONDS` | Maximum wall-clock duration for one resumable run | `600` |
| `ANOMALO_ADMIN_TOKEN` | Authorizes remote management requests | unset |
| `ANOMALO_SESSION_SCHEMA` | Session adapter schema | `v2` |
| `ANOMALO_PI_EXTENSIONS_ENABLED` | Enable the configured trusted Pi extensions | `false` |
| `ANOMALO_PLUGIN_CONFIG` | Explicit plugin allowlist | `./runtime-bundle/config/plugins.yaml` |
| `ANOMALO_PLUGIN_TIMEOUT_MS` | Plugin hook/tool timeout | `30000` |
| `ANOMALO_BUDDY_SERVICE_URL` | Optional Buddy backend URL used by the Buddy dashboard proxy and `buddy-bridge` | `http://127.0.0.1:8765` |
| `ANOMALO_BUDDY_SERVICE_TOKEN` | Token forwarded to the independent Buddy service by the dashboard proxy and allowlisted child plugin | unset |
| `ANOMALO_BUDDY_REQUEST_TIMEOUT_MS` | Buddy bridge request timeout | `1500` |
| `ANOMALO_AGENT_PROMPT_PROFILE` | Default prompt profile | `agent` |
| `WEB_TOOLS_ENABLED` | Publishes DuckDuckGo search and Markdown fetch tools | `true` |
| `ANOMALO_DATA_DIR` | Persistent SQLite data directory | `./data` |

See [`.env.example`](.env.example) for the complete template. Empty optional values are intentionally safe to commit.

### Optional capability plugins

The Node Host does not embed Buddy hardware, audio, or vision runtimes. Buddy
runs as an independent optional Node service in `apps/buddy-service/`. The UI's
Buddy tab is an admin-only control-plane proxy for status, events, connection,
and lightweight state commands; it is not a model-visible ToolRuntime. The
Node Host uses the explicitly allowlisted `@anomalo/buddy-bridge` plugin and
the `runtime-bundle/skills/buddy` Skill only when an Agent Preset Model binds
that plugin.
Audio, vision, camera, and media processing remain outside this integration.

Start the Buddy service separately when a device is available:

```bash
npm run build --workspace @anomalo/buddy-service
npm run start --workspace @anomalo/buddy-service
```

For an Apple Container deployment, build and deploy the independent service
on the same `anomaloharis-external` network as Anomalo. Copy
`runtime-bundle/deploy/buddy-service.container.env.example` to the ignored
`runtime-bundle/deploy/buddy-service.container.env`, set both service tokens
and the device transport values, then run:

```bash
IMAGE_NAME=buddy-service \
DOCKERFILE=runtime-bundle/docker/buddy-service/Dockerfile \
runtime-bundle/scripts/build_apple_container_image.sh
REMOTE=macmini \
ENV_FILE=runtime-bundle/deploy/buddy-service.container.env \
runtime-bundle/scripts/deploy_buddy_container.sh \
  runtime-bundle/artifacts/container-images/buddy-service-<tag>-linux-arm64.env
```

The Anomalo env file must use the `anomaloharis-external` network gateway for
the published Buddy port (currently `ANOMALO_BUDDY_SERVICE_URL=http://192.168.67.1:8765`;
confirm the gateway with `container network inspect anomaloharis-external`) and
the matching `ANOMALO_BUDDY_SERVICE_TOKEN`. The Buddy deployment publishes TCP
`8787` for a remote device by default.

Set `ANOMALO_PI_EXTENSIONS_ENABLED=true` in the Node Host and keep the Buddy
service on loopback for local development. Public Buddy deployments require
separate `BUDDY_SERVICE_TOKEN` and `BUDDY_HOOK_TOKEN` values. The Node service
owns Call Buddy transport, Hook Relay state, and approvals; the Agent Host only
owns the versioned bridge plugin.

The service auto-connects on startup. Without a serial port it opens a local
Buddy TCP listener on `127.0.0.1:8766`; set `BUDDY_TCP_HOST` and
`BUDDY_TCP_CLIENT_IP` explicitly for a remote device. A non-loopback TCP
listener is rejected unless the client IP allowlist is configured.

## Agent runtime

AnomaloHaris assembles each model request from:

1. A prompt profile from `runtime-bundle/config/prompts.yaml`.
2. Optional personal memory from `runtime-bundle/config/AGENTS.md`.
3. Activated skills and MCP server instructions.
4. Session history and available tool schemas.

The runtime emits typed events for run start and finish, LLM requests, streamed message deltas, tool calls, tool results, and errors. The browser UI exposes this context for debugging.

The Agent Inspector's **Web Activity** panel records `web_search` and `web_fetch` calls for the
current session, including DuckDuckGo result lists, fetch backend and timing metadata, and returned
Markdown. `GET /api/sessions/{session_id}/web-traces` exposes the same in-memory trace data for
development and evaluation. Direct fetch rejects private and local targets; JavaScript-rendered
pages require a separately deployed capability plugin or external service.

### Retrieval modes and external Python sandbox

The Retrieval Mode panel controls the current session's `search_mode`:

- `native` uses the active model to execute the Provider's native web retrieval capability.
- `subagent` starts an isolated child AgentCore using the fixed `WEB_RESEARCH_SUBAGENT_MODEL`.
  The child has an ephemeral Session and exactly one tool, `web_search`; it cannot access Python,
  files, browser automation, MCP, Buddy, or the parent Agent's other tools.
- `diy` uses the Node Host's DuckDuckGo search and page-fetch tools.

The mode is persisted in the session database. Existing v2 databases are migrated at startup when
they are missing the `agent_sessions.search_mode` column; a Node.js version change is not required
for this migration.

`sandbox_python_run` is an external capability. The Node Host sends code to FruitSpy over the
configured HTTP API and never starts a Python process or installs Python in the AnomaloHaris
container. FruitSpy must be reachable from the container, and its Bearer token should be kept in
the private `.env`. Requested artifacts are cached under `ANOMALO_DATA_DIR/artifacts/python/` and
served through signed, session-bound artifact URLs; raster images remain inline while other files
download as inert attachments. Set `ANOMALO_ARTIFACT_SECRET` to keep URLs valid across restarts
(the admin token is used as a fallback). See
[`runtime-bundle/docs/fruitspy-python-sandbox-api-requirements.md`](runtime-bundle/docs/fruitspy-python-sandbox-api-requirements.md)
for the endpoint contract.

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
`response_format` field. The tool-calling loop remains streamed internally; AnomaloHaris runs a
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
`GET /api/preset-models` is the public published-model listing used by the
control panel. Draft/retired definitions and all mutations use
`GET/POST /api/manage/preset-models` plus the versioned `validate`, `publish`,
and `retire` routes and require `ANOMALO_ADMIN_TOKEN`.

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
The old `/api/agents` aliases were removed after the Preset Model migration. Use an explicit
versioned Preset Model reference or the default `/api/chat` convenience route. Put an authenticated
reverse proxy in front of any non-local deployment.

To replace records from the retired Preset Agent database, run a dry run first and then repeat with
`--apply`:

```bash
npm --workspace @anomalo/node-host run migrate:preset-models -- --source data/preset-agents.sqlite3
npm --workspace @anomalo/node-host run migrate:preset-models -- --source data/preset-agents.sqlite3 --apply
```

### Prompt profiles and memory

Edit `runtime-bundle/config/prompts.yaml` to add or update system prompt profiles. The file is read for each run, so prompt changes do not require a server restart.

The development UI can upload an `AGENTS.md` file as local agent memory. It is stored at `runtime-bundle/config/AGENTS.md`, which is intentionally ignored by Git because it may contain personal information.

### Skills

Node Host skills live under `runtime-bundle/skills/`. Each skill contains a `SKILL.md` file with
YAML frontmatter and instructions. `runtime-bundle/skills/buddy` documents the
`buddy-bridge` tools; the executable hardware integration remains in the independent Buddy
service and is never imported by the Node runtime.

```text
runtime-bundle/skills/calculator/
└── SKILL.md
```

Skills are activated per session and included in the run context snapshot.

### MCP catalog

Node Host reads `runtime-bundle/config/mcp_servers.yaml` and the corresponding markdown
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

The former Python Agent Host, audio, vision, and direct Node-owned Codex hook runtime have been
removed. Python execution is available only through the explicitly configured external FruitSpy
service described above. The active Buddy service is Node-only under `apps/buddy-service/`; the root
`buddy-backend/` directory is retained only for firmware/protocol notes. Neither is imported by
the Node Host or copied into the Node production image. The optional Node bridge is allowlisted
separately and fails open when the Buddy service is absent.

## Apple Container deployment

The production image builds the Vue frontend and serves it from the Node Host. It contains Node
artifacts plus trusted prompt, skill, and MCP resource files; it does not install Python or expose
the legacy Buddy port. Build an OCI archive with Apple Container:

```bash
runtime-bundle/scripts/build_apple_container_image.sh
```

The script writes the archive and metadata under the ignored `runtime-bundle/artifacts/container-images/` directory. Deploy with a private environment file:

```bash
cp runtime-bundle/deploy/anomaloharis.container.env.example \
  runtime-bundle/deploy/anomaloharis.container.env

REMOTE=user@your-host.example \
ENV_FILE=runtime-bundle/deploy/anomaloharis.container.env \
  runtime-bundle/scripts/deploy_apple_container.sh \
  runtime-bundle/artifacts/container-images/anomaloharis-<tag>-linux-arm64.env
```

The private deployment environment file is ignored by Git. Review both scripts and adapt the network, storage, SSH, and host-loopback settings to your machine before running them.
Before deployment, set `ANOMALO_SERVICE_TOKEN` and the separate `ANOMALO_ADMIN_TOKEN` to different long random secrets. The production image listens on `0.0.0.0` only with explicit acknowledgement and refuses to start without both tokens; compute callers send the service token as a Bearer token, while the dashboard sends the admin token only to management routes.

The deployment script mounts `REMOTE_DATA_DIR` from the deployment host to `/data` in the container. Session history and Stop/Resume checkpoints are stored in `/data/sessions.sqlite3`; Preset Models are stored in `/data/preset-models.sqlite3`; usage, idempotency reservations, and Native Run events are stored in `/data/compute.sqlite3`. Keep this directory on persistent host storage and do not delete it when replacing the container. By default it reuses an existing `.anomalo/anomalo-data` directory, otherwise it creates `.anomaloharis/anomaloharis-data`; set `REMOTE_STORAGE_ROOT` or `REMOTE_DATA_DIR` to an explicit host path when needed.

## Tests and linting

Run the Node workspace checks:

```bash
npm install
npm run build --workspaces
npm --prefix apps/node-host test
npm --prefix frontend test
```

The Node tests cover the agent lifecycle, API routes, provider tool serialization, Preset Models,
plugin loading, browser bridge, resources, frontend projections, and the Buddy service/relay. The
legacy Python and hardware files are historical reference material and are not required to start
the Node production image.

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

AnomaloHaris is developed as a personal system and may change without backward-compatibility guarantees. Issues and pull requests are welcome after the repository is published, but expect hardware- and environment-specific setup for the optional integrations.

## License

This repository currently does not include an open-source license. Until a license is added, the source is publicly visible but remains under the copyright holder's default rights. Choose and add a license before inviting reuse or contributions.
