import { createHash } from "node:crypto";

import Ajv from "ajv";

import type {
  ExecutionRunEvent,
  PresetModelRef,
  StopReason,
} from "@anomaloharis/contracts";
import {
  WorkflowRuntime,
  WorkflowRunStore,
  WorkflowRunner,
  WorkflowNodeExecutionError,
  type CompiledWorkflow,
  type WorkflowNodeExecutionResult,
  type WorkflowRuntimeEvent,
} from "@anomaloharis/workflow-runtime";

import type { PluginHost, PluginOperationContext } from "./plugins.js";
import type {
  ExecutionRuntimeAdapter,
  ResolvedExecutionTarget,
  RunContext,
  RuntimeEvent,
  ChildRunRequest,
} from "./run-control.js";

export type AgentExecution = {
  startAgentChild(
    parentRunId: string,
    target: { kind: "preset_model"; ref: string },
    request: ChildRunRequest,
  ): { runId: string; events: AsyncIterable<ExecutionRunEvent> };
  stopChildren(parentRunId: string, reason: StopReason): Promise<void>;
};

export class WorkflowRuntimeAdapter implements ExecutionRuntimeAdapter {
  readonly kind = "workflow" as const;
  readonly version = "1.0.0";
  readonly packageHash = packageHash("@anomaloharis/workflow-runtime-adapter", this.version);
  readonly capabilities = ["dag", "child-agent-run", "plugin-operation"] as const;
  readonly consumesHostSlot = false;
  private readonly active = new Map<string, WorkflowRunner>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(private readonly options: {
    runtime: WorkflowRuntime;
    store: WorkflowRunStore;
    agentExecution?: AgentExecution;
    plugins?: PluginHost;
    acquireHostSlot?: (signal: AbortSignal) => Promise<() => void>;
  }) {}

  isHealthy(): boolean {
    return this.options.runtime.registry.db.isOpen && this.options.store.db.isOpen;
  }

  resolve(ref: string): ResolvedExecutionTarget {
    const stored = this.options.runtime.registry.get(ref);
    if (stored.status !== "published") throw new Error(`workflow_unavailable:${ref}`);
    return { kind: this.kind, ref: stored.ref, hash: stored.compiled_hash };
  }

  prepareRun(context: { runId: string; target: ResolvedExecutionTarget }): void {
    const stored = this.options.runtime.registry.get(context.target.ref);
    if (stored.status !== "published") throw new Error(`workflow_unavailable:${context.target.ref}`);
    this.options.store.create(context.runId, stored.compiled);
  }

  async *start(context: RunContext, input: unknown): AsyncIterable<RuntimeEvent> {
    const stored = this.options.runtime.registry.get(context.target.ref);
    const compiled = stored.compiled;
    const controller = new AbortController();
    const onAbort = () => controller.abort(context.signal.reason);
    const stopChildrenOnAbort = () => {
      const stopping = this.options.agentExecution?.stopChildren(context.runId, stopReason(controller.signal.reason));
      if (stopping) void stopping.catch(() => undefined);
    };
    controller.signal.addEventListener("abort", stopChildrenOnAbort, { once: true });
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort("timeout"), compiled.policy.timeout_seconds * 1_000);
    const runner = new WorkflowRunner({
      runId: context.runId,
      compiled,
      input,
      signal: controller.signal,
      store: this.options.store,
      ...(this.options.acquireHostSlot ? {
        acquireHostSlot: (node, signal) => node.type === "preset_model"
          ? Promise.resolve(() => undefined)
          : this.options.acquireHostSlot!(signal),
      } : {}),
      executePresetModel: (node, nodeInput, nodeContext) => this.executePresetModel(context, compiled, node, nodeInput, nodeContext.signal, nodeContext.attempt),
      executePluginOperation: (node, nodeInput, nodeContext) => this.executePluginOperation(context, compiled, node, nodeInput, nodeContext.signal),
    });
    this.active.set(context.runId, runner);
    try {
      for await (const event of runner.run()) yield projectWorkflowEvent(event);
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", stopChildrenOnAbort);
      this.active.delete(context.runId);
    }
  }

  async stop(runId: string, reason: StopReason): Promise<void> {
    this.active.get(runId)?.stop(reason);
    await this.options.agentExecution?.stopChildren(runId, reason);
  }

  recover(runId: string, errorCode: "WORKFLOW_HOST_RESTARTED"): void {
    for (const node of this.options.store.listNodes(runId)) {
      if (node.status !== "running") continue;
      this.options.store.update(node.node_run_id, {
        status: "failed",
        error: { error_code: errorCode, error: "The Node Host restarted before this node completed." },
      });
    }
  }

  private async executePresetModel(
    context: RunContext,
    compiled: CompiledWorkflow,
    node: CompiledWorkflow["nodes"][number],
    input: unknown,
    signal: AbortSignal,
    attempt: number,
  ): Promise<WorkflowNodeExecutionResult> {
    const modelRef = typeof node.config.model_ref === "string" ? node.config.model_ref : "";
    const lock = compiled.dependency_locks.find((candidate) => candidate.node_id === node.id && candidate.dependency_kind === "preset_model");
    if (!lock || lock.dependency_ref !== modelRef) throw nodeError("WORKFLOW_DEPENDENCY_LOCK_MISSING", "The Preset Model dependency lock is missing or does not match the node.");
    if (!this.options.agentExecution) throw nodeError("WORKFLOW_AGENT_RUNTIME_UNAVAILABLE", "The Agent Runtime Adapter is not configured.");
    const child = this.options.agentExecution.startAgentChild(context.runId, { kind: "preset_model", ref: modelRef as PresetModelRef }, {
      input: {
        message: serializeAgentInput(input),
        response_format: { type: "json_object" },
      },
      idempotencyKey: `${context.runId}:${node.id}:${attempt}`,
      metadata: { workflow_node_id: node.id, workflow_node_attempt: attempt },
      ...(context.permissions ? { permissions: [...context.permissions] } : {}),
      expectedTargetHash: lock.dependency_hash,
    });
    let output: unknown;
    let usage: Record<string, unknown> | undefined;
    for await (const event of child.events) {
      if (signal.aborted) throw nodeError(stopErrorCode(signal.reason), "Workflow child run stopped.", { child_run_id: child.runId });
      if (event.type === "agent.run.finished") output = event.data.output ?? event.data.final_text;
      if (event.type === "run.succeeded") output = event.data.output;
      if (event.data.usage && typeof event.data.usage === "object" && !Array.isArray(event.data.usage)) usage = structuredClone(event.data.usage) as Record<string, unknown>;
      if (event.type === "run.failed") throw nodeError(
        typeof event.data.error_code === "string" ? event.data.error_code : "AGENT_CHILD_FAILED",
        String(event.data.error ?? event.data.error_code ?? "Agent child failed."),
        { child_run_id: child.runId },
        event.data.retryable === true,
      );
      if (event.type === "run.stopped") throw nodeError("RUN_STOPPED", "Agent child run stopped.", { child_run_id: child.runId });
    }
    return { output: parseStructuredOutput(output), childRunId: child.runId, ...(usage ? { usage } : {}) };
  }

  private async executePluginOperation(
    context: RunContext,
    compiled: CompiledWorkflow,
    node: CompiledWorkflow["nodes"][number],
    input: unknown,
    signal: AbortSignal,
  ): Promise<WorkflowNodeExecutionResult> {
    if (!this.options.plugins) throw nodeError("WORKFLOW_PLUGIN_UNAVAILABLE", "The Plugin Host is not configured.");
    const operationId = typeof node.config.operation_id === "string" ? node.config.operation_id : "";
    const operationVersion = typeof node.config.operation_version === "number" ? node.config.operation_version : 0;
    const operation = this.options.runtime.catalog.pluginOperation(operationId, operationVersion);
    const lock = compiled.dependency_locks.find((candidate) => candidate.node_id === node.id && candidate.dependency_kind === "plugin_operation");
    if (!operation || !lock || lock.dependency_ref !== `${operation.id}@${operation.version}` || lock.dependency_hash !== operation.package_hash) {
      throw nodeError("WORKFLOW_PLUGIN_LOCK_MISMATCH", "The locked Plugin Operation is no longer available at the compiled package hash.");
    }
    const requiredPermissions = [...operation.permissions];
    if (context.permissions && requiredPermissions.some((permission) => !context.permissions!.has(permission) && !context.permissions!.has("*"))) {
      throw nodeError("WORKFLOW_PERMISSION_DENIED", "The caller is missing a permission required by the Plugin Operation.");
    }
    const inputValidator = this.ajv.compile(operation.input_schema);
    if (!inputValidator(input)) throw nodeError("WORKFLOW_PLUGIN_INPUT_SCHEMA_INVALID", JSON.stringify(inputValidator.errors ?? []));
    const operationContext: PluginOperationContext = {
      pluginId: operation.plugin_id,
      runId: context.runId,
      parentRunId: context.runId,
      clientId: context.clientId,
      permissions: requiredPermissions,
      idempotencyKey: `${context.runId}:${node.id}`,
    };
    const timeoutMs = Math.min(operation.timeout_ms, compiled.policy.timeout_seconds * 1_000);
    let result: unknown;
    try {
      result = await withTimeoutSignal(
        signal,
        timeoutMs,
        "WORKFLOW_PLUGIN_OPERATION_TIMEOUT",
        (operationSignal) => this.options.plugins!.callWorkflowOperation(
          { id: operation.id, version: operation.version, packageHash: operation.package_hash, pluginId: operation.plugin_id, pluginVersion: operation.plugin_version, permissions: requiredPermissions, ...(context.permissions ? { authorizedPermissions: [...context.permissions] } : {}), timeoutMs },
          input,
          operationContext,
          operationSignal,
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowNodeExecutionError) throw error;
      throw nodeError(
        errorCode(error, "WORKFLOW_PLUGIN_OPERATION_FAILED"),
        error instanceof Error ? error.message : String(error),
        {},
        operation.idempotency !== "none" && isRetryable(error),
      );
    }
    const outputValidator = this.ajv.compile(operation.output_schema);
    if (!outputValidator(result)) throw nodeError("WORKFLOW_PLUGIN_OUTPUT_SCHEMA_INVALID", JSON.stringify(outputValidator.errors ?? []));
    return { output: result };
  }
}

function projectWorkflowEvent(event: WorkflowRuntimeEvent): RuntimeEvent {
  return { type: event.type, data: event.data, ...(event.terminal ? { terminal: event.terminal } : {}) };
}

function serializeAgentInput(input: unknown): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

function parseStructuredOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function nodeError(code: string, message: string, metadata: { child_run_id?: string } = {}, retryable = false): WorkflowNodeExecutionError {
  return new WorkflowNodeExecutionError(code, message, retryable, metadata.child_run_id);
}

function stopErrorCode(reason: unknown): string {
  return String(reason ?? "") === "timeout" ? "WORKFLOW_TIMEOUT" : "RUN_STOPPED";
}

function stopReason(reason: unknown): StopReason {
  if (reason === "disconnect" || reason === "timeout" || reason === "fail_fast" || reason === "host_shutdown") return reason;
  return "user_stop";
}

function withTimeoutSignal<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal.aborted) return Promise.reject(nodeError(stopErrorCode(parentSignal.reason), "Workflow node stopped."));
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      controller.abort("timeout");
      if (settled) return;
      settled = true;
      cleanup();
      reject(nodeError(timeoutCode, "Workflow Plugin Operation timed out."));
    }, Math.max(1, timeoutMs));
    const onAbort = () => {
      controller.abort(parentSignal.reason);
      if (settled) return;
      settled = true;
      cleanup();
      reject(nodeError(stopErrorCode(parentSignal.reason), "Workflow node stopped."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onAbort);
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
    task(controller.signal).then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function packageHash(name: string, version: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${name}@${version}`).digest("hex")}`;
}

function errorCode(error: unknown, fallback: string): string {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const candidate = value?.error_code ?? value?.errorCode ?? value?.code;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : fallback;
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { retryable?: unknown }).retryable === true);
}
