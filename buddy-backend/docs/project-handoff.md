# MystackChan Project Handoff

> Historical firmware handoff. Anomalo's Node Host no longer embeds the Python
> Buddy host, Codex hook relay, audio bridge, or vision service. Restore any of
> those capabilities only as an explicit, separately tested plugin.

This document captures the working context from the StackChan firmware discussion
so the project can continue from `/path/to/MyStackChan` without
depending on the old `StackChan-BSP` workspace or chat history.

## Current Status

| Area | Status |
| --- | --- |
| Firmware | Arduino sketch compiles and uploads for CoreS3. |
| Device upload | Uploaded successfully to `/dev/cu.usbmodem2101` on 2026-05-27. |
| Firmware version | `0.5.0` in `device.boot` events. |
| Protocol | Call Buddy line protocol over USB Serial, optional TCP line mode. |
| Buddy art | Uses source sprite sheet cut into 16-color, 4-bit packed frames. |
| Host agent | Not implemented here; protocol and architecture docs are ready. |
| Xiaozhi | Not used in current firmware; kept only as conceptual/reference material. |
| Camera probe | Isolated Arduino experiment exists; not integrated into main Buddy firmware. |

Successful upload details:

```text
Chip: ESP32-S3, MAC 44:1b:f6:e1:d5:40
Latest main firmware compile: 1,316,647 bytes, 41% flash
RAM globals: 49,472 bytes, 15% RAM
Upload port: /dev/cu.usbmodem2101
Upload result: hash verified, hard reset via RTS
```

## Project Layout

```text
/path/to/MyStackChan/
  CONTEXT.md
  MystackChan/
    MystackChan.ino
    call_buddy.h
    buddy_sprite_frames.h
    OFFICIAL_REFERENCE.md
  assets/buddy/
    source/cat_state_sheet.png
    generated/buddy-sheet-v2.png
    generated/frames/*.png
    firmware/buddy_sprite_frames.h
  docs/
    project-handoff.md
    call-buddy-protocol.md
    buddy-asset-workflow.md
    macmini-agent-architecture.md
  tools/buddy_assets/
    generate_pixel_buddy.py
    DEPLOY.md
  references/official-stackchan/
    README.md
    STACKCHAN_REPO_README.md
```

## 2026-05-28 Notes

- The current USB-connected development machine is not necessarily the Mac mini.
  Do not hard-code `192.0.2.10` unless the server is actually running there.
- `MystackChan/local_config.h` is ignored and currently stores Wi-Fi/TCP
  settings for a future Mac mini agent at `192.0.2.10:8787`.
- After rebooting the Mac, the experimental camera probe displayed its debug
  information on Buddy. The earlier no-output state was host/USB state, not a
  confirmed firmware failure.
- Current device is running the main `MystackChan` firmware with camera-follow
  enabled by default.
- Standard Stack CoreS3 camera hardware notes from the probe/reference:
  GC0308 at I2C `0x21`; internal I2C `SDA=12`, `SCL=11`; DVP data pins
  `D0=39`, `D1=40`, `D2=41`, `D3=42`, `D4=15`, `D5=16`, `D6=48`, `D7=47`,
  `VSYNC=46`, `HREF=38`, `PCLK=45`; XCLK is fixed onboard/`NC`.
- Arduino `esp_camera.h` compiles and captures frames in this M5Stack ESP32 core.
  Verified probe result: `esp_camera_init(PIXFORMAT_GRAYSCALE, FRAMESIZE_QQVGA)`
  succeeded, sensor PID `0x9B`, repeated frames `160x120`, format `3`, length
  `19200`, with changing checksums. The main firmware now uses this path for
  low-cost lazy motion-following; official StackChan uses ESP-IDF `esp_video`
  for camera.
- Camera-follow behavior: firmware samples a `16x12` motion grid every 60
  seconds, follows qualifying motion with 50% probability, otherwise emits
  `camera.follow.ignore` and treats the current frame as the new baseline. Servo
  follow movement returns home and rebuilds the baseline after settling.
- Servo startup jerk was fixed by enabling auto angle sync:
  `M5StackChan.Motion.setAutoAngleSyncEnabled(true)`. Keep it enabled.
- Buddy sprite was regenerated from the white-line-separated sheet and is drawn
  at `200x200`.

## Decisions Made

- The official StackChan firmware is ESP-IDF based and has app center, games,
  Xiaozhi integration, and official server integration. It is useful as a
  reference, but not the fastest path for this custom Mac mini agent workflow.
- The custom firmware should stay small and device-oriented: UI, LEDs, servos,
  touch input, and simple command/event transport.
- The host/Mac mini agent should own STT, TTS, model calls, Codex/Copilot hooks,
  approval lifecycle, and long-running memory.
- MCP should not run on the StackChan firmware. The Mac mini agent can expose
  StackChan operations as tools/skills to other AI agents.
- Current firmware does not use Xiaozhi code or Xiaozhi protocol. A future
  voice transport can mimic useful Xiaozhi concepts, but should remain under
  Call Buddy control unless there is a clear compatibility requirement.
- Voice should be implemented on the Mac mini side first. The StackChan side can
  later add microphone capture and speaker playback as a dedicated transport.

## Call Buddy Summary

Transport:

- USB Serial at `115200`.
- Optional TCP client from device to host when `MystackChan/local_config.h`
  defines Wi-Fi SSID/password, agent host, and agent port.
- Commands are one text line per command.
- Firmware responses/events are JSON Lines.
- `/dev/cu.usbmodem2101` worked for upload.
- `/dev/tty.usbmodem2101` previously worked better for reading protocol events.
- If USB events disappear, confirm the device is running app firmware, not ROM
  download mode. Rebooting the host Mac fixed one stale USB CDC state.

Core commands:

```text
CB connect [text]
CB idle [text]
CB listen [text]
CB think [text]
CB speak [text]
CB error [text]

CODEX CODING [text]
CODEX APPROVAL <id> [text]
CODEX DONE [text]
CODEX ERROR [text]

STATE idle|listening|thinking|speaking|coding|approval|done|error|sleep
TEXT <text>
SAY <text>
APPROVAL <id> [text]
LOOK <yaw> <pitch> [speed]
LED <r> <g> <b> [ms]
LED AUTO
LED OFF
HOME
HELP
```

Important events:

```text
device.boot
device.heartbeat
buddy.state.changed
call_buddy.state
approval.request.shown
approval.response
touch.click
touch.listen_cancel
touch.listen_timeout
touch.swipe_forward
touch.swipe_backward
motion.look
led.set
display.capture.begin
display.capture.row
display.capture.end
```

See `docs/call-buddy-protocol.md` for the full integration contract.

## Approval Behavior

- `CODEX APPROVAL <id> <text>` enters the approval visual state.
- Touch tap emits `approval.response` with `choice:"approve"`.
- Backward swipe emits `approval.response` with `choice:"deny"`.
- The device only captures user intent. The Mac mini agent must still decide how
  to apply that response to Codex/Copilot/CLI execution.

## Buddy Sprite System

Source file:

```text
assets/buddy/source/cat_state_sheet.png
```

Generated preview:

```text
assets/buddy/generated/buddy-sheet-v2.png
```

Firmware header:

```text
MystackChan/buddy_sprite_frames.h
```

The generator:

```text
tools/buddy_assets/generate_pixel_buddy.py
```

Current visual mapping:

| Source area | Firmware usage |
| --- | --- |
| Row 1 cells 1-2 | idle |
| Row 1 cells 3-4 | listening |
| Row 2 cells 1-2 | speaking |
| Row 2 cells 3-4 | thinking |
| Row 2 cells 4 then 3 | coding |
| Row 3 cells 1-2 | approval |
| Row 3 cells 3-4 | touched-head temporary reaction |
| Row 4 | spare happy/love/shine variants |

PNG storage note:

- PNG files stay in the repo as source and preview artifacts.
- Firmware stores packed indexed data, not PNG files.
- One `80x80` frame is `3200` bytes before C syntax overhead.
- Current generated firmware has 17 logical frames but only 14 unique pixel
  arrays, about `44.8KB` of packed sprite data.

Regenerate assets:

```bash
cd /path/to/MyStackChan
python3 tools/buddy_assets/generate_pixel_buddy.py --repo /path/to/MyStackChan
```

## Build And Upload

Compile:

```bash
"/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli" compile \
  --fqbn m5stack:esp32:m5stack_cores3 \
  /path/to/MyStackChan/MystackChan
```

Upload:

```bash
"/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli" upload \
  -p /dev/cu.usbmodem2101 \
  --fqbn m5stack:esp32:m5stack_cores3 \
  /path/to/MyStackChan/MystackChan
```

Serial communication test, only after the device is visibly running the app UI:

```bash
python3 - <<'PY'
import serial, time
port = "/dev/tty.usbmodem2101"
with serial.Serial(port, 115200, timeout=2) as ser:
    ser.write(b"CB listen mac agent test\n")
    deadline = time.time() + 5
    while time.time() < deadline:
        line = ser.readline()
        if line:
            print(line.decode(errors="replace").rstrip())
PY
```

Avoid opening Arduino serial monitor unless necessary. DTR/RTS changes can put
the ESP32-S3 into ROM download mode.

## Mac Mini Agent Next Steps

1. Implement a serial gateway that opens `/dev/tty.usbmodem*`, sends Call Buddy
   commands, and continuously reads JSON Lines events.
2. Implement a `StackChanSkill` or equivalent in the Mac mini agent with methods
   like `set_state`, `request_approval`, `look`, `set_led`, and `say`.
3. Wire Codex/Copilot hooks to `CODEX CODING`, `CODEX APPROVAL`, `CODEX DONE`,
   and `CODEX ERROR`.
4. Keep approval policy on the Mac side. The firmware response is a user-input
   signal, not direct permission to execute dangerous work.
5. Add voice on the Mac side first: VAD/STT/LLM/TTS locally or via cloud, then
   drive the firmware with `CB listen`, `CB think`, `CB speak`, and `CB idle`.
6. Later add a dedicated audio transport if StackChan microphone/speaker should
   become active in the loop.

## Server Agent Contract Snapshot

The server should expose a small Buddy adapter rather than embedding policy in
firmware:

- `connect()` sends `CB connect <host-name>`
- `set_state("idle|listening|thinking|speaking|error")` sends matching `CB ...`
- `set_coding(text)` sends `CODEX CODING <text>`
- `request_approval(id, text)` sends `CODEX APPROVAL <id> <text>` and waits for
  `approval.response`
- `look(yaw, pitch, speed)` sends `LOOK <yaw> <pitch> <speed>` where `10 = 1 deg`
- `set_led(r,g,b,ms)` sends `LED <r> <g> <b> <ms>`
- `capture_display(id)` sends `CAPTURE <id>` and reconstructs RGB565 hex rows
- `shutdown()` sends `POWER OFF`; `reboot()` sends `REBOOT`

Server must keep approval/security policy. A touch approval event is only a user
intent signal, not automatic permission to execute arbitrary actions.

## Things To Watch

- If the screen shows ESP32 download/writing mode, app firmware is not running.
  Reset the device normally before protocol testing.
- If serial reads produce no JSON, try `/dev/tty.usbmodem*` rather than
  `/dev/cu.usbmodem*`.
- If another future image sheet changes the grid layout, update
  `FRAME_SPECS` in `tools/buddy_assets/generate_pixel_buddy.py`.
- The old procedural cat renderer still exists in the sketch as fallback code,
  but `drawFace()` now uses `drawBuddySprite()`.
- Do not rely on official app store/app center behavior for this firmware. This
  is a custom agent-mode firmware, not a fork of the official app launcher.
