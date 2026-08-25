# ADR-0002: Node-only Host and versioned Preset Model compute center

- Status: Accepted
- Date: 2026-08-22
- Decision owners: AnomaloHaris runtime maintainers
- Supersedes: ADR-0001 as the final target architecture
- Extended by: ADR-0004 for peer Agent/Workflow runtimes behind one Run Control

## Context

ADR-0001 introduced a phased Node Host while retaining a Python Worker for
Python-specific capabilities. The implementation proved that a partial Node
cutover is not sufficient: the current Node Host can start and call a Provider,
but it does not yet provide the complete Python API surface, the frontend event
shape is not equivalent, and a real DeepSeek tool call can be emitted as DSML
text without being executed.

AnomaloHaris is also becoming the shared local AI compute service for other Agent
applications. Those callers need a stable product identity that hides prompts,
plugins, Provider selection, credentials, and tool-loop implementation.

## Decision

1. The final AnomaloHaris backend is Node.js/TypeScript only. Python may remain
   during migration as a behavior reference, but no Python Host or Worker is a
   component of the final production runtime.
2. The externally invocable product unit is a **Preset Model**: an immutable
   combination of prompt, fixed versioned plugins, Provider Model, and runtime
   policy.
3. A Preset Model is uniquely addressed by a lowercase name and a monotonic
   integer version, serialized as `name@version`.
4. The default AnomaloHaris Agent is itself a built-in Preset Model, initially
   `anomaloharis@1`. Legacy `/api/chat`, streaming, and WebSocket routes remain useful
   convenience interfaces and resolve new Sessions to the configured explicit
   default Model Ref; they do not own a separate runtime.
5. Published versions are immutable. Any prompt, plugin, Provider, or policy
   change creates a new version.
6. AnomaloHaris exposes both OpenAI-compatible compute endpoints and native rich
   Run/Event endpoints. All entry points use one RunService and AgentCore.
7. Provider-specific streaming and tool-call formats, including OpenAI
   structured calls and DSML-encoded calls, are normalized inside a
   ProviderGateway before AgentCore sees them.
8. Node becomes the only runtime only after a machine-readable parity manifest,
   real Provider tool-call tests, frontend E2E, data migration, and hardware
   gates pass. A healthy process or listed tools are not sufficient evidence.

The implementation specification is
`docs/design/node-preset-model-compute-center.md`.

## Consequences

- The previous Python Worker boundary is transitional and must be removed.
- Existing preset agents migrate to Preset Model version 1.
- Existing dynamic Skill and MCP combinations migrate into fixed plugin
  bindings on new Preset Model versions.
- Other local Agent services can centralize Provider credentials, usage, cost,
  plugins, and model compatibility in AnomaloHaris.
- Production rollback eventually becomes Node-to-Node image and database
  rollback instead of switching back to the Python Host.
- The migration is longer than a partial Host rewrite because every existing
  API and hardware capability must have a real Node implementation or an
  explicitly approved removal.
