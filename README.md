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
- Vue + Vite development frontend panel that shows the JSON payload prepared for the LLM request.
- Skill and MCP management APIs.
- FastAPI serves the built Vue frontend at `/`.
- Local STT/TTS voice module plus buddy audio chat at `/api/audio/*`.

## Repository Layout

- `frontend/` — Vue + Vite frontend, including its own `package.json` and `.gitignore`.
- `agent-backend/` — main FastAPI agent backend, config, agent skills, tests, Docker files, and deployment scripts.
- `buddy-backend/` — Buddy gateway package, Buddy skills, Copilot hook bridge, protocol docs, and client alignment notes.
- `stock-backend/` — integrated KabuLens market-analysis engine, configuration, reports, and tests.

## Run Backend

```bash
cd /Users/waynewong/code/Anomalo
uv venv --python 3.12 --seed .venv
source .venv/bin/activate
pip install -e ".[audio,buddy,vision,stocks,dev]"
PYTHONPATH=agent-backend:buddy-backend:stock-backend .venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Runtime configuration is centralized in the root `.env`. The split backend folders do not use
separate `.env` files.

Open http://127.0.0.1:8000.

The Stock Analysis page runs KabuLens directly through `POST /api/stocks/scan`; no separate
KabuLens process or publish step is required. The default target is OpenD at `127.0.0.1:11111`.
For an offline deterministic report, set `ANOMALO_STOCK_DATA_MODE=mock` in the root `.env`.
Production deployments automatically run one scan every day at 22:00 in `Asia/Tokyo`; the
Stock Analysis page's **Run Scan** button remains available for manual runs. Override the schedule
with `ANOMALO_STOCK_SCHEDULE_TIMEZONE`, `ANOMALO_STOCK_SCHEDULE_HOUR`, and
`ANOMALO_STOCK_SCHEDULE_MINUTE`, or disable it with `ANOMALO_STOCK_SCHEDULE_ENABLED=false`.
Remote manual scans require `ANOMALO_ADMIN_TOKEN`; save it through **Dashboard > Admin Access**.
For container access to a host-loopback OpenD, set
`ANOMALO_STOCK_OPEND_HOST=host.container.internal` and configure Apple Container once on the host:

```bash
sudo container system dns create host.container.internal --localhost 203.0.113.113
```

Apple Container may remove the associated packet-filter rule after a host restart, in which case
rerun this command before the next scan.

For frontend development, run the FastAPI server above and start Vite in another shell:

```bash
npm --prefix frontend install
npm --prefix frontend run dev
```

Open http://127.0.0.1:5173. Vite proxies `/api`, `/ws`, `/static`, and `/health` to the FastAPI
server on port `8000`.

To update the frontend served by FastAPI:

```bash
npm --prefix frontend run build
```

## Apple container deployment

The production container builds the Vue frontend once and lets FastAPI serve the generated
`agent-backend/app/frontend` files. This avoids running Vite or a separate static-file server in deployment.

Build and save an OCI archive with Apple `container`:

```bash
agent-backend/scripts/build_apple_container_image.sh
```

Production image builds install the Buddy control backend and stock/OpenD dependencies by default,
without STT/TTS model dependencies. If Buddy voice AI is re-enabled later, build with
`INSTALL_EXTRAS=audio,buddy,stocks`.

The script writes a `.tar` image archive and a sibling `.env` metadata file under
`agent-backend/artifacts/container-images/`. Deploy that archive to a remote Mac over SSH:

```bash
REMOTE=user@mac-mini.local \
ENV_FILE=agent-backend/deploy/anomalo.container.env.example \
agent-backend/scripts/deploy_apple_container.sh agent-backend/artifacts/container-images/anomalo-<tag>-linux-arm64.env
```

When the remote Apple Container runtime uses an external disk, place the deployment archive and
persistent artifacts there too. `REMOTE_STORAGE_ROOT` derives both remote directories while
allowing `REMOTE_DIR` and `REMOTE_DATA_DIR` to override either path independently:

```bash
REMOTE=macmini \
REMOTE_CONTAINER_CLI=/opt/homebrew/bin/container \
REMOTE_STORAGE_ROOT=/Volumes/DOCK/container-data/anomalo \
ENV_FILE=agent-backend/deploy/anomalo.container.env \
agent-backend/scripts/deploy_apple_container.sh agent-backend/artifacts/container-images/anomalo-<tag>-linux-arm64.env
```

Use a private env file for real secrets. The container example env uses TCP Buddy transport because
serial passthrough needs host-specific container device configuration.

Remote deployments create and use the dedicated `anomalo-external` network by default so outbound
OpenRouter requests do not depend on the Apple Container runtime's shared default network. Override
the name with `CONTAINER_NETWORK`, or set it to an empty string to use the runtime default.

Deployment images default to `ANOMALO_ENV=production` and
`ANOMALO_BUDDY_AUDIO_DEBUG_STORAGE=off`, so Buddy microphone test captures are not written to disk.
For local diagnosis, use `ANOMALO_ENV=development` with the default
`ANOMALO_BUDDY_AUDIO_DEBUG_STORAGE=auto`, or force the behavior with `on` / `off`.

Without `OPENROUTER_API_KEY`, the app runs in local dev mode and returns a mock assistant response. Set the key in root `.env` to use OpenRouter.

## Local fonts

The frontend can use local, untracked font files for personal deployments. Put licensed font files
outside Git, then point Anomalo at that directory in `.env`:

```bash
ANOMALO_LOCAL_FONT_DIR=/absolute/path/to/anomalo-fonts
```

Expected optional filenames:

- `BradfordLLWeb-Regular.woff2`
- `BradfordLLWeb-Italic.woff2`
- `BradfordLLWeb-Bold.woff2`
- `BradfordLLWeb-BoldItalic.woff2`
- `RedHatMono-Regular.woff2`
- `RedHatMono-Medium.woff2`

These files are served locally from `/fonts/local/*` only when `ANOMALO_LOCAL_FONT_DIR` is set.
Do not commit the font files if you publish this repository.

## Audio for Buddy

Anomalo can now run the full local buddy turn in-process:

`buddy audio -> STT -> AgentRuntime/LLM -> TTS -> buddy audio`

The default implementation is:

- **STT**: `faster-whisper`. `tiny` works for MVP, but Buddy voice in English + Chinese is more
  reliable with `ANOMALO_AUDIO_STT_MODEL=base` or above.
- **TTS**: `kokoro`, `piper-plus`, `cosyvoice` (single-speaker SFT models), or macOS `say`.

For a low-compute Kokoro setup, use a Python 3.12 environment and configure:

```bash
ANOMALO_AUDIO_TTS_PROVIDER=kokoro
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_EN=af_heart
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH=zf_xiaoxiao
ANOMALO_AUDIO_TTS_KOKORO_SPEED=1.0
```

Kokoro currently requires Python 3.12 or lower in this project. It downloads the model from Hugging
Face on first use. Mandarin Chinese voices use `misaki[zh]`;
for fixed Chinese output, `zf_xiaoxiao`, `zf_xiaoyi`, `zm_yunxi`, and `zm_yunyang` are easy starting
points.

If you want the simplest working setup on the current Mac Mini runtime instead, use:

```bash
ANOMALO_AUDIO_TTS_PROVIDER=say
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_EN=Samantha
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH=Tingting
```

If you want to keep using `piper-plus`, configure at least one compatible voice/model:

```bash
ANOMALO_AUDIO_TTS_PROVIDER=piper_plus
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_EN=/absolute/path/to/model.onnx
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH=/absolute/path/to/model.onnx
```

Named Piper models are downloaded on first use into `artifacts/audio-models`. If you use a local
`.onnx` model, Anomalo now accepts either `model.onnx.json` or a sibling `config.json`.

For a low-compute fixed voice with CosyVoice, point Anomalo at a local `CosyVoice-300M-SFT` model
directory and configure a speaker name:

```bash
ANOMALO_AUDIO_TTS_PROVIDER=cosyvoice
ANOMALO_AUDIO_TTS_COSYVOICE_REPO_DIR=/absolute/path/to/CosyVoice
ANOMALO_AUDIO_TTS_COSYVOICE_MODEL_DIR=/absolute/path/to/CosyVoice-300M-SFT
ANOMALO_AUDIO_TTS_DEFAULT_VOICE_ZH=中文女
```

Anomalo sanitizes markdown, URLs, code spans, and emoji before synthesis so reply audio does not
read them literally.

For buddy turns, Anomalo prefers an explicit `output_language`, then infers English vs Chinese from
the final assistant text, then falls back to the transcript language.

Endpoints:

- `POST /api/audio/stt` — multipart audio upload, returns transcript text.
- `POST /api/audio/tts` — JSON text input, returns base64 audio with provider-specific format metadata.
- `POST /api/audio/chat` — multipart audio upload, runs STT -> chat -> TTS, returns transcript,
  final text, and reply audio.
- `POST /api/audio/chat` with `sync_buddy=true` — additionally drives Buddy through
  `CB think` / `CB speak` / `CB idle` if the Call Buddy gateway is connected.

## Buddy Bridge

Anomalo now includes a Call Buddy host adapter for the StackChan/CoreS3 firmware in `buddy-backend/`.
See `buddy-backend/BUDDY_BACKEND.md` for the Buddy backend structure and client alignment contract.

When `ANOMALO_BUDDY_TRANSPORT=tcp`, app startup auto-starts the Buddy TCP listener. The Buddy
voice AI bridge is disabled by default; set `ANOMALO_BUDDY_AUDIO_AI_ENABLED=true` only when you
want microphone turns to run through STT -> AgentRuntime/LLM -> TTS.

Configure the USB serial port if auto-detection is not enough:

```bash
ANOMALO_BUDDY_TRANSPORT=serial
ANOMALO_BUDDY_SERIAL_PORT=/dev/tty.usbmodem2101
ANOMALO_BUDDY_BAUD_RATE=115200
```

For Wi-Fi/TCP mode, Buddy is the **client** and Anomalo is the **server**. The Buddy device IP is
only useful as an optional allow-list; the important part is the Anomalo host IP/port that Buddy
connects to:

```bash
ANOMALO_BUDDY_TRANSPORT=tcp
ANOMALO_BUDDY_TCP_HOST=0.0.0.0
ANOMALO_BUDDY_TCP_PORT=8787
ANOMALO_BUDDY_TCP_CLIENT_IP=192.168.31.78
ANOMALO_BUDDY_AUDIO_AI_ENABLED=false
```

Management endpoints:

- `GET /api/buddy/status` — current connection status and detected serial ports.
- `POST /api/buddy/connect` — open the Call Buddy serial connection or start the TCP listener.
- `POST /api/buddy/disconnect` — close the gateway.
- `GET /api/buddy/events` — poll recent JSON Lines events such as `touch.click`,
  `touch.listen_cancel`, `approval.response`, and `device.heartbeat`.
- `POST /api/buddy/state` — send Buddy state transitions like `idle`, `thinking`, or `speaking`.
- `POST /api/buddy/approval` — show a `CODEX APPROVAL` prompt and wait for the device response.
- `POST /api/buddy/vision/detect` — multipart image upload, lazily loads BlazeFace and returns
  face boxes without controlling Buddy unless `apply_buddy_action=true`.
- `POST /api/buddy/vision/frame` — Buddy-oriented multipart frame upload; detects faces and, when
  vision actions are enabled, pauses roaming on detection.
- `GET /api/buddy/vision/status` — current lazy detector state and latest face detection result.
- `POST /api/copilot/hooks/{event}` — bridge Copilot CLI hooks into Buddy states and optional approvals.

Agent tools now include Buddy control primitives such as `buddy_set_state`,
`buddy_request_approval`, `buddy_look`, and `buddy_set_led`.

Copilot CLI hook support is wired in via `.github/hooks/buddy-status.json`. The repository hook
commands call `buddy-backend/scripts/copilot_buddy_hook.py`, which forwards `userPromptSubmitted`,
`preToolUse`, `notification`, `permissionRequest`, `agentStop`, `sessionEnd`, and
`errorOccurred` payloads to the local Anomalo API.

The default state-machine path is now:

- `userPromptSubmitted` -> Buddy enters coding state.
- `notification` with `permission_prompt` -> Buddy enters approval state.
- `preToolUse` -> Buddy returns to coding once the approved tool actually starts.

`permissionRequest` no longer routes approval decisions through Buddy unless you explicitly enable
`ANOMALO_COPILOT_BUDDY_PERMISSION_BRIDGE_ENABLED=true`. That opt-in mode preserves the earlier
Buddy tap/swipe approval bridge, but the default behavior keeps the visual approval state aligned
with the real Copilot permission prompt instead of every permission-service check.

Remote LLMs can also activate the built-in Buddy skills:

- `buddy_presence` — high-level Buddy state, text, LED, and head movement
- `buddy_approval` — human approval through Buddy tap/swipe
- `buddy_events` — recent Buddy events and connection status

## Buddy Low-Power Face Detection

Buddy vision is server-side and lazy-loaded. The FastAPI process does not import or initialize
OpenCV at startup; the face detector is loaded only when `/api/buddy/vision/detect` or
`/api/buddy/vision/frame` receives an image.

Install the optional runtime dependencies when this feature is enabled in a compatible Python
environment:

```bash
pip install -e ".[audio,buddy,vision]"
```

The default provider is OpenCV Haar (`ANOMALO_BUDDY_VISION_PROVIDER=opencv_haar`). It is a
small, CPU-only detector that is good enough for low-frequency "face-like region" checks and
works in the Apple `linux/arm64` container. MediaPipe BlazeFace remains available as
`ANOMALO_BUDDY_VISION_PROVIDER=mediapipe_blazeface` if a compatible MediaPipe build is
installed manually, but current MediaPipe releases no longer expose the legacy API used by this
provider and some macOS runs may fail during OpenGL initialization.

Recommended low-power settings:

```bash
ANOMALO_BUDDY_VISION_ENABLED=true
ANOMALO_BUDDY_VISION_PROVIDER=opencv_haar
ANOMALO_BUDDY_VISION_FRAME_TOKEN=<random-device-token>
ANOMALO_BUDDY_VISION_SCORE_THRESHOLD=0.45
ANOMALO_BUDDY_VISION_PAUSE_MS=300000
ANOMALO_BUDDY_VISION_LOOK_ENABLED=true
ANOMALO_BUDDY_VISION_LOOK_MAX_YAW_DEGREES=25
ANOMALO_BUDDY_VISION_LOOK_MAX_PITCH_DEGREES=12
ANOMALO_BUDDY_VISION_LOOK_CENTER_YAW=0
ANOMALO_BUDDY_VISION_LOOK_CENTER_PITCH=260
ANOMALO_BUDDY_VISION_LOOK_SPEED=40
ANOMALO_BUDDY_VISION_LOOK_DEADBAND=0.12
```

For non-realtime checks, have Buddy upload a low-resolution frame every few minutes to
`/api/buddy/vision/frame` with `X-Anomalo-Buddy-Vision-Token` or configure
`ANOMALO_BUDDY_VISION_FRAME_CLIENT_IP` / `ANOMALO_BUDDY_TCP_CLIENT_IP` for the Buddy device IP.
If a face-like region is detected, Anomalo sends:

```text
ROAM PAUSE <pause_ms>
LOOK <yaw> <pitch> <speed>
CB idle person nearby
```

`LOOK` uses absolute servo targets. The default center is `yaw=0`, `pitch=260`;
the detected face offset is added to that center before the command is sent.

The `LOOK` target is computed from the largest detected face's center. If the face is already near
the image center, Anomalo skips `LOOK` and only pauses roaming. The firmware still needs to support
`ROAM PAUSE` for this to fully stop idle wandering; until then the host can only send the command
and rely on firmware behavior.

## Buddy Audio Transport

The updated Buddy firmware can now stream half-duplex audio over the same TCP connection:

- Buddy microphone uplink: `audio.input` binary frames, PCM16, `16 kHz` mono, `640` bytes/frame.
- Buddy speaker downlink: `audio.output` binary frames, PCM16, default `24 kHz` mono,
  `960` bytes/frame.
- Control still uses JSON Lines events and line commands such as `AUDIO STATUS`,
  `AUDIO IN START/STOP`, and `AUDIO OUT START/STOP`.

Anomalo now:

- parses Buddy `audio.input` binary frames in the TCP gateway,
- queues completed microphone turns when Buddy stops listening,
- runs those turns through STT -> AgentRuntime/LLM -> TTS only when
  `ANOMALO_BUDDY_AUDIO_AI_ENABLED=true`,
- converts reply audio for Buddy speaker playback, and
- streams `audio.output` frames back to the device.

Practical voice-AI test flow:

1. Start Anomalo on the Mac mini.
2. Set `ANOMALO_BUDDY_AUDIO_AI_ENABLED=true`.
3. Confirm `/api/buddy/status` shows `listening:true` and then `connected:true`.
4. Tap Buddy to enter listening mode.
5. Speak a short English or Chinese utterance.
6. Wait for Buddy to switch from `listening` -> `thinking` -> `speaking` -> `idle`.

When Buddy audio turns are active, the server now logs key milestones at `INFO`, including:

- Buddy TCP listener/client connection
- microphone turn start/finish with frame and byte counts
- transcript text
- final reply text
- output audio send size
- recoverable no-speech cases such as empty transcripts

In development and test environments, Buddy input audio is also saved under
`agent-backend/artifacts/buddy-audio/` for diagnosis. Production deployment disables those files by default.

## Prompts

System-level prompts live in `agent-backend/config/prompts.yaml`. The runtime reads the configured profile on
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

Set `ANOMALO_AGENT_PROMPT_PROFILE` in `.env` to switch the web Agent profile. The development
frontend shows that configured Agent profile on load, then replaces it with the exact JSON request
payload prepared for the LLM whenever a chat run reaches the model call.

Set `ANOMALO_BUDDY_PROMPT_PROFILE` separately for Buddy voice turns. The recommended Buddy profile
is `buddy_voice`; it keeps replies short, conversational, and speech-friendly. Skills and MCP
activation remain session-scoped and reusable, but Agent and Buddy identity/personality prompts are
separate.

## Agent Memory

Upload `AGENTS.md` from the development frontend to save simple personal-agent memory at
`agent-backend/config/AGENTS.md`. The runtime reads this file on every run and inserts it as a system message
between the YAML prompt profile and session history. The Context Assembly panel shows the
`AGENTS.md memory` segment when it is present.

## Python Sandbox

The Python sandbox tool delegates execution to FruitSpy on the same Mac. FruitSpy starts a short-lived
Apple container sandbox and returns stdout/stderr plus optional artifacts. Anomalo immediately caches
returned files under `artifacts/python`, exposes them through a restricted artifact route, and renders
image artifacts in the chat. Anomalo keeps the same `sandbox_python_run` tool name, but it no longer
runs Docker locally.

Configure the shared token in a private env file:

```bash
PYTHON_SANDBOX_ENABLED=true
FRUITSPY_PYTHON_TOOL_BASE_URL=http://127.0.0.1:8848
FRUITSPY_PYTHON_TOOL_TOKEN=<shared-token>
```

If Anomalo runs inside an Apple container, make sure the configured FruitSpy URL is reachable from
that container and allowed by FruitSpy's Python Tool loopback/source policy.

## Skill Layout

Agent skills live under `agent-backend/skills/{skill_name}`. Buddy skills live under
`buddy-backend/skills/{skill_name}` and are loaded into the same runtime catalog.

```text
agent-backend/skills/
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

MCP servers are configured in `agent-backend/config/mcp_servers.yaml`. The management API can add or toggle server configs. Install MCP support with `pip install -e ".[mcp]"`. If the optional `mcp` package is installed, configured servers can expose tools through the registry.

MCP loading is session-scoped and on demand. By default the model only sees the MCP catalog plus `mcp_activate` and `mcp_deactivate`. A server's actual tool schemas are only loaded after that server is activated for the current session, either from the frontend session picker or by calling `mcp_activate`. This keeps large MCP tool packs out of the prompt until they are needed.


## Management APIs

Skill and MCP management endpoints are localhost-only by default. If you need to manage them remotely, set `ANOMALO_ADMIN_TOKEN` and send it as `X-Anomalo-Admin-Token` or `Authorization: Bearer <token>`. Keep MCP commands restricted to trusted local use; MCP server configs can start local processes.

MCP stdio operations use `MCP_TIMEOUT_SECONDS` to avoid hanging `/api/tools` or chat runs when a server does not answer.
