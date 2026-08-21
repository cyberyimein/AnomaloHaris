# ADR-0001: Node.js Host with a Python Worker boundary

- Status: Accepted for phased implementation
- Date: 2026-08-22
- Decision owners: Anomalo runtime maintainers
- Related design: [Pi-inspired Node runtime](../design/pi-inspired-node-runtime.md)

## Context

The current FastAPI process owns HTTP, WebSocket, session persistence, model
orchestration, tool dispatch, and Python-specific capabilities. That makes the
agent loop difficult to test independently and makes a future Node.js Host
migration risky unless the existing event, stop/resume, and structured-output
behavior is frozen first.

## Decision

Implement the migration in independently revertible slices:

1. Freeze the current behavior with JSON Schema fixtures and replayable tests.
2. Deepen the Python implementation behind `ContextBuilder`, `RunController`,
   and `AgentCore`, while keeping `AgentRuntime` as the compatibility facade.
3. Add an npm workspace and a single `@anomalo/contracts` source for the
   cross-process event, tool, and run-request contracts.

The Python Host remains the only production run owner during these phases.
Node code is fixture/replay-only until the later Node Host phases. No Session
schema migration, hardware change, or live dual execution is included here.

## Consequences

- Existing REST, NDJSON, WebSocket, and frontend event behavior remains the
  compatibility boundary.
- Python and TypeScript can validate the same fixture payloads before either
  runtime is switched in production.
- The new modules add explicit seams, but adapters and production traffic stay
  unchanged until their dedicated phases.
- A failure in a later phase can be reverted without reverting the frozen
  contract fixtures or changing persisted Session data.

