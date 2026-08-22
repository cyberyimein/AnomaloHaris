import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentCore } from "./core.js";
import { ResourceContextBuilder } from "./context.js";
import { buildNodeHost } from "./host.js";
import { OpenAICompatibleAdapter, ProviderUnavailableError, type ModelAdapter, type ModelCompletion, type ModelRequest, type ModelStreamEvent } from "./model.js";
import { BrowserToolBridge, BrowserToolRuntime } from "./browser.js";
import { FileResourceLoader } from "./resources.js";
import { ChildProcessPluginBackend, PiPluginHost, readPluginLoadConfig } from "./plugins.js";
import { builtinPluginCatalog, createPluginManifest } from "./plugin-catalog.js";
import { DEFAULT_PRESET_MODEL_REF, SqlitePresetModelRegistry, type CompiledPresetModel } from "./preset-models.js";
import { SqliteSessionAdapter } from "./sqlite.js";
import { RunController } from "./controller.js";
import { asToolAdapter, CompositeToolRuntime, CoreToolRuntime, PluginToolAdapter } from "./tools.js";
import { WebToolRuntime } from "./web.js";
import { ServiceAuth, SqliteComputeStore, SqliteNativeRunStore } from "./compute-api.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const dataDir = resolve(process.env.ANOMALO_DATA_DIR ?? join(repoRoot, "data"));
const databasePath = process.env.ANOMALO_SESSION_DB_PATH || join(dataDir, "sessions.sqlite3");
const presetModelDatabasePath = process.env.ANOMALO_PRESET_MODEL_DB_PATH || join(dataDir, "preset-models.sqlite3");
const computeDatabasePath = process.env.ANOMALO_COMPUTE_DB_PATH || join(dataDir, "compute.sqlite3");
const modelName = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const defaultPresetModelRef = process.env.ANOMALO_DEFAULT_PRESET_MODEL || DEFAULT_PRESET_MODEL_REF;
const apiKey = process.env.OPENROUTER_API_KEY;
const managementApiKey = process.env.OPENROUTER_MANAGEMENT_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
const staticDir = process.env.ANOMALO_FRONTEND_DIR ?? join(repoRoot, "agent-backend", "app", "frontend");
const port = Number(process.env.PORT ?? "8000");
const requestedHost = process.env.HOST ?? "127.0.0.1";
const isPublicHost = requestedHost !== "127.0.0.1" && requestedHost !== "::1" && requestedHost !== "localhost";
const host = isPublicHost && process.env.ANOMALO_ACKNOWLEDGE_PUBLIC_HOST !== "true" ? "127.0.0.1" : requestedHost;
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

const extensionsEnabled = process.env.ANOMALO_PI_EXTENSIONS_ENABLED === "true";
const pluginConfig = extensionsEnabled
  ? readPluginLoadConfig(process.env.ANOMALO_PLUGIN_CONFIG ?? join(repoRoot, "agent-backend", "config", "plugins.yaml"))
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
  skillDirs: [join(repoRoot, "agent-backend", "skills")],
  mcpConfigPath: join(repoRoot, "agent-backend", "config", "mcp_servers.yaml"),
});
const presetModels = new SqlitePresetModelRegistry(presetModelDatabasePath, {
  catalog: pluginCatalog,
  resolvePrompt: (profile) => resources.promptText(profile),
});
const serviceClients = parseServiceClients(process.env.ANOMALO_SERVICE_TOKENS, process.env.ANOMALO_SERVICE_TOKEN);
if (hasPublicBinding && serviceClients.length === 0) {
  throw new Error("Public host binding requires ANOMALO_SERVICE_TOKEN or ANOMALO_SERVICE_TOKENS.");
}
if (hasPublicBinding && !process.env.ANOMALO_ADMIN_TOKEN) {
  throw new Error("Public host binding requires a separate ANOMALO_ADMIN_TOKEN.");
}
const computeStore = new SqliteComputeStore(computeDatabasePath);
const serviceAuth = new ServiceAuth({
  clients: serviceClients,
  required: process.env.ANOMALO_SERVICE_AUTH_REQUIRED === "true" || serviceClients.length > 0 || hasPublicBinding,
});
presetModels.ensureBuiltinDefault({
  model: modelName,
  promptProfile: process.env.ANOMALO_AGENT_PROMPT_PROFILE ?? "agent",
});
const defaultPresetModel = presetModels.resolve(defaultPresetModelRef);

const browserBridge = new BrowserToolBridge(Number(process.env.BROWSER_TOOL_TIMEOUT_SECONDS ?? "60") * 1000);

const plugins = new PiPluginHost({
  timeoutMs: Number(process.env.ANOMALO_PLUGIN_TIMEOUT_MS ?? "30000"),
  catalog: pluginCatalog,
  ...(extensionsEnabled ? { backend: new ChildProcessPluginBackend() } : {}),
});
if (extensionsEnabled) {
  const report = await plugins.load(pluginConfig);
  if (report.errors.length > 0) console.warn(`[node-host] Plugin load report: ${JSON.stringify(report)}`);
}

class PresetModelAdapter implements ModelAdapter {
  readonly model: string;
  private readonly adapters = new Map<string, ModelAdapter>();

  constructor(private readonly options: {
    registry: SqlitePresetModelRegistry;
    fallbackModel: string;
    baseUrl: string;
    apiKey?: string;
  }) {
    this.model = options.fallbackModel;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    yield* this.adapterFor(request).stream(request, signal);
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string | ModelCompletion> {
    return this.adapterFor(request).complete(request, signal);
  }

  private adapterFor(request: ModelRequest): ModelAdapter {
    const compiled = request.presetModelRef
      ? this.options.registry.resolveForBoundSession(request.presetModelRef)
      : undefined;
    const provider = compiled ? providerConfig(compiled, this.options) : {
      model: request.model,
      baseUrl: this.options.baseUrl,
      toolProtocol: "auto" as const,
      ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
    };
    const cacheKey = [
      compiled?.ref ?? "fallback",
      provider.model,
      provider.baseUrl,
      compiled?.credentialRef ?? "default",
      provider.toolProtocol,
      provider.apiKey ? createHash("sha256").update(provider.apiKey).digest("hex") : "missing",
    ].join("\u0000");
    const cached = this.adapters.get(cacheKey);
    if (cached) return cached;
    if (!provider.apiKey) {
      throw new ProviderUnavailableError(`No credential is configured for Preset Model ${compiled?.ref ?? provider.model}.`);
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
): { model: string; baseUrl: string; apiKey?: string; toolProtocol: "openai" | "dsml" | "auto" | "none" } {
  if (model.definition.provider.adapter !== "openai-compatible") {
    throw new Error(`provider_adapter_unsupported:${model.definition.provider.adapter}`);
  }
  const credentialRef = model.credentialRef;
  const envPrefix = credentialRef
    ? `ANOMALO_CREDENTIAL_${credentialRef.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`
    : undefined;
  const credentialApiKey = envPrefix ? process.env[`${envPrefix}_API_KEY`] : undefined;
  const credentialBaseUrl = envPrefix ? process.env[`${envPrefix}_BASE_URL`] : undefined;
  const apiKey = credentialApiKey ?? (credentialRef === "openrouter-primary" || !credentialRef ? options.apiKey : undefined);
  const baseUrl = credentialBaseUrl ?? options.baseUrl;
  return {
    model: model.providerModel,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    toolProtocol: model.toolProtocol,
  };
}

const model = new PresetModelAdapter({
  registry: presetModels,
  fallbackModel: modelName,
  baseUrl,
  ...(apiKey ? { apiKey } : {}),
});
const tools = new CompositeToolRuntime([
  asToolAdapter("host-core", 100, new CoreToolRuntime()),
  asToolAdapter("web", 80, new WebToolRuntime({
    enabled: process.env.WEB_TOOLS_ENABLED !== "false",
    timeoutMs: Number(process.env.WEB_FETCH_TIMEOUT_SECONDS ?? "30") * 1000,
    maxChars: Number(process.env.WEB_FETCH_MAX_CHARS ?? "30000"),
  })),
  asToolAdapter("browser-bridge", 70, new BrowserToolRuntime(browserBridge)),
  new PluginToolAdapter(plugins),
]);
const sessions = new SqliteSessionAdapter(databasePath);
const core = new AgentCore({
  model,
  tools,
  sessions,
  context: new ResourceContextBuilder(tools, resources),
  plugins,
});
const controller = new RunController(core);
const app = await buildNodeHost({
  controller,
  sessions,
  model: modelName,
  presetModels,
  defaultPresetModel: defaultPresetModel.ref,
  promptProfile: process.env.ANOMALO_AGENT_PROMPT_PROFILE ?? "agent",
  searchMode: process.env.ANOMALO_SEARCH_MODE ?? "diy",
  runtimeImpl: "node",
  sessionSchema: 2,
  browserBridge,
  tools,
  ...(existsSync(join(staticDir, "index.html")) ? { staticDir } : {}),
  resources,
  plugins,
  ...(providerCredits ? { providerCredits } : {}),
  ...(process.env.ANOMALO_ADMIN_TOKEN ? { managementToken: process.env.ANOMALO_ADMIN_TOKEN } : {}),
  compute: {
    auth: serviceAuth,
    usage: computeStore,
    idempotency: computeStore,
    nativeRuns: new SqliteNativeRunStore(computeStore.db),
  },
  logger: process.env.ANOMALO_ENV !== "test",
});

if (host !== requestedHost) {
  console.warn("[node-host] Refusing public bind without ANOMALO_ACKNOWLEDGE_PUBLIC_HOST=true.");
}
await app.listen({ port, host });

async function shutdown(): Promise<void> {
  sessions.close();
  presetModels.close();
  computeStore.close();
  await app.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function parseServiceClients(raw: string | undefined, fallbackToken: string | undefined): Array<{ id: string; token: string; scopes: string[] }> {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is { id: string; token: string; scopes?: string[] } => (
          Boolean(item) && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
          && typeof (item as Record<string, unknown>).token === "string"
        )).map((item) => ({ id: item.id, token: item.token, scopes: item.scopes ?? ["compute:models", "compute:invoke", "compute:read"] }));
      }
    } catch (error) {
      console.warn(`[node-host] Ignoring invalid ANOMALO_SERVICE_TOKENS JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fallbackToken ? [{ id: "default", token: fallbackToken, scopes: ["compute:models", "compute:invoke", "compute:read"] }] : [];
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
