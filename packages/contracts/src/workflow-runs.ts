import { Type } from "@sinclair/typebox";

import { PresetModelRefSchema } from "./schemas.js";
import { WorkflowRefSchema } from "./workflows.js";

/** The two execution runtimes exposed by the unified Run Control. */
export const ExecutionRuntimeKindSchema = Type.Union([
  Type.Literal("preset_model"),
  Type.Literal("workflow"),
]);

export const ExecutionRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("stopping"),
  Type.Literal("stopped"),
]);

export const WorkflowNodeRunStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
  Type.Literal("stopped"),
]);

export const StopReasonSchema = Type.Union([
  Type.Literal("user_stop"),
  Type.Literal("disconnect"),
  Type.Literal("timeout"),
  Type.Literal("fail_fast"),
  Type.Literal("host_shutdown"),
]);

export const ExecutionTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal("preset_model"), ref: PresetModelRefSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("workflow"), ref: WorkflowRefSchema }, { additionalProperties: false }),
], { $id: "https://anomaloharis.dev/schemas/execution-target.schema.json" });

export const WorkflowRunRequestSchema = Type.Object(
  {
    input: Type.Unknown(),
    idempotency_key: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    metadata: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown())),
  },
  { additionalProperties: false, $id: "https://anomaloharis.dev/schemas/workflow-run-request.schema.json" },
);

/**
 * Runtime events are deliberately separate from the legacy AgentEvent contract.
 * Agent events are retained under an `agent.*` type and can therefore be replayed
 * without changing the existing chat/WebSocket contract.
 */
export const ExecutionRunEventSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    run_id: Type.String({ minLength: 1 }),
    parent_run_id: Type.Optional(Type.String({ minLength: 1 })),
    runtime_kind: ExecutionRuntimeKindSchema,
    target_ref: Type.String({ minLength: 1 }),
    sequence: Type.Integer({ minimum: 1 }),
    timestamp: Type.String({ minLength: 1 }),
    type: Type.String({ pattern: "^[a-z][a-z0-9_.-]+$", minLength: 1 }),
    data: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false, $id: "https://anomaloharis.dev/schemas/execution-run-event.schema.json" },
);

export const ExecutionRunSchema = Type.Object(
  {
    run_id: Type.String({ minLength: 1 }),
    parent_run_id: Type.Optional(Type.String({ minLength: 1 })),
    runtime_kind: ExecutionRuntimeKindSchema,
    target_ref: Type.String({ minLength: 1 }),
    target_hash: Type.String({ minLength: 1 }),
    runtime_adapter_version: Type.String({ minLength: 1 }),
    runtime_adapter_hash: Type.String({ minLength: 1 }),
    client_id: Type.String({ minLength: 1 }),
    status: ExecutionRunStatusSchema,
    input: Type.Unknown(),
    output: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    idempotency_key: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    created_at: Type.String({ minLength: 1 }),
    started_at: Type.Optional(Type.String({ minLength: 1 })),
    finished_at: Type.Optional(Type.String({ minLength: 1 })),
    stopped_at: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false, $id: "https://anomaloharis.dev/schemas/execution-run.schema.json" },
);

export const WorkflowNodeRunSchema = Type.Object(
  {
    node_run_id: Type.String({ minLength: 1 }),
    workflow_run_id: Type.String({ minLength: 1 }),
    node_id: Type.String({ minLength: 1 }),
    attempt: Type.Integer({ minimum: 1 }),
    status: WorkflowNodeRunStatusSchema,
    input: Type.Optional(Type.Unknown()),
    output: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    child_run_id: Type.Optional(Type.String({ minLength: 1 })),
    started_at: Type.Optional(Type.String({ minLength: 1 })),
    finished_at: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false, $id: "https://anomaloharis.dev/schemas/workflow-node-run.schema.json" },
);

export type ExecutionRuntimeKind = import("@sinclair/typebox").Static<typeof ExecutionRuntimeKindSchema>;
export type ExecutionRunStatus = import("@sinclair/typebox").Static<typeof ExecutionRunStatusSchema>;
export type WorkflowNodeRunStatus = import("@sinclair/typebox").Static<typeof WorkflowNodeRunStatusSchema>;
export type StopReason = import("@sinclair/typebox").Static<typeof StopReasonSchema>;
export type ExecutionTarget = import("@sinclair/typebox").Static<typeof ExecutionTargetSchema>;
export type WorkflowRunRequest = import("@sinclair/typebox").Static<typeof WorkflowRunRequestSchema>;
export type ExecutionRunEvent = import("@sinclair/typebox").Static<typeof ExecutionRunEventSchema>;
export type ExecutionRun = import("@sinclair/typebox").Static<typeof ExecutionRunSchema>;
export type WorkflowNodeRun = import("@sinclair/typebox").Static<typeof WorkflowNodeRunSchema>;
