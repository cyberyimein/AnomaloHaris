import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowRuntime } from "@anomaloharis/workflow-runtime";

import { InMemorySessionAdapter } from "./session.js";
import { buildNodeHost } from "./host.js";
import { RuntimeCatalog } from "./runtime-catalog.js";
import { RunControl } from "./run-control.js";
import { WorkflowRuntimeAdapter } from "./workflow-runtime-adapter.js";
import { WorkflowRunStore } from "@anomaloharis/workflow-runtime";
import { ServiceAuth } from "./compute-api.js";

const apps: Array<{ close(): Promise<void> }> = [];
const databases: DatabaseSync[] = [];
const runtimes: WorkflowRuntime[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const database of databases.splice(0)) database.close();
});

describe("Workflow run API", () => {
  it("runs an exact published ref through Run Control and replays events", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const runtime = new WorkflowRuntime({ database });
    runtimes.push(runtime);
    const imported = await runtime.importDraft(definition());
    await runtime.publish(imported.workflow.ref);
    const store = new WorkflowRunStore(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new WorkflowRuntimeAdapter({ runtime, store }));
    const control = new RunControl(database, catalog);
    const sessions = new InMemorySessionAdapter();
    const app = await buildNodeHost({ sessions, model: "replay", workflowManagement: runtime, runControl: control });
    apps.push(app);

    const first = await app.inject({ method: "POST", url: "/api/workflows/simple/versions/1/runs", payload: { input: { message: "hello" }, idempotency_key: "api-run-1" } });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody.run).toMatchObject({ runtime_kind: "workflow", target_ref: "simple@1", status: "succeeded", output: { message: "hello" } });
    expect(firstBody.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const replay = await app.inject({ method: "POST", url: "/api/workflows/simple/versions/1/runs", payload: { input: { message: "hello" }, idempotency_key: "api-run-1" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().run.run_id).toBe(firstBody.run.run_id);

    const events = await app.inject({ method: "GET", url: `/api/runs/${firstBody.run.run_id}/events?after_sequence=3` });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.map((event: { sequence: number }) => event.sequence)).toEqual([4, 5, 6, 7, 8, 9]);
    const stop = await app.inject({ method: "POST", url: `/api/runs/${firstBody.run.run_id}/stop`, payload: { reason: "user_stop" } });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ stopped: false, status: "succeeded" });
  });

  it("does not run a draft or retired Workflow", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const runtime = new WorkflowRuntime({ database });
    runtimes.push(runtime);
    await runtime.importDraft(definition());
    const store = new WorkflowRunStore(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new WorkflowRuntimeAdapter({ runtime, store }));
    const control = new RunControl(database, catalog);
    const sessions = new InMemorySessionAdapter();
    const app = await buildNodeHost({ sessions, model: "replay", workflowManagement: runtime, runControl: control });
    apps.push(app);

    const response = await app.inject({ method: "POST", url: "/api/workflows/simple/versions/1/runs", payload: { input: {} } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error_code: "workflow_not_found" });
  });

  it("enforces workflow service scopes and ref allowlists", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const runtime = new WorkflowRuntime({ database });
    runtimes.push(runtime);
    const imported = await runtime.importDraft(definition());
    await runtime.publish(imported.workflow.ref);
    const store = new WorkflowRunStore(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new WorkflowRuntimeAdapter({ runtime, store }));
    const control = new RunControl(database, catalog);
    const sessions = new InMemorySessionAdapter();
    const auth = new ServiceAuth({
      required: true,
      clients: [{ id: "urus", token: "secret", scopes: ["workflow:run", "workflow:read"], workflowRefs: ["other@1"] }],
    });
    const app = await buildNodeHost({
      sessions,
      model: "replay",
      workflowManagement: runtime,
      runControl: control,
      compute: { auth, runControl: control },
    });
    apps.push(app);

    const missing = await app.inject({ method: "POST", url: "/api/workflows/simple/versions/1/runs", payload: { input: {} } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error_code: "unauthorized" });

    const forbidden = await app.inject({ method: "POST", url: "/api/workflows/simple/versions/1/runs", headers: { authorization: "Bearer secret" }, payload: { input: {} } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error_code: "workflow_ref_forbidden" });
  });
});

function definition() {
  return {
    api_version: "anomaloharis.dev/workflow/v1",
    kind: "Workflow",
    metadata: { name: "simple", version: 1, description: "Run API fixture." },
    spec: {
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      nodes: [
        { id: "input", type: "input", type_version: 1, config: {} },
        { id: "output", type: "output", type_version: 1, config: {} },
      ],
      edges: [{ from: { node: "input", port: "data" }, to: { node: "output", port: "result" } }],
    },
  };
}
