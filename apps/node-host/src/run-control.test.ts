import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { assertLegalRunTransition, RunControl, type ExecutionRuntimeAdapter, type RunContext } from "./run-control.js";
import { RuntimeCatalog } from "./runtime-catalog.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("RunControl", () => {
  it("owns legal transitions and reuses an idempotent run", async () => {
    expect(() => assertLegalRunTransition("queued", "succeeded")).toThrow("Illegal Run transition");
    expect(() => assertLegalRunTransition("queued", "running")).not.toThrow();

    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new SuccessfulAdapter());
    const control = new RunControl(database, catalog);

    const first = control.start(
      { kind: "workflow", ref: "demo@1" },
      { clientId: "urus", input: { value: 1 }, idempotency_key: "operation-1" },
    );
    const second = control.start(
      { kind: "workflow", ref: "demo@1" },
      { clientId: "urus", input: { value: 1 }, idempotency_key: "operation-1" },
    );
    expect(second.runId).toBe(first.runId);
    expect(second.existing).toBe(true);

    const [firstEvents, secondEvents] = await Promise.all([collect(first), collect(second)]);
    expect(firstEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(secondEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(control.get(first.runId)).toMatchObject({ status: "succeeded", output: { value: 1 }, usage: { total_tokens: 2 } });
    expect(firstEvents.at(-1)).toMatchObject({ type: "run.succeeded", data: { status: "succeeded" } });
  });

  it("rejects reusing an idempotency key with a different input", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new SuccessfulAdapter());
    const control = new RunControl(database, catalog);
    control.start({ kind: "workflow", ref: "demo@1" }, { clientId: "urus", input: { value: 1 }, idempotency_key: "operation-1" });
    expect(() => control.start({ kind: "workflow", ref: "demo@1" }, { clientId: "urus", input: { value: 2 }, idempotency_key: "operation-1" })).toThrow("idempotency key");
  });

  it("converges residual running runs after a Host restart", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new SuccessfulAdapter());
    const control = new RunControl(database, catalog);
    database.prepare(`
      INSERT INTO execution_runs(run_id, runtime_kind, target_ref, target_hash, runtime_adapter_version, runtime_adapter_hash, client_id, status, input_json, request_hash, created_at)
      VALUES ('run_restart', 'workflow', 'demo@1', 'sha256:demo', 'test', 'sha256:test', 'urus', 'running', '{}', 'sha256:req', '2026-08-25T00:00:00.000Z')
    `).run();
    const recovered = await control.recover();
    expect(recovered).toEqual([{ runId: "run_restart", action: "failed" }]);
    expect(control.get("run_restart")).toMatchObject({ status: "failed" });
    expect((await collect(control.events("run_restart"))).at(-1)).toMatchObject({
      type: "run.failed",
      data: { error_code: "WORKFLOW_HOST_RESTARTED" },
    });
  });

  it("refuses to requeue a Run under a different Runtime Adapter package", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new SuccessfulAdapter());
    const control = new RunControl(database, catalog);
    database.prepare(`
      INSERT INTO execution_runs(run_id, runtime_kind, target_ref, target_hash, runtime_adapter_version, runtime_adapter_hash, client_id, status, input_json, request_hash, created_at)
      VALUES ('run_changed_adapter', 'workflow', 'demo@1', 'sha256:demo', 'test', 'sha256:other', 'urus', 'queued', '{}', 'sha256:req', '2026-08-25T00:00:00.000Z')
    `).run();

    await expect(control.recover()).resolves.toEqual([{ runId: "run_changed_adapter", action: "failed" }]);
    expect(control.get("run_changed_adapter")).toMatchObject({ status: "failed" });
  });

  it("commits stopped only after the runtime execution has converged", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new StoppableAdapter());
    const control = new RunControl(database, catalog);
    const handle = control.start({ kind: "workflow", ref: "demo@1" }, { clientId: "urus", input: {} });
    const eventsPromise = collect(handle);

    await waitUntil(() => control.eventsSnapshot(handle.runId).some((event) => event.type === "workflow.node.started"));
    await expect(control.stop(handle.runId, "user_stop")).resolves.toMatchObject({ status: "stopped" });
    const events = await eventsPromise;

    expect(events.at(-1)).toMatchObject({ type: "run.stopped" });
    expect(events.filter((event) => event.type === "run.stopped")).toHaveLength(1);
  });

  it("aggregates usage emitted by multiple workflow nodes", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new UsageAdapter());
    const control = new RunControl(database, catalog);
    const handle = control.start({ kind: "workflow", ref: "demo@1" }, { clientId: "urus", input: {} });
    await collect(handle);

    expect(control.get(handle.runId).usage).toEqual({ promptTokens: 5, totalTokens: 8, currency: "USD" });
  });

  it("derives child identity and permissions from the Workflow parent", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const catalog = new RuntimeCatalog();
    catalog.register(new SuccessfulAdapter());
    catalog.register(new CapacityAdapter());
    const control = new RunControl(database, catalog);
    database.prepare(`
      INSERT INTO execution_runs(
        run_id, runtime_kind, target_ref, target_hash, runtime_adapter_version, runtime_adapter_hash,
        client_id, status, input_json, permissions_json, request_hash, created_at
      ) VALUES ('parent', 'workflow', 'demo@1', 'sha256:demo', 'test', 'sha256:test', 'parent-client', 'running', '{}', '["compute:invoke"]', 'sha256:req', '2026-08-25T00:00:00.000Z')
    `).run();

    expect(() => control.startAgentChild("parent", { kind: "preset_model", ref: "agent@1" }, {
      input: {},
      permissions: ["compute:invoke", "admin"],
    })).toThrow("cannot widen");
    const child = control.startAgentChild("parent", { kind: "preset_model", ref: "agent@1" }, {
      input: {},
      permissions: ["compute:invoke"],
    });
    await collect(child);

    expect(control.get(child.runId)).toMatchObject({ parent_run_id: "parent", client_id: "parent-client", status: "succeeded" });
  });

  it("applies one host capacity limit to all Agent Runs", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const catalog = new RuntimeCatalog();
    const adapter = new CapacityAdapter();
    catalog.register(adapter);
    const control = new RunControl(database, catalog, { maxConcurrency: 1 });
    const first = control.start({ kind: "preset_model", ref: "agent@1" }, { clientId: "one", input: {} });
    const second = control.start({ kind: "preset_model", ref: "agent@1" }, { clientId: "two", input: {} });
    await Promise.all([collect(first), collect(second)]);

    expect(adapter.maximumActive).toBe(1);
  });
});

class SuccessfulAdapter implements ExecutionRuntimeAdapter {
  readonly kind = "workflow" as const;
  readonly version = "test";
  readonly packageHash = "sha256:test";
  readonly capabilities = ["test"];
  readonly consumesHostSlot = false;

  isHealthy(): boolean { return true; }

  resolve(ref: string) {
    return { kind: this.kind, ref, hash: "sha256:demo" } as const;
  }

  async *start(_context: RunContext, input: unknown) {
    yield { type: "workflow.run.succeeded", data: { output: input, usage: { total_tokens: 2 } }, terminal: "succeeded" as const };
  }

  stop(): void {}
}

class StoppableAdapter extends SuccessfulAdapter {
  override async *start(context: RunContext, _input: unknown) {
    yield { type: "workflow.node.started", data: { node_id: "wait" } };
    if (!context.signal.aborted) await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "workflow.run.stopped", data: { reason: "user_stop" }, terminal: "stopped" as const };
  }
}

class UsageAdapter extends SuccessfulAdapter {
  override async *start(_context: RunContext, _input: unknown) {
    yield { type: "workflow.node.succeeded", data: { usage: { promptTokens: 2, totalTokens: 3, currency: "USD" } } };
    yield { type: "workflow.node.succeeded", data: { usage: { promptTokens: 3, totalTokens: 5, currency: "USD" } } };
    yield { type: "workflow.run.succeeded", data: { output: {} }, terminal: "succeeded" as const };
  }
}

class CapacityAdapter implements ExecutionRuntimeAdapter {
  readonly kind = "preset_model" as const;
  readonly version = "test";
  readonly packageHash = "sha256:agent-test";
  readonly capabilities = ["test"];
  readonly consumesHostSlot = true;
  private active = 0;
  maximumActive = 0;

  isHealthy(): boolean { return true; }
  resolve(ref: string) { return { kind: this.kind, ref, hash: "sha256:agent" } as const; }
  async *start(_context: RunContext, input: unknown) {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active -= 1;
    yield { type: "agent.run.finished", data: { output: input }, terminal: "succeeded" as const };
  }
  stop(): void {}
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition_not_met");
}
