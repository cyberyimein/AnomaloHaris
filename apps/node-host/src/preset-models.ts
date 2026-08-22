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

import type { BootstrapToolRequest } from "./types.js";

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
  promptProfile?: string | undefined;
  systemPrompt?: string | undefined;
  fixedPlugins: string[];
  allowedToolNames?: string[] | undefined;
  bootstrapTools?: BootstrapToolRequest[] | undefined;
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
`;

export class SqlitePresetModelRegistry {
  readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;
  private readonly now: () => string;

  constructor(
    dbPath: string,
    options: { database?: DatabaseSync; now?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
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
  }

  createDraft(definition: PresetModelDefinition): CompiledPresetModel {
    validateDefinition(definition);
    const existing = this.db.prepare(
      "SELECT 1 FROM preset_model_versions WHERE name = ? AND version = ?",
    ).get(definition.name, definition.version);
    if (existing) throw new Error("preset_model_version_exists");

    const createdAt = this.now();
    const compiled = compileDefinition(definition, "draft");
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

  retire(ref: string): CompiledPresetModel {
    const record = this.read(ref, { includeDraft: true });
    if (record.status === "retired") return record;
    this.db.prepare(`
      UPDATE preset_model_versions
      SET status = 'retired', retired_at = ?
      WHERE name = ? AND version = ?
    `).run(this.now(), record.name, record.version);
    return this.read(`${record.name}@${record.version}`, { includeDraft: true });
  }

  resolve(ref: string, options: { allowDraft?: boolean } = {}): CompiledPresetModel {
    const record = this.read(ref, { includeDraft: options.allowDraft === true });
    if (record.status === "retired") throw new Error("preset_model_not_found");
    return record;
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
    return compiledFromRow(typed);
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

function compileDefinition(definition: PresetModelDefinition, status: "draft" | "published" | "retired"): CompiledPresetModel {
  const providerProtocol = definition.provider.tool_protocol ?? "auto";
  const fixedPlugins = [...(definition.plugins?.fixed ?? [])];
  const allowedToolNames = definition.plugins?.allowed_tools ? [...definition.plugins.allowed_tools] : undefined;
  const bootstrapTools = definition.plugins?.bootstrap_tools as BootstrapToolRequest[] | undefined;
  const promptHash = hash({ profile: definition.prompt?.profile ?? "agent", system: definition.prompt?.system ?? "" });
  const pluginLockHash = hash(fixedPlugins);
  const snapshot = {
    provider_model: definition.provider.model,
    tool_protocol: providerProtocol,
    prompt_profile: definition.prompt?.profile ?? "agent",
    system_prompt: definition.prompt?.system ?? "",
    fixed_plugins: fixedPlugins,
    allowed_tools: allowedToolNames ?? null,
    bootstrap_tools: bootstrapTools ?? null,
    policy: definition.policy ?? {},
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
    ...(definition.prompt?.profile ? { promptProfile: definition.prompt.profile } : {}),
    ...(definition.prompt?.system !== undefined ? { systemPrompt: definition.prompt.system } : {}),
    fixedPlugins,
    ...(allowedToolNames ? { allowedToolNames } : {}),
    ...(bootstrapTools ? { bootstrapTools } : {}),
    definition: structuredClone(definition),
    promptHash,
    pluginLockHash,
    compiledHash: hash(snapshot),
  };
}

function compiledFromRow(row: RegistryRow): CompiledPresetModel {
  const definition = JSON.parse(row.definition_json) as PresetModelDefinition;
  const compiled = compileDefinition(definition, row.status);
  if (compiled.compiledHash !== row.compiled_hash) throw new Error("preset_model_compiled_hash_mismatch");
  return {
    ...compiled,
    promptHash: row.prompt_hash,
    pluginLockHash: row.plugin_lock_hash,
    compiledHash: row.compiled_hash,
  };
}

function parseRef(ref: string): { name: string; version?: number | undefined } {
  const value = ref.trim().toLowerCase();
  const match = /^([a-z][a-z0-9._-]{0,63})(?:@([1-9][0-9]{0,8}))?$/.exec(value);
  if (!match) throw new Error("invalid_preset_model_ref");
  return { name: match[1]!, ...(match[2] ? { version: Number(match[2]) } : {}) };
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
