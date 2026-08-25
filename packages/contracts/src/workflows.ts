import { Type } from "@sinclair/typebox";

const JsonSchemaValueSchema = Type.Record(Type.String(), Type.Unknown());

export const WorkflowApiVersionSchema = Type.Literal("anomaloharis.dev/workflow/v1");
export const WorkflowCapabilityApiVersionSchema = Type.Literal("anomaloharis.dev/workflow-capabilities/v1");

export const WorkflowRefSchema = Type.String({
  pattern: "^[a-z][a-z0-9-]{0,63}@[1-9][0-9]{0,8}$",
  minLength: 3,
});

export const WorkflowNameSchema = Type.String({
  pattern: "^[a-z][a-z0-9-]{0,63}$",
  minLength: 1,
});

export const WorkflowNodeTypeSchema = Type.Union([
  Type.Literal("input"),
  Type.Literal("output"),
  Type.Literal("preset_model"),
  Type.Literal("condition"),
  Type.Literal("parallel"),
  Type.Literal("join"),
  Type.Literal("plugin_operation"),
]);

export const WorkflowNodeSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", minLength: 1 }),
    type: WorkflowNodeTypeSchema,
    type_version: Type.Integer({ minimum: 1, maximum: 100 }),
    config: JsonSchemaValueSchema,
    retry: Type.Optional(Type.Object({
      max_attempts: Type.Integer({ minimum: 1, maximum: 10 }),
      backoff_ms: Type.Integer({ minimum: 0, maximum: 60_000 }),
    }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

export const WorkflowEndpointSchema = Type.Object({
  node: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", minLength: 1 }),
  port: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", minLength: 1 }),
}, { additionalProperties: false });

export const WorkflowEdgeSchema = Type.Object({
  from: WorkflowEndpointSchema,
  to: WorkflowEndpointSchema,
}, { additionalProperties: false });

export const WorkflowPolicySchema = Type.Object({
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
  max_parallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
  failure_mode: Type.Optional(Type.Literal("fail_fast")),
}, { additionalProperties: false });

export const WorkflowDefinitionSchema = Type.Object(
  {
    api_version: WorkflowApiVersionSchema,
    kind: Type.Literal("Workflow"),
    metadata: Type.Object({
      name: WorkflowNameSchema,
      version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      description: Type.String({ maxLength: 4_000 }),
      labels: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.String({ maxLength: 512 }))),
    }, { additionalProperties: false }),
    spec: Type.Object({
      input_schema: JsonSchemaValueSchema,
      output_schema: JsonSchemaValueSchema,
      nodes: Type.Array(WorkflowNodeSchema, { minItems: 1, maxItems: 100 }),
      edges: Type.Array(WorkflowEdgeSchema, { maxItems: 400 }),
      policy: Type.Optional(WorkflowPolicySchema),
    }, { additionalProperties: false }),
    compatibility: Type.Optional(Type.Object({
      authored_against_manifest_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    }, { additionalProperties: false })),
  },
  { additionalProperties: false, $id: "https://anomaloharis.dev/schemas/workflow-definition.schema.json" },
);

export const WorkflowPortSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$", minLength: 1 }),
  schema: JsonSchemaValueSchema,
  cardinality: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("many")])),
}, { additionalProperties: false });

export const WorkflowNodeTypeCapabilitySchema = Type.Object({
  type: WorkflowNodeTypeSchema,
  type_version: Type.Integer({ minimum: 1 }),
  description: Type.String({ maxLength: 4_000 }),
  config_schema: JsonSchemaValueSchema,
  inputs: Type.Array(WorkflowPortSchema),
  outputs: Type.Array(WorkflowPortSchema),
}, { additionalProperties: false });

export const WorkflowPresetModelCapabilitySchema = Type.Object({
  ref: WorkflowRefSchema,
  description: Type.String({ maxLength: 4_000 }),
  compiled_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  plugin_lock_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
}, { additionalProperties: false });

export const WorkflowPluginOperationCapabilitySchema = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9._-]{0,127}$", minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
  plugin_id: Type.String({ pattern: "^[a-z][a-z0-9._-]{0,63}$", minLength: 1 }),
  plugin_version: Type.String({ minLength: 1 }),
  package_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  description: Type.String({ maxLength: 4_000 }),
  input_schema: JsonSchemaValueSchema,
  output_schema: JsonSchemaValueSchema,
  permissions: Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 }),
  timeout_ms: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
  idempotency: Type.Union([
    Type.Literal("required"),
    Type.Literal("supported"),
    Type.Literal("none"),
  ]),
}, { additionalProperties: false });

export const WorkflowCapabilityManifestSchema = Type.Object(
  {
    api_version: WorkflowCapabilityApiVersionSchema,
    engine: Type.Object({
      runtime_id: Type.Literal("workflow-runtime"),
      runtime_version: Type.String({ minLength: 1 }),
      adapter_version: Type.String({ minLength: 1 }),
      package_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
      definition_api_version: WorkflowApiVersionSchema,
    }, { additionalProperties: false }),
    limits: Type.Object({
      graph: Type.Literal("dag"),
      max_nodes: Type.Integer({ minimum: 1 }),
      max_edges: Type.Integer({ minimum: 0 }),
      max_parallelism: Type.Integer({ minimum: 1 }),
      max_duration_seconds: Type.Integer({ minimum: 1 }),
    }, { additionalProperties: false }),
    node_types: Type.Array(WorkflowNodeTypeCapabilitySchema),
    preset_models: Type.Array(WorkflowPresetModelCapabilitySchema),
    plugin_operations: Type.Array(WorkflowPluginOperationCapabilitySchema),
    unsupported_features: Type.Array(Type.String({ minLength: 1 })),
    generated_at: Type.String({ minLength: 1 }),
    manifest_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  },
  { additionalProperties: false, $id: "https://anomaloharis.dev/schemas/workflow-capability-manifest.schema.json" },
);

export const WorkflowValidationErrorCodeSchema = Type.Union([
  Type.Literal("WORKFLOW_INVALID_JSON"),
  Type.Literal("WORKFLOW_SCHEMA_INVALID"),
  Type.Literal("WORKFLOW_REF_INVALID"),
  Type.Literal("WORKFLOW_NODE_ID_DUPLICATE"),
  Type.Literal("WORKFLOW_ENTRY_INVALID"),
  Type.Literal("WORKFLOW_OUTPUT_INVALID"),
  Type.Literal("WORKFLOW_NODE_UNREACHABLE"),
  Type.Literal("WORKFLOW_CYCLE_FORBIDDEN"),
  Type.Literal("WORKFLOW_PORT_NOT_FOUND"),
  Type.Literal("WORKFLOW_PORT_MULTIPLE_INPUTS"),
  Type.Literal("WORKFLOW_SCHEMA_INCOMPATIBLE"),
  Type.Literal("WORKFLOW_NODE_TYPE_UNSUPPORTED"),
  Type.Literal("WORKFLOW_NODE_CONFIG_INVALID"),
  Type.Literal("WORKFLOW_PRESET_MODEL_NOT_FOUND"),
  Type.Literal("WORKFLOW_PLUGIN_OPERATION_NOT_FOUND"),
  Type.Literal("WORKFLOW_PLUGIN_OPERATION_FORBIDDEN"),
  Type.Literal("WORKFLOW_LIMIT_EXCEEDED"),
  Type.Literal("WORKFLOW_PERMISSION_DENIED"),
  Type.Literal("WORKFLOW_MANIFEST_OUTDATED"),
]);

export const WorkflowValidationIssueSchema = Type.Object({
  code: WorkflowValidationErrorCodeSchema,
  path: Type.String({ pattern: "^(?:|(?:/[^~]*(?:~[01][^~]*)*)*)$" }),
  node_id: Type.Optional(Type.String({ minLength: 1 })),
  message: Type.String({ maxLength: 4_000 }),
}, { additionalProperties: false });

export const WorkflowResolvedDependencySchema = Type.Object({
  node_id: Type.String({ minLength: 1 }),
  dependency_kind: Type.Union([Type.Literal("preset_model"), Type.Literal("plugin_operation")]),
  dependency_ref: Type.String({ minLength: 1 }),
  dependency_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
}, { additionalProperties: false });

export const WorkflowValidationReportSchema = Type.Object(
  {
    valid: Type.Boolean(),
    errors: Type.Array(WorkflowValidationIssueSchema),
    warnings: Type.Array(WorkflowValidationIssueSchema),
    resolved_dependencies: Type.Array(WorkflowResolvedDependencySchema),
    definition_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    capability_manifest_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    compiled_hash: Type.Union([Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const WorkflowSummarySchema = Type.Object({
  ref: WorkflowRefSchema,
  name: WorkflowNameSchema,
  version: Type.Integer({ minimum: 1 }),
  description: Type.String({ maxLength: 4_000 }),
  status: Type.Union([Type.Literal("draft"), Type.Literal("published"), Type.Literal("retired")]),
  definition_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  compiled_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  capability_manifest_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  created_at: Type.String({ minLength: 1 }),
  updated_at: Type.String({ minLength: 1 }),
  published_at: Type.Optional(Type.String({ minLength: 1 })),
  retired_at: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export const WorkflowImportResultSchema = Type.Object({
  workflow: WorkflowSummarySchema,
  validation: WorkflowValidationReportSchema,
  idempotent: Type.Boolean(),
}, { additionalProperties: false, $id: "https://anomaloharis.dev/schemas/workflow-import-result.schema.json" });

export type JsonSchema = Record<string, unknown>;
export type WorkflowDefinition = import("@sinclair/typebox").Static<typeof WorkflowDefinitionSchema>;
export type WorkflowNode = import("@sinclair/typebox").Static<typeof WorkflowNodeSchema>;
export type WorkflowEdge = import("@sinclair/typebox").Static<typeof WorkflowEdgeSchema>;
export type WorkflowName = import("@sinclair/typebox").Static<typeof WorkflowNameSchema>;
export type WorkflowRef = import("@sinclair/typebox").Static<typeof WorkflowRefSchema>;
export type WorkflowNodeType = import("@sinclair/typebox").Static<typeof WorkflowNodeTypeSchema>;
export type WorkflowNodeTypeCapability = import("@sinclair/typebox").Static<typeof WorkflowNodeTypeCapabilitySchema>;
export type WorkflowCapabilityManifest = import("@sinclair/typebox").Static<typeof WorkflowCapabilityManifestSchema>;
export type WorkflowPresetModelCapability = import("@sinclair/typebox").Static<typeof WorkflowPresetModelCapabilitySchema>;
export type WorkflowPluginOperationCapability = import("@sinclair/typebox").Static<typeof WorkflowPluginOperationCapabilitySchema>;
export type WorkflowValidationErrorCode = import("@sinclair/typebox").Static<typeof WorkflowValidationErrorCodeSchema>;
export type WorkflowValidationIssue = import("@sinclair/typebox").Static<typeof WorkflowValidationIssueSchema>;
export type WorkflowResolvedDependency = import("@sinclair/typebox").Static<typeof WorkflowResolvedDependencySchema>;
export type WorkflowValidationReport = import("@sinclair/typebox").Static<typeof WorkflowValidationReportSchema>;
export type WorkflowSummary = import("@sinclair/typebox").Static<typeof WorkflowSummarySchema>;
export type WorkflowImportResult = import("@sinclair/typebox").Static<typeof WorkflowImportResultSchema>;

export function canonicalWorkflowJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflowJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalWorkflowJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalizeWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    ...structuredClone(definition),
    metadata: {
      ...definition.metadata,
      ...(definition.metadata.labels ? { labels: { ...definition.metadata.labels } } : {}),
    },
    spec: {
      ...definition.spec,
      nodes: [...definition.spec.nodes]
        .map((node) => structuredClone(node))
        .sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...definition.spec.edges]
        .map((edge) => structuredClone(edge))
        .sort((left, right) => edgeSortKey(left).localeCompare(edgeSortKey(right))),
    },
  };
}

export function workflowRefOf(definition: Pick<WorkflowDefinition, "metadata">): WorkflowRef {
  return `${definition.metadata.name}@${definition.metadata.version}` as WorkflowRef;
}

function edgeSortKey(edge: WorkflowEdge): string {
  return `${edge.from.node}:${edge.from.port}->${edge.to.node}:${edge.to.port}`;
}
