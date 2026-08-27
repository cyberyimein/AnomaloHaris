import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowRuntime, WorkflowRunStore } from "@anomaloharis/workflow-runtime";

import { AgentCore } from "./core.js";
import { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";
import { RunController } from "./controller.js";
import { SqlitePresetModelRegistry } from "./preset-models.js";
import { ReplayModelAdapter } from "./model.js";
import { InMemorySessionAdapter } from "./session.js";
import { DeterministicToolRuntime } from "./tools.js";
import { RuntimeCatalog } from "./runtime-catalog.js";
import { RunControl } from "./run-control.js";
import { WorkflowRuntimeAdapter } from "./workflow-runtime-adapter.js";

const resources: Array<{ close(): void }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
});

describe("WorkflowRuntimeAdapter", () => {
  it("creates a child Agent Run with the locked Preset Model and projects structured output", async () => {
    const presetModels = new SqlitePresetModelRegistry(":memory:");
    resources.push(presetModels);
    presetModels.ensureBuiltinDefault({ model: "replay" });
    const model = presetModels.resolve("anomaloharis@1");
    const sessions = new InMemorySessionAdapter();
    const replayModel = new ReplayModelAdapter([[{ type: "text.delta", text: '{"ok":true}' }, { type: "done" }]], { completions: ['{"ok":true}'] });
    const controller = new RunController(new AgentCore({
      model: replayModel,
      tools: new DeterministicToolRuntime([]),
      sessions,
    }));

    const workflowDatabase = new DatabaseSync(":memory:");
    resources.push(workflowDatabase);
    const runtime = new WorkflowRuntime({
      database: workflowDatabase,
      presetModels: {
        listPublished: () => [{ ref: model.ref, description: model.description, compiled_hash: hash(model.compiledHash), plugin_lock_hash: hash(model.pluginLockHash) }],
        resolve: (ref) => ref === model.ref ? { ref: model.ref, description: model.description, compiled_hash: hash(model.compiledHash), plugin_lock_hash: hash(model.pluginLockHash) } : undefined,
      },
    });
    resources.push(runtime);
    const imported = await runtime.importDraft(presetWorkflow(model.ref));
    await runtime.publish(imported.workflow.ref);

    const store = new WorkflowRunStore(workflowDatabase);
    const catalog = new RuntimeCatalog();
    const agentAdapter = new AgentRuntimeAdapter({ registry: presetModels, controller });
    let control!: RunControl;
    const workflowAdapter = new WorkflowRuntimeAdapter({
      runtime,
      store,
      agentExecution: {
        startAgentChild: (parentRunId, target, request) => {
          const handle = control.startAgentChild(parentRunId, target, request);
          return { runId: handle.runId, events: handle };
        },
        stopChildren: (parentRunId, reason) => control.stopChildren(parentRunId, reason),
      },
    });
    catalog.register(agentAdapter);
    catalog.register(workflowAdapter);
    control = new RunControl(workflowDatabase, catalog);

    const handle = control.start({ kind: "workflow", ref: imported.workflow.ref }, { clientId: "urus", input: { prompt: "classify" } });
    const events = [];
    for await (const event of handle) events.push(event);
    const run = control.get(handle.runId);
    expect(run).toMatchObject({ status: "succeeded", output: { ok: true } });
    expect(replayModel.streamCalls[0]?.responseFormat).toBeUndefined();
    const child = workflowDatabase.prepare("SELECT run_id, parent_run_id, status FROM execution_runs WHERE parent_run_id = ?").get(handle.runId) as Record<string, unknown>;
    expect(child).toMatchObject({ parent_run_id: handle.runId, status: "succeeded" });
    expect(events.some((event) => event.type === "workflow.node.succeeded" && event.data.child_run_id === child.run_id)).toBe(true);
  });

  it("uses a distinct child idempotency key for each Preset Model retry", async () => {
    const workflowDatabase = new DatabaseSync(":memory:");
    resources.push(workflowDatabase);
    const model = { ref: "reviewer@1", description: "Retry model", compiled_hash: hash("reviewer"), plugin_lock_hash: hash("plugins") };
    const runtime = new WorkflowRuntime({
      database: workflowDatabase,
      presetModels: {
        listPublished: () => [model],
        resolve: (ref) => ref === model.ref ? model : undefined,
      },
    });
    resources.push(runtime);
    const imported = await runtime.importDraft(presetWorkflow(model.ref, true));
    await runtime.publish(imported.workflow.ref);
    workflowDatabase.exec("CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY);");
    workflowDatabase.prepare("INSERT INTO execution_runs(run_id) VALUES ('run_retry_child')").run();
    const store = new WorkflowRunStore(workflowDatabase);
    const stored = runtime.registry.get(imported.workflow.ref);
    store.create("run_retry_child", stored.compiled);
    const keys: string[] = [];
    const agentExecution = {
      startAgentChild: (_parentRunId: string, _target: { kind: "preset_model"; ref: string }, request: { idempotencyKey?: string }) => {
        keys.push(request.idempotencyKey ?? "");
        const failed = keys.length === 1;
        return {
          runId: `child-${keys.length}`,
          events: (async function* () {
            yield {
              schema_version: 1 as const,
              run_id: `child-${keys.length}`,
              runtime_kind: "preset_model" as const,
              target_ref: model.ref,
              sequence: 1,
              timestamp: "2026-08-25T00:00:00.000Z",
              type: failed ? "run.failed" : "run.succeeded",
              data: failed ? { error_code: "transient", error: "retry me", retryable: true } : { output: { ok: true } },
            };
          })(),
        };
      },
      stopChildren: async () => undefined,
    };
    const adapter = new WorkflowRuntimeAdapter({ runtime, store, agentExecution });
    const events = [];
    for await (const event of adapter.start({
      runId: "run_retry_child",
      clientId: "urus",
      target: { kind: "workflow", ref: imported.workflow.ref, hash: stored.compiled_hash },
      metadata: {},
      signal: new AbortController().signal,
    }, { value: "retry" })) events.push(event);

    expect(keys).toEqual(["run_retry_child:model:1", "run_retry_child:model:2"]);
    expect(events.at(-1)).toMatchObject({ type: "workflow.run.succeeded", data: { output: { ok: true } } });
  });
});

function hash(value: string): `sha256:${string}` {
  return (value.startsWith("sha256:") ? value : `sha256:${value}`) as `sha256:${string}`;
}

function presetWorkflow(modelRef: string, retry = false) {
  return {
    api_version: "anomaloharis.dev/workflow/v1",
    kind: "Workflow",
    metadata: { name: "preset-child", version: 1, description: "Preset child fixture." },
    spec: {
      input_schema: { type: "object" },
      output_schema: {},
      nodes: [
        { id: "input", type: "input", type_version: 1, config: {} },
        { id: "model", type: "preset_model", type_version: 1, config: { model_ref: modelRef, input_mode: "message", session_mode: "isolated" }, ...(retry ? { retry: { max_attempts: 2, backoff_ms: 0 } } : {}) },
        { id: "output", type: "output", type_version: 1, config: {} },
      ],
      edges: [
        { from: { node: "input", port: "data" }, to: { node: "model", port: "input" } },
        { from: { node: "model", port: "output" }, to: { node: "output", port: "result" } },
      ],
    },
  };
}
