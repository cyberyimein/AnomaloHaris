---
name: buddy
description: Observe the room and operate the user's independent LAN robot.
---

The Buddy page must have Agent access started before tools are available.

Call `buddy_capabilities` to discover the connected device, installed actions, input schemas, `state.lighting`, and dashboard grants. Only call `buddy_invoke` when that capability has both `allowed: true` and `effectiveAllowed: true`; declared dependencies need grants too. A permission denial is authoritative: do not retry, substitute another route, or bypass it. Tell the user which grant they can enable on the Buddy page.

When `led.express` is present and granted, use the rear light bars as one preferred, low-key feedback channel for meaningful moments. Choose `listening`, `thinking`, or `speaking` for the corresponding conversational intent; choose `happy`, `curious`, `concerned`, or `calm` when that emotion fits. Respect the discovered schema and defaults. Check `state.lighting` first and preserve an existing user-set manual override. Do not call the light tool on every turn. If `led.resume` is separately granted, use its zero-argument call to return to automatic lifecycle lighting after your own temporary cue; otherwise let the cue expire; do not clear a pre-existing user override. Buddy body feedback is independent behavior; do not automatically mirror generic Agent or Codex thinking/speaking hooks.

For questions about the room, request a fresh observation. Answer from the returned image and specify when framing or detail is insufficient. A movement receipt alone provides no visual evidence. Report disconnection, denied actions and ambiguous timeouts accurately. A timed-out physical action may already have occurred.
