import { createHash } from "node:crypto";

import {
  canonicalWorkflowJson,
  type JsonSchema,
  type WorkflowCapabilityManifest,
  type WorkflowNodeType,
  type WorkflowNodeTypeCapability,
  type WorkflowPluginOperationCapability,
  type WorkflowPresetModelCapability,
} from "@anomaloharis/contracts";

export type WorkflowPresetModelSource = {
  listPublished(): readonly WorkflowPresetModelCapability[];
  resolve(ref: string): WorkflowPresetModelCapability | undefined;
};

export type WorkflowPluginOperationSource = {
  listWorkflowOperations(): readonly WorkflowPluginOperationCapability[];
  resolveWorkflowOperation(id: string, version: number): WorkflowPluginOperationCapability | undefined;
};

export type WorkflowCapabilityCatalogOptions = {
  presetModels?: WorkflowPresetModelSource;
  pluginOperations?: WorkflowPluginOperationSource;
  runtimeVersion?: string;
  adapterVersion?: string;
  packageHash?: string;
  maxParallelism?: number;
  now?: () => string;
};

const anySchema: JsonSchema = {};
const objectSchema: JsonSchema = { type: "object", additionalProperties: true };
const emptyConfigSchema: JsonSchema = { type: "object", additionalProperties: false };

const NODE_TYPES: readonly WorkflowNodeTypeCapability[] = [
  nodeType("input", "The single workflow input boundary.", emptyConfigSchema, [], [port("data")]),
  nodeType("output", "The single workflow output boundary.", emptyConfigSchema, [port("result")], []),
  nodeType(
    "preset_model",
    "Runs an exact published Preset Model through the Agent Runtime Adapter.",
    {
      type: "object",
      properties: {
        model_ref: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,63}@[1-9][0-9]{0,8}$" },
        input_mode: { const: "message" },
        session_mode: { const: "isolated" },
      },
      required: ["model_ref"],
      additionalProperties: false,
    },
    [port("input")],
    [port("output")],
  ),
  nodeType(
    "condition",
    "Selects a true or false branch using a restricted expression AST.",
    { type: "object", required: ["expression"], properties: { expression: objectSchema }, additionalProperties: false },
    [port("input")],
    [port("true"), port("false")],
  ),
  nodeType("parallel", "Explicitly fans out one value under the workflow parallelism limit.", emptyConfigSchema, [port("input")], [port("output")]),
  nodeType("join", "Joins all declared branch inputs in stable order.", emptyConfigSchema, [port("input", "many")], [port("output")]),
  nodeType(
    "plugin_operation",
    "Calls one exact workflow-callable Plugin Operation.",
    {
      type: "object",
      properties: {
        operation_id: { type: "string", minLength: 1 },
        operation_version: { type: "integer", minimum: 1 },
      },
      required: ["operation_id", "operation_version"],
      additionalProperties: false,
    },
    [port("input")],
    [port("output")],
  ),
];

export class WorkflowCapabilityCatalog {
  private readonly presetModels: WorkflowPresetModelSource;
  private readonly pluginOperations: WorkflowPluginOperationSource;
  private readonly runtimeVersion: string;
  private readonly adapterVersion: string;
  private readonly packageHash: string;
  private readonly maxParallelism: number;
  private readonly now: () => string;

  constructor(options: WorkflowCapabilityCatalogOptions = {}) {
    this.presetModels = options.presetModels ?? emptyPresetModelSource;
    this.pluginOperations = options.pluginOperations ?? emptyPluginOperationSource;
    this.runtimeVersion = options.runtimeVersion ?? "1.0.0";
    this.adapterVersion = options.adapterVersion ?? "1.0.0";
    this.packageHash = options.packageHash ?? sha256({ package: "@anomaloharis/workflow-runtime", version: this.runtimeVersion });
    this.maxParallelism = positiveInteger(options.maxParallelism, 8);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  nodeTypes(): readonly WorkflowNodeTypeCapability[] {
    return NODE_TYPES.map((item) => structuredClone(item));
  }

  nodeType(type: WorkflowNodeType, version: number): WorkflowNodeTypeCapability | undefined {
    const item = NODE_TYPES.find((candidate) => candidate.type === type && candidate.type_version === version);
    return item ? structuredClone(item) : undefined;
  }

  presetModel(ref: string): WorkflowPresetModelCapability | undefined {
    const item = this.presetModels.resolve(ref);
    return item ? structuredClone(item) : undefined;
  }

  pluginOperation(id: string, version: number): WorkflowPluginOperationCapability | undefined {
    const item = this.pluginOperations.resolveWorkflowOperation(id, version);
    return item ? structuredClone(item) : undefined;
  }

  manifest(): WorkflowCapabilityManifest {
    const nodeTypes = [...this.nodeTypes()].sort((left, right) => `${left.type}:${left.type_version}`.localeCompare(`${right.type}:${right.type_version}`));
    const presetModels = [...this.presetModels.listPublished()]
      .map((item) => structuredClone(item))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const pluginOperations = [...this.pluginOperations.listWorkflowOperations()]
      .map((item) => structuredClone(item))
      .sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`));
    const body = {
      api_version: "anomaloharis.dev/workflow-capabilities/v1" as const,
      engine: {
        runtime_id: "workflow-runtime" as const,
        runtime_version: this.runtimeVersion,
        adapter_version: this.adapterVersion,
        package_hash: this.packageHash,
        definition_api_version: "anomaloharis.dev/workflow/v1" as const,
      },
      limits: { graph: "dag" as const, max_nodes: 100, max_edges: 400, max_parallelism: this.maxParallelism, max_duration_seconds: 3_600 },
      node_types: nodeTypes,
      preset_models: presetModels,
      plugin_operations: pluginOperations,
      unsupported_features: ["approval", "loop", "subworkflow", "wait"],
    };
    return {
      ...body,
      generated_at: this.now(),
      manifest_hash: sha256(body),
    };
  }
}

function nodeType(
  type: WorkflowNodeType,
  description: string,
  configSchema: JsonSchema,
  inputs: WorkflowNodeTypeCapability["inputs"],
  outputs: WorkflowNodeTypeCapability["outputs"],
): WorkflowNodeTypeCapability {
  return { type, type_version: 1, description, config_schema: configSchema, inputs, outputs };
}

function port(name: string, cardinality: "single" | "many" = "single") {
  return { name, schema: structuredClone(anySchema), cardinality } as const;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkflowJson(value)).digest("hex")}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const emptyPresetModelSource: WorkflowPresetModelSource = {
  listPublished: () => [],
  resolve: () => undefined,
};

const emptyPluginOperationSource: WorkflowPluginOperationSource = {
  listWorkflowOperations: () => [],
  resolveWorkflowOperation: () => undefined,
};
