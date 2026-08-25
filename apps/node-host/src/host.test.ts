import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "./core.js";
import type { BuddyDashboardClient } from "./buddy-dashboard.js";
import { RunController } from "./controller.js";
import { ReplayModelAdapter, type ReplayStep } from "./model.js";
import { InMemorySessionAdapter } from "./session.js";
import { buildNodeHost } from "./host.js";
import { DeterministicToolRuntime } from "./tools.js";
import { SqlitePresetModelRegistry } from "./preset-models.js";
import { FileResourceLoader } from "./resources.js";
import { builtinPluginCatalog, type PluginCatalog } from "./plugin-catalog.js";
import type { PluginHost } from "./plugins.js";
import { PythonSandboxRuntime, PYTHON_SANDBOX_TOOL_NAME } from "./python-sandbox.js";
import type { SessionCheckpoint } from "./types.js";

const apps: Array<{ close(): Promise<void> }> = [];
const tempDirectories: string[] = [];
const registries: SqlitePresetModelRegistry[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const registry of registries.splice(0)) registry.close();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Node Host", () => {
  it("serves health, chat, session, and NDJSON endpoints", async () => {
    const app = await makeApp([
      [{ type: "text.delta", text: "hello from node" }, { type: "done" }],
      [{ type: "text.delta", text: "streamed" }, { type: "done" }],
    ]);
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok", runtime: "node", session_schema: 2 });

    expect((await app.inject({ method: "GET", url: "/api/tools?session_id=host-session" })).json().tools).toEqual([]);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { session_id: "host-session", message: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ session_id: "host-session", final_text: "hello from node" });

    const stream = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: { session_id: "stream-session", message: "stream" },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("application/x-ndjson");
    expect(stream.body.trim().split("\n").map((line) => JSON.parse(line).type)).toContain("run.finished");

    const sessions = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(sessions.json().sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: "host-session", title: "hello" }),
      expect.objectContaining({ session_id: "stream-session", title: "stream" }),
    ]));
  });

  it("keeps connection controls separate from run events on WebSocket", async () => {
    const app = await makeApp([[{ type: "text.delta", text: "websocket result" }, { type: "done" }]]);
    apps.push(app);
    await app.ready();
    const messages: Array<Record<string, unknown>> = [];
    const socket = await app.injectWS("/ws/chat/ws-session", {}, {
      onInit: (ws) => ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>)),
    });

    socket.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => messages.some((message) => message.type === "pong"));
    expect(messages.some((message) => message.type === "session.state")).toBe(true);

    socket.send(JSON.stringify({ type: "user.message", session_id: "ws-session", content: "hi" }));
    await waitFor(() => messages.some((message) => message.type === "run.finished"));
    expect(messages.find((message) => message.type === "run.finished")).toMatchObject({
      session_id: "ws-session",
    });
    socket.close();
  });

  it("serves the frontend shell when a static directory is configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "anomaloharis-node-host-"));
    tempDirectories.push(directory);
    writeFileSync(join(directory, "index.html"), "<html>node-host</html>");
    writeFileSync(join(directory, "app.js"), "console.log('asset')");
    const app = await makeApp([], directory);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("node-host");
    const asset = await app.inject({ method: "GET", url: "/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("asset");
  });

  it("resolves the default Preset Model and rejects a session model switch", async () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.ensureBuiltinDefault({ model: "replay-model" });
    registry.publish(registry.createDraft({
      name: "luna",
      version: 1,
      description: "Coding model",
      provider: { adapter: "openai-compatible", model: "luna-provider", tool_protocol: "auto" },
      plugins: { fixed: ["host-core"] },
    }).ref);
    const app = await makeApp([
      [{ type: "text.delta", text: "default" }, { type: "done" }],
      [{ type: "text.delta", text: "compat" }, { type: "done" }],
    ], undefined, registry);
    apps.push(app);

    const models = await app.inject({ method: "GET", url: "/api/preset-models" });
    expect(models.json()).toMatchObject({ default_preset_model: "anomaloharis@1" });
    expect(models.json().preset_models).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: "anomaloharis@1", status: "published" }),
      expect.objectContaining({ ref: "luna@1", status: "published" }),
    ]));

    const first = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { session_id: "bound-session", message: "hello" },
    });
    expect(first.statusCode).toBe(200);
    const override = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        session_id: "override-session",
        message: "hello",
        response_format: { type: "json_object" },
      },
    });
    expect(override.statusCode).toBe(400);
    expect(override.json()).toMatchObject({ error_code: "preset_model_override_forbidden" });
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(404);
    const mismatch = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { session_id: "bound-session", message: "switch", preset_model: "luna@1" },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ error_code: "session_model_mismatch" });
  });

  it("uses the saved retrieval mode for the implicit built-in default preset", async () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.ensureBuiltinDefault({ model: "replay-model" });
    const sessions = new InMemorySessionAdapter();
    await sessions.setSearchMode("retrieval-session", "native");
    const app = await makeApp(
      [[{ type: "text.delta", text: "native mode" }, { type: "done" }]],
      undefined,
      registry,
      undefined,
      undefined,
      undefined,
      sessions,
    );
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { session_id: "retrieval-session", message: "search" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.started", data: expect.objectContaining({ search_mode: "native" }) }),
    ]));
  });

  it("rejects retrieval mode changes while a run checkpoint can be resumed", async () => {
    const sessions = new InMemorySessionAdapter();
    await sessions.checkpoint({
      runId: "checkpoint-run",
      sessionId: "checkpoint-session",
      reason: "stopped",
      iteration: 1,
      state: {
        promptProfile: "agent",
        originalUserContent: "search",
        currentUserMessage: { role: "user", content: "search" },
        assistantText: "",
        pendingToolCalls: [],
        completedToolCallIds: [],
        loopMessages: [],
        bootstrapContext: [],
        model: "replay-model",
        searchMode: "diy",
      },
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    } satisfies SessionCheckpoint);
    const app = await makeApp([], undefined, undefined, undefined, undefined, undefined, sessions);
    apps.push(app);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/sessions/checkpoint-session/search-mode",
      payload: { mode: "native" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error_code: "search_mode_checkpoint_active" });
  });

  it("keeps an existing session on its bound model when the default changes", async () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.ensureBuiltinDefault({ model: "default-provider" });
    registry.publish(registry.createDraft({
      name: "luna",
      version: 1,
      description: "New default",
      provider: { adapter: "openai-compatible", model: "luna-provider", tool_protocol: "auto" },
      plugins: { fixed: [] },
    }).ref);
    const sessions = new InMemorySessionAdapter();
    const first = await makeApp(
      [[{ type: "text.delta", text: "first" }, { type: "done" }]],
      undefined,
      registry,
      undefined,
      undefined,
      undefined,
      sessions,
      "anomaloharis@1",
    );
    apps.push(first);
    const initial = await first.inject({ method: "POST", url: "/api/chat", payload: { session_id: "stable-session", message: "first" } });
    expect(initial.statusCode).toBe(200);

    const second = await makeApp(
      [[{ type: "text.delta", text: "second" }, { type: "done" }]],
      undefined,
      registry,
      undefined,
      undefined,
      undefined,
      sessions,
      "luna@1",
    );
    apps.push(second);
    const continued = await second.inject({ method: "POST", url: "/api/chat", payload: { session_id: "stable-session", message: "continue" } });
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({ final_text: "second" });
  });

  it("serves resource debug APIs and keeps management/plugin metadata separate", async () => {
    const root = mkdtempSync(join(tmpdir(), "anomaloharis-host-resources-"));
    tempDirectories.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "prompts.yaml"), "profiles:\n  agent:\n    messages:\n      - role: system\n        content: |\n          Luna prompt.\n");
    const resources = new FileResourceLoader({
      projectRoot: root,
      promptConfigPath: join(root, "config", "prompts.yaml"),
    });
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.ensureBuiltinDefault({ model: "replay-model" });
    const app = await makeApp([], undefined, registry, resources, undefined, "secret");
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/prompts" })).json()).toMatchObject({
      profile: "agent",
      messages: [{ role: "system", content: expect.stringContaining("Luna prompt.") }],
    });
    expect((await app.inject({ method: "POST", url: "/api/memory/upload", payload: { content: "memory from UI" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/memory" })).json()).toMatchObject({ content: "memory from UI" });

    const mode = await app.inject({ method: "PATCH", url: "/api/sessions/resource-session/search-mode", payload: { mode: "native" } });
    expect(mode.json()).toMatchObject({ session_id: "resource-session", mode: "native" });
    expect((await app.inject({ method: "GET", url: "/api/sessions/resource-session/search-mode" })).json().mode).toBe("native");
    expect((await app.inject({ method: "GET", url: "/api/plugins" })).json()).toEqual({ plugins: [] });

    expect((await app.inject({ method: "GET", url: "/api/manage/preset-models" })).statusCode).toBe(403);
    const draft = await app.inject({
      method: "POST",
      url: "/api/manage/preset-models",
      headers: { "x-anomaloharis-admin-token": "secret" },
      payload: {
        name: "luna",
        version: 1,
        description: "Coding model",
        provider: { adapter: "openai-compatible", model: "luna-provider" },
      },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().preset_model.ref).toBe("luna@1");

    const legacyHeaderDraft = await app.inject({
      method: "POST",
      url: "/api/manage/preset-models",
      headers: { "x-anomalo-admin-token": "secret" }, // naming-compat
      payload: {
        name: "legacy-header",
        version: 1,
        description: "Legacy header compatibility check",
        provider: { adapter: "openai-compatible", model: "legacy-header-provider" },
      },
    });
    expect(legacyHeaderDraft.statusCode).toBe(201);
    expect(legacyHeaderDraft.json().preset_model.ref).toBe("legacy-header@1");
  });

  it("shows registered plugin catalog entries even when optional child plugins are disabled", async () => {
    const app = await makeApp([], undefined, undefined, undefined, undefined, undefined, undefined, "anomaloharis@1", builtinPluginCatalog());
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/plugins" });

    expect(response.statusCode).toBe(200);
    expect(response.json().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "buddy-bridge", state: "catalogued", loaded: false }),
      expect.objectContaining({ id: "web", tools: expect.arrayContaining(["web_search"]) }),
    ]));
  });

  it("keeps Buddy dashboard control behind management access and proxies only allowlisted operations", async () => {
    const buddy = {
      status: async () => ({ connected: true, transport: "tcp" }),
      events: async () => ({ events: [] }),
      connect: async () => ({ connected: true }),
      disconnect: async () => ({ connected: false }),
      setState: async (body: Record<string, unknown>) => ({ state: body.state }),
    } as unknown as BuddyDashboardClient;
    const app = await makeApp([], undefined, undefined, undefined, undefined, "secret", undefined, "anomaloharis@1", undefined, buddy);
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/buddy/status" })).statusCode).toBe(403);
    const status = await app.inject({ method: "GET", url: "/api/buddy/status", headers: { "x-anomaloharis-admin-token": "secret" } });
    expect(status.json()).toEqual({ connected: true, transport: "tcp" });
    const state = await app.inject({
      method: "POST",
      url: "/api/buddy/state",
      headers: { "x-anomaloharis-admin-token": "secret" },
      payload: { state: "thinking" },
    });
    expect(state.json()).toEqual({ state: "thinking" });
  });

  it("serves Python artifacts only through signed session-bound URLs", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "anomaloharis-host-artifacts-"));
    tempDirectories.push(artifactsDir);
    const pythonSandbox = new PythonSandboxRuntime({
      baseUrl: "http://fruitspy.test",
      token: "fruitspy-secret",
      artifactsDir,
      artifactAccessSecret: "artifact-secret",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/api/v1/tools/python")) return new Response(JSON.stringify({ ready: true }), { status: 200 });
        if (String(url).endsWith("/artifacts/chart.png")) return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
        return new Response(JSON.stringify({
          ok: true,
          execution_id: "exec_host",
          artifacts: [{ name: "chart.png", media_type: "image/png", download_url: "/api/v1/tools/python/executions/exec_host/artifacts/chart.png" }],
        }), { status: 200 });
      },
    });
    const result = await pythonSandbox.call(
      { id: "artifact-call", name: PYTHON_SANDBOX_TOOL_NAME, arguments: { code: "plot()", artifacts: [{ path: "chart.png" }] } },
      {
        sessionId: "artifact-session",
        runId: "artifact-run",
        searchMode: "diy",
        model: "replay",
        activeSkills: new Set(),
        activeMcpServers: new Set(),
      },
      new AbortController().signal,
    );
    const artifactUrl = String((result.data as { artifacts: Array<{ url: string }> }).artifacts[0]?.url);
    const app = await makeApp([], undefined, undefined, undefined, undefined, undefined, undefined, "anomaloharis@1", undefined, undefined, pythonSandbox);
    apps.push(app);

    expect((await app.inject({ method: "GET", url: artifactUrl })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: artifactUrl })).headers).toMatchObject({
      "content-disposition": "inline; filename=\"chart.png\"",
      "x-content-type-options": "nosniff",
    });
    expect((await app.inject({ method: "GET", url: artifactUrl.split("?")[0] })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: artifactUrl.replace("artifact-session", "other-session") })).statusCode).toBe(404);
  });
});

async function makeApp(
  steps: ReplayStep[],
  staticDir?: string,
  presetModels?: SqlitePresetModelRegistry,
  resources?: FileResourceLoader,
  plugins?: PluginHost,
  managementToken?: string,
  sessionAdapter?: InMemorySessionAdapter,
  defaultPresetModel = "anomaloharis@1",
  pluginCatalog?: PluginCatalog,
  buddy?: BuddyDashboardClient,
  pythonSandbox?: PythonSandboxRuntime,
) {
  const tools = new DeterministicToolRuntime([]);
  const model = new ReplayModelAdapter(steps);
  const sessions = sessionAdapter ?? new InMemorySessionAdapter();
  const core = new AgentCore({ model, tools, sessions });
  return buildNodeHost({
    controller: new RunController(core),
    sessions,
    model: "replay-model",
    ...(presetModels ? { presetModels, defaultPresetModel } : {}),
    tools,
    ...(staticDir ? { staticDir } : {}),
    ...(resources ? { resources } : {}),
    ...(plugins ? { plugins } : {}),
    ...(pluginCatalog ? { pluginCatalog } : {}),
    ...(buddy ? { buddy } : {}),
    ...(pythonSandbox ? { pythonSandbox } : {}),
    ...(managementToken ? { managementToken } : {}),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for WebSocket message.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
