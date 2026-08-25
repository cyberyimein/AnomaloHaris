import { createHash } from "node:crypto";

import {
  canonicalWorkflowJson,
  canonicalizeWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRef,
} from "@anomaloharis/contracts";

export type WorkflowDependencyLock = {
  node_id: string;
  dependency_kind: "preset_model" | "plugin_operation";
  dependency_ref: string;
  dependency_hash: string;
};

export type CompiledWorkflowNode = Pick<WorkflowNode, "id" | "type" | "type_version" | "config"> & {
  retry: { max_attempts: number; backoff_ms: number };
};

export type CompiledWorkflow = {
  compiler_version: "1.0.0";
  ref: WorkflowRef;
  definition: WorkflowDefinition;
  definition_hash: string;
  capability_manifest_hash: string;
  topology_order: string[];
  nodes: CompiledWorkflowNode[];
  edges: WorkflowDefinition["spec"]["edges"];
  policy: {
    timeout_seconds: number;
    max_parallelism: number;
    failure_mode: "fail_fast";
  };
  dependency_locks: WorkflowDependencyLock[];
  compiled_hash: string;
};

export function compileWorkflow(input: {
  definition: WorkflowDefinition;
  capabilityManifestHash: string;
  topologyOrder: readonly string[];
  dependencyLocks: readonly WorkflowDependencyLock[];
}): CompiledWorkflow {
  const definition = canonicalizeWorkflowDefinition(input.definition);
  const definitionHash = hashJson(definition);
  const nodesById = new Map(definition.spec.nodes.map((node) => [node.id, node]));
  const nodes = input.topologyOrder.map((id) => {
    const node = nodesById.get(id);
    if (!node) throw new Error(`workflow_compile_node_missing:${id}`);
    return {
      id: node.id,
      type: node.type,
      type_version: node.type_version,
      config: structuredClone(node.config),
      retry: {
        max_attempts: node.retry?.max_attempts ?? 1,
        backoff_ms: node.retry?.backoff_ms ?? 0,
      },
    };
  });
  const body = {
    compiler_version: "1.0.0" as const,
    ref: `${definition.metadata.name}@${definition.metadata.version}`,
    definition_hash: definitionHash,
    capability_manifest_hash: input.capabilityManifestHash,
    topology_order: [...input.topologyOrder],
    nodes,
    edges: structuredClone(definition.spec.edges),
    policy: {
      timeout_seconds: definition.spec.policy?.timeout_seconds ?? 900,
      max_parallelism: definition.spec.policy?.max_parallelism ?? 4,
      failure_mode: definition.spec.policy?.failure_mode ?? "fail_fast" as const,
    },
    dependency_locks: [...input.dependencyLocks]
      .map((lock) => structuredClone(lock))
      .sort((left, right) => `${left.node_id}:${left.dependency_kind}:${left.dependency_ref}`.localeCompare(`${right.node_id}:${right.dependency_kind}:${right.dependency_ref}`)),
  };
  return {
    ...body,
    definition,
    compiled_hash: hashJson(body),
  };
}

export function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkflowJson(value)).digest("hex")}`;
}
