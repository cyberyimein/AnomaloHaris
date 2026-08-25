# ADR-0004: Peer Agent and Workflow runtimes behind one Run Control

- Status: Accepted
- Date: 2026-08-25
- Decision owners: AnomaloHaris runtime maintainers
- Extends: ADR-0002
- Implementation specification: `docs/design/workflow-runtime-development-design.md`

## Context

ADR-0002 establishes Preset Model as an immutable callable resource and requires all Agent entry points to use one RunService and AgentCore. AnomaloHaris now also needs versioned, importable Workflows that can orchestrate Preset Models and explicitly workflow-callable plugin operations.

Two initially plausible structures create different problems.

Treating Workflow as a normal PluginHost plugin would force a tool-and-hook Interface to absorb Registry persistence, compilation, DAG scheduling, top-level Run lifecycle, management routes, UI integration, cancellation, recovery, usage, and audit. That would make the PluginHost Interface shallow and give one plugin exceptional Host privileges.

Building a completely independent Workflow core would duplicate run identity, authorization, idempotency, event transport, cancellation, usage, audit, and recovery. Agent and Workflow behaviour would then drift even though a Workflow Run must create and control child Agent Runs.

## Decision

1. Preset Model and Workflow are peer callable resources. Both use immutable exact `name@version` references.
2. AgentCore and WorkflowRunner are peer execution Modules.
3. Agent and Workflow execution share one deep **Run Control** Module. Run Control owns run identity, caller authorization, target allowlists, idempotency, top-level event sequence and replay, cancellation, global concurrency and budget, usage aggregation, terminal state, and audit indexing.
4. Agent Runtime Adapter and Workflow Runtime Adapter register at the Run Control Seam. A Runtime Adapter is trusted built-in code with a fixed version and package hash; it is not a normal PluginHost tool plugin.
5. Workflow Runtime owns Workflow Registry, validation, compilation, DAG scheduling, Workflow Run details, Node Runs, dependency locks, and capability export.
6. WorkflowRunner invokes Preset Models only through the one-way AgentExecution Interface. The production AgentExecution Adapter uses Run Control to create and control child Agent Runs.
7. AgentCore must not import or depend on Workflow Runtime, Workflow Definition, Node Run, or DAG types.
8. PluginHost continues to own ordinary tools, hooks, and explicitly `workflow_callable` plugin operations. Runtime Adapter and PluginHost remain separate Seams.
9. Host remains the only owner of transport, authentication projection, HTTP routing, error envelopes, and frontend shells. Runtime Adapters cannot register arbitrary Fastify routes or inject arbitrary frontend code.
10. Existing Agent RunService behaviour is preserved through an Agent Runtime Adapter while its shared responsibilities are deepened into Run Control. A separate WorkflowRunService with duplicated top-level run semantics is forbidden.

The required dependency direction is:

```text
Run Control
  ├── Agent Runtime Adapter → AgentCore
  └── Workflow Runtime Adapter → WorkflowRunner
                                  ├── AgentExecution Interface → child Agent Run
                                  └── PluginOperation Adapter → PluginHost

AgentCore ✗→ Workflow Runtime
```

## Consequences

- Callers get consistent run identity, idempotency, events, stop, usage, and audit for Agent and Workflow targets.
- WorkflowRunner gains Leverage from AgentCore without knowing Provider, prompt, tool-loop, or Session Implementation details.
- AgentCore remains independently testable and cannot acquire a reverse dependency on orchestration.
- Workflow Runtime can be disabled, version-locked, replaced, or tested through its Runtime Adapter while Agent Runtime continues to function.
- PluginHost does not gain database, route, UI, or top-level execution responsibilities.
- Implementing Workflow requires a deliberate Run Control deepening slice before real DAG execution. Merely adding Workflow-specific tables and routes beside the current RunService is not sufficient.
- Workflow-specific state remains local to Workflow Runtime, while shared run state remains local to Run Control.

## Rejected alternatives

### Workflow as a normal PluginHost plugin

Rejected because the required Interface would be much broader than tool registration and lifecycle hooks. The plugin would either become privileged enough to bypass Host invariants or require pass-through methods for every Workflow operation, reducing Depth and Locality.

### Fully independent Agent and Workflow cores

Rejected because it duplicates shared run behaviour and creates two meanings for identity, cancellation, event ordering, usage, and audit.

### Workflow embedded inside AgentCore

Rejected because DAG scheduling, import validation, and Node Run persistence are not Agent loop responsibilities. Embedding them would couple Agent execution to orchestration and prevent AgentCore from remaining a small deep Module.
