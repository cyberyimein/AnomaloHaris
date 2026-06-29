# MystackChan Project Context

This project is the custom Arduino firmware and working documentation for a
CoreS3 StackChan device used as a local AI/agent buddy.

## Current Direction

- Device role: embodied desktop interface, not the main AI runtime.
- Host agent role: STT/TTS/LLM/tool orchestration, Codex/Copilot hooks,
  approval policy, and future audio pipeline. The future production host may be
  the Mac mini, but the current USB-connected development machine is not
  necessarily the Mac mini.
- Firmware role: display buddy state, play sprite animations, drive LEDs/servos,
  read touch input, and expose a small line-based control protocol.
- Protocol name: Call Buddy.
- Current firmware is not Xiaozhi firmware and does not implement Xiaozhi protocol.
  Xiaozhi was evaluated as a useful reference, but the current implementation is
  intentionally smaller and Arduino-compatible.

## Current Firmware State

- Board: M5Stack CoreS3 with StackChan BSP library.
- Sketch: `MystackChan/MystackChan.ino`
- Firmware version in events: `0.5.0`
- Transport: USB Serial line protocol at `115200`; optional TCP line mode exists
  and is enabled only when Wi-Fi constants are configured in ignored local
  config.
- Last successful upload: `/dev/cu.usbmodem2101` using Arduino CLI auto-reset.
- Last main firmware compile: 1,430,243 bytes flash used, 69,944 bytes RAM used.

## 2026-05-28 Working Memory

- Main Buddy firmware has Wi-Fi config support via ignored
  `MystackChan/local_config.h`; the current local file points at Mac mini
  `192.168.31.31:8787`, but server-side development should not assume the
  current Codex machine is that Mac mini.
- Current device is running the main Buddy firmware with camera-follow enabled
  by default.
- Mac reboot fixed the USB/serial visibility problem during the camera probe;
  after reboot the device displayed camera debug information normally.
- `experiments/camera_probe/camera_probe.ino` is an isolated CoreS3 camera
  experiment. It confirms the standard Stack CoreS3/StackChan hardware path:
  GC0308 camera at I2C `0x21`, internal I2C `SDA=12`, `SCL=11`, fixed onboard
  XCLK, DVP pins from the official StackChan reference.
- Camera follow status: Arduino `esp_camera.h` compiles and runs for CoreS3.
  Main firmware initializes the GC0308 camera in grayscale QQVGA mode, samples a
  `16x12` block-difference grid every 60 seconds, and moves toward detected
  motion at low speed. After any servo movement it returns home and rebuilds the
  visual baseline so its own head motion does not keep retriggering.
- Camera follow is intentionally lazy: even when motion is detected, firmware
  only follows it with `CAMERA_FOLLOW_INTEREST_PERCENT=50`. Ignored motion emits
  `camera.follow.ignore` and becomes the new baseline.
- Idle wander is now owned by camera-follow mode: every random 14-30 seconds it
  makes a visible slow glance, holds for random 2.2-4.2 seconds, returns home,
  and rebuilds the baseline. Home movement is skipped when already at home to
  avoid no-op servo noise.
- TCP connection to the Mac mini agent has been verified from Buddy:
  `network.wifi.connected` showed Buddy at `192.168.31.78`, then
  `network.tcp.connected` to `192.168.31.31:8787`, then the server sent
  `CB connect` text `MacMiniM4 online`. Use `NET STATUS` over serial for live
  diagnostics.
- Audio transport is implemented in firmware as half-duplex PCM16 over the same
  TCP socket: `audio.input` binary frames are `0x20/0x02`, 16 kHz mono, 320
  samples / 640 bytes; `audio.output` binary frames are `0x21/0x02`, default
  24 kHz mono, 960 bytes. Use `AUDIO STATUS`, `AUDIO IN START/STOP`, and
  `AUDIO OUT START [sample_rate] [chunk_bytes]` for diagnostics/control.
- Current post-audio-flash network check: Buddy joined Wi-Fi as `192.168.31.78`
  but `192.168.31.31:8787` returned connection refused, so end-to-end audio
  could not be verified until the Mac mini listener is running again.
- Servo boot jerk was fixed by keeping
  `M5StackChan.Motion.setAutoAngleSyncEnabled(true)`. Do not turn this off.
- Idle glance is intentionally small/original: yaw `-120`/`120`, pitch `260`,
  speed `180`, and guarded with `frameNo > 0` so boot does not immediately
  trigger a left turn.
- Buddy cat sprite uses the white-line-separated source sheet and draws at
  `BUDDY_DRAW_SIZE=200`, `BUDDY_DRAW_Y=24`.
- One power button is firmware-readable and now enters software-off/deep sleep.
  The other physical button still resets or enters ROM download mode and cannot
  be repurposed by firmware.
- Back touch tap enters local listening, second tap cancels with
  `touch.listen_cancel`, and no follow-up for 12 seconds emits
  `touch.listen_timeout`.

## Visual Asset State

- Source sheet: `assets/buddy/source/cat_state_sheet.png`
- Generated preview: `assets/buddy/generated/buddy-sheet-v2.png`
- Firmware asset header: `MystackChan/buddy_sprite_frames.h`
- PNG files are not embedded in firmware. The generator converts the source sheet
  to 16-color, 4-bit packed `PROGMEM` data.
- Current unique sprite storage is about 44.8 KB for 14 unique `80x80` frames.

## Active State Mapping

| State / condition | Visual frames |
| --- | --- |
| `idle` | source row 1 cells 1-2 |
| `listening` | source row 1 cells 3-4 |
| `speaking` | source row 2 cells 1-2 |
| `thinking` | source row 2 cells 3-4 |
| `coding` | source row 2 cells 4 then 3 |
| `approval` | source row 3 cells 1-2 |
| touch reaction | source row 3 cells 3-4, temporary overlay |
| `done` / `error` / `sleep` | spare/reused frames |

## Important Operating Notes

- Use `/dev/cu.usbmodem2101` for Arduino upload.
- Use `/dev/tty.usbmodem2101` for agent/serial communication tests when the app
  is already running normally.
- Do not open serial monitor casually. DTR/RTS changes, stale host USB state, or
  BOOT being held can push or leave the ESP32-S3 in ROM download mode. A Mac
  reboot resolved one observed no-output case.
- Ask the user to confirm the device is in normal app mode before testing
  `CB ...` commands.
- Touch tap approves an active approval request. Backward swipe denies it.

## Primary Docs

- `docs/project-handoff.md`: complete current handoff and project memory.
- `docs/call-buddy-protocol.md`: Mac agent integration protocol.
- `docs/buddy-asset-workflow.md`: sprite source, generation, and firmware packing.
- `docs/macmini-agent-architecture.md`: broader future Mac mini architecture.
- `MystackChan/OFFICIAL_REFERENCE.md`: official StackChan/Xiaozhi reference notes.
