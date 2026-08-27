import Ajv2020 from "ajv/dist/2020.js";

import type { JsonSchema } from "@anomaloharis/contracts";

import type { CompiledWorkflow, CompiledWorkflowNode } from "./compiler.js";
import { executeConditionNode } from "./nodes/condition.js";
import { executeInputNode } from "./nodes/input.js";
import { executeJoinNode } from "./nodes/join.js";
import { executeOutputNode } from "./nodes/output.js";
import { executeParallelNode } from "./nodes/parallel.js";
import { WorkflowRunStore } from "./store.js";

export type WorkflowNodeExecutionContext = {
  runId: string;
  nodeId: string;
  attempt: number;
  signal: AbortSignal;
};

export type WorkflowNodeExecutionResult = {
  output: unknown;
  childRunId?: string;
  usage?: Record<string, unknown>;
};

export type WorkflowNodeExecutor = (
  node: CompiledWorkflowNode,
  input: unknown,
  context: WorkflowNodeExecutionContext,
) => Promise<WorkflowNodeExecutionResult>;

export class WorkflowNodeExecutionError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly retryable = false,
    readonly childRunId?: string,
  ) {
    super(message);
    this.name = "WorkflowNodeExecutionError";
  }
}

export type WorkflowRuntimeEvent = {
  type:
    | "workflow.run.started"
    | "workflow.node.started"
    | "workflow.node.succeeded"
    | "workflow.node.failed"
    | "workflow.node.skipped"
    | "workflow.run.succeeded"
    | "workflow.run.failed"
    | "workflow.run.stopped";
  data: Record<string, unknown>;
  terminal?: "succeeded" | "failed" | "stopped";
};

export type WorkflowRunnerOptions = {
  runId: string;
  compiled: CompiledWorkflow;
  input: unknown;
  signal: AbortSignal;
  store: WorkflowRunStore;
  executePresetModel?: WorkflowNodeExecutor;
  executePluginOperation?: WorkflowNodeExecutor;
  now?: () => string;
  acquireHostSlot?: (node: CompiledWorkflowNode, signal: AbortSignal) => Promise<() => void>;
};

type NodeState = "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped" | "stopped";
type NodeOutcome = { nodeId: string; status: "succeeded" | "failed" | "stopped"; output?: unknown; error?: Record<string, unknown>; usage?: Record<string, unknown>; childRunId?: string };
type ActiveTask = { nodeId: string; promise: Promise<NodeOutcome> };

/**
 * Deterministic, dependency-driven DAG runner. It knows graph semantics and
 * node lifecycle only; actual Agent and Plugin execution is injected by Host.
 */
export class WorkflowRunner {
  private readonly now: () => string;
  private readonly states = new Map<string, NodeState>();
  private readonly outputs = new Map<string, unknown>();
  private readonly disabledEdges = new Set<string>();
  private readonly incoming = new Map<string, Array<{ from: string; fromPort: string; toPort: string }>>();
  private readonly outgoing = new Map<string, Array<{ fromPort: string; to: string; toPort: string }>>();
  private readonly nodeById: Map<string, CompiledWorkflowNode>;
  private readonly nodeRunIds = new Map<string, string>();
  private readonly nodeAttempts = new Map<string, number>();
  private readonly inputValidator;
  private readonly outputValidator;
  private readonly controller = new AbortController();

  constructor(private readonly options: WorkflowRunnerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.nodeById = new Map(options.compiled.nodes.map((node) => [node.id, node]));
    for (const node of options.compiled.nodes) {
      this.states.set(node.id, "pending");
      this.nodeAttempts.set(node.id, 1);
      const nodeRun = options.store.latestNode(options.runId, node.id);
      if (nodeRun) this.nodeRunIds.set(node.id, nodeRun.node_run_id);
    }
    for (const edge of options.compiled.edges) {
      const incoming = this.incoming.get(edge.to.node) ?? [];
      incoming.push({ from: edge.from.node, fromPort: edge.from.port, toPort: edge.to.port });
      this.incoming.set(edge.to.node, incoming);
      const outgoing = this.outgoing.get(edge.from.node) ?? [];
      outgoing.push({ fromPort: edge.from.port, to: edge.to.node, toPort: edge.to.port });
      this.outgoing.set(edge.from.node, outgoing);
    }
    // Ajv keeps `$id` registrations for the lifetime of an instance. A
    // module-level compiler therefore rejects the same immutable Workflow
    // schema on the second run in a long-lived Host process. Keep validators
    // scoped to this Runner so concurrent/repeated Runs can reuse schema ids
    // without sharing mutable registry state.
    this.inputValidator = new Ajv2020({ allErrors: true, strict: false }).compile(
      options.compiled.definition.spec.input_schema as JsonSchema,
    );
    this.outputValidator = new Ajv2020({ allErrors: true, strict: false }).compile(
      options.compiled.definition.spec.output_schema as JsonSchema,
    );
    if (options.signal.aborted) this.controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => this.controller.abort(options.signal.reason), { once: true });
  }

  async *run(): AsyncIterable<WorkflowRuntimeEvent> {
    if (!this.inputValidator(this.options.input)) {
      yield this.failed({ error_code: "WORKFLOW_INPUT_SCHEMA_INVALID", details: this.inputValidator.errors ?? [] });
      return;
    }
    yield { type: "workflow.run.started", data: { workflow_ref: this.options.compiled.ref, compiled_hash: this.options.compiled.compiled_hash } };

    const ready = this.options.compiled.topology_order.filter((id) => (this.incoming.get(id)?.length ?? 0) === 0);
    ready.forEach((id) => this.markReady(id));
    const active = new Map<string, Promise<NodeOutcome>>();
    const limit = Math.max(1, this.options.compiled.policy.max_parallelism);
    let failed = false;
    let finalOutput: unknown;
    let lastFailure: { nodeId: string; error: Record<string, unknown> } | undefined;

    while (active.size > 0 || this.hasReady()) {
      while (!failed && !this.controller.signal.aborted && active.size < limit) {
        const nodeId = this.nextReady();
        if (!nodeId) break;
        if (this.shouldSkip(nodeId)) {
          yield* this.skipNode(nodeId);
          this.releaseDependents(nodeId);
          continue;
        }
        let releaseHostSlot: (() => void) | undefined;
        if (this.options.acquireHostSlot) {
          try {
            releaseHostSlot = await this.options.acquireHostSlot(this.nodeById.get(nodeId)!, this.controller.signal);
          } catch {
            break;
          }
          if (this.controller.signal.aborted) {
            releaseHostSlot();
            break;
          }
        }
        const task = this.startNode(nodeId, releaseHostSlot);
        active.set(nodeId, task);
        yield { type: "workflow.node.started", data: { node_id: nodeId, attempt: this.nodeAttempts.get(nodeId) ?? 1, input: this.nodeInput(nodeId) } };
      }

      if (active.size === 0) break;
      const settled = await Promise.race([...active.entries()].map(async ([nodeId, promise]) => ({ nodeId, outcome: await promise })));
      active.delete(settled.nodeId);
      const outcome = settled.outcome;
      if (outcome.status === "succeeded") {
        this.states.set(outcome.nodeId, "succeeded");
        if (outcome.output !== undefined) this.setNodeOutputs(outcome.nodeId, outcome.output);
        const nodeRunId = this.nodeRunIds.get(outcome.nodeId);
        if (nodeRunId) this.options.store.update(nodeRunId, {
          status: "succeeded",
          output: outcome.output,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
          ...(outcome.childRunId ? { childRunId: outcome.childRunId } : {}),
          finishedAt: this.now(),
        });
        if (this.nodeById.get(outcome.nodeId)?.type === "output") finalOutput = outcome.output;
        yield { type: "workflow.node.succeeded", data: { node_id: outcome.nodeId, attempt: this.nodeAttempts.get(outcome.nodeId) ?? 1, output: outcome.output, ...(outcome.usage ? { usage: outcome.usage } : {}), ...(outcome.childRunId ? { child_run_id: outcome.childRunId } : {}) } };
        this.releaseDependents(outcome.nodeId);
      } else if (outcome.status === "stopped" || this.controller.signal.aborted) {
        this.states.set(outcome.nodeId, "stopped");
        lastFailure = { nodeId: outcome.nodeId, error: outcome.error ?? { error_code: "RUN_STOPPED" } };
        const nodeRunId = this.nodeRunIds.get(outcome.nodeId);
        if (nodeRunId) this.options.store.update(nodeRunId, {
          status: "stopped",
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.childRunId ? { childRunId: outcome.childRunId } : {}),
          finishedAt: this.now(),
        });
        yield { type: "workflow.node.failed", data: { node_id: outcome.nodeId, attempt: this.nodeAttempts.get(outcome.nodeId) ?? 1, error: outcome.error ?? { error_code: "RUN_STOPPED" }, ...(outcome.childRunId ? { child_run_id: outcome.childRunId } : {}) } };
        failed = true;
      } else {
        this.states.set(outcome.nodeId, "failed");
        lastFailure = { nodeId: outcome.nodeId, error: outcome.error ?? { error_code: "WORKFLOW_NODE_FAILED" } };
        const nodeRunId = this.nodeRunIds.get(outcome.nodeId);
        if (nodeRunId) this.options.store.update(nodeRunId, {
          status: "failed",
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.childRunId ? { childRunId: outcome.childRunId } : {}),
          finishedAt: this.now(),
        });
        yield { type: "workflow.node.failed", data: { node_id: outcome.nodeId, attempt: this.nodeAttempts.get(outcome.nodeId) ?? 1, error: outcome.error ?? { error_code: "WORKFLOW_NODE_FAILED" }, ...(outcome.childRunId ? { child_run_id: outcome.childRunId } : {}) } };
        failed = true;
        this.controller.abort("fail_fast");
      }
    }

    for (const [nodeId, state] of this.states) {
      if (["pending", "ready"].includes(state)) {
        this.states.set(nodeId, this.controller.signal.aborted ? "stopped" : "skipped");
        const nodeRunId = this.nodeRunIds.get(nodeId);
        if (nodeRunId) this.options.store.update(nodeRunId, { status: this.controller.signal.aborted ? "stopped" : "skipped", finishedAt: this.now() });
        yield { type: "workflow.node.skipped", data: { node_id: nodeId, reason: this.controller.signal.aborted ? "stopped" : "fail_fast" } };
      }
    }
    if (this.options.signal.aborted || (this.controller.signal.aborted && this.controller.signal.reason !== "fail_fast")) {
      const reason = String(this.controller.signal.reason ?? "stop");
      yield { type: "workflow.run.stopped", data: { error_code: reason === "timeout" ? "WORKFLOW_TIMEOUT" : "RUN_STOPPED", reason }, terminal: "stopped" };
    } else if (failed || [...this.states.values()].some((state) => state === "failed")) {
      yield this.failed({
        error_code: "WORKFLOW_NODE_FAILED",
        ...(lastFailure ? { node_id: lastFailure.nodeId, details: lastFailure.error } : {}),
      });
    } else if (!this.outputValidator(finalOutput)) {
      yield this.failed({ error_code: "WORKFLOW_OUTPUT_SCHEMA_INVALID", details: this.outputValidator.errors ?? [] });
    } else {
      yield { type: "workflow.run.succeeded", data: { output: finalOutput }, terminal: "succeeded" };
    }
  }

  stop(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private startNode(nodeId: string, releaseHostSlot?: () => void): Promise<NodeOutcome> {
    const node = this.nodeById.get(nodeId)!;
    const attempt = this.nodeAttempts.get(nodeId) ?? 1;
    try {
      this.states.set(nodeId, "running");
      const nodeRunId = this.nodeRunIds.get(nodeId);
      if (nodeRunId) {
        this.options.store.update(nodeRunId, { status: "ready", input: this.nodeInput(nodeId) });
        this.options.store.update(nodeRunId, { status: "running", input: this.nodeInput(nodeId), startedAt: this.now() });
      }
    } catch (error) {
      releaseHostSlot?.();
      return Promise.reject(error);
    }
    return this.executeNode(node, this.nodeInput(nodeId), attempt).catch((error) => ({
      nodeId,
      status: this.controller.signal.aborted ? "stopped" as const : "failed" as const,
      error: errorRecord(error),
      ...childRunMetadata(error),
    })).finally(() => releaseHostSlot?.());
  }

  private async executeNode(node: CompiledWorkflowNode, input: unknown, attempt: number): Promise<NodeOutcome> {
    if (this.controller.signal.aborted) return { nodeId: node.id, status: "stopped", error: { error_code: "RUN_STOPPED" } };
    try {
      const result = await this.executorFor(node)(node, input, { runId: this.options.runId, nodeId: node.id, attempt, signal: this.controller.signal });
      return {
        nodeId: node.id,
        status: "succeeded",
        output: result.output,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.childRunId ? { childRunId: result.childRunId } : {}),
      };
    } catch (error) {
      const details = { error: errorRecord(error), ...childRunMetadata(error) };
      if (this.controller.signal.aborted) return { nodeId: node.id, status: "stopped", ...details };
      if (isRetryableNodeError(error) && attempt < node.retry.max_attempts) {
        const currentNodeRunId = this.nodeRunIds.get(node.id);
        if (currentNodeRunId) this.options.store.update(currentNodeRunId, { status: "failed", error: details.error, ...(details.childRunId ? { childRunId: details.childRunId } : {}), finishedAt: this.now() });
        if (node.retry.backoff_ms > 0) await delay(node.retry.backoff_ms, this.controller.signal);
        this.nodeAttempts.set(node.id, attempt + 1);
        const retryRunId = this.options.store.createAttempt(this.options.runId, node.id, attempt + 1);
        this.nodeRunIds.set(node.id, retryRunId);
        this.states.set(node.id, "running");
        this.options.store.update(retryRunId, { status: "ready", input });
        this.options.store.update(retryRunId, { status: "running", input, startedAt: this.now() });
        return this.executeNode(node, input, attempt + 1);
      }
      return { nodeId: node.id, status: "failed", ...details };
    }
  }

  private executorFor(node: CompiledWorkflowNode): WorkflowNodeExecutor {
    if (node.type === "preset_model") return this.options.executePresetModel ?? unavailableExecutor("WORKFLOW_AGENT_RUNTIME_UNAVAILABLE");
    if (node.type === "plugin_operation") return this.options.executePluginOperation ?? unavailableExecutor("WORKFLOW_PLUGIN_UNAVAILABLE");
    return async (current, input) => {
      if (current.type === "input") return { output: executeInputNode(input) };
      if (current.type === "output") return { output: executeOutputNode(input) };
      if (current.type === "condition") return { output: executeConditionNode(current.config.expression, input) };
      if (current.type === "parallel") return { output: executeParallelNode(input) };
      if (current.type === "join") return { output: executeJoinNode(input) };
      return { output: input };
    };
  }

  private nodeInput(nodeId: string): unknown {
    if (nodeId === this.options.compiled.topology_order[0]) return this.options.input;
    const incoming = this.incoming.get(nodeId) ?? [];
    const values = incoming
      .filter((edge) => !this.disabledEdges.has(edgeKey(edge.from, edge.fromPort, nodeId, edge.toPort)))
      .filter((edge) => !["skipped", "stopped"].includes(this.states.get(edge.from) ?? "pending"))
      .map((edge) => this.outputs.get(`${edge.from}:${edge.fromPort}`));
    const node = this.nodeById.get(nodeId)!;
    if (incoming.length > 1 || node.type === "join") return values;
    return values[0];
  }

  private setNodeOutputs(nodeId: string, output: unknown): void {
    const node = this.nodeById.get(nodeId)!;
    const outgoing = this.outgoing.get(nodeId) ?? [];
    if (node.type === "condition" && output && typeof output === "object" && !Array.isArray(output)) {
      const value = output as { branch?: unknown; value?: unknown };
      for (const edge of outgoing) {
        if (edge.fromPort === value.branch) this.outputs.set(`${nodeId}:${edge.fromPort}`, value.value);
        else this.disabledEdges.add(edgeKey(nodeId, edge.fromPort, edge.to, edge.toPort));
      }
      return;
    }
    for (const port of new Set(outgoing.map((edge) => edge.fromPort))) {
      this.outputs.set(`${nodeId}:${port}`, output);
    }
  }

  private releaseDependents(nodeId: string): void {
    for (const edge of this.outgoing.get(nodeId) ?? []) {
      if (this.states.get(edge.to) !== "pending") continue;
      const dependencies = this.incoming.get(edge.to) ?? [];
      if (dependencies.every((dependency) => ["succeeded", "failed", "skipped", "stopped"].includes(this.states.get(dependency.from) ?? "pending"))) {
        this.markReady(edge.to);
      }
    }
  }

  private shouldSkip(nodeId: string): boolean {
    const incoming = this.incoming.get(nodeId) ?? [];
    if (!incoming.length) return false;
    return incoming.every((edge) => this.disabledEdges.has(edgeKey(edge.from, edge.fromPort, nodeId, edge.toPort)));
  }

  private markReady(nodeId: string): void {
    if (this.states.get(nodeId) === "pending") this.states.set(nodeId, "ready");
  }

  private nextReady(): string | undefined {
    return this.options.compiled.topology_order.find((id) => this.states.get(id) === "ready");
  }

  private hasReady(): boolean {
    return this.options.compiled.topology_order.some((id) => this.states.get(id) === "ready");
  }

  private *skipNode(nodeId: string): Generator<WorkflowRuntimeEvent> {
    this.states.set(nodeId, "skipped");
    const nodeRunId = this.nodeRunIds.get(nodeId);
    if (nodeRunId) this.options.store.update(nodeRunId, { status: "skipped", finishedAt: this.now() });
    yield { type: "workflow.node.skipped", data: { node_id: nodeId, reason: "condition" } };
  }

  private failed(data: Record<string, unknown>): WorkflowRuntimeEvent {
    return { type: "workflow.run.failed", data, terminal: "failed" };
  }
}

function unavailableExecutor(errorCode: string): WorkflowNodeExecutor {
  return async () => {
    throw new WorkflowNodeExecutionError(errorCode, "The required Workflow node Adapter is not configured.");
  };
}

function edgeKey(from: string, fromPort: string, to: string, toPort: string): string {
  return `${from}:${fromPort}->${to}:${toPort}`;
}

function errorRecord(error: unknown): Record<string, unknown> {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const explicitCode = value?.error_code ?? value?.errorCode ?? value?.code;
  return {
    error_code: typeof explicitCode === "string" && explicitCode.length > 0
      ? explicitCode
      : error instanceof Error && error.name === "AbortError" ? "RUN_STOPPED" : "WORKFLOW_NODE_FAILED",
    error: error instanceof Error ? error.message : String(error),
  };
}

function isRetryableNodeError(error: unknown): boolean {
  return error instanceof WorkflowNodeExecutionError
    ? error.retryable
    : Boolean(error && typeof error === "object" && (error as { retryable?: unknown }).retryable === true);
}

function childRunMetadata(error: unknown): { childRunId?: string } {
  if (error instanceof WorkflowNodeExecutionError && error.childRunId) return { childRunId: error.childRunId };
  const value = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  return typeof value?.child_run_id === "string" ? { childRunId: value.child_run_id } : {};
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Workflow node stopped."));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Workflow node stopped.")); }, { once: true });
  });
}
