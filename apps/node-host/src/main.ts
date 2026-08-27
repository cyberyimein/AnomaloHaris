import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentCore } from "./core.js";
import { ResourceContextBuilder } from "./context.js";
import { BuddyDashboardClient } from "./buddy-dashboard.js";
import { buildNodeHost } from "./host.js";
import { OpenAICompatibleAdapter, ProviderUnavailableError, type ModelAdapter, type ModelCompletion, type ModelRequest, type ModelStreamEvent } from "./model.js";
import { BrowserToolBridge, BrowserToolRuntime } from "./browser.js";
import { FileResourceLoader } from "./resources.js";
import { ChildProcessPluginBackend, PiPluginHost, readPluginLoadConfig } from "./plugins.js";
import { builtinPluginCatalog, createPluginManifest } from "./plugin-catalog.js";
import { DEFAULT_PRESET_MODEL_REF, SqlitePresetModelRegistry, type CompiledPresetModel } from "./preset-models.js";
import { DEFAULT_SEARCH_MODE, DEFAULT_SUBAGENT_MODEL, isSearchMode, ResponsesSearchRuntime } from "./retrieval.js";
import { PythonSandboxRuntime } from "./python-sandbox.js";
import { SqliteSessionAdapter } from "./sqlite.js";
import { RunController } from "./controller.js";
import { asToolAdapter, CompositeToolRuntime, CoreToolRuntime, PluginToolAdapter, TimeZoneToolRuntime } from "./tools.js";
import { SkillRuntime, SkillToolRuntime } from "./skills.js";
import { WebToolRuntime } from "./web.js";
import { ServiceAuth, SqliteComputeStore, SqliteNativeRunStore } from "./compute-api.js";
import { legacyNamingAdapter } from "@anomaloharis/contracts";
import { WorkflowRuntime } from "@anomaloharis/workflow-runtime";
import { WorkflowRunStore } from "@anomaloharis/workflow-runtime";
import { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";
import { RuntimeCatalog } from "./runtime-catalog.js";
import { RunControl } from "./run-control.js";
import { WorkflowRuntimeAdapter } from "./workflow-runtime-adapter.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const env = (name: string): string | undefined => legacyNamingAdapter.readEnv(process.env, name);
const dataDir = resolve(env("ANOMALOHARIS_DATA_DIR") ?? join(repoRoot, "data"));
const databasePath = env("ANOMALOHARIS_SESSION_DB_PATH") || join(dataDir, "sessions.sqlite3");
const presetModelDatabasePath = env("ANOMALOHARIS_PRESET_MODEL_DB_PATH") || join(dataDir, "preset-models.sqlite3");
const computeDatabasePath = env("ANOMALOHARIS_COMPUTE_DB_PATH") || join(dataDir, "compute.sqlite3");
const modelName = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const defaultPresetModelRef = env("ANOMALOHARIS_DEFAULT_PRESET_MODEL") || DEFAULT_PRESET_MODEL_REF;
const apiKey = process.env.OPENROUTER_API_KEY;
const managementApiKey = process.env.OPENROUTER_MANAGEMENT_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
const artifactAccessSecret = env("ANOMALOHARIS_ARTIFACT_SECRET") || env("ANOMALOHARIS_ADMIN_TOKEN");
const configuredSearchMode = env("ANOMALOHARIS_SEARCH_MODE");
const defaultSearchMode = isSearchMode(configuredSearchMode) ? configuredSearchMode : DEFAULT_SEARCH_MODE;
const subagentModel = process.env.WEB_RESEARCH_SUBAGENT_MODEL?.trim() || DEFAULT_SUBAGENT_MODEL;
const searchTimeoutMs = Number(process.env.SEARCH_MODE_TIMEOUT_SECONDS ?? "90") * 1000;
const workflowRefAllowlist = (env("ANOMALOHARIS_WORKFLOW_ALLOWED_REFS") ?? "").split(",").map((ref) => ref.trim()).filter(Boolean);
const staticDir = env("ANOMALOHARIS_FRONTEND_DIR") ?? join(repoRoot, "runtime-bundle", "app", "frontend");
const port = Number(process.env.PORT ?? "8000");
const requestedHost = process.env.HOST ?? "127.0.0.1";
const isPublicHost = requestedHost !== "127.0.0.1" && requestedHost !== "::1" && requestedHost !== "localhost";
const host = isPublicHost && env("ANOMALOHARIS_ACKNOWLEDGE_PUBLIC_HOST") !== "true" ? "127.0.0.1" : requestedHost;
const hasPublicBinding = host === requestedHost && isPublicHost;
const providerCredits = baseUrl.includes("openrouter.ai")
  ? async (): Promise<Record<string, unknown>> => {
    if (!managementApiKey) {
      return {
        status: "config_missing",
        configured: false,
        message: "Set OPENROUTER_MANAGEMENT_API_KEY to show OpenRouter credits.",
      };
    }
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/credits`, {
        headers: { Authorization: `Bearer ${managementApiKey}`, Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Provider credits request failed with HTTP ${response.status}.`);
      const raw = await response.json() as { data?: unknown } & Record<string, unknown>;
      const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? raw.data as Record<string, unknown>
        : raw;
      const totalCredits = numberOrNull(data.total_credits);
      const totalUsage = numberOrNull(data.total_usage);
      return {
        status: "ready",
        configured: true,
        currency: "USD",
        total_credits: totalCredits,
        total_usage: totalUsage,
        remaining_credits: totalCredits !== null && totalUsage !== null ? Math.max(totalCredits - totalUsage, 0) : null,
        updated_at: new Date().toISOString(),
        cached: false,
      };
    } catch (error) {
      return {
        status: "error",
        configured: true,
        message: `Credit refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  : undefined;

const extensionsEnabled = env("ANOMALOHARIS_PI_EXTENSIONS_ENABLED") === "true";
const pluginConfig = extensionsEnabled
  ? readPluginLoadConfig(env("ANOMALOHARIS_PLUGIN_CONFIG") ?? join(repoRoot, "runtime-bundle", "config", "plugins.yaml"))
  : { plugins: [] };
const pluginCatalog = builtinPluginCatalog();
for (const spec of pluginConfig.plugins) {
  if (pluginCatalog.get(spec.id)) continue;
  pluginCatalog.register(createPluginManifest({
    id: spec.id,
    version: spec.version ?? "0.0.0-local",
    package: spec.package ?? `@local/${spec.id}`,
    entry: spec.entry ?? ".",
    compatibility: spec.compatibility,
    permissions: spec.permissions ?? [],
    capabilities: spec.capabilities ?? [],
    ...(spec.entry && existsSync(spec.entry) ? { packageRoot: spec.entry } : {}),
  }));
}

const resources = new FileResourceLoader({
  projectRoot: repoRoot,
  skillDirs: [join(repoRoot, "runtime-bundle", "skills")],
  mcpConfigPath: join(repoRoot, "runtime-bundle", "config", "mcp_servers.yaml"),
});
const skillRuntime = new SkillRuntime();
const bundledSkillSnapshot = resources.skillSnapshot();
const presetModels = new SqlitePresetModelRegistry(presetModelDatabasePath, {
  catalog: pluginCatalog,
  resolvePrompt: (profile) => resources.promptText(profile),
  bundledSkillSnapshot,
});
const serviceClients = parseServiceClients(env("ANOMALOHARIS_SERVICE_TOKENS"), env("ANOMALOHARIS_SERVICE_TOKEN"));
if (hasPublicBinding && serviceClients.length === 0) {
  throw new Error("Public host binding requires ANOMALOHARIS_SERVICE_TOKEN or ANOMALOHARIS_SERVICE_TOKENS.");
}
if (hasPublicBinding && !env("ANOMALOHARIS_ADMIN_TOKEN")) {
  throw new Error("Public host binding requires a separate ANOMALOHARIS_ADMIN_TOKEN.");
}
const computeStore = new SqliteComputeStore(computeDatabasePath);
const serviceAuth = new ServiceAuth({
  clients: serviceClients,
  required: env("ANOMALOHARIS_SERVICE_AUTH_REQUIRED") === "true" || serviceClients.length > 0 || hasPublicBinding,
});
presetModels.ensureBuiltinDefault({
  model: modelName,
  promptProfile: env("ANOMALOHARIS_AGENT_PROMPT_PROFILE") ?? "agent",
});
presetModels.ensureBuiltinUrusScheduledEvent({ model: modelName });
const defaultPresetModel = presetModels.resolve(defaultPresetModelRef);

const browserBridge = new BrowserToolBridge(Number(process.env.BROWSER_TOOL_TIMEOUT_SECONDS ?? "60") * 1000);
const pythonSandbox = new PythonSandboxRuntime({
  enabled: process.env.PYTHON_SANDBOX_ENABLED !== "false",
  ...(process.env.FRUITSPY_PYTHON_TOOL_BASE_URL ? { baseUrl: process.env.FRUITSPY_PYTHON_TOOL_BASE_URL } : {}),
  ...(process.env.FRUITSPY_PYTHON_TOOL_API_PATH ? { apiPath: process.env.FRUITSPY_PYTHON_TOOL_API_PATH } : {}),
  ...(process.env.FRUITSPY_PYTHON_TOOL_TOKEN ? { token: process.env.FRUITSPY_PYTHON_TOOL_TOKEN } : {}),
  defaultTimeoutMs: Number(process.env.PYTHON_SANDBOX_TIMEOUT_SECONDS ?? "10") * 1000,
  statusTimeoutMs: Number(process.env.FRUITSPY_PYTHON_TOOL_STATUS_TIMEOUT_SECONDS ?? "2") * 1000,
  artifactsDir: join(dataDir, "artifacts"),
  ...(artifactAccessSecret ? { artifactAccessSecret } : {}),
});
const buddyServiceUrl = env("ANOMALOHARIS_BUDDY_SERVICE_URL")?.trim();
const buddyServiceToken = env("ANOMALOHARIS_BUDDY_SERVICE_TOKEN");
const buddyDashboard = buddyServiceUrl
  ? new BuddyDashboardClient({
    baseUrl: buddyServiceUrl,
    ...(buddyServiceToken ? { token: buddyServiceToken } : {}),
    timeoutMs: Number(env("ANOMALOHARIS_BUDDY_REQUEST_TIMEOUT_MS") ?? "1500"),
  })
  : undefined;

const plugins = new PiPluginHost({
  timeoutMs: Number(env("ANOMALOHARIS_PLUGIN_TIMEOUT_MS") ?? "30000"),
  catalog: pluginCatalog,
  ...(extensionsEnabled ? { backend: new ChildProcessPluginBackend() } : {}),
});
if (extensionsEnabled) {
  const report = await plugins.load(pluginConfig);
  if (report.errors.length > 0) console.warn(`[node-host] Plugin load report: ${JSON.stringify(report)}`);
}

const runMaxConcurrency = boundedPositiveInteger(env("ANOMALOHARIS_RUN_MAX_CONCURRENCY"), 8);
const workflowRuntime = new WorkflowRuntime({
  databasePath: env("ANOMALOHARIS_WORKFLOW_DB_PATH") || join(dataDir, "workflows.sqlite3"),
  maxParallelism: runMaxConcurrency,
  presetModels: {
    listPublished: () => presetModels.list()
      .filter((summary) => summary.status === "published")
      .flatMap((summary) => {
        try {
          const model = presetModels.resolve(summary.ref);
          return [{ ref: model.ref, description: model.description, compiled_hash: workflowHash(model.compiledHash), plugin_lock_hash: workflowHash(model.pluginLockHash) }];
        } catch {
          return [];
        }
      }),
    resolve: (ref) => {
      try {
        const model = presetModels.resolve(ref);
        return model.status === "published"
          ? { ref: model.ref, description: model.description, compiled_hash: workflowHash(model.compiledHash), plugin_lock_hash: workflowHash(model.pluginLockHash) }
          : undefined;
      } catch {
        return undefined;
      }
    },
  },
  pluginOperations: {
    listWorkflowOperations: () => pluginCatalog.listWorkflowOperations()
      .filter((operation) => plugins.status().some((status) => status.id === operation.plugin_id && status.loaded && !status.circuitOpen))
      .map(workflowOperationCapability),
    resolveWorkflowOperation: (id, version) => pluginCatalog.listWorkflowOperations()
      .filter((operation) => operation.id === id && operation.version === version)
      .map(workflowOperationCapability)
      .find((operation) => plugins.status().some((status) => status.id === operation.plugin_id && status.loaded && !status.circuitOpen)),
  },
});

class PresetModelAdapter implements ModelAdapter {
  readonly model: string;
  private readonly adapters = new Map<string, ModelAdapter>();

  constructor(private readonly options: {
    registry: SqlitePresetModelRegistry;
    model: string;
    baseUrl: string;
    apiKey?: string;
  }) {
    this.model = options.model;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    yield* this.adapterFor(request).stream(request, signal);
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string | ModelCompletion> {
    return this.adapterFor(request).complete(request, signal);
  }

  private adapterFor(request: ModelRequest): ModelAdapter {
    if (!request.presetModelRef) throw new Error("preset_model_required");
    const compiled = this.options.registry.resolveForBoundSession(request.presetModelRef);
    const provider = providerConfig(compiled, this.options);
    const cacheKey = [
      compiled.ref,
      provider.model,
      provider.baseUrl,
      compiled.credentialRef ?? "default",
      provider.toolProtocol,
      provider.apiKey ? createHash("sha256").update(provider.apiKey).digest("hex") : "missing",
    ].join("\u0000");
    const cached = this.adapters.get(cacheKey);
    if (cached) return cached;
    if (!provider.apiKey) {
      throw new ProviderUnavailableError(`No credential is configured for Preset Model ${compiled.ref}.`);
    }
    const adapter = new OpenAICompatibleAdapter({
      model: provider.model,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      toolProtocol: provider.toolProtocol,
    });
    this.adapters.set(cacheKey, adapter);
    return adapter;
  }
}

function providerConfig(
  model: CompiledPresetModel,
  options: { baseUrl: string; apiKey?: string },
): { model: string; baseUrl: string; apiKey?: string; credentialRef?: string; toolProtocol: "openai" | "dsml" | "auto" | "none" } {
  if (model.definition.provider.adapter !== "openai-compatible") {
    throw new Error(`provider_adapter_unsupported:${model.definition.provider.adapter}`);
  }
  const credentialRef = model.credentialRef;
  const envPrefix = credentialRef
    ? `ANOMALOHARIS_CREDENTIAL_${credentialRef.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`
    : undefined;
  const credentialApiKey = envPrefix ? env(`${envPrefix}_API_KEY`) : undefined;
  const credentialBaseUrl = envPrefix ? env(`${envPrefix}_BASE_URL`) : undefined;
  const apiKey = credentialApiKey ?? (credentialRef === "openrouter-primary" || !credentialRef ? options.apiKey : undefined);
  const baseUrl = credentialBaseUrl ?? options.baseUrl;
  return {
    model: model.providerModel,
    baseUrl,
    ...(credentialRef ? { credentialRef } : {}),
    ...(apiKey ? { apiKey } : {}),
    toolProtocol: model.toolProtocol,
  };
}

const model = new PresetModelAdapter({
  registry: presetModels,
  model: defaultPresetModel.providerModel,
  baseUrl,
  ...(apiKey ? { apiKey } : {}),
});
const tools = new CompositeToolRuntime([
  asToolAdapter("agent-skills", 110, new SkillToolRuntime(skillRuntime, bundledSkillSnapshot), { alwaysAvailable: true }),
  asToolAdapter("host-core", 100, new CoreToolRuntime()),
  asToolAdapter("time-tools", 100, new TimeZoneToolRuntime()),
  asToolAdapter("web", 80, new WebToolRuntime({
    enabled: process.env.WEB_TOOLS_ENABLED !== "false",
    timeoutMs: Number(process.env.WEB_FETCH_TIMEOUT_SECONDS ?? "30") * 1000,
    maxChars: Number(process.env.WEB_FETCH_MAX_CHARS ?? "30000"),
  })),
  asToolAdapter("web", 81, new ResponsesSearchRuntime({
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    subagentModel,
    timeoutMs: searchTimeoutMs,
    resolveProvider: (context) => {
      if (!context.presetModelRef) return undefined;
      try {
        const compiled = presetModels.resolveForBoundSession(context.presetModelRef);
        const provider = providerConfig(compiled, { baseUrl, ...(apiKey ? { apiKey } : {}) });
        return {
          baseUrl: provider.baseUrl,
          ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        };
      } catch {
        return { baseUrl: "", apiKey: "" };
      }
    },
  })),
  asToolAdapter("python-sandbox", 75, pythonSandbox),
  asToolAdapter("browser-bridge", 70, new BrowserToolRuntime(browserBridge)),
  new PluginToolAdapter(plugins),
]);
const sessions = new SqliteSessionAdapter(databasePath, { defaultSearchMode });
const core = new AgentCore({
  model,
  tools,
  sessions,
  context: new ResourceContextBuilder(tools, resources, { bundledSkillSnapshot }),
  plugins,
});
const controller = new RunController(core);
const workflowRunStore = new WorkflowRunStore(workflowRuntime.registry.db);
const runtimeCatalog = new RuntimeCatalog();
const agentRuntimeAdapter = new AgentRuntimeAdapter({ registry: presetModels, controller });
let runControl!: RunControl;
const workflowRuntimeAdapter = new WorkflowRuntimeAdapter({
  runtime: workflowRuntime,
  store: workflowRunStore,
  plugins,
  agentExecution: {
    startAgentChild: (parentRunId, target, request) => {
      const handle = runControl.startAgentChild(parentRunId, target, request);
      return { runId: handle.runId, events: handle };
    },
    stopChildren: (parentRunId, reason) => runControl.stopChildren(parentRunId, reason),
  },
  acquireHostSlot: (signal) => runControl.acquireHostSlot(signal),
});
runtimeCatalog.register(agentRuntimeAdapter);
runtimeCatalog.register(workflowRuntimeAdapter);
runControl = new RunControl(workflowRuntime.registry.db, runtimeCatalog, {
  maxConcurrency: runMaxConcurrency,
});
await runControl.recover();
const managementToken = env("ANOMALOHARIS_ADMIN_TOKEN");
const app = await buildNodeHost({
  sessions,
  model: modelName,
  presetModels,
  defaultPresetModel: defaultPresetModel.ref,
  browserBridge,
  tools,
  ...(existsSync(join(staticDir, "index.html")) ? { staticDir } : {}),
  resources,
  skillSnapshot: bundledSkillSnapshot,
  plugins,
  pluginCatalog,
  ...(buddyDashboard ? { buddy: buddyDashboard } : {}),
  ...(providerCredits ? { providerCredits } : {}),
  subagentModel,
  pythonSandbox,
  ...(managementToken ? { managementToken } : {}),
  workflowManagement: workflowRuntime,
  runControl,
  ...(workflowRefAllowlist.length > 0 ? { workflowRefAllowlist } : {}),
  compute: {
    auth: serviceAuth,
    usage: computeStore,
    idempotency: computeStore,
    nativeRuns: new SqliteNativeRunStore(computeStore.db),
    runControl,
    skillSnapshot: bundledSkillSnapshot,
  },
  logger: env("ANOMALOHARIS_ENV") !== "test",
});

if (host !== requestedHost) {
  console.warn("[node-host] Refusing public bind without ANOMALOHARIS_ACKNOWLEDGE_PUBLIC_HOST=true.");
}
await app.listen({ port, host });

async function shutdown(): Promise<void> {
  sessions.close();
  presetModels.close();
  computeStore.close();
  await app.close();
  workflowRuntime.close();
}

function workflowOperationCapability(operation: ReturnType<typeof pluginCatalog.listWorkflowOperations>[number]) {
  return {
    id: operation.id,
    version: operation.version,
    plugin_id: operation.plugin_id,
    plugin_version: operation.plugin_version,
    package_hash: operation.package_hash.startsWith("sha256:") ? operation.package_hash : `sha256:${operation.package_hash}`,
    description: operation.description,
    input_schema: structuredClone(operation.input_schema),
    output_schema: structuredClone(operation.output_schema),
    permissions: [...operation.permissions].sort(),
    timeout_ms: operation.timeout_ms,
    idempotency: operation.idempotency,
  } as const;
}

function workflowHash(value: string): `sha256:${string}` {
  return value.startsWith("sha256:") ? value as `sha256:${string}` : `sha256:${value}`;
}

function boundedPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function parseServiceClients(raw: string | undefined, fallbackToken: string | undefined): Array<{ id: string; token: string; scopes: string[] }> {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is { id: string; token: string; scopes?: string[]; workflow_refs?: string[] } => (
          Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
          && typeof (item as Record<string, unknown>).token === "string"
        )).map((item) => ({ id: item.id, token: item.token, scopes: item.scopes ?? ["compute:models", "compute:invoke", "compute:read"], ...(item.workflow_refs ? { workflowRefs: item.workflow_refs } : {}) }));
      }
    } catch (error) {
      console.warn(`[node-host] Ignoring invalid ANOMALOHARIS_SERVICE_TOKENS JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fallbackToken ? [{ id: "default", token: fallbackToken, scopes: ["compute:models", "compute:invoke", "compute:read"] }] : [];
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
