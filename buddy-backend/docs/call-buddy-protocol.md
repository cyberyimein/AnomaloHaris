# Call Buddy Firmware Protocol

This document is the low-level Call Buddy firmware protocol reference for the
MyStackChan CoreS3. It is intentionally device-oriented: the firmware owns
display state, touch input, LEDs, servo posture, and simple command/event
transport. Anomalo's Node Host does not own this transport, STT/TTS, audio,
vision, or Codex hooks. A future Buddy plugin may consume this protocol after a
separate capability decision.

> Audio and camera sections below describe historical firmware capabilities only.
> They are not active Anomalo Host APIs or a promise that the optional plugin
> will restore those features.

## Current Firmware

- Device: M5Stack CoreS3 with StackChan BSP library.
- Sketch: `MystackChan/MystackChan.ino`
- Protocol layer: `MystackChan/call_buddy.h`
- Firmware version in events: `0.5.0`
- This is not Xiaozhi firmware and does not implement Xiaozhi protocol.
- Verified command path: `/dev/tty.usbmodem2101` at `115200`, using `HELP`,
  `CB listen ...`, and `CB idle ...`.

## Transport

### USB Serial

- Baud rate: `115200`
- Framing: one UTF-8 text command per line, terminated by `\n`.
- Responses/events: JSON Lines, one JSON object per line.
- macOS note: prefer `/dev/tty.usbmodem*` for the agent process. In local tests
  `/dev/cu.usbmodem2101` uploaded firmware but did not reliably read command
  responses, while `/dev/tty.usbmodem2101` did.
- If the device screen or serial output shows ESP32 download/firmware writing
  mode, the application firmware is not running. Exit that mode first by
  rebooting/resetting the device without holding BOOT; otherwise `CB ...`
  commands cannot work.

### TCP Line Mode

The sketch has optional TCP client support behind ignored local config constants:

- `MYSTACKCHAN_WIFI_SSID`
- `MYSTACKCHAN_WIFI_PASS`
- `MYSTACKCHAN_AGENT_HOST`
- `MYSTACKCHAN_AGENT_PORT`

When these are empty, USB Serial is the active transport. TCP uses the same
line command and JSON Lines event format. Do not assume the USB-connected
development machine is the Mac mini; configure the actual host IP for the
machine running the server process.

## Command Format

Commands are case-insensitive for command names. Text after the command is kept
as display/status text.

```text
COMMAND arg1 arg2 optional free text
```

## Core Call Buddy Commands

| Command | Effect | Buddy visual state | Event |
| --- | --- | --- | --- |
| `CB connect [text]` | Mark host link online | idle | `call_buddy.state` |
| `CB disconnect [text]` | Mark host link offline | idle | `call_buddy.state` |
| `CB idle [text]` | Return to ready state | idle | `call_buddy.state` |
| `CB listen [text]` | Start a voice/user turn | listening | `call_buddy.state` |
| `CB think [text]` | Agent is processing | thinking | `call_buddy.state` |
| `CB speak [text]` | Agent is speaking/playing TTS | speaking | `call_buddy.state` |
| `CB stop [text]` | Cancel/reset current turn | idle | `call_buddy.state` |
| `CB error [text]` | Show failure state | error | `call_buddy.state` |

Alias: `CALLBUDDY ...` is equivalent to `CB ...`.

Examples:

```text
CB connect mac mini online
CB listen listening for command
CB think routing to codex
CB speak response ready
CB idle ready
```

## Codex Buddy Commands

These commands are dedicated shortcuts for Codex/Copilot/agent hooks.

| Command | Effect | Event |
| --- | --- | --- |
| `CODEX CODING [text]` | Show active coding state | `codex.coding` |
| `CODEX WRITE [text]` | Alias for coding state | `codex.coding` |
| `CODEX APPROVAL <id> [text]` | Show approval-required state | `approval.request.shown` |
| `CODEX DONE [text]` | Show success state, then auto-idle | `codex.done` |
| `CODEX ERROR [text]` | Show error state, then auto-idle | `codex.error` |

Example:

```text
CODEX APPROVAL shell-42 Allow running build script?
```

When an approval is active:

- Back touch tap emits `approval.response` with `choice:"approve"`.
- Back touch backward swipe emits `approval.response` with `choice:"deny"`.

## Generic Device Commands

| Command | Effect |
| --- | --- |
| `HELP` | Print command list as plain text. |
| `STATE <state>` | Force buddy state. States: `idle`, `listening`, `thinking`, `speaking`, `coding`, `approval`, `done`, `error`, `sleep`. |
| `TEXT <text>` | Set bottom status text without changing state. |
| `SAY <text>` | Set speaking state with text. |
| `APPROVAL <id> [text]` | Generic approval request. |
| `LOOK <yaw> <pitch> [speed]` | Move servos. Units are `10 = 1 degree`. |
| `LED <r> <g> <b> [ms]` | Temporary manual LED override. |
| `LED AUTO` | Return LED control to firmware state machine. |
| `LED OFF` | Turn LEDs off and return to auto control. |
| `CAPTURE [id]` / `SCREENSHOT [id]` | Stream the current display frame as RGB565 hex rows. |
| `POWER OFF` / `SHUTDOWN` | Enter firmware-controlled software off: LEDs and servos off, display asleep, ESP32-S3 deep sleep. |
| `REBOOT` / `RESTART` | Restart the ESP32-S3. |
| `HOME` | Return servo posture to home. |

## Camera Follow Commands

Camera follow is enabled by default in the current firmware. It is intentionally
low cost and lazy: the device samples grayscale QQVGA frames as a `16x12` block
motion grid, follows qualifying motion with 50% probability, and ignores the
other 50% as the new baseline.

| Command | Effect | Event |
| --- | --- | --- |
| `FOLLOW ON` / `CAMERA FOLLOW ON` | Enable camera-follow sampling. | `camera.follow.config` |
| `FOLLOW OFF` / `CAMERA FOLLOW OFF` | Disable camera-follow sampling. | `camera.follow.config` |
| `FOLLOW NOW` / `CAMERA FOLLOW NOW` | Force one immediate sample. | `camera.follow.now` plus sample/motion/ignore events |
| `FOLLOW STATUS` / `CAMERA FOLLOW STATUS` | Report follow readiness and settings. | `camera.follow.status` |
| `NET STATUS` / `WIFI STATUS` / `NETWORK STATUS` | Report Wi-Fi/TCP diagnostics. | `network.status` |
| `AUDIO STATUS` | Report audio transport and hardware state. | `audio.status` |
| `AUDIO IN START` / `AUDIO INPUT START` / `MIC START` | Start microphone PCM16 streaming to the TCP agent. | `audio.input.start` |
| `AUDIO IN STOP` / `AUDIO INPUT STOP` / `MIC STOP` | Stop microphone streaming. | `audio.input.stop` |
| `AUDIO OUT START [sample_rate] [chunk_bytes]` | Prepare speaker playback for fixed-size PCM16 binary frames. Defaults: `24000 960`. | `audio.output.start` |
| `AUDIO OUT STOP` / `AUDIO OUTPUT STOP` / `SPEAKER STOP` | Stop speaker playback. | `audio.output.stop` |

Current default settings:

- Sample interval: `60000` ms.
- Camera mode: grayscale QQVGA, `160x120`, `19200` bytes per frame.
- Motion grid: `16x12`.
- Interest probability: `interest_percent:50`.
- Idle wander: random 14-30 second gap, random 2.2-4.2 second hold.
- Servo movement returns home after a short hold, then the firmware rebuilds the
  camera baseline after settling.

## Display Capture

The display capture protocol is for visual debugging from the host. It captures
the firmware's `M5Canvas` immediately before transmission, so it matches what
the sketch just pushed to the LCD.

Host command:

```text
CAPTURE optional-id
```

Firmware responses:

```json
{"type":"display.capture.begin","payload":{"id":"optional-id","width":320,"height":240,"format":"rgb565_hex","rows":240}}
{"type":"display.capture.row","payload":{"id":"optional-id","y":0,"data":"0000...","sum":12345}}
{"type":"display.capture.end","payload":{"id":"optional-id","rows":240}}
```

`data` is one full row. Each pixel is four hex digits in RGB565 order. `sum` is
the row's 16-bit additive checksum over decoded RGB565 pixel values.

Use the helper:

```bash
python3 tools/capture_display.py --port /dev/tty.usbmodem2101 --out captures/current.png
```

## Audio Transport

The current firmware supports first-pass half-duplex audio over the same TCP
connection as the line protocol. JSON Lines remain the control channel; audio is
sent as fixed-size binary frames.

Binary frame header:

```text
byte 0      frame_type
byte 1      codec_or_subtype
byte 2-5    stream_seq uint32 big-endian
byte 6-13   timestamp_ms uint64 big-endian
byte 14..   fixed-size PCM16 payload
```

Current frame values:

| Value | Name | Direction |
| --- | --- | --- |
| `0x20` | `audio.input` | Buddy to Mac mini |
| `0x21` | `audio.output` | Mac mini to Buddy |
| `0x02` | `pcm16` | 16-bit signed little-endian PCM |

Current audio settings:

- Input: `16000 Hz`, mono, PCM16, `320` samples / `640` bytes per frame.
- Output default: `24000 Hz`, mono, PCM16, `960` bytes per frame.
- Output max chunk size: `2048` bytes.
- Output chunk size is configured with `AUDIO OUT START [sample_rate] [chunk_bytes]`.
- CoreS3/M5Unified cannot use microphone and speaker simultaneously, so the
  firmware switches hardware mode: listening stops speaker output; speaker
  output stops microphone capture.

Touch behavior:

- Back touch starts local listening and starts `audio.input` if TCP is connected.
- Second tap cancels local listening and stops `audio.input`.
- Listening timeout also stops `audio.input`.

## Event Format

All firmware-generated events are JSON Lines:

```json
{"type":"event.name","payload":{}}
```

Important event types:

| Event | Payload |
| --- | --- |
| `device.boot` | `{ "device", "serial", "commands", "fw" }` |
| `device.heartbeat` | `{ "state", "battery_v", "call_buddy" }` |
| `buddy.state.changed` | `{ "state", "title" }` |
| `call_buddy.state` | `{ "online", "state", "session", "turn", "text" }` |
| `call_buddy.command.unknown` | `{ "command" }` |
| `approval.request.shown` | `{ "id", "text", "source?" }` |
| `approval.response` | `{ "id", "choice", "method" }` |
| `touch.click` | `{ "action":"listen_start", "timeout_ms" }` |
| `touch.listen_cancel` | `{}` |
| `touch.listen_timeout` | `{}` |
| `touch.swipe_forward` | `{}` |
| `touch.swipe_backward` | `{}` |
| `motion.look` | `{ "yaw", "pitch", "speed" }` |
| `led.set` | `{ "r", "g", "b", "ms" }` |
| `display.capture.begin` | `{ "id", "width", "height", "format", "rows" }` |
| `display.capture.row` | `{ "id", "y", "data", "sum" }` |
| `display.capture.end` | `{ "id", "rows" }` |
| `camera.follow.init` | `{ "ok", "framesize", "format" }` or `{ "ok":false, "error" }` |
| `camera.follow.baseline` | `{ "frame", "grid" }` |
| `camera.follow.sample` | `{ "frame", "motion":false, "blocks", "score", "mean", "threshold" }` |
| `camera.follow.motion` | `{ "frame", "blocks", "score", "mean", "x", "y", "yaw", "pitch", "speed" }` |
| `camera.follow.ignore` | `{ "frame", "reason":"lazy", "roll", "chance_percent", "blocks", "score", "mean", "x", "y", "yaw", "pitch" }` |
| `camera.follow.home` | `{ "reason" }` |
| `camera.follow.glance` | `{ "yaw", "pitch", "speed", "hold_ms" }` |
| `camera.follow.status` | `{ "enabled", "ready", "baseline", "frames", "interval_ms", "interest_percent" }` |
| `camera.follow.config` | `{ "enabled", "ready?" }` |
| `camera.follow.now` | `{ "moved" }` |
| `camera.follow.error` | `{ "stage", ... }` |
| `network.wifi.connecting` | `{ "status" }` |
| `network.wifi.connected` | `{ "local_ip", "rssi" }` |
| `network.wifi.disconnected` | `{ "status" }` |
| `network.tcp.connecting` | `{ "host", "port", "local_ip" }` |
| `network.tcp.connected` | `{ "host", "port", "local_ip" }` |
| `network.tcp.connect_failed` | `{ "host", "port", "local_ip" }` |
| `network.tcp.disconnected` | `{ "reason" }` |
| `network.status` | `{ "reason", "configured", "wifi_connected", "wifi_status", "local_ip", "rssi", "tcp_connected", "host", "port" }` |
| `audio.status` | `{ "reason", "input_active", "output_active", "hardware", "input_sample_rate", "input_chunk_samples", "output_sample_rate", "output_chunk_bytes", "input_frames", "output_frames" }` |
| `audio.input.start` | `{ "reason", "codec", "sample_rate", "channels", "chunk_samples", "chunk_bytes", "frame_type" }` |
| `audio.input.stop` | `{ "reason", "frames" }` |
| `audio.output.start` | `{ "reason", "codec", "sample_rate", "channels", "chunk_bytes", "frame_type" }` |
| `audio.output.stop` | `{ "reason", "frames" }` |
| `audio.error` | `{ "stage", ... }` |

Touch events also trigger a short local `touch` buddy animation. A back touch
tap starts local listening; tapping again emits `touch.listen_cancel`, and no
follow-up for 12 seconds emits `touch.listen_timeout`. The Mac agent should use
these event names as the source of local touch input and cancellation.

Heartbeat example:

```json
{"type":"device.heartbeat","payload":{"state":"listening","battery_v":4.11,"call_buddy":{"online":true,"state":"listening","session":"local-1","turn":1}}}
```

## Recommended Agent State Flow

For voice input:

```text
CB listen waiting for speech
CB think transcribing
CB think asking model
CB speak playing answer
CB idle ready
```

For Codex approval:

```text
CODEX CODING editing files
CODEX APPROVAL codex-123 Approve shell command?
```

Then wait for:

```json
{"type":"approval.response","payload":{"id":"codex-123","choice":"approve","method":"tap"}}
```

## Host-Agent Implementation Notes

- Treat firmware commands as best-effort UI/device state updates, not as the
  source of truth for agent policy.
- Keep command text short. The device truncates long status text on screen.
- Read continuously because heartbeat and touch events are asynchronous.
- Reconnect by reopening the serial device and sending `CB connect ...`.
- If no JSON is received on macOS, try `/dev/tty.usbmodem*` before
  `/dev/cu.usbmodem*`.
- If the serial stream prints `waiting for download`, the board is in ESP32 ROM
  bootloader mode. Do not treat that as a protocol failure; reset the device
  into normal app mode and retry.
- Audio now uses a fixed-size binary side channel on the same TCP socket. Keep
  the JSON Lines control parser separate from binary frame parsing on the Mac
  mini side.
- The firmware already handles local back-touch listening UX: first tap emits
  `touch.click` with `action:"listen_start"`, second tap while listening emits
  `touch.listen_cancel`, and timeout emits `touch.listen_timeout`.
- Camera follow is already integrated into the main firmware. The firmware emits
  motion metadata only; it does not stream raw camera frames over this protocol.
