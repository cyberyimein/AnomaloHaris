---
name: buddy
description: Control the optional Buddy device through the isolated Buddy backend.
requires_plugins: buddy-bridge
---

# Buddy Control

Use this skill only when the current Preset Model includes the `buddy-bridge`
plugin and the user asks for device presence, short status, movement, LEDs,
recent device events, or an explicit approval prompt.

The tools are a remote control surface, not direct hardware access:

- `buddy_status` checks whether the independent Buddy backend and device are available.
- `buddy_recent_events` reads sanitized touch, heartbeat, connection, and approval events.
- `buddy_set_state` and `buddy_set_text` update the device's visual status.
- `buddy_look` and `buddy_set_led` control lightweight physical cues only.
- `buddy_request_approval` waits for an explicit user decision when approval is enabled.

Do not claim that a device action succeeded until the tool returns success. If
the backend is unavailable, continue the Agent task without repeatedly retrying
and explain the limitation briefly. Never request or expose serial details,
service tokens, full prompts, tool arguments, or raw device logs. Audio,
vision, camera, and media processing are not part of this skill.
