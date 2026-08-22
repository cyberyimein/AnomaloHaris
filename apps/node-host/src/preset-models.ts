import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  PresetModelDefinition,
  PresetModelRef,
  PresetModelSummary,
} from "@anomalo/contracts";
import { validateContract } from "@anomalo/contracts";

import type { AgentPolicy, BootstrapToolRequest } from "./types.js";
import type { ResponseFormat } from "@anomalo/contracts";
import { PluginCatalog, type PluginLock } from "./plugin-catalog.js";

export const DEFAULT_PRESET_MODEL_REF = "anomalo@1" as PresetModelRef;

export type CompiledPresetModel = {
  ref: PresetModelRef;
  name: string;
  version: number;
  description: string;
  status: "draft" | "published" | "retired";
  providerModel: string;
  toolProtocol: "openai" | "dsml" | "auto" | "none";
  credentialRef?: string | undefined;
  promptProfile: string;
  systemPrompt: string;
  promptSnapshotVersion: 1;
  fixedPlugins: string[];
  pluginLocks: PluginLock[];
  toolCatalog: string[];
  allowedToolNames?: string[] | undefined;
  bootstrapTools?: BootstrapToolRequest[] | undefined;
  policy: AgentPolicy;
  definition: PresetModelDefinition;
  promptHash: string;
  pluginLockHash: string;
  compiledHash: string;
};

type RegistryRow = {
  name: string;
  version: number;
  status: "draft" | "published" | "retired";
  description: string;
  definition_json: string;
  compiled_snapshot_json: string;
  prompt_hash: string;
  plugin_lock_hash: string;
  compiled_hash: string;
};

type LegacyPresetAgent = {
  name: string;
  description?: string;
  ghost?: boolean;
  system_prompt?: string;
  model?: string;
  temperature?: number;
  tool_names?: string[];
  bootstrap_tools?: BootstrapToolRequest[];
  search_mode?: string;
  response_format?: Record<string, unknown>;
};

export type PresetModelMigrationDryRun = {
  dryRun: true;
  created: Array<{ ref: PresetModelRef; definition: PresetModelDefinition }>;
  skipped: Array<{ ref: string; reason: string }>;
  errors: Array<{ name: string; error: string }>;
};

const REGISTRY_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS preset_models (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS preset_model_versions (
  name TEXT NOT NULL REFERENCES preset_models(name) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  description TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  compiled_snapshot_json TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  plugin_lock_hash TEXT NOT NULL,
  compiled_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  retired_at TEXT,
  PRIMARY KEY(name, version)
);
CREATE INDEX IF NOT EXISTS idx_preset_model_versions_status
  ON preset_model_versions(name, status, version DESC);
CREATE TABLE IF NOT EXISTS preset_model_plugin_locks (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  package_name TEXT NOT NULL,
  entry TEXT NOT NULL,
  compatibility TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  package_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  PRIMARY KEY(name, version, plugin_id),
  FOREIGN KEY(name, version) REFERENCES preset_model_versions(name, version) ON DELETE CASCADE
);
`;

export class SqlitePresetModelRegistry {
  readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;
  private readonly now: () => string;
  private readonly catalog: PluginCatalog | undefined;
  private readonly resolvePrompt: ((profile: string) => string) | undefined;

  constructor(
    dbPath: string,
    options: { database?: DatabaseSync; now?: () => string; catalog?: PluginCatalog; resolvePrompt?: (profile: string) => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.catalog = options.catalog;
    this.resolvePrompt = options.resolvePrompt;
    if (options.database) {
      this.db = options.database;
      this.ownsDatabase = false;
    } else {
      if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.ownsDatabase = true;
    }
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(REGISTRY_SCHEMA);
    this.migrateLegacyPromptSnapshots();
  }

  createDraft(definition: PresetModelDefinition): CompiledPresetModel {
    validateDefinition(definition);
    const existing = this.db.prepare(
      "SELECT 1 FROM preset_model_versions WHERE name = ? AND version = ?",
    ).get(definition.name, definition.version);
    if (existing) throw new Error("preset_model_version_exists");

    const createdAt = this.now();
    const compiled = compileDefinition(definition, "draft", this.catalog, this.resolvePrompt);
    this.db.prepare(
      "INSERT OR IGNORE INTO preset_models(name, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(definition.name, definition.description, createdAt, createdAt);
    this.db.prepare(`
      INSERT INTO preset_model_versions(
        name, version, status, description, definition_json, compiled_snapshot_json,
        prompt_hash, plugin_lock_hash, compiled_hash, created_at
      ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      definition.name,
      definition.version,
      definition.description,
      JSON.stringify(definition),
      JSON.stringify(compiled),
      compiled.promptHash,
      compiled.pluginLockHash,
      compiled.compiledHash,
      createdAt,
    );
    this.persistPluginLocks(compiled);
    return compiled;
  }

  publish(ref: string): CompiledPresetModel {
    const record = this.read(ref, { includeDraft: true });
    if (record.status === "retired") throw new Error("preset_model_retired");
    if (record.status === "draft") {
      this.db.prepare(`
        UPDATE preset_model_versions
        SET status = 'published', published_at = ?, retired_at = NULL
        WHERE name = ? AND version = ?
      `).run(this.now(), record.name, record.version);
      return this.read(`${record.name}@${record.version}`, { includeDraft: true });
    }
    return record;
  }

  retire(ref: string, options: { defaultRef?: string } = {}): CompiledPresetModel {
    const record = this.read(ref, { includeDraft: true });
    if (record.status === "retired") return record;
    if (options.defaultRef && normalizeRef(options.defaultRef) === normalizeRef(record.ref)) {
      throw new Error("preset_model_default_cannot_retire");
    }
    this.db.prepare(`
      UPDATE preset_model_versions
      SET status = 'retired', retired_at = ?
      WHERE name = ? AND version = ?
    `).run(this.now(), record.name, record.version);
    return this.read(`${record.name}@${record.version}`, { includeDraft: true });
  }

  resolve(ref: string, options: { allowDraft?: boolean; allowRetired?: boolean } = {}): CompiledPresetModel {
    const record = this.read(ref, { includeDraft: options.allowDraft === true });
    if (record.status === "retired" && options.allowRetired !== true) throw new Error("preset_model_not_found");
    return record;
  }

  resolveForBoundSession(ref: string): CompiledPresetModel {
    return this.resolve(ref, { allowRetired: true });
  }

  list(options: { includeDraft?: boolean; includeRetired?: boolean } = {}): PresetModelSummary[] {
    const statuses = options.includeDraft && options.includeRetired
      ? ["draft", "published", "retired"]
      : options.includeDraft
        ? ["draft", "published"]
        : options.includeRetired
          ? ["published", "retired"]
          : ["published"];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT name, version, status, description, definition_json, compiled_hash
      FROM preset_model_versions
      WHERE status IN (${placeholders})
      ORDER BY name ASC, version DESC
    `).all(...statuses) as RegistryRow[];
    return rows.map((row) => ({
      ref: `${row.name}@${row.version}` as PresetModelRef,
      name: row.name,
      version: row.version,
      description: row.description,
      status: row.status,
      provider_model: (JSON.parse(row.definition_json) as PresetModelDefinition).provider.model,
      compiled_hash: row.compiled_hash,
    }));
  }

  ensureBuiltinDefault(options: {
    model: string;
    promptProfile?: string;
    description?: string;
  }): CompiledPresetModel {
    try {
      return this.resolve(DEFAULT_PRESET_MODEL_REF);
    } catch (error) {
      if (!(error instanceof Error) || !["preset_model_not_found", "preset_model_not_published"].includes(error.message)) throw error;
      try {
        return this.resolveForBoundSession(DEFAULT_PRESET_MODEL_REF);
      } catch {
        // The built-in row does not exist yet; seed it below.
      }
    }
    try {
      return this.publish(DEFAULT_PRESET_MODEL_REF);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "preset_model_not_found") throw error;
    }
    const definition: PresetModelDefinition = {
      name: "anomalo",
      version: 1,
      description: options.description ?? "The built-in Anomalo Agent preset model.",
      provider: {
        adapter: "openai-compatible",
        model: options.model,
        credential_ref: "openrouter-primary",
        tool_protocol: "auto",
        capabilities: { streaming: true, tools: "encoded", structuredOutput: "prompted" },
      },
      prompt: { profile: options.promptProfile ?? "agent" },
      plugins: { fixed: ["host-core", "web", "browser-bridge", "pi-plugin-host"] },
      policy: { search_mode: "diy" },
      metadata: { builtin: true },
    };
    return this.publish(this.createDraft(definition).ref);
  }

  migrationDryRun(agents: LegacyPresetAgent[]): PresetModelMigrationDryRun {
    const result: PresetModelMigrationDryRun = { dryRun: true, created: [], skipped: [], errors: [] };
    for (const agent of agents) {
      try {
        const definition = legacyAgentToDefinition(agent);
        const ref = `${definition.name}@${definition.version}`;
        if (this.has(ref)) {
          result.skipped.push({ ref, reason: "already_exists" });
        } else {
          result.created.push({ ref: ref as PresetModelRef, definition });
        }
      } catch (error) {
        result.errors.push({ name: agent.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  close(): void {
    if (this.ownsDatabase && this.db.isOpen) this.db.close();
  }

  private persistPluginLocks(model: CompiledPresetModel): void {
    for (const lock of model.pluginLocks) {
      this.db.prepare(`
        INSERT INTO preset_model_plugin_locks(
          name, version, plugin_id, plugin_version, package_name, entry,
          compatibility, permissions_json, package_hash, manifest_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        model.name,
        model.version,
        lock.id,
        lock.version,
        lock.package,
        lock.entry,
        lock.compatibility,
        JSON.stringify(lock.permissions),
        lock.packageHash,
        lock.manifestHash,
      );
    }
  }

  private has(ref: string): boolean {
    try {
      this.read(ref, { includeDraft: true });
      return true;
    } catch {
      return false;
    }
  }

  private read(ref: string, options: { includeDraft: boolean }): CompiledPresetModel {
    const parsed = parseRef(ref);
    const row = parsed.version === undefined
      ? this.db.prepare(`
        SELECT name, version, status, description, definition_json, compiled_snapshot_json,
          prompt_hash, plugin_lock_hash, compiled_hash
        FROM preset_model_versions
        WHERE name = ? AND status = 'published'
        ORDER BY version DESC LIMIT 1
      `).get(parsed.name)
      : this.db.prepare(`
        SELECT name, version, status, description, definition_json, compiled_snapshot_json,
          prompt_hash, plugin_lock_hash, compiled_hash
        FROM preset_model_versions WHERE name = ? AND version = ?
      `).get(parsed.name, parsed.version);
    if (!row) throw new Error("preset_model_not_found");
    const typed = row as RegistryRow;
    if (typed.status === "draft" && !options.includeDraft) throw new Error("preset_model_not_published");
    return compiledFromRow(typed, this.catalog, this.resolvePrompt);
  }

  private migrateLegacyPromptSnapshots(): void {
    if (!this.resolvePrompt) return;
    const rows = this.db.prepare(`
      SELECT name, version, status, description, definition_json, compiled_snapshot_json,
        prompt_hash, plugin_lock_hash, compiled_hash
      FROM preset_model_versions
    `).all() as RegistryRow[];
    const update = this.db.prepare(`
      UPDATE preset_model_versions
      SET compiled_snapshot_json = ?, prompt_hash = ?, plugin_lock_hash = ?, compiled_hash = ?
      WHERE name = ? AND version = ?
    `);
    for (const row of rows) {
      const stored = parseCompiledSnapshot(row.compiled_snapshot_json);
      if (stored?.promptSnapshotVersion === 1) continue;
      if (stored?.pluginLocks) this.catalog?.assertCurrent(stored.pluginLocks);
      const definition = JSON.parse(row.definition_json) as PresetModelDefinition;
      const compiled = compileDefinition(definition, row.status, this.catalog, this.resolvePrompt);
      update.run(
        JSON.stringify(compiled),
        compiled.promptHash,
        compiled.pluginLockHash,
        compiled.compiledHash,
        row.name,
        row.version,
      );
    }
  }
}

export function legacyAgentToDefinition(agent: LegacyPresetAgent): PresetModelDefinition {
  const name = agent.name.trim().toLowerCase();
  if (!name) throw new Error("legacy_agent_name_required");
  return {
    name,
    version: 1,
    description: agent.description ?? "Migrated legacy Anomalo agent.",
    provider: {
      adapter: "openai-compatible",
      model: agent.model ?? "",
      tool_protocol: "auto",
    },
    ...(agent.system_prompt === undefined && agent.search_mode === undefined
      ? {}
      : { prompt: { ...(agent.system_prompt === undefined ? {} : { system: agent.system_prompt }) } }),
    plugins: {
      fixed: agent.ghost ? [] : ["host-core", "web", "browser-bridge"],
      ...(agent.tool_names ? { allowed_tools: agent.tool_names } : {}),
      ...(agent.bootstrap_tools ? { bootstrap_tools: agent.bootstrap_tools } : {}),
    },
    policy: {
      ...(agent.temperature === undefined ? {} : { temperature: agent.temperature }),
      ...(agent.search_mode === undefined ? {} : { search_mode: agent.search_mode }),
      ...(agent.response_format === undefined ? {} : { response_format: agent.response_format }),
    },
    metadata: { migrated_from: "legacy_preset_agent" },
  };
}

function validateDefinition(definition: PresetModelDefinition): void {
  const validation = validateContract("presetModelDefinition", definition);
  if (!validation.valid) throw new Error(`invalid_preset_model_definition:${JSON.stringify(validation.errors)}`);
}

function compilePolicy(raw: Record<string, unknown> | undefined): AgentPolicy {
  const policy = raw ?? {};
  const temperature = numberPolicy(policy, ["temperature"], 0, 2);
  const responseFormat = parseResponseFormatPolicy(policy.response_format ?? policy.responseFormat);
  const searchMode = typeof (policy.search_mode ?? policy.searchMode) === "string"
    ? String(policy.search_mode ?? policy.searchMode)
    : undefined;
  const toolExecution = policy.tool_execution ?? policy.toolExecution ?? "sequential";
  if (toolExecution !== "sequential") throw new Error("unsupported_tool_execution_policy");
  return {
    maxToolIterations: integerPolicy(policy, ["max_tool_iterations", "maxToolIterations"], 50, 1, 1_000),
    runTimeoutMs: integerPolicy(policy, ["run_timeout_ms", "runTimeoutMs"], 600_000, 1_000, 3_600_000),
    bootstrapToolTimeoutMs: integerPolicy(policy, ["bootstrap_tool_timeout_ms", "bootstrapToolTimeoutMs"], 2_000, 1, 120_000),
    toolTimeoutMs: integerPolicy(policy, ["tool_timeout_ms", "toolTimeoutMs"], 30_000, 1, 600_000),
    structuredOutputRetryCount: 1,
    toolExecution: "sequential",
    ...(temperature === undefined ? {} : { temperature }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    searchMode: searchMode ?? "diy",
  };
}

function integerPolicy(
  policy: Record<string, unknown>,
  keys: string[],
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = keys.map((key) => policy[key]).find((candidate) => candidate !== undefined);
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_policy:${keys[0]}`);
  }
  return value;
}

function numberPolicy(
  policy: Record<string, unknown>,
  keys: string[],
  minimum: number,
  maximum: number,
): number | undefined {
  const value = keys.map((key) => policy[key]).find((candidate) => candidate !== undefined);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_policy:${keys[0]}`);
  }
  return value;
}

function parseResponseFormatPolicy(value: unknown): ResponseFormat | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_policy:response_format");
  const record = value as Record<string, unknown>;
  if (record.type === "text" || record.type === "json_object") return { type: record.type };
  if (record.type === "json_schema" && record.json_schema && typeof record.json_schema === "object" && !Array.isArray(record.json_schema)) {
    const schema = record.json_schema as Record<string, unknown>;
    if (typeof schema.name !== "string" || !schema.name || typeof schema.schema !== "object" || schema.schema === null || Array.isArray(schema.schema)) {
      throw new Error("invalid_policy:response_format");
    }
    return {
      type: "json_schema",
      json_schema: {
        name: schema.name,
        ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
        schema: schema.schema as Record<string, unknown>,
      },
    };
  }
  throw new Error("invalid_policy:response_format");
}

function compileDefinition(
  definition: PresetModelDefinition,
  status: "draft" | "published" | "retired",
  catalog?: PluginCatalog,
  resolvePrompt?: (profile: string) => string,
): CompiledPresetModel {
  const providerProtocol = definition.provider.tool_protocol ?? "auto";
  const fixedPlugins = [...(definition.plugins?.fixed ?? [])];
  const graph = catalog?.compile(fixedPlugins);
  const pluginLocks = graph?.locks ?? [];
  const toolCatalog = graph?.toolNames ?? [];
  const allowedToolNames = definition.plugins?.allowed_tools ? [...definition.plugins.allowed_tools] : undefined;
  if (graph && allowedToolNames?.some((name) => !toolCatalog.includes(name))) {
    const invalid = allowedToolNames.find((name) => !toolCatalog.includes(name));
    throw new Error(`tool_not_bound:${invalid}`);
  }
  const bootstrapTools = definition.plugins?.bootstrap_tools as BootstrapToolRequest[] | undefined;
  if (providerProtocol === "none" && (fixedPlugins.length > 0 || Boolean(allowedToolNames?.length) || Boolean(bootstrapTools?.length))) {
    throw new Error("tool_protocol_none_with_tools");
  }
  const policy = compilePolicy(definition.policy);
  const promptProfile = definition.prompt?.profile ?? "agent";
  const systemPrompt = definition.prompt?.system !== undefined
    ? definition.prompt.system
    : resolvePrompt?.(promptProfile) ?? "";
  const promptHash = hash({ profile: promptProfile, content: systemPrompt });
  const pluginLockHash = graph?.pluginLockHash ?? hash(fixedPlugins);
  const snapshot = {
    provider_adapter: definition.provider.adapter,
    provider_model: definition.provider.model,
    credential_ref: definition.provider.credential_ref ?? null,
    tool_protocol: providerProtocol,
    provider_capabilities: definition.provider.capabilities ?? null,
    prompt_profile: promptProfile,
    prompt_content: systemPrompt,
    prompt_snapshot_version: 1,
    fixed_plugins: fixedPlugins,
    plugin_locks: pluginLocks,
    tool_catalog: toolCatalog,
    allowed_tools: allowedToolNames ?? null,
    bootstrap_tools: bootstrapTools ?? null,
    policy,
  };
  return {
    ref: `${definition.name}@${definition.version}` as PresetModelRef,
    name: definition.name,
    version: definition.version,
    description: definition.description,
    status,
    providerModel: definition.provider.model,
    toolProtocol: providerProtocol,
    ...(definition.provider.credential_ref ? { credentialRef: definition.provider.credential_ref } : {}),
    promptProfile,
    systemPrompt,
    promptSnapshotVersion: 1,
    fixedPlugins,
    pluginLocks,
    toolCatalog,
    ...(allowedToolNames ? { allowedToolNames } : {}),
    ...(bootstrapTools ? { bootstrapTools } : {}),
    policy,
    definition: structuredClone(definition),
    promptHash,
    pluginLockHash,
    compiledHash: hash(snapshot),
  };
}

function compiledFromRow(
  row: RegistryRow,
  catalog?: PluginCatalog,
  resolvePrompt?: (profile: string) => string,
): CompiledPresetModel {
  const definition = JSON.parse(row.definition_json) as PresetModelDefinition;
  const stored = parseCompiledSnapshot(row.compiled_snapshot_json);
  if (stored?.promptSnapshotVersion === 1) {
    const expectedPromptHash = hash({ profile: stored.promptProfile, content: stored.systemPrompt });
    const expectedPluginLockHash = hash(stored.pluginLocks.length > 0 ? stored.pluginLocks : stored.fixedPlugins);
    if (
      stored.name !== row.name
      || stored.version !== row.version
      || stored.compiledHash !== row.compiled_hash
      || stored.promptHash !== row.prompt_hash
      || stored.pluginLockHash !== row.plugin_lock_hash
      || expectedPromptHash !== row.prompt_hash
      || expectedPluginLockHash !== row.plugin_lock_hash
      || compiledHashFromSnapshot(definition, stored) !== row.compiled_hash
    ) {
      throw new Error("preset_model_compiled_hash_mismatch");
    }
    catalog?.assertCurrent(stored.pluginLocks);
    return {
      ...stored,
      status: row.status,
      definition,
      promptHash: row.prompt_hash,
      pluginLockHash: row.plugin_lock_hash,
      compiledHash: row.compiled_hash,
    };
  }
  const compiled = compileDefinition(definition, row.status, catalog, resolvePrompt);
  if (compiled.compiledHash !== row.compiled_hash && legacyCompiledHash(definition, compiled) !== row.compiled_hash) {
    throw new Error("preset_model_compiled_hash_mismatch");
  }
  if (compiled.pluginLockHash !== row.plugin_lock_hash) throw new Error("preset_model_plugin_lock_mismatch");
  return {
    ...compiled,
    promptHash: row.prompt_hash,
    pluginLockHash: row.plugin_lock_hash,
    compiledHash: row.compiled_hash,
  };
}

function compiledHashFromSnapshot(definition: PresetModelDefinition, model: CompiledPresetModel): string {
  return hash({
    provider_adapter: definition.provider.adapter,
    provider_model: model.providerModel,
    credential_ref: model.credentialRef ?? null,
    tool_protocol: model.toolProtocol,
    provider_capabilities: definition.provider.capabilities ?? null,
    prompt_profile: model.promptProfile,
    prompt_content: model.systemPrompt,
    prompt_snapshot_version: 1,
    fixed_plugins: model.fixedPlugins,
    plugin_locks: model.pluginLocks,
    tool_catalog: model.toolCatalog,
    allowed_tools: model.allowedToolNames ?? null,
    bootstrap_tools: model.bootstrapTools ?? null,
    policy: model.policy,
  });
}

function parseCompiledSnapshot(value: string): CompiledPresetModel | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<CompiledPresetModel>;
    return parsed && typeof parsed === "object" && typeof parsed.compiledHash === "string"
      ? parsed as CompiledPresetModel
      : undefined;
  } catch {
    return undefined;
  }
}

function legacyCompiledHash(definition: PresetModelDefinition, compiled: CompiledPresetModel): string {
  return hash({
    provider_model: definition.provider.model,
    tool_protocol: definition.provider.tool_protocol ?? "auto",
    prompt_profile: definition.prompt?.profile ?? "agent",
    system_prompt: definition.prompt?.system ?? "",
    fixed_plugins: compiled.fixedPlugins,
    plugin_locks: compiled.pluginLocks,
    tool_catalog: compiled.toolCatalog,
    allowed_tools: compiled.allowedToolNames ?? null,
    bootstrap_tools: compiled.bootstrapTools ?? null,
    policy: definition.policy ?? {},
  });
}

function parseRef(ref: string): { name: string; version?: number | undefined } {
  const value = ref.trim().toLowerCase();
  const match = /^([a-z][a-z0-9._-]{0,63})(?:@([1-9][0-9]{0,8}))?$/.exec(value);
  if (!match) throw new Error("invalid_preset_model_ref");
  return { name: match[1]!, ...(match[2] ? { version: Number(match[2]) } : {}) };
}

function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase();
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
