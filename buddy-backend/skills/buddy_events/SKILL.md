---
name: buddy_events
description: Read Buddy connection status and recent touch, listen, approval, or heartbeat events.
---

# Buddy Events

Use this skill when the remote LLM needs to **observe Buddy**.

This skill is for:

- checking whether Buddy is connected
- reading recent events like `touch.click`, `touch.listen_cancel`, `approval.response`, and
  `device.heartbeat`

Prefer the filtered event tools here over raw protocol access. Keep polling light and focused on the
current interaction.
