import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ToolCall, ToolDefinition, ToolResult } from "@anomalo/contracts";

import type { ModelMessage, ToolContext } from "./types.js";
import { type PluginLock, PluginCatalog } from "./plugin-catalog.js";

export type PluginCompatibility = "L1" | "L2" | "L3" | "L4" | "L5";

export type PluginPermission = "tools.register" | "lifecycle.context" | "lifecycle.run" | "commands.register";

export type PluginSpec = {
  id: string;
  version?: string;
  package?: string;
  entry?: string;
  manifestHash?: string;
  packageHash?: string;
  enabled?: boolean;
  required?: boolean;
  trust?: "local-code";
  compatibility: PluginCompatibility;
  permissions?: readonly PluginPermission[];
  priority?: number;
};

export type PluginLoadConfig = {
  plugins: readonly PluginSpec[];
  locks?: readonly PluginLock[];
};

export function readPluginLoadConfig(path: string): PluginLoadConfig {
  if (!existsSync(path)) return { plugins: [] };
  const text = readFileSync(path, "utf8").trim();
  if (!text) return { plugins: [] };
  try {
    const parsed = JSON.parse(text) as { plugins?: unknown };
    if (Array.isArray(parsed.plugins)) return { plugins: parsed.plugins as PluginSpec[] };
  } catch {
    // The deployment format is YAML; use the deliberately small parser below
    // so the Host does not need a second runtime dependency just to read an
    // allowlist.
  }
  return { plugins: parsePluginYaml(text) };
}

export type PluginContext = {
  pluginId: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
};

export type PluginEvent =
  | { type: "session_start"; context: PluginContext }
  | { type: "before_agent_start"; context: PluginContext; messages: ModelMessage[] }
  | { type: "context"; context: PluginContext; messages: ModelMessage[]; tools: ToolDefinition[] }
  | { type: "tool_call"; context: PluginContext; call: ToolCall }
  | { type: "tool_result"; context: PluginContext; call: ToolCall; result: ToolResult }
  | { type: "turn_end"; context: PluginContext; iteration: number }
  | { type: "agent_end"; context: PluginContext; eventType: "run.finished" | "run.stopped" | "run.error" };

export type PluginEventResult = {
  allow?: boolean;
  messages?: ModelMessage[];
  tools?: ToolDefinition[];
  call?: ToolCall;
  result?: ToolResult;
  metadata?: Record<string, unknown>;
};

export type PluginHook = (event: PluginEvent) => PluginEventResult | void | Promise<PluginEventResult | void>;
export type PluginToolHandler = (
  call: ToolCall,
  context: ToolContext,
  signal: AbortSignal,
) => ToolResult | Promise<ToolResult>;

export type PluginApi = {
  registerTool(definition: ToolDefinition, handler: PluginToolHandler): void;
  on(event: PluginEvent["type"], hook: PluginHook): void;
};

export type PiExtension = {
  id?: string;
  compatibility?: PluginCompatibility;
  tools?: readonly ToolDefinition[];
  callTool?: PluginToolHandler;
  hooks?: Partial<Record<PluginEvent["type"], PluginHook>>;
  setup?: (api: PluginApi) => void | Promise<void>;
};

export type PluginStatus = {
  id: string;
  version?: string;
  manifestHash?: string;
  packageHash?: string;
  compatibility: PluginCompatibility;
  enabled: boolean;
  loaded: boolean;
  required: boolean;
  tools: string[];
  failures: number;
  circuitOpen: boolean;
  error?: string;
};

export type PluginLoadReport = {
  plugins: PluginStatus[];
  errors: Array<{ id: string; error: string; required: boolean }>;
  unsupported: Array<{ id: string; capability: string }>;
};

export interface PluginHost {
  load(config: PluginLoadConfig): Promise<PluginLoadReport>;
  unload(pluginId: string): Promise<void>;
  tools(context: PluginContext): Promise<ToolDefinition[]>;
  callTool(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult>;
  dispatch(event: PluginEvent): Promise<PluginEventResult>;
  status(): PluginStatus[];
}

export interface PluginBackend {
  load(spec: PluginSpec, timeoutMs: number): Promise<PluginBackendHandle>;
  unload(handle: PluginBackendHandle): Promise<void>;
  tools(handle: PluginBackendHandle, context: PluginContext, timeoutMs: number): Promise<ToolDefinition[]>;
  callTool(handle: PluginBackendHandle, call: ToolCall, context: ToolContext, signal: AbortSignal, timeoutMs: number): Promise<ToolResult>;
  dispatch(handle: PluginBackendHandle, event: PluginEvent, timeoutMs: number): Promise<PluginEventResult | undefined>;
}

export type PluginBackendHandle = {
  id: string;
  spec: PluginSpec;
  extension?: PiExtension;
  _tools?: Map<string, { definition: ToolDefinition; handler?: PluginToolHandler }>;
  child?: ChildProcess;
  request?: (method: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
};

type LoadedPlugin = {
  status: PluginStatus;
  spec: PluginSpec;
  handle?: PluginBackendHandle;
};

/**
 * Pi L1-L3 compatibility host. Discovery is deliberately configuration-only:
 * a project directory is never scanned for executable TypeScript by default.
 */
export class PiPluginHost implements PluginHost {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly timeoutMs: number;
  private readonly backend: PluginBackend;
  private readonly catalog: PluginCatalog | undefined;

  constructor(options: { timeoutMs?: number; backend?: PluginBackend; catalog?: PluginCatalog } = {}) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
    this.backend = options.backend ?? new InProcessPluginBackend();
    this.catalog = options.catalog;
  }

  async load(config: PluginLoadConfig): Promise<PluginLoadReport> {
    this.catalog?.assertSpecs(config.plugins, config.locks);
    const report: PluginLoadReport = { plugins: [], errors: [], unsupported: [] };
    for (const spec of config.plugins) {
      const status: PluginStatus = {
        id: spec.id,
        ...(spec.version ? { version: spec.version } : {}),
        ...(spec.manifestHash ? { manifestHash: spec.manifestHash } : {}),
        ...(spec.packageHash ? { packageHash: spec.packageHash } : {}),
        compatibility: spec.compatibility,
        enabled: spec.enabled !== false,
        loaded: false,
        required: spec.required === true,
        tools: [],
        failures: 0,
        circuitOpen: false,
      };
      this.loaded.set(spec.id, { status, spec });
      if (spec.enabled === false) {
        report.plugins.push(status);
        continue;
      }
      if (spec.compatibility === "L4" || spec.compatibility === "L5") {
        const capability = spec.compatibility === "L4" ? "session_fork" : "ui.tui";
        report.unsupported.push({ id: spec.id, capability });
      }
      if (spec.trust !== undefined && spec.trust !== "local-code") {
        const error = "Only trusted local-code plugins are supported.";
        status.error = error;
        report.errors.push({ id: spec.id, error, required: status.required });
        report.plugins.push(status);
        continue;
      }
      try {
        const handle = await withTimeout(this.backend.load(spec, this.timeoutMs), this.timeoutMs, `plugin load ${spec.id}`);
        status.loaded = true;
        status.tools = await withTimeout(
          this.backend.tools(handle, { pluginId: spec.id }, this.timeoutMs).then((tools) => tools.map((tool) => tool.name)),
          this.timeoutMs,
          `plugin tools ${spec.id}`,
        );
        this.loaded.set(spec.id, { status, spec, handle });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.error = message;
        report.errors.push({ id: spec.id, error: message, required: status.required });
        if (status.required) throw new Error(`Required plugin ${spec.id} failed to load: ${message}`);
      }
      report.plugins.push(status);
    }
    this.assertNoEqualPriorityToolNames();
    return report;
  }

  async unload(pluginId: string): Promise<void> {
    const plugin = this.loaded.get(pluginId);
    if (plugin?.handle) await withTimeout(this.backend.unload(plugin.handle), this.timeoutMs, `plugin unload ${pluginId}`);
    this.loaded.delete(pluginId);
  }

  async tools(context: PluginContext): Promise<ToolDefinition[]> {
    const all: Array<{ definition: ToolDefinition; priority: number; pluginId: string }> = [];
    for (const plugin of this.loaded.values()) {
      if (!plugin.handle || !plugin.status.loaded || plugin.status.circuitOpen) continue;
      let definitions: ToolDefinition[];
      try {
        definitions = await withTimeout(this.backend.tools(plugin.handle, context, this.timeoutMs), this.timeoutMs, `plugin tools ${plugin.spec.id}`);
      } catch (error) {
        this.recordFailure(plugin, error);
        continue;
      }
      for (const definition of definitions) {
        all.push({ definition, priority: plugin.spec.priority ?? 20, pluginId: plugin.spec.id });
      }
    }
    const selected = new Map<string, { definition: ToolDefinition; priority: number; pluginId: string }>();
    for (const item of all) {
      const existing = selected.get(item.definition.name);
      if (!existing || item.priority > existing.priority) selected.set(item.definition.name, item);
    }
    return [...selected.values()].map((item) => structuredClone(item.definition));
  }

  async callTool(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    const candidates = [...this.loaded.values()]
      .filter((plugin) => plugin.handle && plugin.status.loaded && !plugin.status.circuitOpen)
      .sort((a, b) => (b.spec.priority ?? 20) - (a.spec.priority ?? 20));
    for (const plugin of candidates) {
      let definitions: ToolDefinition[];
      try {
        definitions = await withTimeout(
          this.backend.tools(plugin.handle!, { pluginId: plugin.spec.id, sessionId: context.sessionId, runId: context.runId }, this.timeoutMs),
          this.timeoutMs,
          `plugin tools ${plugin.spec.id}`,
        );
      } catch (error) {
        this.recordFailure(plugin, error);
        continue;
      }
      if (definitions.some((definition) => definition.name === call.name)) {
        try {
          const result = await withTimeout(
            this.backend.callTool(plugin.handle!, call, context, signal, this.timeoutMs),
            this.timeoutMs,
            `plugin tool ${plugin.spec.id}.${call.name}`,
          );
          return { ...result, name: call.name };
        } catch (error) {
          this.recordFailure(plugin, error);
          return {
            name: call.name,
            ok: false,
            content: error instanceof Error ? error.message : String(error),
            data: { error_code: "plugin_failed", plugin_id: plugin.spec.id },
          };
        }
      }
    }
    return { name: call.name, ok: false, content: `Plugin tool not found: ${call.name}`, data: { error_code: "tool_not_found" } };
  }

  async dispatch(event: PluginEvent): Promise<PluginEventResult> {
    let result: PluginEventResult = {};
    for (const plugin of this.loaded.values()) {
      if (!plugin.handle || !plugin.status.loaded || plugin.status.circuitOpen) continue;
      try {
        const response = await withTimeout(
          this.backend.dispatch(plugin.handle, event, this.timeoutMs),
          this.timeoutMs,
          `plugin hook ${plugin.spec.id}.${event.type}`,
        );
        if (!response) continue;
        result = {
          ...result,
          ...response,
          ...(response.messages ? { messages: response.messages } : {}),
          ...(response.tools ? { tools: response.tools } : {}),
          ...(response.call ? { call: response.call } : {}),
          ...(response.result ? { result: response.result } : {}),
          ...(response.metadata ? { metadata: { ...(result.metadata ?? {}), ...response.metadata } } : {}),
        };
        if (response.allow === false) return result;
      } catch (error) {
        this.recordFailure(plugin, error);
      }
    }
    return result;
  }

  status(): PluginStatus[] {
    return [...this.loaded.values()].map(({ status }) => ({ ...status, tools: [...status.tools] }));
  }

  private recordFailure(plugin: LoadedPlugin, error: unknown): void {
    plugin.status.failures += 1;
    if (plugin.status.failures >= 3) plugin.status.circuitOpen = true;
    plugin.status.error = error instanceof Error ? error.message : String(error);
  }

  private assertNoEqualPriorityToolNames(): void {
    const owners = new Map<string, { id: string; priority: number }>();
    for (const plugin of this.loaded.values()) {
      for (const name of plugin.status.tools) {
        const priority = plugin.spec.priority ?? 20;
        const existing = owners.get(name);
        if (existing && existing.priority === priority) {
          throw new Error(`Plugins ${existing.id} and ${plugin.spec.id} register ${name} at the same priority.`);
        }
        if (!existing || priority > existing.priority) owners.set(name, { id: plugin.spec.id, priority });
      }
    }
  }
}

export class InProcessPluginBackend implements PluginBackend {
  async load(spec: PluginSpec, _timeoutMs: number): Promise<PluginBackendHandle> {
    if (!spec.entry && !spec.package) throw new Error("Plugin requires an explicit package or entry.");
    const moduleSpecifier = resolvePluginModuleSpecifier(spec);
    const imported = await import(moduleSpecifier);
    const exported = (imported.default ?? imported.plugin ?? imported) as PiExtension | ((api: PluginApi) => PiExtension | void | Promise<PiExtension | void>);
    const registeredTools = new Map<string, { definition: ToolDefinition; handler: PluginToolHandler }>();
    const registeredHooks = new Map<PluginEvent["type"], PluginHook>();
    const api: PluginApi = {
      registerTool: (definition, handler) => registeredTools.set(definition.name, { definition, handler }),
      on: (event, hook) => registeredHooks.set(event, hook),
    };
    const extension = (typeof exported === "function" ? await exported(api) : exported) ?? {};
    if (extension.setup) await extension.setup(api);
    for (const [event, hook] of Object.entries(extension.hooks ?? {}) as Array<[PluginEvent["type"], PluginHook]>) {
      registeredHooks.set(event, hook);
    }
    const tools = new Map<string, { definition: ToolDefinition; handler?: PluginToolHandler }>();
    for (const definition of extension.tools ?? []) tools.set(definition.name, { definition });
    for (const [name, value] of registeredTools) tools.set(name, value);
    return {
      id: spec.id,
      spec,
      extension: { ...extension, hooks: Object.fromEntries(registeredHooks) },
      _tools: tools,
    };
  }

  async unload(_handle: PluginBackendHandle): Promise<void> {}

  async tools(handle: PluginBackendHandle, _context: PluginContext, _timeoutMs: number): Promise<ToolDefinition[]> {
    return [...(getTools(handle).values())].map(({ definition }) => structuredClone(definition));
  }

  async callTool(handle: PluginBackendHandle, call: ToolCall, context: ToolContext, signal: AbortSignal, _timeoutMs: number): Promise<ToolResult> {
    const tool = getTools(handle).get(call.name);
    const handler = tool?.handler ?? handle.extension?.callTool;
    if (!handler) return { name: call.name, ok: false, content: `Plugin has no handler for ${call.name}.`, data: { error_code: "tool_not_implemented" } };
    return normalizeToolResult(await handler(call, context, signal), call.name);
  }

  async dispatch(handle: PluginBackendHandle, event: PluginEvent, _timeoutMs: number): Promise<PluginEventResult | undefined> {
    const hook = handle.extension?.hooks?.[event.type];
    return hook ? (await hook(event)) ?? undefined : undefined;
  }
}

/** Child-process backend used by production hosts. The child receives no model or admin secrets. */
export class ChildProcessPluginBackend implements PluginBackend {
  private readonly childEntry: string;

  constructor(childEntry = fileURLToPath(new URL("./plugin-child.js", import.meta.url))) {
    this.childEntry = childEntry;
  }

  async load(spec: PluginSpec, timeoutMs: number): Promise<PluginBackendHandle> {
    if (!spec.entry && !spec.package) throw new Error("Plugin requires an explicit package or entry.");
    if (spec.entry && !spec.package && !isAbsolute(spec.entry) && !spec.entry.startsWith("data:") && !existsSync(resolve(spec.entry))) {
      throw new Error(`Plugin entry does not exist: ${spec.entry}`);
    }
    const child = fork(this.childEntry, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        NODE_ENV: "production",
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      },
    });
    const request = createChildRequester(child);
    const handle: PluginBackendHandle = { id: spec.id, spec, child, request };
    try {
      await request("load", { spec }, timeoutMs);
      return handle;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  async unload(handle: PluginBackendHandle): Promise<void> {
    if (handle.request) {
      try { await handle.request("unload", {}, this.timeoutForShutdown()); } catch { /* child may already be gone */ }
    }
    handle.child?.kill();
  }

  async tools(handle: PluginBackendHandle, context: PluginContext, timeoutMs: number): Promise<ToolDefinition[]> {
    const result = await handle.request?.("tools", { context }, timeoutMs);
    return Array.isArray((result as { tools?: unknown })?.tools) ? (result as { tools: ToolDefinition[] }).tools : [];
  }

  async callTool(handle: PluginBackendHandle, call: ToolCall, context: ToolContext, signal: AbortSignal, timeoutMs: number): Promise<ToolResult> {
    const result = await abortableRequest(handle.request, "callTool", { call, context }, timeoutMs, signal);
    return normalizeToolResult((result as { result: ToolResult }).result, call.name);
  }

  async dispatch(handle: PluginBackendHandle, event: PluginEvent, timeoutMs: number): Promise<PluginEventResult | undefined> {
    const result = await handle.request?.("dispatch", { event }, timeoutMs);
    return (result as { result?: PluginEventResult } | undefined)?.result;
  }

  private timeoutForShutdown(): number { return Math.min(this.timeoutForShutdownValue, 1_000); }
  private readonly timeoutForShutdownValue = 1_000;
}

export function resolvePluginModuleSpecifier(spec: Pick<PluginSpec, "package" | "entry">): string {
  if (spec.entry?.startsWith("data:")) return spec.entry;
  if (spec.entry && isAbsolute(spec.entry)) return pathToFileURL(spec.entry).href;
  if (spec.package) {
    if (!spec.entry || spec.entry === "." || spec.entry === "./") return spec.package;
    return `${spec.package}/${spec.entry.replace(/^\.\//, "")}`;
  }
  if (spec.entry) return pathToFileURL(resolve(spec.entry)).href;
  throw new Error("Plugin requires an explicit package or entry.");
}

function getTools(handle: PluginBackendHandle): Map<string, { definition: ToolDefinition; handler?: PluginToolHandler }> {
  return handle._tools ?? new Map();
}

function parsePluginYaml(text: string): PluginSpec[] {
  const plugins: PluginSpec[] = [];
  let current: Partial<PluginSpec> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line === "plugins:") continue;
    if (line.startsWith("- ")) {
      if (current?.id) plugins.push(current as PluginSpec);
      current = {};
      parsePluginField(current, line.slice(2));
      continue;
    }
    if (current) parsePluginField(current, line);
  }
  if (current?.id) plugins.push(current as PluginSpec);
  return plugins;
}

function parsePluginField(target: Partial<PluginSpec>, field: string): void {
  const separator = field.indexOf(":");
  if (separator < 0) return;
  const key = field.slice(0, separator).trim() as keyof PluginSpec;
  const raw = field.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  if (key === "version") target.version = raw;
  else if (key === "manifestHash") target.manifestHash = raw;
  else if (key === "packageHash") target.packageHash = raw;
  else if (key === "enabled") target.enabled = raw === "true";
  else if (key === "required") target.required = raw === "true";
  else if (key === "priority") target.priority = Number(raw);
  else if (key === "id" || key === "package" || key === "entry" || key === "trust" || key === "compatibility") target[key] = raw as never;
}

function normalizeToolResult(result: ToolResult, name: string): ToolResult {
  return { name, ok: result.ok, content: result.content, data: result.data ?? {} };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createChildRequester(child: ChildProcess): (method: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown> {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    const id = typeof value.id === "number" ? value.id : undefined;
    if (id === undefined) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (value.ok === true) entry.resolve(value.result);
    else entry.reject(new Error(typeof value.error === "string" ? value.error : "Plugin child request failed."));
  });
  child.on("exit", () => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error("Plugin child exited."));
    }
  });
  return (method, payload, timeoutMs) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Plugin request timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, method, payload }, (error) => {
      if (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function abortableRequest(
  request: PluginBackendHandle["request"],
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!request) throw new Error("Plugin child request channel is unavailable.");
  if (signal.aborted) throw new Error("Plugin tool call cancelled.");
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      request(method, payload, timeoutMs),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Plugin tool call cancelled.")), { once: true })),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
