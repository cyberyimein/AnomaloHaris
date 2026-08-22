import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "./core.js";
import { InMemoryIdempotencyRepository, InMemoryUsageRepository, ServiceAuth, SqliteComputeStore } from "./compute-api.js";
import { RunController } from "./controller.js";
import { ReplayModelAdapter, type ReplayStep } from "./model.js";
import { SqlitePresetModelRegistry } from "./preset-models.js";
import { InMemorySessionAdapter } from "./session.js";
import { buildNodeHost } from "./host.js";
import { DeterministicToolRuntime } from "./tools.js";

const apps: Array<{ close(): Promise<void> }> = [];
const registries: SqlitePresetModelRegistry[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const registry of registries.splice(0)) registry.close();
});

describe("OpenAI-compatible compute API", () => {
  it("lists published preset models and returns standard non-streaming completions", async () => {
    const usage = new InMemoryUsageRepository();
    const app = await makeApp([[{ type: "text.delta", text: "hello" }, { type: "done" }]], usage);
    apps.push(app);

    const models = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer luna-token" } });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({ object: "list", data: [expect.objectContaining({ id: "luna@1" })] });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer luna-token" },
      payload: { model: "luna@1", messages: [{ role: "user", content: "hello" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: "luna@1",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    });
    await expect(usage.list()).resolves.toEqual([expect.objectContaining({ status: "completed", modelRef: "luna@1" })]);
  });

  it("keeps tools private, supports SSE, and enforces idempotency", async () => {
    const idempotency = new InMemoryIdempotencyRepository();
    const app = await makeApp([
      [{ type: "text.delta", text: "streamed" }, { type: "done" }],
      [{ type: "text.delta", text: "once" }, { type: "done" }],
    ], new InMemoryUsageRepository(), idempotency);
    apps.push(app);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer luna-token" },
      payload: { model: "luna@1", messages: [{ role: "user", content: "hello" }], tools: [] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "invalid_request" } });

    const stream = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer luna-token" },
      payload: { model: "luna@1", stream: true, messages: [{ role: "user", content: "stream" }] },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain('"content":"streamed"');
    expect(stream.body).toContain("[DONE]");

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer luna-token", "idempotency-key": "same-request" },
      payload: { model: "luna@1", messages: [{ role: "user", content: "once" }] },
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer luna-token", "idempotency-key": "same-request" },
      payload: { model: "luna@1", messages: [{ role: "user", content: "once" }] },
    });
    expect(first.json()).toEqual(replay.json());
    const reused = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer luna-token", "idempotency-key": "same-request" },
      payload: { model: "luna@1", messages: [{ role: "user", content: "different" }] },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
  });

  it("supports native preset-model runs and protects routes with scopes", async () => {
    const app = await makeApp([[{ type: "text.delta", text: "native" }, { type: "done" }]]);
    apps.push(app);
    const missing = await app.inject({ method: "GET", url: "/v1/models" });
    expect(missing.statusCode).toBe(401);
    const run = await app.inject({
      method: "POST",
      url: "/api/preset-models/luna/versions/1/runs",
      headers: { authorization: "Bearer luna-token" },
      payload: { session_id: "native-session", message: "run" },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ model: "luna@1", events: expect.arrayContaining([expect.objectContaining({ type: "run.finished" })]) });
    const runId = run.json().run_id as string;
    const events = await app.inject({ method: "GET", url: `/api/runs/${runId}/events`, headers: { authorization: "Bearer luna-token" } });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.at(-1).type).toBe("run.finished");
  });

  it("persists usage and idempotency records in the compute store", async () => {
    const store = new SqliteComputeStore(":memory:");
    await store.begin({
      requestId: "request-1",
      runId: "run-1",
      clientId: "client-1",
      modelRef: "luna@1",
      providerModel: "luna-provider",
      status: "running",
      inputTokens: 1,
      outputTokens: 0,
      totalTokens: 1,
      startedAt: "2026-08-22T00:00:00.000Z",
    });
    await store.finish({
      requestId: "request-1",
      runId: "run-1",
      clientId: "client-1",
      modelRef: "luna@1",
      providerModel: "luna-provider",
      status: "completed",
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      startedAt: "2026-08-22T00:00:00.000Z",
      endedAt: "2026-08-22T00:00:00.010Z",
      latencyMs: 10,
    });
    await store.put({ clientId: "client-1", key: "key-1", requestHash: "hash-1", response: { id: "chatcmpl-1" }, createdAt: "2026-08-22T00:00:00.000Z" });
    expect(await store.list()).toEqual([expect.objectContaining({ status: "completed", totalTokens: 3, latencyMs: 10 })]);
    await expect(store.get("client-1", "key-1")).resolves.toMatchObject({ requestHash: "hash-1", response: { id: "chatcmpl-1" } });
    store.close();
  });
});

async function makeApp(
  steps: ReplayStep[],
  usage = new InMemoryUsageRepository(),
  idempotency = new InMemoryIdempotencyRepository(),
) {
  const registry = new SqlitePresetModelRegistry(":memory:");
  registries.push(registry);
  registry.createDraft({
    name: "luna",
    version: 1,
    description: "Coding preset",
    provider: { adapter: "openai-compatible", model: "luna-provider", tool_protocol: "auto" },
    plugins: { fixed: [] },
  });
  registry.publish("luna@1");
  const sessions = new InMemorySessionAdapter();
  const core = new AgentCore({ model: new ReplayModelAdapter(steps), tools: new DeterministicToolRuntime([]), sessions });
  const app = await buildNodeHost({
    controller: new RunController(core),
    sessions,
    model: "luna-provider",
    presetModels: registry,
    defaultPresetModel: "luna@1",
    compute: {
      auth: new ServiceAuth({ clients: [{ id: "luna-client", token: "luna-token" }] }),
      usage,
      idempotency,
    },
  });
  return app;
}
