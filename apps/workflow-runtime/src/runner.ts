import Ajv2020 from "ajv/dist/2020.js";

import type { JsonSchema } from "@anomaloharis/contracts";

import type { CompiledWorkflow, CompiledWorkflowNode } from "./compiler.js";
import { WorkflowNodeExecution, type NodeOutcome, type WorkflowNodeExecutor } from "./node-execution.js";
import { WorkflowRunGraph } from "./run-graph.js";
import type { WorkflowRunStore } from "./store.js";

// Preserve the public runner API while node execution lives in its own module.
export { WorkflowNodeExecutionError } from "./node-execution.js";
export type {
  WorkflowNodeExecutionContext,
  WorkflowNodeExecutionResult,
  WorkflowNodeExecutor,
} from "./node-execution.js";

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

type RunProgress = {
  failed: boolean;
  finalOutput: unknown;
  lastFailure: { nodeId: string; error: Record<string, unknown> } | undefined;
};

/** Schedules ready DAG nodes. Agent and Plugin implementations are injected by the Host. */
export class WorkflowRunner {
  private readonly graph: WorkflowRunGraph;
  private readonly execution: WorkflowNodeExecution;
  private readonly inputValidator;
  private readonly outputValidator;
  private readonly controller = new AbortController();

  constructor(private readonly options: WorkflowRunnerOptions) {
    this.graph = new WorkflowRunGraph(options.compiled, options.input);
    this.execution = new WorkflowNodeExecution({
      runId: options.runId,
      graph: this.graph,
      store: options.store,
      signal: this.controller.signal,
      now: options.now ?? (() => new Date().toISOString()),
      executePresetModel: options.executePresetModel,
      executePluginOperation: options.executePluginOperation,
    });
    // Each schema needs its own Ajv registry: input and output may share a $id,
    // and repeated runs must not inherit registrations from earlier runners.
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
    yield {
      type: "workflow.run.started",
      data: { workflow_ref: this.options.compiled.ref, compiled_hash: this.options.compiled.compiled_hash },
    };

    this.graph.markRootsReady();
    const active = new Map<string, Promise<NodeOutcome>>();
    const limit = Math.max(1, this.options.compiled.policy.max_parallelism);
    const progress: RunProgress = { failed: false, finalOutput: undefined, lastFailure: undefined };

    while (active.size > 0 || this.graph.hasReady()) {
      // Fill capacity in topology order. Disabled condition branches consume no slot.
      while (!progress.failed && !this.controller.signal.aborted && active.size < limit) {
        const nodeId = this.graph.nextReady();
        if (!nodeId) break;
        if (this.graph.shouldSkip(nodeId)) {
          yield this.skipNode(nodeId, "condition");
          this.graph.releaseDependents(nodeId);
          continue;
        }
        let releaseHostSlot: (() => void) | undefined;
        if (this.options.acquireHostSlot) {
          try {
            releaseHostSlot = await this.options.acquireHostSlot(this.graph.node(nodeId), this.controller.signal);
          } catch {
            break;
          }
          if (this.controller.signal.aborted) {
            releaseHostSlot();
            break;
          }
        }
        active.set(nodeId, this.execution.start(nodeId, releaseHostSlot));
        yield {
          type: "workflow.node.started",
          data: { node_id: nodeId, attempt: this.execution.attemptFor(nodeId), input: this.graph.inputFor(nodeId) },
        };
      }

      // Drain started tasks even after fail-fast or cancellation; their results must be journaled.
      if (active.size === 0) break;
      const settled = await Promise.race([...active.entries()].map(async ([nodeId, promise]) => ({
        nodeId, outcome: await promise,
      })));
      active.delete(settled.nodeId);
      const { event, status } = this.recordOutcome(settled.outcome, progress);
      yield event;
      if (status === "succeeded") {
        this.graph.releaseDependents(settled.nodeId);
      } else {
        progress.failed = true;
        // Abort after publishing the node failure, preserving event-consumer stop semantics.
        if (status === "failed") this.controller.abort("fail_fast");
      }
    }

    yield* this.skipUnscheduledNodes();
    yield this.terminalEvent(progress);
  }

  stop(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  /** Update graph and journal state before exposing a node outcome to consumers. */
  private recordOutcome(outcome: NodeOutcome, progress: RunProgress): {
    event: WorkflowRuntimeEvent;
    status: NodeOutcome["status"];
  } {
    const data: Record<string, unknown> = {
      node_id: outcome.nodeId,
      attempt: this.execution.attemptFor(outcome.nodeId),
    };
    if (outcome.childRunId) data.child_run_id = outcome.childRunId;
    if (outcome.status === "succeeded") {
      // Completed work remains successful even if cancellation arrived before settlement.
      this.graph.succeed(outcome.nodeId, outcome.output);
      this.execution.recordOutcome(outcome, "succeeded");
      if (this.graph.node(outcome.nodeId).type === "output") progress.finalOutput = outcome.output;
      data.output = outcome.output;
      if (outcome.usage) data.usage = outcome.usage;
      return { status: "succeeded", event: { type: "workflow.node.succeeded", data } };
    }

    let status: "failed" | "stopped" = "failed";
    let fallbackCode = "WORKFLOW_NODE_FAILED";
    if (outcome.status === "stopped" || this.controller.signal.aborted) {
      status = "stopped";
      fallbackCode = "RUN_STOPPED";
    }
    this.graph.setState(outcome.nodeId, status);
    const error = outcome.error ?? { error_code: fallbackCode };
    progress.lastFailure = { nodeId: outcome.nodeId, error };
    this.execution.recordOutcome(outcome, status);
    data.error = error;
    return { status, event: { type: "workflow.node.failed", data } };
  }

  private skipNode(nodeId: string, reason: "condition" | "stopped" | "fail_fast"): WorkflowRuntimeEvent {
    let status: "skipped" | "stopped" = "skipped";
    if (reason === "stopped") status = "stopped";
    this.graph.setState(nodeId, status);
    this.execution.recordSkipped(nodeId, status);
    return { type: "workflow.node.skipped", data: { node_id: nodeId, reason } };
  }

  /** Nodes that never started still receive a terminal journal state and a skip event. */
  private *skipUnscheduledNodes(): Generator<WorkflowRuntimeEvent> {
    for (const [nodeId, state] of this.graph.entries()) {
      if (state !== "pending" && state !== "ready") continue;
      let reason: "stopped" | "fail_fast" = "fail_fast";
      if (this.controller.signal.aborted) reason = "stopped";
      yield this.skipNode(nodeId, reason);
    }
  }

  private terminalEvent(progress: RunProgress): WorkflowRuntimeEvent {
    const signal = this.controller.signal;
    // Parent cancellation takes precedence over node-failure aggregation.
    if (this.options.signal.aborted || (signal.aborted && signal.reason !== "fail_fast")) {
      const reason = String(signal.reason ?? "stop");
      let errorCode = "RUN_STOPPED";
      if (reason === "timeout") errorCode = "WORKFLOW_TIMEOUT";
      return { type: "workflow.run.stopped", data: { error_code: errorCode, reason }, terminal: "stopped" };
    }
    if (progress.failed || this.graph.hasFailed()) {
      const data: Record<string, unknown> = { error_code: "WORKFLOW_NODE_FAILED" };
      if (progress.lastFailure) {
        data.node_id = progress.lastFailure.nodeId;
        data.details = progress.lastFailure.error;
      }
      return this.failed(data);
    }
    if (!this.outputValidator(progress.finalOutput)) {
      return this.failed({ error_code: "WORKFLOW_OUTPUT_SCHEMA_INVALID", details: this.outputValidator.errors ?? [] });
    }
    return { type: "workflow.run.succeeded", data: { output: progress.finalOutput }, terminal: "succeeded" };
  }

  private failed(data: Record<string, unknown>): WorkflowRuntimeEvent {
    return { type: "workflow.run.failed", data, terminal: "failed" };
  }
}
