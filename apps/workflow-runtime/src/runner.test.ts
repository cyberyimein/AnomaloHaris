import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore } from "./store.js";
import { WorkflowNodeExecutionError, WorkflowRunner } from "./runner.js";

const resources: Array<{ close(): void }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
});

describe("WorkflowRunner", () => {
  it("executes condition branches and joins in compiled topology order", async () => {
    const database = new DatabaseSync(":memory:");
    resources.push(database);
    const runtime = new WorkflowRuntime({ database });
    const imported = await runtime.importDraft(definition());
    await runtime.publish(imported.workflow.ref);
    database.exec("CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO execution_runs(run_id) VALUES ('run_workflow')").run();
    const store = new WorkflowRunStore(database);
    const stored = runtime.registry.get(imported.workflow.ref);
    store.create("run_workflow", stored.compiled);

    const runner = new WorkflowRunner({
      runId: "run_workflow",
      compiled: stored.compiled,
      input: { go: true, value: "stable" },
      signal: new AbortController().signal,
      store,
    });
    const events = [];
    for await (const event of runner.run()) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.node.started",
      "workflow.node.succeeded",
      "workflow.node.started",
      "workflow.node.succeeded",
      "workflow.node.skipped",
      "workflow.node.started",
      "workflow.node.succeeded",
      "workflow.node.started",
      "workflow.node.succeeded",
      "workflow.node.started",
      "workflow.node.succeeded",
      "workflow.run.succeeded",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "workflow.run.succeeded", data: { output: [{ go: true, value: "stable" }] } });
    expect(store.listNodes("run_workflow").map((node) => [node.node_id, node.status])).toEqual([
      ["condition", "succeeded"],
      ["false_branch", "skipped"],
      ["input", "succeeded"],
      ["join", "succeeded"],
      ["output", "succeeded"],
      ["parallel", "succeeded"],
    ]);
  });

  it("isolates schema registries across repeated runs", async () => {
    const database = new DatabaseSync(":memory:");
    resources.push(database);
    const runtime = new WorkflowRuntime({ database });
    const imported = await runtime.importDraft(schemaIdDefinition());
    await runtime.publish(imported.workflow.ref);
    database.exec("CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO execution_runs(run_id) VALUES (?)").run("run_schema_1");
    database.prepare("INSERT INTO execution_runs(run_id) VALUES (?)").run("run_schema_2");
    const store = new WorkflowRunStore(database);
    const compiled = runtime.registry.get(imported.workflow.ref).compiled;
    store.create("run_schema_1", compiled);
    store.create("run_schema_2", compiled);

    for (const runId of ["run_schema_1", "run_schema_2"]) {
      const runner = new WorkflowRunner({
        runId,
        compiled,
        input: { go: true, value: "stable" },
        signal: new AbortController().signal,
        store,
      });
      const events = [];
      for await (const event of runner.run()) events.push(event);
      expect(events.at(-1)?.type).toBe("workflow.run.succeeded");
    }
  });

  it("persists failed and successful attempts when a node retries", async () => {
    const database = new DatabaseSync(":memory:");
    resources.push(database);
    const runtime = new WorkflowRuntime({
      database,
      presetModels: {
        listPublished: () => [{ ref: "retry-model@1", description: "Retry model", compiled_hash: hash("model"), plugin_lock_hash: hash("plugins") }],
        resolve: (ref) => ref === "retry-model@1" ? { ref: "retry-model@1", description: "Retry model", compiled_hash: hash("model"), plugin_lock_hash: hash("plugins") } : undefined,
      },
    });
    const imported = await runtime.importDraft(retryDefinition());
    await runtime.publish(imported.workflow.ref);
    database.exec("CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO execution_runs(run_id) VALUES ('run_retry')").run();
    const store = new WorkflowRunStore(database);
    const compiled = runtime.registry.get(imported.workflow.ref).compiled;
    store.create("run_retry", compiled);
    let calls = 0;
    const runner = new WorkflowRunner({
      runId: "run_retry",
      compiled,
      input: { value: "retry" },
      signal: new AbortController().signal,
      store,
      executePresetModel: async (_node, input) => {
        calls += 1;
        if (calls === 1) throw new WorkflowNodeExecutionError("transient", "transient", true);
        return { output: input };
      },
    });
    const events = [];
    for await (const event of runner.run()) events.push(event);

    expect(events.at(-1)?.type).toBe("workflow.run.succeeded");
    expect(store.listNodes("run_retry").filter((node) => node.node_id === "model").map((node) => node.status)).toEqual(["failed", "succeeded"]);
  });

  it("does not retry deterministic node failures", async () => {
    const database = new DatabaseSync(":memory:");
    resources.push(database);
    const runtime = new WorkflowRuntime({
      database,
      presetModels: {
        listPublished: () => [{ ref: "retry-model@1", description: "Retry model", compiled_hash: hash("model"), plugin_lock_hash: hash("plugins") }],
        resolve: (ref) => ref === "retry-model@1" ? { ref: "retry-model@1", description: "Retry model", compiled_hash: hash("model"), plugin_lock_hash: hash("plugins") } : undefined,
      },
    });
    const imported = await runtime.importDraft(retryDefinition());
    await runtime.publish(imported.workflow.ref);
    database.exec("CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO execution_runs(run_id) VALUES ('run_no_retry')").run();
    const store = new WorkflowRunStore(database);
    const compiled = runtime.registry.get(imported.workflow.ref).compiled;
    store.create("run_no_retry", compiled);
    let calls = 0;
    const runner = new WorkflowRunner({
      runId: "run_no_retry",
      compiled,
      input: { value: "retry" },
      signal: new AbortController().signal,
      store,
      executePresetModel: async () => {
        calls += 1;
        throw new WorkflowNodeExecutionError("WORKFLOW_PERMISSION_DENIED", "denied");
      },
    });
    const events = [];
    for await (const event of runner.run()) events.push(event);

    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "workflow.run.failed" });
  });

  it("fails external nodes when their execution Adapter is missing", async () => {
    const database = new DatabaseSync(":memory:");
    resources.push(database);
    const runtime = new WorkflowRuntime({
      database,
      presetModels: {
        listPublished: () => [{ ref: "retry-model@1", description: "Retry model", compiled_hash: hash("model"), plugin_lock_hash: hash("plugins") }],
        resolve: (ref) => ref === "retry-model@1" ? { ref: "retry-model@1", description: "Retry model", compiled_hash: hash("model"), plugin_lock_hash: hash("plugins") } : undefined,
      },
    });
    const imported = await runtime.importDraft(retryDefinition());
    await runtime.publish(imported.workflow.ref);
    database.exec("CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO execution_runs(run_id) VALUES ('run_missing_adapter')").run();
    const store = new WorkflowRunStore(database);
    const compiled = runtime.registry.get(imported.workflow.ref).compiled;
    store.create("run_missing_adapter", compiled);
    const runner = new WorkflowRunner({ runId: "run_missing_adapter", compiled, input: {}, signal: new AbortController().signal, store });
    const events = [];
    for await (const event of runner.run()) events.push(event);

    expect(events.find((event) => event.type === "workflow.node.failed")).toMatchObject({
      data: { error: { error_code: "WORKFLOW_AGENT_RUNTIME_UNAVAILABLE" } },
    });
  });

  it("preserves an input value when one output port fans out to multiple nodes", async () => {
    const database = new DatabaseSync(":memory:");
    resources.push(database);
    const runtime = new WorkflowRuntime({ database });
    const imported = await runtime.importDraft(fanoutDefinition());
    await runtime.publish(imported.workflow.ref);
    database.exec("CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY);");
    database.prepare("INSERT INTO execution_runs(run_id) VALUES ('run_fanout')").run();
    const store = new WorkflowRunStore(database);
    const stored = runtime.registry.get(imported.workflow.ref);
    store.create("run_fanout", stored.compiled);

    const runner = new WorkflowRunner({
      runId: "run_fanout",
      compiled: stored.compiled,
      input: { value: "fanout" },
      signal: new AbortController().signal,
      store,
    });
    const events = [];
    for await (const event of runner.run()) events.push(event);

    expect(events.at(-1)).toMatchObject({ type: "workflow.run.succeeded", data: { output: [{ value: "fanout" }, { value: "fanout" }] } });
  });

  it("runs ready nodes concurrently and joins outputs in edge order", async () => {
    const { compiled, store } = await executionFixture(parallelModelDefinition());
    let releaseLeft!: () => void;
    const leftFinished = new Promise<void>((resolve) => { releaseLeft = resolve; });
    let activeSlots = 0;
    let peakSlots = 0;
    const acquired: string[] = [];
    const released: string[] = [];
    const runner = new WorkflowRunner({
      runId: "run_readability", compiled, store,
      input: { value: "parallel" }, signal: new AbortController().signal,
      acquireHostSlot: async (node) => {
        acquired.push(node.id);
        activeSlots += 1;
        peakSlots = Math.max(peakSlots, activeSlots);
        return () => { released.push(node.id); activeSlots -= 1; };
      },
      executePresetModel: async (node) => {
        if (node.id === "left") await leftFinished;
        return { output: { side: node.id } };
      },
    });
    const events = [];
    for await (const event of runner.run()) {
      events.push(event);
      if (event.type === "workflow.node.succeeded" && event.data.node_id === "right") releaseLeft();
    }

    expect(peakSlots).toBe(2);
    expect(activeSlots).toBe(0);
    expect(released.toSorted()).toEqual(acquired.toSorted());
    expect(events.filter((event) => event.type === "workflow.node.succeeded")
      .map((event) => event.data.node_id)).toEqual(["input", "right", "left", "join", "output"]);
    expect(events.at(-1)?.data.output).toEqual([{ side: "left" }, { side: "right" }]);
  });

  it("keeps one host slot across retries and preserves child-run metadata", async () => {
    const { compiled, store } = await executionFixture(retryDefinition());
    const acquired: string[] = [];
    const released: string[] = [];
    const runner = new WorkflowRunner({
      runId: "run_readability", compiled, store,
      input: { value: "retry" }, signal: new AbortController().signal,
      acquireHostSlot: async (node) => {
        acquired.push(node.id);
        return () => { released.push(node.id); };
      },
      executePresetModel: async (_node, input, context) => {
        if (context.attempt === 1) throw new WorkflowNodeExecutionError("transient", "retry", true, "child_failed");
        return { output: input, childRunId: "child_succeeded", usage: { total_tokens: 7 } };
      },
    });
    const events = [];
    for await (const event of runner.run()) events.push(event);

    expect(acquired.filter((nodeId) => nodeId === "model")).toHaveLength(1);
    expect(released.filter((nodeId) => nodeId === "model")).toHaveLength(1);
    expect(store.listNodes("run_readability").filter((node) => node.node_id === "model")
      .map((node) => [node.attempt, node.status, node.child_run_id])).toEqual([
        [1, "failed", "child_failed"], [2, "succeeded", "child_succeeded"],
      ]);
    expect(events.find((event) => event.type === "workflow.node.succeeded" && event.data.node_id === "model")?.data)
      .toMatchObject({ attempt: 2, child_run_id: "child_succeeded", usage: { total_tokens: 7 } });
  });

  it("releases an acquired slot when cancellation prevents node startup", async () => {
    const { compiled, store } = await executionFixture(parallelModelDefinition());
    const abort = new AbortController();
    const released: string[] = [];
    const runner = new WorkflowRunner({
      runId: "run_readability", compiled, store,
      input: { value: "stop" }, signal: abort.signal,
      acquireHostSlot: async (node) => {
        if (node.id === "left") abort.abort("user_stop");
        return () => { released.push(node.id); };
      },
      executePresetModel: async () => { throw new Error("Cancelled nodes must not start."); },
    });
    const events = [];
    for await (const event of runner.run()) events.push(event);

    expect(released).toEqual(["input", "left"]);
    expect(events.filter((event) => event.type === "workflow.node.started")
      .map((event) => event.data.node_id)).toEqual(["input"]);
    expect(store.listNodes("run_readability").find((node) => node.node_id === "left")?.status).toBe("stopped");
    expect(events.at(-1)).toMatchObject({ type: "workflow.run.stopped", data: { reason: "user_stop" } });
  });

  it("drains active tasks after fail-fast and journals a late successful result", async () => {
    const { compiled, store } = await executionFixture(parallelModelDefinition());
    const runner = new WorkflowRunner({
      runId: "run_readability", compiled, store,
      input: { value: "failure" }, signal: new AbortController().signal,
      executePresetModel: async (node, _input, context) => {
        if (node.id === "left") throw new WorkflowNodeExecutionError("denied", "permission denied");
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return { output: { side: "right" } };
      },
    });
    const events = [];
    for await (const event of runner.run()) events.push(event);

    expect(events.filter((event) => event.type === "workflow.node.failed")
      .map((event) => event.data.node_id)).toEqual(["left"]);
    expect(events.some((event) => event.type === "workflow.node.succeeded" && event.data.node_id === "right")).toBe(true);
    expect(store.listNodes("run_readability").find((node) => node.node_id === "right")?.status).toBe("succeeded");
    expect(store.listNodes("run_readability").find((node) => node.node_id === "join")?.status).toBe("stopped");
    expect(events.at(-1)?.type).toBe("workflow.run.failed");
  });
});

async function executionFixture(value: unknown) {
  const database = new DatabaseSync(":memory:");
  resources.push(database);
  const preset = { ref: "retry-model@1", description: "Retry model", compiled_hash: hash("model"), plugin_lock_hash: hash("plugins") };
  const runtime = new WorkflowRuntime({
    database,
    presetModels: { listPublished: () => [preset], resolve: () => preset },
  });
  const imported = await runtime.importDraft(value);
  await runtime.publish(imported.workflow.ref);
  database.exec("CREATE TABLE execution_runs(run_id TEXT PRIMARY KEY);");
  database.prepare("INSERT INTO execution_runs(run_id) VALUES ('run_readability')").run();
  const store = new WorkflowRunStore(database);
  const compiled = runtime.registry.get(imported.workflow.ref).compiled;
  store.create("run_readability", compiled);
  return { compiled, store };
}

function parallelModelDefinition() {
  const value = fanoutDefinition();
  return {
    ...value,
    spec: {
      ...value.spec,
      policy: { max_parallelism: 2 },
      nodes: value.spec.nodes.map((node) => {
        if (node.id === "left" || node.id === "right") {
          return { ...node, type: "preset_model", config: { model_ref: "retry-model@1" } };
        }
        return node;
      }),
    },
  };
}

function hash(value: string): `sha256:${string}` {
  return (`sha256:${value.padEnd(64, "0").slice(0, 64)}`) as `sha256:${string}`;
}

function definition() {
  return {
    api_version: "anomaloharis.dev/workflow/v1",
    kind: "Workflow",
    metadata: { name: "branching", version: 1, description: "Branching test workflow." },
    spec: {
      input_schema: { type: "object" },
      output_schema: {},
      nodes: [
        { id: "input", type: "input", type_version: 1, config: {} },
        { id: "condition", type: "condition", type_version: 1, config: { expression: { path: "$.go" } } },
        { id: "parallel", type: "parallel", type_version: 1, config: {} },
        { id: "false_branch", type: "parallel", type_version: 1, config: {} },
        { id: "join", type: "join", type_version: 1, config: {} },
        { id: "output", type: "output", type_version: 1, config: {} },
      ],
      edges: [
        { from: { node: "input", port: "data" }, to: { node: "condition", port: "input" } },
        { from: { node: "condition", port: "true" }, to: { node: "parallel", port: "input" } },
        { from: { node: "condition", port: "false" }, to: { node: "false_branch", port: "input" } },
        { from: { node: "false_branch", port: "output" }, to: { node: "join", port: "input" } },
        { from: { node: "parallel", port: "output" }, to: { node: "join", port: "input" } },
        { from: { node: "join", port: "output" }, to: { node: "output", port: "result" } },
      ],
    },
  };
}

function schemaIdDefinition() {
  const value = definition();
  return {
    ...value,
    metadata: { ...value.metadata, name: "schema-id-flow" },
    spec: {
      ...value.spec,
      input_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://urus.dev/schemas/remote_decision_input.v1.json",
        type: "object",
      },
      output_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://urus.dev/schemas/remote_decision_artifact.v1.json",
      },
    },
  };
}

function retryDefinition() {
  return {
    api_version: "anomaloharis.dev/workflow/v1",
    kind: "Workflow",
    metadata: { name: "retry-flow", version: 1, description: "Retry test workflow." },
    spec: {
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      nodes: [
        { id: "input", type: "input", type_version: 1, config: {} },
        { id: "model", type: "preset_model", type_version: 1, config: { model_ref: "retry-model@1" }, retry: { max_attempts: 2, backoff_ms: 0 } },
        { id: "output", type: "output", type_version: 1, config: {} },
      ],
      edges: [
        { from: { node: "input", port: "data" }, to: { node: "model", port: "input" } },
        { from: { node: "model", port: "output" }, to: { node: "output", port: "result" } },
      ],
    },
  };
}

function fanoutDefinition() {
  return {
    api_version: "anomaloharis.dev/workflow/v1",
    kind: "Workflow",
    metadata: { name: "fanout", version: 1, description: "Input fan-out test workflow." },
    spec: {
      input_schema: { type: "object" },
      output_schema: { type: "array", items: { type: "object" } },
      nodes: [
        { id: "input", type: "input", type_version: 1, config: {} },
        { id: "left", type: "parallel", type_version: 1, config: {} },
        { id: "right", type: "parallel", type_version: 1, config: {} },
        { id: "join", type: "join", type_version: 1, config: {} },
        { id: "output", type: "output", type_version: 1, config: {} },
      ],
      edges: [
        { from: { node: "input", port: "data" }, to: { node: "left", port: "input" } },
        { from: { node: "input", port: "data" }, to: { node: "right", port: "input" } },
        { from: { node: "left", port: "output" }, to: { node: "join", port: "input" } },
        { from: { node: "right", port: "output" }, to: { node: "join", port: "input" } },
        { from: { node: "join", port: "output" }, to: { node: "output", port: "result" } },
      ],
    },
  };
}
