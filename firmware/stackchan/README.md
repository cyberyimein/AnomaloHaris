# StackChan Agent Firmware

> Firmware is developed in [BuddyNeko](https://github.com/cyberyimein/buddy-neko).
> This directory is AnomaloHaris's pinned integration snapshot; the selected commit
> and runtime file hashes are recorded in [UPSTREAM.json](UPSTREAM.json).
> Develop firmware changes upstream, then update this snapshot. Local
> `config.py` remains private and is not part of the upstream snapshot.

This is a UIFlow2 MicroPython firmware package for the StackChan CoreS3. The
device joins Wi-Fi and serves a small authenticated API. AnomaloHaris connects to the
device at its configured LAN address.

## Hardware and API references

- [StackChan UIFlow2 guide, version 2.4.7](https://uiflow-micropython.readthedocs.io/en/2.4.7/controllers/stackchan.html)
- [StackChan camera guide](https://uiflow-micropython.readthedocs.io/en/stable/advanced/camera.html)
- [CoreS3 image buffer API, version 2.4.7](https://uiflow-micropython.readthedocs.io/en/2.4.7/advanced/image.html)
- [CoreS3 ambient light sensor, version 2.4.7](https://uiflow-micropython.readthedocs.io/en/2.4.7/hardware/als.html)
- [CoreS3 display API, version 2.4.7](https://uiflow-micropython.readthedocs.io/en/2.4.7/hardware/display.html)
- [UIFlow2 Power API, version 2.4.7](https://uiflow-micropython.readthedocs.io/en/2.4.7/system/power.html)
- [UIFlow2 Button API, version 2.4.7](https://uiflow-micropython.readthedocs.io/en/2.4.7/hardware/button.html)
- [Espressif RGB565 camera buffer example](https://developer.espressif.com/workshops/edge-ai-with-esp32-s3/assignment-4/)

The documented servo API uses degrees. The X axis supports approximately
`-135..135`, and the Y axis supports `0..90`. This firmware restricts pan to
`-90..90` and tilt to `5..85` to keep agent commands inside a conservative
operating range. The official StackChan guide provides a servo-zero calibration
program because mechanical alignment differs between units. This device's
previous calibration was recovered from its saved NVS partition as X raw zero
`485` and Y raw zero `636`. To restore those values after flashing UIFlow2, open
the device REPL and write only these two `servo` namespace entries, then reboot:

```python
import esp32
nvs = esp32.NVS("servo")
nvs.set_i32("zero_pos_1", 485)
nvs.set_i32("zero_pos_2", 636)
nvs.commit()
```

These values are specific to this unit. Do not use them for another StackChan.
If a device's saved calibration is unavailable, use the official guide's manual
zero-calibration flow instead of guessing offsets. At startup, the firmware
powers the servo rail, waits 1000 ms for power and UART feedback to settle, then
reads feedback with torque disabled, synchronizes the goal positions to that
feedback, and enables torque without changing the head pose. If startup feedback
is unavailable, it leaves the servo rail off and retries before the first
commanded movement.

UIFlow2 documents CoreS3 camera snapshots as RGB565 and restricts camera JPEG
mode to AtomS3R-M12. The device sends big-endian RGB565 pixels to Buddy service;
the deployment host converts them into compressed PNG for the dashboard and
Agent, avoiding the slow Python PNG expansion on the device.

The camera stays uninitialized during startup and idle animations. Each capture
initializes it, copies the returned pixels into Python-owned storage, and calls
`deinit()` before transmission. Captures do not retain a camera-owned framebuffer.
The capture tick is recorded when the owned copy is ready, before camera teardown.

## Lifecycle and standby

The device reports a `state.mode` of `booting`, `connecting`, `ready`,
`acting`, `sleeping`, `shutting_down`, or `error`. `state.action` remains `idle` between actions
and names the active capability while the device is acting. The optional cat
renderer shows the matching expression and English state label; the built-in
face is used when its assets are unavailable.

`device.sleep` and `device.wake` are zero-argument capabilities. Sleep turns off
servo torque and the servo rail, sets the documented Widgets backlight to 12,
and keeps Wi-Fi and the HTTP API available. While sleeping, only `device.wake`
and an idempotent `device.sleep` invocation are accepted; other device
capabilities ask the agent to wake first. The local touch zones also wake the
device on a new touch edge, after a held touch is released. Wake restores the
backlight to 128 without moving the head or powering the servos. The next head
command initializes the servo rail and synchronizes it to the measured pose
before moving.

When UIFlow2 provides `M5.Power.powerOff()`, the firmware advertises
`device.shutdown`. It releases servo power, turns off the RGB and power LEDs,
shows `SHUTTING DOWN`, and keeps the network response path alive. The HTTP
server normally arms final power-off after the invocation reply, followed by a
500 ms settle interval. A 2500 ms deadline from the accepted shutdown intent
also completes power-off if the reply cannot be delivered. A two-second `BtnPWR`
long press uses the same sequence. The shutdown capability is omitted if the
Power API is unavailable.

The robot can also act as a manually guided head. `head.release` takes no
arguments: it keeps the servo rail powered, synchronizes the targets to the
measured pose, and releases torque so the head can be repositioned by hand.
While `state.guiding` is true, the firmware polls servo feedback and reports
changes of at least two degrees as
`state.lastInteraction={type:"head.moved_by_hand",pan,tilt,atMs}`. This is an
inference from feedback while torque is released; the device cannot distinguish
a hand from another external force. It does not react to or command motion
while guiding. Invalid feedback instead reports
`{type:"head.feedback_warning",reason,atMs}` and issues no pose command. `head.hold`
takes no arguments, resynchronizes both servo targets to the current measured
pose, then enables torque. A regular `head.move` or `head.home` also synchronizes
to the latest feedback before applying its requested motion.

Touch polling runs through a cooperative service hook during network transfers,
motion waits, and developer snapshot encoding. Native camera/LCD/UART calls are
still synchronous; `state.runtime.maxServiceGapMs` exposes the largest observed
gap between service ticks. A validated touch edge updates `state.lastInteraction` to
`{type:"touch",zones:[0,1,0],atMs}` (three binary touch states), refreshes the
inactivity deadline, and briefly shows a touch response and LED pulse. Touch
while sleeping wakes the device. GET status polling and `touch.read` remain
passive and do not refresh the sleep deadline. `led.set` overrides the
lifecycle status color until the next lifecycle mode transition.

Pure sensor queries do not enter `acting`, clear component faults, or cancel
manual light colors. `state.faults` contains persistent component records
(`component`, `message`, `sinceMs`); `state.lastInvocationError` records the last
call error separately. Faults require explicit or verified component recovery.
Motion results include measured angles, the requested `target`, and
`feedbackVerified`; missing/out-of-tolerance feedback fails instead of reporting
the target as a completed move. Torque readback is checked when supported;
unsupported readback is reported as unconfirmed.

The agent face renderer is optional. When `cat_renderer.py` and the
`assets/cats/` resources are installed beside `main.py`, lifecycle/action states
and touch responses use the cat frames; otherwise the built-in face/status
display remains available.

Automatic standby defaults to five minutes after the most recent agent action.
Set `INACTIVITY_SLEEP_MS` in `config.py` to change the timeout, or set it to `0`
to disable automatic sleep. `GET /v1/status` polling and `touch.read` do not
reset this timer, so service health checks do not keep the device awake. The
firmware uses MicroPython `ticks_diff` for wrap-safe elapsed-time checks.

## Install

1. Install the M5Stack UIFlow2 firmware for StackChan/CoreS3 at version 2.4.7.
2. Copy `config.example.py` to `config.py` and set the Wi-Fi credentials, static
   LAN address, device ID, and a random device token of at least 32 characters.
3. Upload `main.py`, `device.py`, `http_api.py`, `capabilities.py`,
   `png_encoder.py`, `display_debug.py`, `debug_snapshot.py`, `cat_renderer.py`,
   `lazy_camera.py`,
   `light_engine.py`, `light_driver.py`, `cooperative_http.py`, `device_service.py`,
   `schema_validator.py`,
   the `assets/cats/` resources, and `config.py` to the device filesystem using
   UIFlow2. The renderer and assets are optional; without them the built-in
   status face is used.
   Set `main.py` as the startup program.
4. Configure AnomaloHaris with the same device address and token. The default API
   port is `8080`.

`config.py` is ignored by Git. Avoid putting Wi-Fi passwords or tokens in
`config.example.py` or committed files. A router DHCP reservation can be used
instead of setting `DEVICE_IP` in firmware if the router is the source of the
fixed address.

## Device API

Every route requires `Authorization: Bearer <BUDDY_DEVICE_TOKEN>`.

```text
GET  /v1/status
GET  /v1/debug/snapshot
POST /v1/invoke
```

`GET /v1/debug/snapshot` returns the regular status, display capture metadata
and optional PNG, renderer diagnostics, touch levels, both rear LED strips'
6 RGB values, and the manual lighting override. A `display.source` of
`submitted_framebuffer` identifies the frame submitted by firmware to the
display; it is not a physical LCD readback.

Invocation JSON uses the same request ID for the device action and response.

```json
{
  "requestId": "observe-123",
  "capability": "head.observe",
  "args": { "direction": "left" }
}
```

Direct device camera results contain base64 RGB565 data without a data-URI prefix.
Buddy service converts this into the existing `image/png` result for tools and
the dashboard. Service observations use `receivedAt` for host receipt time;
`capturedAtMs` remains a device monotonic tick, not an epoch timestamp.

```json
{
  "requestId": "observe-123",
  "result": {
    "direction": "left",
    "image": {
      "mimeType": "application/x-rgb565",
      "encoding": "rgb565-be",
      "data": "...base64 RGB565...",
      "width": 320,
      "height": 240,
      "capturedAtMs": 28413
    }
  }
}
```

The current built-in capability list is discovered from the initialized device
modules through `GET /v1/status`. `head.observe` requires both `head.move` and
`camera.capture`. New modules can add capabilities through
`DeviceController.register_capability()` with an input schema and declared
capability dependencies.
The device validates a supported schema subset before hardware handlers:
objects, arrays, strings, finite numbers, integers, booleans, null, required
properties, enums, bounds, `anyOf`, and boolean `additionalProperties`.
Unsupported validation keywords are rejected at registration. Defaults and UI
annotations do not mutate arguments. Buddy service validates arguments again
before contacting the device.

- `head.release` and `head.hold` enter and exit manual head guidance without
  pose arguments. While guiding, `state.head` exposes validated feedback in
  degrees and `state.lastInteraction` reports touch, measured head movement, or
  invalid feedback.
- `device.shutdown` is available only when the initialized M5 Power API exposes
  `powerOff()`; it powers down the device after the invocation response is sent.
- `head.move` accepts optional `pan` (`-90..90`) and `tilt` (`5..85`), plus
  `moveTimeMs` (`250..3000`, default `800`) and `speed` (`0..100`, default
  `20`). At least one axis is required.
- `head.home` returns to pan `0`, tilt `45`.
- `camera.capture` takes one new QVGA image.
- `head.observe` accepts a `direction` of `left`, `center`, or `right`, optional
  `tilt` (`5..85`, default `45`), and optional `settleMs` (`0..2000`, default
  `250`). It waits for the full 800 ms move followed by the settle time before
  taking the image.
- `led.set`, `touch.read`, `power.read`, `infrared.send`, `infrared.read`,
  `nfc.detect`, `speaker.tone`, `display.text`, `ambient.read`, and `imu.read`
  expose the corresponding documented StackChan/CoreS3 functions when their
  driver modules initialized successfully.

## Expressive lightbars

The two six-pixel rear bars run their own non-blocking light engine. Ready uses
a dim four-second gold breath; connection uses amber chases; actions use cyan scanning;
camera use has an amber indicator. Sleep has a dim blue breath, errors have red
pulses, hand guidance has paired green/purple trails, and touch triggers a short
opposing blue wave. Shutdown turns both bars off.

`led.express` selects `happy`, `curious`, `thinking`, `listening`, `speaking`,
`concerned`, or `calm`, with `intensity` 0.1–1 (default 0.5) and `durationMs`
1000–60000 (default 8000). It changes the lights without changing the robot's
mode or cat expression. Effects expire back to automatic state lighting;
`led.resume` cancels the current temporary/manual effect immediately. Error,
sleep, shutdown, and camera indication take priority over emotional cues.

The lighting tab has an explicit Agent expressions grant for `led.express` and
`led.resume`. New grants start disabled. The agent chooses cues through these
tools; generic Agent/Codex execution hooks do not control the body.

Since firmware `0.4.3`, idle ready breathing uses half its previous RGB amplitude
(peak multiplier 0.125, reported intensity 0.25). `led.set` is also a sideband
operation: sequential per-strip edits preserve previously selected colors without
inserting the acting-state cyan effect between writes.
Firmware `0.4.4` changes idle breathing to dark gold (`0xD0A000`) over four
seconds, retaining the reduced brightness and using no blue channel. Idle has
no automatic exit timer; it continues until an action, touch, emotion command,
sleep, or other lifecycle event changes the light state.
Firmware `0.4.5` filters touch transients before producing a touch animation:
one zone pattern must remain pressed for 120 ms, and a stable 200 ms release is
required before another gesture. This filter is non-blocking and does not change
the raw values returned by `touch.read`.
Firmware `0.4.6` also restores the original StackChan-BSP Si12T sensitivity:
high range, level 4 (`0xCC`), instead of the Python SDK's most sensitive default
(`0x00`). Stable noise can outlast a debounce window, so both sensor sensitivity
and software filtering matter.
Firmware `0.4.7` requires a Si12T medium/high output (`2` or `3`) for automatic
touch gestures. Weak output `1` remains visible through `touch.read` but cannot
wake the body, reset its idle timer, or start touch animations. On this device,
unattended transients reached `1`, while a user-confirmed rear-pad press reached
`2/3` and held high output for several seconds. Boolean touch drivers retain
their normal pressed/released semantics.

`state.lighting` includes the current source, pattern, lease time, and two RGB
pixel arrays. These arrays describe the last successfully refreshed frame.
The legacy UIFlow2 RGB driver can update its staging buffer while returning
`False` without writing LED RAM. On this driver, a compatibility transport writes
the complete 12-pixel RGB565 frame to LED RAM and then triggers its refresh latch.
Other drivers retain their setter and refresh path. The developer snapshot separately
includes `driverStrips` from the SDK's staging buffer; this is not a hardware
register readback. Neither is an optical measurement. Effects advance through
the cooperative service hook; native peripheral calls can hold the current
indication until they return. Status polling does not refresh expression leases.

Status also returns the last measured head pose and `headObservedAtMs`, updated
at initialization, completed motion, and hand-guidance feedback. It does not
poll the servo UART, which would interrupt light animation on every health check.

## Debug snapshot CLI

From the repository root, fetch current device status, the firmware's submitted
display framebuffer, renderer diagnostics, touch levels, and lighting override
with the read-only debug endpoint:

```sh
python3 scripts/qa/buddy-debug-snapshot.py \
  --config firmware/stackchan/config.py \
  --output /tmp/buddy-debug
```

The CLI reads the literal `BUDDY_DEVICE_TOKEN` assignment from the selected
local Python config without executing that file. Alternatively, set
`BUDDY_DEVICE_TOKEN` in the environment and omit `--config`. The default device
URL is `http://192.168.31.78:8080`; use `--url` to select another device. The
output directory receives `snapshot.json` and, when the submitted framebuffer
is available and includes a PNG, `screen.png`. A `submitted_framebuffer` source
means the image is the frame sent to the display; it is not a physical LCD
readback. The touch levels are the three sensor values in the device's `0..3`
range. The request timeout is 90 seconds to allow the first PNG encoding. The
command only performs an authenticated `GET /v1/debug/snapshot`; it does not
invoke robot actions.

Run the CLI's mocked, hardware-independent checks with:

```sh
python3 -m unittest discover -s scripts/qa -p 'test_buddy_debug_snapshot.py' -v
```

## Local checks

Run the hardware-independent fake-device tests from this directory:

```sh
python3 -m unittest -v
```

The tests cover request authentication and routing, safe servo input checks,
capability dependencies and extension, sensor and module adapters, and PNG
encoding. They do not replace an on-device test of camera colors, servo
calibration, or UIFlow2 module availability.


## Verified device

The room device runs UIFlow2 v2.4.7 with this program and automatically joins
Wi-Fi at `192.168.31.78:8080`. USB backup and verification completed before
flashing. Servo calibration was restored from its backup NVS, and small head
movement, a QVGA PNG capture over Wi-Fi, and home movement were verified.
The measured home feedback was approximately pan -0.4°, tilt 44.3°.

The Buddy client timeout defaults to 29 seconds. Camera capture and debug PNG
encoding occupy the single-threaded device server until encoding completes.
Credentials are in the ignored `config.py`.

### Verification on 2026-11-15

Firmware `0.3.3` uses an owned full-screen framebuffer, immutable BMP transport,
and native PNG fallback. Native raw-buffer output produced tiled cats and mixed
camera imagery on this device, so it is no longer used to write the LCD.
The heap collection threshold scales with available memory; text rasterization
uses complete rows rather than allocating a rectangle for every glyph pixel.

- 83 firmware tests and 7 snapshot CLI tests passed.
- Two consecutive captures from the deployed Buddy page returned valid 320 × 240 PNGs.
- The submitted screen after capture matched all 25,600 original cat sprite pixels.
- Debug snapshots read three touch levels and both six-LED strips; one recorded
  the touch expression and its blue RGB pulse. The user confirmed the physical
  animation no longer mixed camera images or tiled cats.
- The final heart/standby screen was captured successfully. Browser power-off
  returned `shutting_down`; the API remained unreachable for 32 seconds and USB
  disappeared. The user confirmed the screen and lights were extinguished.

Submitted-frame captures describe the last successfully transferred pixels;
they do not read the physical LCD panel back.

### Expressive-light verification on 2026-11-15

Firmware `0.4.2` addresses the installed UIFlow2 driver's premature `False`
return: its staging buffer changed, but a direct hardware RAM comparison proved
that individual color writes had not reached the LEDs. The legacy compatibility
transport sends all 24 bytes of LED color RAM before latching the frame. Failures
preserve the previously submitted colors and timestamp until a successful retry.

- The user confirmed both rear bars illuminated after an explicit RGB refresh.
- The user reported static output during the subsequent animation check; the
  earlier cache-only checks did not prove that animation reached the hardware.
- A direct 24-byte write to LED RAM was read back successfully on the device.
- With the compatibility transport installed, all six sampled animation frames
  matched LED hardware RAM, and all five successive frame comparisons changed.
- The user confirmed physical animation on `0.4.2`, then reported blue-white
  colors. A paused direct red/green test displayed the expected colors. Firmware
  `0.4.3` fixes per-strip edits being overwritten by acting-state colors; API
  checks confirm red/green values persist after consecutive edits. Its 122
  firmware tests pass, including the dimmer idle cycle and manual-edit regression.
- The user then confirmed green/yellow moving lights on `0.4.3`. The blue-white
  appearance after expiry is the restored teal ready-breathing pattern.
- Firmware `0.4.6` passed 129 tests after the dark-gold idle and touch-stability
  changes. Live status samples over 32 seconds all showed `ready_breathe` with
  gold RGB targets and no driver error. Touch events were still recorded during
  that interval, so those samples alone do not prove the absence of brief touch
  overlays; unattended physical confirmation is required for that conclusion.
- A later intermittent blue-white overlay disproved the initial short physical
  check. Raw capture showed unattended `LOW=1` transients, while a user-confirmed
  rear-pad press reached `[3, 3, 0]` for several seconds. Firmware `0.4.7` filters
  LOW from gestures while preserving raw reads. All 132 firmware tests passed;
  47 live samples over 65.4 seconds recorded only dark-gold `ready_breathe`, no
  accepted touch events, and no light-driver errors.
- 120 firmware tests passed after the compatibility fix. The earlier integration
  checks passed 7 developer-CLI and 224 Node Host/bridge/service tests.
- Playwright covered 21 discovered capabilities and 25 mocked manual calls.
- Live browser checks covered emotion controls, seconds-to-milliseconds conversion,
  persistent manual RGB, automatic restore, unchanged grants, and denied Agent
  access while disabled. A subsequent live camera capture returned a valid QVGA PNG.
- The Agent expressions checkbox remains off until the user grants access.

## Runtime scheduling (0.5.0)

HTTP reads and writes use nonblocking sockets with total deadlines. Cooperative
work polls touch, power and lighting during I/O; expensive LCD state changes are
coalesced and deferred until the transfer finishes. Servo movement sends both
axis commands before servicing deferred rendering. The clock helpers reuse the module-level time import; repeated runtime imports
are expensive on the installed UIFlow build. Native camera and LCD calls
remain synchronous; this is not a hard real-time scheduler.

Wi-Fi power saving is disabled when `network.WLAN.PM_NONE` is supported, matching
the original Arduino firmware. Camera initialization explicitly disables
horizontal mirroring before capture; this was checked against a physical text
target. Camera frames are copied before teardown and encoded as PNG by the host.
For the RGB565 response, bounded dimensions, exact data length and canonical
base64 are checked before inserting the large data field into JSON; all
metadata still uses the normal JSON encoder.

Installed SDK behavior must be verified on the actual device: the torque-enable
register is one byte at address 40, and writing a goal position also enables
torque. Releasing the head must only disable torque and read position; it must
not synchronize a target. Calibration in NVS is preserved.
