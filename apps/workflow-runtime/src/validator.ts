import Ajv, { type ErrorObject } from "ajv";

import {
  canonicalizeWorkflowDefinition,
  validateContract,
  type JsonSchema,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowValidationErrorCode,
  type WorkflowValidationIssue,
  type WorkflowValidationReport,
} from "@anomaloharis/contracts";

import { WorkflowCapabilityCatalog } from "./capability-catalog.js";
import { compileWorkflow, hashJson, type CompiledWorkflow, type WorkflowDependencyLock } from "./compiler.js";

const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_EXPRESSION_DEPTH = 8;
const MAX_EXPRESSION_NODES = 64;

const configAjv = new Ajv({ allErrors: true, strict: false });

export type WorkflowValidationResult = {
  definition?: WorkflowDefinition;
  report: WorkflowValidationReport;
  compiled?: CompiledWorkflow;
};

export class WorkflowValidator {
  constructor(
    private readonly catalog: WorkflowCapabilityCatalog,
    private readonly maxDefinitionBytes = MAX_DEFINITION_BYTES,
  ) {}

  validate(input: unknown): WorkflowValidationReport {
    return this.validateAndCompile(input).report;
  }

  validateAndCompile(input: unknown): WorkflowValidationResult {
    const parsed = parseDefinitionInput(input, this.maxDefinitionBytes);
    if (parsed.errorCode) {
      const report = baseReport(hashJson(parsed.hashValue), this.catalog.manifest().manifest_hash);
      report.errors.push(issue(parsed.errorCode ?? "WORKFLOW_INVALID_JSON", "", parsed.message));
      return finalize(report);
    }

    const schemaResult = validateContract("workflowDefinition", parsed.value);
    const definitionHash = hashJson(parsed.value);
    const manifest = this.catalog.manifest();
    const report = baseReport(definitionHash, manifest.manifest_hash);
    if (!schemaResult.valid) {
      report.errors.push(...schemaErrors(schemaResult.errors ?? [], parsed.value));
      return finalize(report);
    }

    const definition = canonicalizeWorkflowDefinition(parsed.value as WorkflowDefinition);
    report.definition_hash = hashJson(definition);
    this.validatePortableSchema(definition.spec.input_schema, "/spec/input_schema", report);
    this.validatePortableSchema(definition.spec.output_schema, "/spec/output_schema", report);
    this.validateLimits(definition, report);

    const nodesById = new Map<string, WorkflowNode>();
    const nodeIndexes = new Map<string, number>();
    definition.spec.nodes.forEach((node, index) => {
      if (nodesById.has(node.id)) {
        report.errors.push(issue("WORKFLOW_NODE_ID_DUPLICATE", `/spec/nodes/${index}/id`, `Node id ${node.id} is duplicated.`, node.id));
      } else {
        nodesById.set(node.id, node);
        nodeIndexes.set(node.id, index);
      }
    });

    const inputNodes = definition.spec.nodes.filter((node) => node.type === "input");
    const outputNodes = definition.spec.nodes.filter((node) => node.type === "output");
    if (inputNodes.length !== 1) report.errors.push(issue("WORKFLOW_ENTRY_INVALID", "/spec/nodes", "A workflow must contain exactly one input node."));
    if (outputNodes.length !== 1) report.errors.push(issue("WORKFLOW_OUTPUT_INVALID", "/spec/nodes", "A workflow must contain exactly one output node."));

    const nodeCapabilities = new Map<string, ReturnType<WorkflowCapabilityCatalog["nodeType"]>>();
    const dependencyLocks: WorkflowDependencyLock[] = [];
    for (const [index, node] of definition.spec.nodes.entries()) {
      const capability = this.catalog.nodeType(node.type, node.type_version);
      if (!capability) {
        report.errors.push(issue("WORKFLOW_NODE_TYPE_UNSUPPORTED", `/spec/nodes/${index}/type`, `Node type ${node.type}@${node.type_version} is not supported.`, node.id));
        continue;
      }
      nodeCapabilities.set(node.id, capability);
      this.validateNodeConfig(node, index, capability.config_schema, report);
      this.resolveNodeDependency(node, index, report, dependencyLocks);
    }

    const adjacency = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();
    const singleInputs = new Set<string>();
    for (const [index, edge] of definition.spec.edges.entries()) {
      const from = nodesById.get(edge.from.node);
      const to = nodesById.get(edge.to.node);
      const fromCapability = from ? nodeCapabilities.get(from.id) : undefined;
      const toCapability = to ? nodeCapabilities.get(to.id) : undefined;
      const fromPort = fromCapability?.outputs.find((port) => port.name === edge.from.port);
      const toPort = toCapability?.inputs.find((port) => port.name === edge.to.port);
      if (!from || !to || !fromPort || !toPort) {
        report.errors.push(issue("WORKFLOW_PORT_NOT_FOUND", `/spec/edges/${index}`, "The edge references a node or port that is not declared."));
        continue;
      }
      const inputKey = `${to.id}:${toPort.name}`;
      if (toPort.cardinality !== "many" && singleInputs.has(inputKey)) {
        report.errors.push(issue("WORKFLOW_PORT_MULTIPLE_INPUTS", `/spec/edges/${index}/to`, `Input port ${inputKey} has more than one incoming edge.`, to.id));
      }
      if (toPort.cardinality !== "many") singleInputs.add(inputKey);
      const sourceSchema = effectivePortSchema(definition, from, fromPort.name, fromPort.schema, "output");
      const targetSchema = effectivePortSchema(definition, to, toPort.name, toPort.schema, "input");
      if (!schemasAssignable(sourceSchema, targetSchema)) {
        report.errors.push(issue("WORKFLOW_SCHEMA_INCOMPATIBLE", `/spec/edges/${index}`, `Output ${edge.from.node}.${edge.from.port} is not assignable to ${edge.to.node}.${edge.to.port}.`, to.id));
      }
      adjacency.set(from.id, [...(adjacency.get(from.id) ?? []), to.id]);
      reverse.set(to.id, [...(reverse.get(to.id) ?? []), from.id]);
    }

    const topology = topologicalOrder([...nodesById.keys()], adjacency);
    if (!topology) {
      report.errors.push(issue("WORKFLOW_CYCLE_FORBIDDEN", "/spec/edges", "Workflow graphs must be acyclic."));
    }
    const root = inputNodes[0]?.id;
    const sink = outputNodes[0]?.id;
    if (root) {
      const reachable = walk(root, adjacency);
      for (const node of definition.spec.nodes) {
        if (!reachable.has(node.id)) report.errors.push(issue("WORKFLOW_NODE_UNREACHABLE", `/spec/nodes/${nodeIndexes.get(node.id) ?? 0}`, `Node ${node.id} is not reachable from the input node.`, node.id));
      }
    }
    if (sink) {
      const canReachOutput = walk(sink, reverse);
      for (const node of definition.spec.nodes) {
        if (!canReachOutput.has(node.id)) report.errors.push(issue("WORKFLOW_NODE_UNREACHABLE", `/spec/nodes/${nodeIndexes.get(node.id) ?? 0}`, `Node ${node.id} cannot reach the output node.`, node.id));
      }
    }

    const authoredManifestHash = definition.compatibility?.authored_against_manifest_hash;
    if (authoredManifestHash && authoredManifestHash !== manifest.manifest_hash) {
      report.warnings.push(issue("WORKFLOW_MANIFEST_OUTDATED", "/compatibility/authored_against_manifest_hash", "The authored capability manifest differs; exact dependencies are checked independently."));
    }
    report.resolved_dependencies = dependencyLocks.map((lock) => ({ ...lock }));
    if (report.errors.length > 0 || !topology) return finalize(report);
    const compiled = compileWorkflow({
      definition,
      capabilityManifestHash: manifest.manifest_hash,
      topologyOrder: topology,
      dependencyLocks,
    });
    report.compiled_hash = compiled.compiled_hash;
    return finalize(report, definition, compiled);
  }

  private validateLimits(definition: WorkflowDefinition, report: WorkflowValidationReport): void {
    const manifest = this.catalog.manifest();
    if (definition.spec.nodes.length > manifest.limits.max_nodes || definition.spec.edges.length > manifest.limits.max_edges) {
      report.errors.push(issue("WORKFLOW_LIMIT_EXCEEDED", "/spec", `Workflow graph exceeds the ${manifest.limits.max_nodes} node or ${manifest.limits.max_edges} edge limit.`));
    }
    const policy = definition.spec.policy;
    if (policy?.max_parallelism !== undefined && policy.max_parallelism > manifest.limits.max_parallelism) {
      report.errors.push(issue("WORKFLOW_LIMIT_EXCEEDED", "/spec/policy/max_parallelism", `max_parallelism cannot exceed ${manifest.limits.max_parallelism}.`));
    }
  }

  private validateNodeConfig(node: WorkflowNode, index: number, schema: JsonSchema, report: WorkflowValidationReport): void {
    if (!portableSchema(schema, MAX_SCHEMA_DEPTH)) {
      report.errors.push(issue("WORKFLOW_NODE_CONFIG_INVALID", `/spec/nodes/${index}/config`, "Node config schema is not portable or exceeds the safety limits.", node.id));
      return;
    }
    try {
      const validate = configAjv.compile(schema);
      if (!validate(node.config)) report.errors.push(issue("WORKFLOW_NODE_CONFIG_INVALID", `/spec/nodes/${index}/config`, "Node config does not match the capability schema.", node.id));
    } catch {
      report.errors.push(issue("WORKFLOW_NODE_CONFIG_INVALID", `/spec/nodes/${index}/config`, "Node config schema could not be compiled.", node.id));
    }
    if (node.type === "condition" && !validateExpression((node.config as Record<string, unknown>).expression)) {
      report.errors.push(issue("WORKFLOW_NODE_CONFIG_INVALID", `/spec/nodes/${index}/config/expression`, "Condition expression must use the restricted workflow expression AST.", node.id));
    }
  }

  private resolveNodeDependency(node: WorkflowNode, index: number, report: WorkflowValidationReport, locks: WorkflowDependencyLock[]): void {
    const config = node.config as Record<string, unknown>;
    if (node.type === "preset_model") {
      const ref = typeof config.model_ref === "string" ? config.model_ref : "";
      const model = ref ? this.catalog.presetModel(ref) : undefined;
      if (!model) {
        report.errors.push(issue("WORKFLOW_PRESET_MODEL_NOT_FOUND", `/spec/nodes/${index}/config/model_ref`, `Preset Model ${ref || "<missing>"} is not published.`, node.id));
      } else {
        locks.push({ node_id: node.id, dependency_kind: "preset_model", dependency_ref: model.ref, dependency_hash: model.compiled_hash });
      }
    }
    if (node.type === "plugin_operation") {
      const id = typeof config.operation_id === "string" ? config.operation_id : "";
      const version = typeof config.operation_version === "number" ? config.operation_version : 0;
      const operation = id && version > 0 ? this.catalog.pluginOperation(id, version) : undefined;
      if (!operation) {
        report.errors.push(issue("WORKFLOW_PLUGIN_OPERATION_NOT_FOUND", `/spec/nodes/${index}/config/operation_id`, `Workflow-callable Plugin Operation ${id || "<missing>"}@${version || "<missing>"} is unavailable.`, node.id));
      } else {
        locks.push({ node_id: node.id, dependency_kind: "plugin_operation", dependency_ref: `${operation.id}@${operation.version}`, dependency_hash: operation.package_hash });
      }
    }
  }

  private validatePortableSchema(schema: JsonSchema, path: string, report: WorkflowValidationReport): void {
    if (!portableSchema(schema, MAX_SCHEMA_DEPTH)) report.errors.push(issue("WORKFLOW_SCHEMA_INVALID", path, "JSON Schema must be local, bounded, and free of unsafe keys."));
  }
}

function parseDefinitionInput(input: unknown, maxBytes: number): { value?: unknown; hashValue: unknown; errorCode?: WorkflowValidationErrorCode; message: string } {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > maxBytes) return { hashValue: input, errorCode: "WORKFLOW_LIMIT_EXCEEDED", message: "Workflow Definition exceeds the 1 MiB limit." };
    try {
      return { value: JSON.parse(input), hashValue: input, message: "" };
    } catch {
      return { hashValue: input, errorCode: "WORKFLOW_INVALID_JSON", message: "Workflow Definition is not valid JSON." };
    }
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { hashValue: null, errorCode: "WORKFLOW_INVALID_JSON", message: "Workflow Definition cannot be serialized as JSON." };
  }
  if (typeof serialized !== "string") return { hashValue: null, errorCode: "WORKFLOW_INVALID_JSON", message: "Workflow Definition cannot be serialized as JSON." };
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) return { hashValue: input, errorCode: "WORKFLOW_LIMIT_EXCEEDED", message: "Workflow Definition exceeds the 1 MiB limit." };
  return { value: input, hashValue: input, message: "" };
}

function schemaErrors(errors: ErrorObject[], value: unknown): WorkflowValidationIssue[] {
  return errors.map((error) => {
    const path = error.instancePath || "";
    const match = /^\/spec\/nodes\/(\d+)/.exec(path);
    const node = match && Array.isArray((value as { spec?: { nodes?: unknown[] } })?.spec?.nodes)
      ? ((value as { spec: { nodes: unknown[] } }).spec.nodes[Number(match[1])] as { id?: unknown } | undefined)
      : undefined;
    return issue("WORKFLOW_SCHEMA_INVALID", path, error.message ?? "Workflow Definition does not match the schema.", typeof node?.id === "string" ? node.id : undefined);
  });
}

function baseReport(definitionHash: string, manifestHash: string): WorkflowValidationReport {
  return {
    valid: false,
    errors: [],
    warnings: [],
    resolved_dependencies: [],
    definition_hash: definitionHash,
    capability_manifest_hash: manifestHash,
    compiled_hash: null,
  };
}

function finalize(report: WorkflowValidationReport, definition?: WorkflowDefinition, compiled?: CompiledWorkflow): WorkflowValidationResult {
  report.errors = sortIssues(report.errors);
  report.warnings = sortIssues(report.warnings);
  report.resolved_dependencies.sort((left, right) => `${left.node_id}:${left.dependency_kind}:${left.dependency_ref}`.localeCompare(`${right.node_id}:${right.dependency_kind}:${right.dependency_ref}`));
  report.valid = report.errors.length === 0;
  return { report, ...(definition ? { definition } : {}), ...(compiled ? { compiled } : {}) };
}

function issue(code: WorkflowValidationErrorCode, path: string, message: string, nodeId?: string): WorkflowValidationIssue {
  return { code, path, ...(nodeId ? { node_id: nodeId } : {}), message };
}

function sortIssues(issues: WorkflowValidationIssue[]): WorkflowValidationIssue[] {
  return [...issues].sort((left, right) => `${left.path}:${left.code}:${left.node_id ?? ""}`.localeCompare(`${right.path}:${right.code}:${right.node_id ?? ""}`));
}

function topologicalOrder(nodes: string[], adjacency: Map<string, string[]>): string[] | undefined {
  const indegree = new Map(nodes.map((node) => [node, 0]));
  for (const [from, targets] of adjacency) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
    if (!indegree.has(from)) indegree.set(from, 0);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([node]) => node).sort();
  const order: string[] = [];
  while (ready.length) {
    const current = ready.shift()!;
    order.push(current);
    for (const target of [...(adjacency.get(current) ?? [])].sort()) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  return order.length === indegree.size ? order : undefined;
}

function walk(start: string, adjacency: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []).filter((node) => !visited.has(node)));
  }
  return visited;
}

function effectivePortSchema(definition: WorkflowDefinition, node: WorkflowNode, port: string, schema: JsonSchema, direction: "input" | "output"): JsonSchema {
  if (node.type === "input" && direction === "output" && port === "data") return definition.spec.input_schema;
  if (node.type === "output" && direction === "input" && port === "result") return definition.spec.output_schema;
  return schema;
}

function schemasAssignable(source: JsonSchema, target: JsonSchema): boolean {
  if (Object.keys(target).length === 0 || Object.keys(source).length === 0) return true;
  const sourceType = schemaType(source);
  const targetType = schemaType(target);
  if (sourceType && targetType && sourceType !== targetType) return false;
  if (targetType === "object" && sourceType === "object") {
    const sourceProperties = (source.properties ?? {}) as Record<string, JsonSchema>;
    const targetProperties = (target.properties ?? {}) as Record<string, JsonSchema>;
    for (const required of (target.required ?? []) as string[]) {
      if (!sourceProperties[required]) return false;
    }
    for (const [key, targetProperty] of Object.entries(targetProperties)) {
      const sourceProperty = sourceProperties[key];
      if (sourceProperty && !schemasAssignable(sourceProperty, targetProperty)) return false;
    }
  }
  if (targetType === "array" && sourceType === "array" && source.items && target.items && typeof source.items === "object" && typeof target.items === "object") {
    return schemasAssignable(source.items as JsonSchema, target.items as JsonSchema);
  }
  return true;
}

function schemaType(schema: JsonSchema): string | undefined {
  return typeof schema.type === "string" ? schema.type : undefined;
}

function portableSchema(value: unknown, depth: number): value is JsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth < 0) return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) return false;
    if (key === "$ref" && typeof item === "string" && !item.startsWith("#")) return false;
    if (key === "format" && typeof item !== "string") return false;
    if (item && typeof item === "object") {
      if (Array.isArray(item)) {
        if (item.length > 100 || item.some((child) => child && typeof child === "object" && !portableSchema(child, depth - 1))) return false;
      } else if (!portableSchema(item, depth - 1)) return false;
    }
  }
  return true;
}

function validateExpression(value: unknown): boolean {
  let count = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    if (++count > MAX_EXPRESSION_NODES || depth > MAX_EXPRESSION_DEPTH || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    if (typeof record.path === "string") return Object.keys(record).every((key) => key === "path") && record.path.startsWith("$.");
    if (Object.prototype.hasOwnProperty.call(record, "literal")) return Object.keys(record).every((key) => key === "literal");
    const op = record.op;
    if (typeof op !== "string") return false;
    if (["exists"].includes(op)) return visit(record.value ?? record.left, depth + 1);
    if (["not"].includes(op)) return visit(record.value ?? record.left, depth + 1);
    if (["and", "or"].includes(op)) return Array.isArray(record.values) && record.values.length > 0 && record.values.every((item) => visit(item, depth + 1));
    if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(op)) return visit(record.left, depth + 1) && visit(record.right, depth + 1);
    return false;
  };
  return visit(value, 0);
}
