import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
import { WorkflowRuntime, type WorkflowManagement } from "@anomaloharis/workflow-runtime";
import { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";
import { RunControl } from "./run-control.js";
import { RuntimeCatalog } from "./runtime-catalog.js";

const apps: Array<{ close(): Promise<void> }> = [];
const tempDirectories: string[] = [];
const registries: SqlitePresetModelRegistry[] = [];
const workflowRuntimes: WorkflowRuntime[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const registry of registries.splice(0)) registry.close();
  for (const runtime of workflowRuntimes.splice(0)) runtime.close();
  for (const database of databases.splice(0)) database.close();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Node Host", () => {
  it("exposes the Workflow management seam without exposing run routes", async () => {
    const runtime = new WorkflowRuntime();
    workflowRuntimes.push(runtime);
    const app = await makeApp([], undefined, undefined, undefined, undefined, "admin-secret", undefined, "anomaloharis@1", undefined, undefined, undefined, runtime);
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/manage/workflow-capabilities" })).statusCode).toBe(403);
    const headers = { "x-anomaloharis-admin-token": "admin-secret" };
    const capabilities = await app.inject({ method: "GET", url: "/api/manage/workflow-capabilities", headers });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().engine.runtime_id).toBe("workflow-runtime");

    const definition = simpleWorkflowDefinition();
    const validation = await app.inject({ method: "POST", url: "/api/manage/workflows/validate", headers, payload: definition });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().validation.valid).toBe(true);

    const imported = await app.inject({ method: "POST", url: "/api/manage/workflows/import", headers, payload: definition });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().workflow.status).toBe("draft");
    expect((await app.inject({ method: "GET", url: "/api/workflows/simple@1/runs" })).statusCode).toBe(404);

    const published = await app.inject({ method: "POST", url: "/api/manage/workflows/simple/versions/1/publish", headers });
    expect(published.statusCode).toBe(200);
    const exported = await app.inject({ method: "GET", url: "/api/manage/workflows/simple/versions/1/export", headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("simple-v1.json");
  });

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

    const missingModel = await app.inject({ method: "GET", url: "/api/preset-models/luna@2" });
    expect(missingModel.statusCode).toBe(404);
    expect(missingModel.json()).toMatchObject({ error_code: "preset_model_not_found" });

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

  it("shows one current preset model by default and exposes retired history explicitly", async () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.ensureBuiltinDefault({ model: "replay-model" });
    const v1 = registry.publish(registry.createDraft({
      name: "urus-arbitration",
      version: 1,
      description: "Arbitration model",
      provider: { adapter: "openai-compatible", model: "urus-provider" },
      plugins: { fixed: [] },
    }).ref);
    registry.publish(registry.createDraft({
      ...v1.definition,
      version: 2,
      metadata: { ghost: "🦬" },
    }).ref);
    const app = await makeApp([], undefined, registry, undefined, undefined, "secret");
    apps.push(app);

    const current = await app.inject({
      method: "GET",
      url: "/api/manage/preset-models",
      headers: { "x-anomaloharis-admin-token": "secret" },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().preset_models.map((model: { ref: string }) => model.ref)).toEqual([
      "anomaloharis@1",
      "urus-arbitration@2",
    ]);

    const history = await app.inject({
      method: "GET",
      url: "/api/manage/preset-models?include_history=true",
      headers: { "x-anomaloharis-admin-token": "secret" },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().preset_models.map((model: { ref: string; status: string }) => `${model.ref}:${model.status}`)).toEqual([
      "anomaloharis@1:published",
      "urus-arbitration@2:published",
      "urus-arbitration@1:retired",
    ]);
  });

  it("exposes model-scoped Skill metadata without exposing Skill bodies", async () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.ensureBuiltinDefault({ model: "replay-model" });
    registry.publish(registry.createDraft({
      name: "progressive-skill-model",
      version: 1,
      description: "Progressive Skills",
      provider: { adapter: "openai-compatible", model: "skill-provider" },
      prompt: {
        skills: [
          { content: "---\nname: invoice-review\ndescription: Review invoices.\n---\n\nPrivate invoice rules." },
          { content: "---\nname: contract-review\ndescription: Review contracts.\n---\n\nPrivate contract rules." },
        ],
      },
      plugins: { fixed: [] },
    }).ref);
    const app = await makeApp([], undefined, registry, undefined, undefined, "secret", undefined, "progressive-skill-model@1");
    apps.push(app);

    const listed = await app.inject({ method: "GET", url: "/api/sessions/skill-session/skills?preset_model=progressive-skill-model@1" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().skills).toEqual([
      expect.objectContaining({ name: "contract-review", summary: "Review contracts.", instructions_available: true }),
      expect.objectContaining({ name: "invoice-review", summary: "Review invoices.", instructions_available: true }),
    ]);
    expect(JSON.stringify(listed.json())).not.toContain("Private invoice rules.");

    const activated = await app.inject({
      method: "PUT",
      url: "/api/sessions/skill-session/skills?preset_model=progressive-skill-model@1",
      payload: { active_skills: ["invoice-review"] },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ active_skills: ["invoice-review"] });
  });

  it("rejects Skill API requests scoped to a different model than the bound Session", async () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.ensureBuiltinDefault({ model: "replay-model" });
    const bound = registry.publish(registry.createDraft({
      name: "bound-skill-model",
      version: 1,
      description: "Bound Skill model",
      provider: { adapter: "openai-compatible", model: "bound-skill-provider" },
      prompt: { skills: [{ content: "---\nname: bound-review\ndescription: Review bound documents.\n---\n\nBound rules." }] },
      plugins: { fixed: [] },
    }).ref);
    const other = registry.publish(registry.createDraft({
      name: "other-skill-model",
      version: 1,
      description: "Other Skill model",
      provider: { adapter: "openai-compatible", model: "other-skill-provider" },
      prompt: { skills: [{ content: "---\nname: other-review\ndescription: Review other documents.\n---\n\nOther rules." }] },
      plugins: { fixed: [] },
    }).ref);
    const sessions = new InMemorySessionAdapter();
    await sessions.setPresetModel("bound-skill-session", bound.ref);
    const app = await makeApp([], undefined, registry, undefined, undefined, "secret", sessions);
    apps.push(app);

    const listed = await app.inject({ method: "GET", url: `/api/sessions/bound-skill-session/skills?preset_model=${other.ref}` });
    expect(listed.statusCode).toBe(409);
    expect(listed.json()).toMatchObject({ error_code: "session_model_mismatch" });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/sessions/bound-skill-session/skills?preset_model=${other.ref}`,
      payload: { active_skills: ["other-review"] },
    });
    expect(updated.statusCode).toBe(409);
    expect(updated.json()).toMatchObject({ error_code: "session_model_mismatch" });

    const tools = await app.inject({
      method: "GET",
      url: `/api/tools?session_id=bound-skill-session&preset_model=${other.ref}`,
    });
    expect(tools.statusCode).toBe(409);
    expect(tools.json()).toMatchObject({ error_code: "session_model_mismatch" });
  });

  it("does not expose current deployment Skills for a Session whose model is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "anomaloharis-host-missing-skill-model-"));
    tempDirectories.push(root);
    mkdirSync(join(root, "skills", "current-skill"), { recursive: true });
    writeFileSync(join(root, "skills", "current-skill", "SKILL.md"), "---\nname: current-skill\ndescription: Current deployment rules.\n---\n\nCurrent deployment instructions.");
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.ensureBuiltinDefault({ model: "replay-model" });
    const sessions = new InMemorySessionAdapter();
    await sessions.setPresetModel("missing-skill-model-session", "removed-model@1");
    const app = await makeApp(
      [],
      undefined,
      registry,
      new FileResourceLoader({ projectRoot: root, skillDirs: [join(root, "skills")] }),
      undefined,
      undefined,
      sessions,
    );
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/sessions/missing-skill-model-session/skills" });

    expect(response.statusCode).toBe(200);
    expect(response.json().skills).toEqual([]);
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
  workflowManagement?: WorkflowManagement,
) {
  const tools = new DeterministicToolRuntime([]);
  const model = new ReplayModelAdapter(steps);
  const sessions = sessionAdapter ?? new InMemorySessionAdapter();
  const core = new AgentCore({ model, tools, sessions });
  const controller = new RunController(core);
  const effectiveRegistry = presetModels ?? new SqlitePresetModelRegistry(":memory:");
  if (!presetModels) {
    effectiveRegistry.ensureBuiltinDefault({ model: "replay-model" });
    registries.push(effectiveRegistry);
  }
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const catalog = new RuntimeCatalog();
  catalog.register(new AgentRuntimeAdapter({ registry: effectiveRegistry, controller }));
  const runControl = new RunControl(database, catalog);
  return buildNodeHost({
    sessions,
    model: "replay-model",
    presetModels: effectiveRegistry,
    defaultPresetModel,
    runControl,
    tools,
    ...(staticDir ? { staticDir } : {}),
    ...(resources ? { resources } : {}),
    ...(plugins ? { plugins } : {}),
    ...(pluginCatalog ? { pluginCatalog } : {}),
    ...(buddy ? { buddy } : {}),
    ...(pythonSandbox ? { pythonSandbox } : {}),
    ...(managementToken ? { managementToken } : {}),
    ...(workflowManagement ? { workflowManagement } : {}),
  });
}

function simpleWorkflowDefinition() {
  return {
    api_version: "anomaloharis.dev/workflow/v1",
    kind: "Workflow",
    metadata: { name: "simple", version: 1, description: "A simple management fixture." },
    spec: {
      input_schema: { type: "object", properties: { message: { type: "string" } }, additionalProperties: false },
      output_schema: { type: "object", properties: { message: { type: "string" } }, additionalProperties: false },
      nodes: [
        { id: "input", type: "input", type_version: 1, config: {} },
        { id: "output", type: "output", type_version: 1, config: {} },
      ],
      edges: [{ from: { node: "input", port: "data" }, to: { node: "output", port: "result" } }],
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for WebSocket message.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
