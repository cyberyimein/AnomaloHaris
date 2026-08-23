# ADR-0001: Node.js Host with a Python Worker boundary

- Status: Superseded as the final target by ADR-0002; retained as migration history
- Date: 2026-08-22
- Decision owners: AnomaloHaris runtime maintainers

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

This ADR is historical. The completed target is the Node-only Host described by
ADR-0002 and `docs/design/node-preset-model-compute-center.md`; there is no
runtime switch and no Node-to-Python Worker fallback in the production path.
Python-specific, Buddy, audio, and vision behavior may remain as migration
fixtures or separately deployed services, but it is not part of the Node Host
process tree.

## Consequences

- Existing REST, NDJSON, WebSocket, and frontend event behavior remains the
  compatibility boundary.
- Python and TypeScript can validate the same fixture payloads before either
  runtime is switched in production.
- The Node Host owns HTTP, WebSocket, Agent Run, and Session lifecycle.
- Web, Browser, and Pi L1-L3 adapters are behind the Node `ToolRuntime` and
  `PluginHost` seams. Buddy/audio/vision are optional plugin boundaries, not
  built-in Host capabilities.
- Rollback is to a previous Node image with a compatible database backup; the
  removed Python launcher is not a production fallback.
