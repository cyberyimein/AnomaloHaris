# Anomalo

Anomalo is a personal AI engineering project built to explore how a modern agent can reason, use tools, control a physical StackChan robot, and eventually assist with personal stock analysis. It is implemented as an event-driven FastAPI agent host with a Vue control panel.

> [!IMPORTANT]
> Anomalo is an experimental personal project, not a hardened multi-user service. Keep it on a trusted network unless you add authentication and deployment controls appropriate for your environment.

## Why this project exists

Anomalo has three primary goals:

1. **Learn and track modern agent-harness techniques.** The project is a hands-on laboratory for streaming agent runtimes, tool calling, context assembly, prompt profiles, memory, skills, MCP, sandboxed execution, and human approval flows. Its purpose is to turn new agent patterns into working code that can be inspected and understood.
2. **Provide a control panel for a StackChan robot.** Anomalo acts as the robot's host-side control plane. The web dashboard and Buddy bridge manage serial or TCP connections, state changes, touch events, approvals, voice turns, low-frequency vision, and movement-related commands.
3. **Grow into an AI-assisted personal stock-analysis tool.** The repository already contains a deterministic market-analysis engine, live or mock market-data adapters, structured evidence, reports, and a stock dashboard. The longer-term goal is to connect these capabilities to the agent so AI can help explain market context, investigate setups, and support a personal research workflow without presenting itself as an autonomous trading system.

These goals share one runtime: agent-harness experiments can be tested through the browser, embodied through StackChan, and applied to a concrete research domain instead of remaining isolated demos.

## What is implemented today

- Streams agent lifecycle, message, and tool events over WebSocket or REST.
- Uses an OpenAI SDK-compatible client with OpenRouter defaults and a local mock mode.
- Loads prompt profiles, `AGENTS.md` memory, Python skills, and MCP servers at runtime.
- Provides a Vue dashboard for chat, context inspection, Buddy control, and stock analysis.
- Supports STT and TTS providers for local voice conversations.
- Connects to a Buddy/StackChan-style device over serial or TCP.
- Offers low-frequency face detection and Buddy look/roam commands.
- Runs deterministic stock analysis with mock data or live data from Futu OpenD.
- Delegates optional Python execution to a separate FruitSpy sandbox service.
- Includes Apple Container build and remote deployment scripts.

## Repository layout

```text
.
├── agent-backend/   FastAPI app, agent runtime, tools, prompts, audio, and deployment files
├── buddy-backend/   Buddy gateway, device APIs, Copilot hooks, skills, and protocol docs
├── frontend/        Vue 3 and Vite source
├── stock-backend/   Market-data clients, analysis engine, reports, configuration, and tests
├── .env.example     Shared runtime configuration template
├── pyproject.toml   Python package metadata and dependency groups
└── uv.lock          Reproducible Python dependency lockfile
```

The production frontend build is committed under `agent-backend/app/frontend/` so FastAPI can serve the application without a separate Node.js process.

## Requirements

- Python 3.12
- [`uv`](https://docs.astral.sh/uv/)
- Node.js and npm when developing or rebuilding the frontend
- Optional services or hardware for OpenRouter, Futu OpenD, FruitSpy, or Buddy features

## Quick start

Clone the repository and create your local configuration:

```bash
git clone <your-fork-or-repository-url>
cd Anomalo
cp .env.example .env
```

Install the core application plus the common development integrations:

```bash
uv sync --extra buddy --extra stocks --extra dev
```

Start FastAPI from the repository root:

```bash
PYTHONPATH=agent-backend:buddy-backend:stock-backend \
  uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>.

Without `OPENROUTER_API_KEY`, Anomalo uses a deterministic mock response. Add an OpenRouter key to the untracked `.env` file to enable model calls:

```dotenv
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=openai/gpt-4o-mini
```

Never commit `.env` or another file containing real credentials.

## Frontend development

Start the FastAPI server first, then run Vite in another terminal:

```bash
npm --prefix frontend install
npm --prefix frontend run dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/api`, `/ws`, `/health`, `/fonts`, and `/static` to the backend on port `8000` by default. Set `ANOMALO_BACKEND_URL` when the backend uses a different origin.

To refresh the frontend committed for FastAPI:

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
| `ANOMALO_ADMIN_TOKEN` | Authorizes remote management requests | unset |
| `ANOMALO_AGENT_PROMPT_PROFILE` | Browser-agent prompt profile | `agent` |
| `ANOMALO_BUDDY_PROMPT_PROFILE` | Buddy voice prompt profile | `buddy_voice` |
| `ANOMALO_STOCK_DATA_MODE` | Stock data source: `opend` or `mock` | `opend` |
| `ANOMALO_BUDDY_TRANSPORT` | Buddy transport: `serial` or `tcp` | `serial` |
| `ANOMALO_BUDDY_AUDIO_AI_ENABLED` | Enables Buddy STT/LLM/TTS turns | `false` |
| `ANOMALO_BUDDY_VISION_ENABLED` | Enables Buddy vision actions | `false` |
| `PYTHON_SANDBOX_ENABLED` | Publishes the FruitSpy-backed Python tool when ready | `true` |

See [`.env.example`](.env.example) for the complete template. Empty optional values are intentionally safe to commit.

## Agent runtime

Anomalo assembles each model request from:

1. A prompt profile from `agent-backend/config/prompts.yaml`.
2. Optional personal memory from `agent-backend/config/AGENTS.md`.
3. Activated skills and MCP server instructions.
4. Session history and available tool schemas.

The runtime emits typed events for run start and finish, LLM requests, streamed message deltas, tool calls, tool results, and errors. The browser UI exposes this context for debugging.

### Chat endpoints

- `WS /ws/chat/{session_id}` — bidirectional event streaming.
- `POST /api/chat` — collected JSON response.
- `POST /api/chat/stream` — newline-delimited streaming JSON.

### Prompt profiles and memory

Edit `agent-backend/config/prompts.yaml` to add or update system prompt profiles. The file is read for each run, so prompt changes do not require a server restart.

The development UI can upload an `AGENTS.md` file as local agent memory. It is stored at `agent-backend/config/AGENTS.md`, which is intentionally ignored by Git because it may contain personal information.

### Skills

Skills live under `agent-backend/skills/` and `buddy-backend/skills/`. Each skill contains a `SKILL.md` file with YAML frontmatter; an optional `tools.py` can expose public Python functions as agent tools.

```text
agent-backend/skills/calculator/
├── SKILL.md
└── tools.py
```

Skills are activated per session. Treat skill code as trusted code because it runs in the Anomalo process.

### MCP servers

MCP servers are configured in `agent-backend/config/mcp_servers.yaml` and activated per session. Install MCP support when needed:

```bash
uv sync --extra mcp
```

MCP configurations can start local processes and pass environment variables. Only add servers you trust, and never commit secrets inside the YAML file.

## Python sandbox integration

The `sandbox_python_run` tool delegates execution to a separately deployed FruitSpy service. FruitSpy is not included in this repository. Anomalo only exposes the tool when the service is ready and a shared token is configured.

```dotenv
PYTHON_SANDBOX_ENABLED=true
FRUITSPY_PYTHON_TOOL_BASE_URL=http://127.0.0.1:8848
FRUITSPY_PYTHON_TOOL_TOKEN=replace-with-a-shared-token
```

Returned artifacts are copied into the ignored `agent-backend/artifacts/python/` directory and served through a restricted artifact route.

## Audio

Install the optional audio dependencies:

```bash
uv sync --extra audio
```

Audio support provides:

- `POST /api/audio/stt` for speech-to-text.
- `POST /api/audio/tts` for text-to-speech.
- `POST /api/audio/chat` for an STT → agent → TTS turn.

Supported providers include `faster-whisper` for STT and Kokoro, Piper, CosyVoice, or macOS `say` for TTS. Some providers download models on first use. Model files and generated audio belong in ignored artifact directories, not in Git.

Python 3.12 is required by the current audio dependency set. Start with the macOS system voice for a lightweight local setup:

```dotenv
ANOMALO_AUDIO_TTS_PROVIDER=say
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_EN=Samantha
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH=Tingting
```

## Buddy device bridge

The Buddy package connects a compatible device over USB serial or TCP. It handles state commands, JSON Lines events, approvals, binary audio frames, and optional low-frequency vision frames.

For serial mode:

```dotenv
ANOMALO_BUDDY_TRANSPORT=serial
ANOMALO_BUDDY_SERIAL_PORT=/dev/tty.usbmodemXXXX
ANOMALO_BUDDY_BAUD_RATE=115200
```

For TCP mode, Buddy is the client and Anomalo is the server:

```dotenv
ANOMALO_BUDDY_TRANSPORT=tcp
ANOMALO_BUDDY_TCP_HOST=0.0.0.0
ANOMALO_BUDDY_TCP_PORT=8787
ANOMALO_BUDDY_TCP_CLIENT_IP=
```

Use `ANOMALO_BUDDY_TCP_CLIENT_IP` as an optional allow-list. Set `ANOMALO_BUDDY_AUDIO_AI_ENABLED=true` only after the audio dependencies and models are ready.

See [`buddy-backend/BUDDY_BACKEND.md`](buddy-backend/BUDDY_BACKEND.md) and [`buddy-backend/docs/call-buddy-protocol.md`](buddy-backend/docs/call-buddy-protocol.md) for the host/device contract.

## Stock analysis

The integrated stock engine reads `stock-backend/config/settings.yaml` and `stock-backend/config/watchlists.yaml`, calculates market context and technical evidence, and writes ignored report artifacts under `stock-backend/outputs/`.

The current calculation and ranking pipeline is intentionally deterministic and testable. AI-assisted interpretation is the project direction: the agent should consume structured evidence, explain why a setup received attention, answer follow-up questions, and help organize personal research while keeping the underlying measurements auditable.

Run an offline deterministic scan without Futu OpenD:

```dotenv
ANOMALO_STOCK_DATA_MODE=mock
```

For live data, install the `stocks` extra, run Futu OpenD, and configure its host and port:

```dotenv
ANOMALO_STOCK_DATA_MODE=opend
ANOMALO_STOCK_OPEND_HOST=127.0.0.1
ANOMALO_STOCK_OPEND_PORT=11111
```

When `ANOMALO_ENV=production`, the in-process scheduler runs at 22:00 in `Asia/Tokyo` by default. The schedule can be changed or disabled with the `ANOMALO_STOCK_SCHEDULE_*` variables.

The tracked watchlist is an example and can reveal your market interests if you customize it. Review it before publishing a fork.

> [!WARNING]
> Stock reports are analytical software output, not investment advice. Validate the data and methodology before relying on any result.

See [`stock-backend/README.md`](stock-backend/README.md) and the documents in `stock-backend/docs/` for details.

## Apple Container deployment

The production image builds the Vue frontend and serves it from FastAPI. Build an OCI archive with Apple Container:

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

## Tests and linting

Install development dependencies, then run:

```bash
uv sync --extra dev --extra buddy --extra stocks
uv run pytest
uv run ruff check .
```

The test suite covers the agent lifecycle, API routes, Python sandbox adapter, audio service, Buddy gateway and skills, vision, stock analysis, and prompt behavior.

## Security notes

- Keep all credentials in the ignored root `.env` or a secret manager.
- Set a strong `ANOMALO_ADMIN_TOKEN` before allowing non-loopback management requests.
- The current application does not provide complete user authentication for chat, audio, memory, session, prompt, or credits endpoints. Put an authenticated reverse proxy or equivalent access control in front of any non-local deployment.
- Loopback checks can be affected by reverse proxies. Do not assume they provide end-user authentication.
- Skills run trusted Python in the main process, and MCP configurations may launch local commands.
- Keep FruitSpy isolated and require its shared token; Anomalo is an adapter, not the sandbox boundary.
- Buddy TCP, serial, audio, vision, and approval bridges should only be enabled on trusted networks and devices.
- Generated reports, audio captures, uploaded memory, artifacts, local fonts, and model files are ignored and should remain outside Git.
- If a secret has ever been committed, removing it from the latest commit is not enough: rotate it and clean the Git history before publishing.

## Project status

Anomalo is developed as a personal system and may change without backward-compatibility guarantees. Issues and pull requests are welcome after the repository is published, but expect hardware- and environment-specific setup for the optional integrations.

## License

This repository currently does not include an open-source license. Until a license is added, the source is publicly visible but remains under the copyright holder's default rights. Choose and add a license before inviting reuse or contributions.
