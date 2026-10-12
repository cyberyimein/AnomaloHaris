import type { CompiledWorkflowNode } from "./compiler.js";
import { executeConditionNode } from "./nodes/condition.js";
import { executeInputNode } from "./nodes/input.js";
import { executeJoinNode } from "./nodes/join.js";
import { executeOutputNode } from "./nodes/output.js";
import { executeParallelNode } from "./nodes/parallel.js";
import type { WorkflowRunGraph } from "./run-graph.js";
import type { WorkflowNodeUpdate, WorkflowRunStore } from "./store.js";

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

export type NodeOutcome = {
  nodeId: string;
  status: "succeeded" | "failed" | "stopped";
  output?: unknown;
  error?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  childRunId?: string;
};

type NodeExecutionOptions = {
  runId: string;
  graph: WorkflowRunGraph;
  store: WorkflowRunStore;
  signal: AbortSignal;
  now: () => string;
  executePresetModel?: WorkflowNodeExecutor | undefined;
  executePluginOperation?: WorkflowNodeExecutor | undefined;
};

/** Executes node attempts and owns their journal entries, retry policy, and slot release. */
export class WorkflowNodeExecution {
  private readonly nodeRunIds = new Map<string, string>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: NodeExecutionOptions) {
    for (const [nodeId] of options.graph.entries()) {
      this.attempts.set(nodeId, 1);
      const stored = options.store.latestNode(options.runId, nodeId);
      if (stored) this.nodeRunIds.set(nodeId, stored.node_run_id);
    }
  }

  attemptFor(nodeId: string): number {
    return this.attempts.get(nodeId) ?? 1;
  }

  start(nodeId: string, releaseHostSlot?: () => void): Promise<NodeOutcome> {
    const { graph, store, now } = this.options;
    const node = graph.node(nodeId);
    const attempt = this.attemptFor(nodeId);
    try {
      graph.setState(nodeId, "running");
      const nodeRunId = this.nodeRunIds.get(nodeId);
      if (nodeRunId) {
        store.update(nodeRunId, { status: "ready", input: graph.inputFor(nodeId) });
        store.update(nodeRunId, { status: "running", input: graph.inputFor(nodeId), startedAt: now() });
      }
    } catch (error) {
      releaseHostSlot?.();
      return Promise.reject(error);
    }
    // Keep the host slot across retries; release it exactly once when this task settles.
    return this.executeAttempt(node, graph.inputFor(nodeId), attempt)
      .catch((error) => this.failureOutcome(nodeId, error))
      .finally(() => releaseHostSlot?.());
  }

  recordOutcome(outcome: NodeOutcome, status: NodeOutcome["status"]): void {
    const update: WorkflowNodeUpdate = { status };
    if (status === "succeeded") {
      update.output = outcome.output;
      if (outcome.usage) update.usage = outcome.usage;
    } else if (outcome.error) {
      update.error = outcome.error;
    }
    if (outcome.childRunId) update.childRunId = outcome.childRunId;
    this.finishNode(outcome.nodeId, update);
  }

  recordSkipped(nodeId: string, status: "skipped" | "stopped"): void {
    this.finishNode(nodeId, { status });
  }

  private finishNode(nodeId: string, update: WorkflowNodeUpdate): void {
    const nodeRunId = this.nodeRunIds.get(nodeId);
    if (!nodeRunId) return;
    update.finishedAt = this.options.now();
    this.options.store.update(nodeRunId, update);
  }

  private async executeAttempt(node: CompiledWorkflowNode, input: unknown, attempt: number): Promise<NodeOutcome> {
    const { signal, runId } = this.options;
    if (signal.aborted) return { nodeId: node.id, status: "stopped", error: { error_code: "RUN_STOPPED" } };
    try {
      const result = await this.executorFor(node)(node, input, { runId, nodeId: node.id, attempt, signal });
      const outcome: NodeOutcome = { nodeId: node.id, status: "succeeded", output: result.output };
      if (result.usage) outcome.usage = result.usage;
      if (result.childRunId) outcome.childRunId = result.childRunId;
      return outcome;
    } catch (error) {
      const outcome = this.failureOutcome(node.id, error);
      if (signal.aborted) return outcome;
      if (!isRetryableNodeError(error) || attempt >= node.retry.max_attempts) return outcome;

      // Persist a failed attempt before backoff or allocating the next attempt.
      const update: WorkflowNodeUpdate = { status: "failed", error: outcome.error! };
      if (outcome.childRunId) update.childRunId = outcome.childRunId;
      this.finishNode(node.id, update);
      if (node.retry.backoff_ms > 0) await delay(node.retry.backoff_ms, signal);
      this.startRetry(node, input, attempt + 1);
      return this.executeAttempt(node, input, attempt + 1);
    }
  }

  private startRetry(node: CompiledWorkflowNode, input: unknown, attempt: number): void {
    const { runId, store, graph, now } = this.options;
    this.attempts.set(node.id, attempt);
    const nodeRunId = store.createAttempt(runId, node.id, attempt);
    this.nodeRunIds.set(node.id, nodeRunId);
    graph.setState(node.id, "running");
    store.update(nodeRunId, { status: "ready", input });
    store.update(nodeRunId, { status: "running", input, startedAt: now() });
  }

  private failureOutcome(nodeId: string, error: unknown): NodeOutcome {
    let status: NodeOutcome["status"] = "failed";
    if (this.options.signal.aborted) status = "stopped";
    const outcome: NodeOutcome = { nodeId, status, error: errorRecord(error) };
    const childRunId = childRunIdFromError(error);
    if (childRunId !== undefined) outcome.childRunId = childRunId;
    return outcome;
  }

  private executorFor(node: CompiledWorkflowNode): WorkflowNodeExecutor {
    if (node.type === "preset_model") {
      return this.options.executePresetModel ?? unavailableExecutor("WORKFLOW_AGENT_RUNTIME_UNAVAILABLE");
    }
    if (node.type === "plugin_operation") {
      return this.options.executePluginOperation ?? unavailableExecutor("WORKFLOW_PLUGIN_UNAVAILABLE");
    }
    return executeBuiltinNode;
  }
}

/** Built-in nodes transform values; external capabilities are injected by the Host. */
async function executeBuiltinNode(node: CompiledWorkflowNode, input: unknown): Promise<WorkflowNodeExecutionResult> {
  switch (node.type) {
    case "input": return { output: executeInputNode(input) };
    case "output": return { output: executeOutputNode(input) };
    case "condition": return { output: executeConditionNode(node.config.expression, input) };
    case "parallel": return { output: executeParallelNode(input) };
    case "join": return { output: executeJoinNode(input) };
    default: return { output: input };
  }
}

function unavailableExecutor(errorCode: string): WorkflowNodeExecutor {
  return async () => {
    throw new WorkflowNodeExecutionError(errorCode, "The required Workflow node Adapter is not configured.");
  };
}

/** Normalize adapter errors without changing public error codes or child-run metadata. */
function errorRecord(error: unknown): Record<string, unknown> {
  let value: Record<string, unknown> | undefined;
  if (error && typeof error === "object") value = error as Record<string, unknown>;
  const explicitCode = value?.error_code ?? value?.errorCode ?? value?.code;
  let errorCode = "WORKFLOW_NODE_FAILED";
  if (typeof explicitCode === "string" && explicitCode.length > 0) errorCode = explicitCode;
  else if (error instanceof Error && error.name === "AbortError") errorCode = "RUN_STOPPED";
  let message: string;
  if (error instanceof Error) message = error.message;
  else message = String(error);
  return { error_code: errorCode, error: message };
}

function isRetryableNodeError(error: unknown): boolean {
  if (error instanceof WorkflowNodeExecutionError) return error.retryable;
  return Boolean(error && typeof error === "object" && (error as { retryable?: unknown }).retryable === true);
}

function childRunIdFromError(error: unknown): string | undefined {
  if (error instanceof WorkflowNodeExecutionError && error.childRunId) return error.childRunId;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.child_run_id === "string") return value.child_run_id;
  }
  return undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Workflow node stopped."));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Workflow node stopped."));
    }, { once: true });
  });
}
