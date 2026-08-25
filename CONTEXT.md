# AnomaloHaris Domain Context

## Product identity

- **AnomaloHaris** is the product and the Node.js/TypeScript local AI compute center.
- **`anomaloharis`** is the only canonical machine-readable product namespace after the Stage 0 naming migration.
- **`@anomaloharis/*`** is the canonical npm scope.
- **`anomaloharis@1`** is the immutable reference of the built-in default Preset Model after Stage 0.
- **`anomalo`**, **`@anomalo/*`**, **`anomalo.dev`**, **`ANOMALO_*`**, and **`X-Anomalo-*`** are legacy identifiers permitted only inside the centralized Stage 0 migration Adapter, migration fixtures, and historical documents. <!-- naming-compat -->

## Runtime concepts

- **Preset Model** — an immutable, published Agent capability combining prompt resources, fixed plugins, a Provider Model, and runtime policy.
- **Preset Model Ref** — the exact `<name>@<version>` identity of a Preset Model.
- **Agent Runtime** — the execution Module built around AgentCore for running an exact Preset Model Ref.
- **Workflow Runtime** — the executable Module that manages, validates, compiles, and runs workflows alongside AgentCore; it may be installed through a trusted built-in plugin Adapter.
- **Runtime Adapter** — a trusted Adapter that installs an execution Runtime at the Run Control Seam; it is not a normal tool plugin.
- **Run Control** — the single shared Module that owns run identity, authorization, idempotency, top-level events, cancellation, usage, and audit for Agent and Workflow execution.
- **AgentExecution Interface** — the one-way Interface through which WorkflowRunner creates and controls child Agent Runs without depending on AgentCore Implementation details.
- **Workflow Definition** — portable declarative JSON managed by the Workflow Runtime; it is data, not executable plugin code.
- **Workflow Ref** — the exact `<name>@<version>` identity of a published Workflow Definition.
- **Compiled Workflow** — an immutable execution snapshot with exact node, Preset Model, plugin-operation, and hash locks.
- **Workflow Capability Manifest** — a machine-readable description of the node types, Preset Models, workflow-callable plugin operations, and limits supported by one AnomaloHaris instance.
- **Workflow Run** — one execution of a published Workflow Ref with run-specific input data.
- **Node Run** — one node attempt within a Workflow Run.
