# ADR-0001: Node.js Host with a Python Worker boundary

- Status: Superseded as the final target by ADR-0002; retained as migration history
- Date: 2026-08-22
- Decision owners: Anomalo runtime maintainers

## Context

The current FastAPI process owns HTTP, WebSocket, session persistence, model
orchestration, tool dispatch, and Python-specific capabilities. That makes the
agent loop difficult to test independently and makes a future Node.js Host
migration risky unless the existing event, stop/resume, and structured-output
behavior is frozen first.

## Decision

> ADR-0002 replaces the final “Node Host + Python Worker” destination with a
> Node-only Host and versioned Preset Model compute center. The phased seams and
> compatibility work in this ADR remain useful migration inputs, but Python is
> no longer an accepted component of the completed production architecture.

Implement the migration in independently revertible slices:

1. Freeze the current behavior with JSON Schema fixtures and replayable tests.
2. Deepen the Python implementation behind `ContextBuilder`, `RunController`,
   and `AgentCore`, while keeping `AgentRuntime` as the compatibility facade.
3. Add an npm workspace and a single `@anomalo/contracts` source for the
   cross-process event, tool, and run-request contracts.

The migration now has a live Node Host path. The Python Host remains the safe
default until the Node Host reaches public API parity; deployments can opt in
with `ANOMALO_RUNTIME_IMPL=node`. The Python process can still be used as a
loopback Worker for Python-only tools, audio, vision, and Buddy capabilities,
without deleting v2 tables.

## Consequences

- Existing REST, NDJSON, WebSocket, and frontend event behavior remains the
  compatibility boundary.
- Python and TypeScript can validate the same fixture payloads before either
  runtime is switched in production.
- The opt-in Node path owns HTTP, WebSocket, Agent Run, and Session lifecycle;
  the Worker does not write the primary Session tables.
- Web, Browser, Python Worker, and Pi L1-L3 adapters are behind the Node
  `ToolRuntime` and `PluginHost` seams. Unavailable Worker capabilities degrade
  to structured `worker_unavailable` tool results.
- A failure in the Node path can be reverted by stopping new runs, preserving
  checkpoints, and switching the Host owner back to Python; v2 tables remain
  intact for that rollback.
