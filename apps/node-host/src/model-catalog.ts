import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ModelCatalogProvider = {
  adapter: string;
  model: string;
  credentialRef?: string | undefined;
  toolProtocol?: "openai" | "dsml" | "auto" | "none" | undefined;
  capabilities?: Record<string, unknown> | undefined;
};

export type ModelCatalogEntry = ModelCatalogProvider & {
  id: string;
  name: string;
  active: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  usageCount: number;
};

export type ModelBinding = ModelCatalogProvider & {
  id: string;
  revision: number;
  active: boolean;
};

export type ModelCatalogDefaults = {
  defaultModelId?: string | undefined;
  researchModelId?: string | undefined;
  revision: number;
  updatedAt: string;
};

export type PresetProviderSeed = ModelCatalogProvider & {
  ref: string;
  status: "draft" | "published" | "retired";
};

export class ModelCatalogRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super("model_catalog_revision_conflict");
  }
}

const MODEL_CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_ref TEXT,
  tool_protocol TEXT,
  capabilities_json TEXT,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_catalog_history (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_ref TEXT,
  tool_protocol TEXT,
  capabilities_json TEXT,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id, revision)
);
CREATE TABLE IF NOT EXISTS preset_model_catalog_bindings (
  preset_ref TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES model_catalog(id),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_catalog_defaults (
  id INTEGER PRIMARY KEY CHECK(id=1),
  default_model_id TEXT REFERENCES model_catalog(id),
  research_model_id TEXT REFERENCES model_catalog(id),
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`;
const DEFAULT_PRESET_REF = "anomaloharis@1";

type ModelRow = {
  id: string;
  name: string;
  adapter: string;
  model: string;
  credential_ref: string | null;
  tool_protocol: string | null;
  capabilities_json: string | null;
  active: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

type HistoryRow = Omit<ModelRow, "created_at">;

type DefaultsRow = {
  default_model_id: string | null;
  research_model_id: string | null;
  revision: number;
  updated_at: string;
};

export class ModelCatalog {
  constructor(
    readonly db: DatabaseSync,
    private readonly options: { now?: () => string; defaultPresetRef?: string } = {},
  ) {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(MODEL_CATALOG_SCHEMA);
  }

  listModels(): ModelCatalogEntry[] {
    const rows = this.db.prepare(`
      SELECT model_catalog.*, (
        SELECT COUNT(*) FROM preset_model_catalog_bindings AS binding
        WHERE binding.model_id = model_catalog.id
      ) + (
        SELECT CASE WHEN default_model_id = model_catalog.id THEN 1 ELSE 0 END
          + CASE WHEN research_model_id = model_catalog.id THEN 1 ELSE 0 END
        FROM model_catalog_defaults WHERE id = 1
      ) AS usage_count
      FROM model_catalog ORDER BY name COLLATE NOCASE, id
    `).all() as Array<ModelRow & { usage_count: number }>;
    return rows.map((row) => this.entry(row));
  }

  getModel(id: string): ModelCatalogEntry | undefined {
    const row = this.db.prepare(`
      SELECT model_catalog.*, (
        SELECT COUNT(*) FROM preset_model_catalog_bindings AS binding
        WHERE binding.model_id = model_catalog.id
      ) + COALESCE((SELECT CASE WHEN default_model_id = model_catalog.id THEN 1 ELSE 0 END
        + CASE WHEN research_model_id = model_catalog.id THEN 1 ELSE 0 END
        FROM model_catalog_defaults WHERE id = 1), 0) AS usage_count
      FROM model_catalog WHERE id = ?
    `).get(id) as (ModelRow & { usage_count: number }) | undefined;
    return row ? this.entry(row) : undefined;
  }

  createModel(input: {
    id: string;
    name: string;
    adapter: string;
    model: string;
    credentialRef?: string | undefined;
    toolProtocol?: ModelCatalogProvider["toolProtocol"];
    capabilities?: Record<string, unknown> | undefined;
  }): ModelCatalogEntry {
    validateModelIdentity(input.id, input.name);
    validateProvider(input);
    return this.transaction(() => {
      if (this.getModel(input.id)) throw new Error("model_catalog_model_exists");
      const now = this.now();
      this.db.prepare(`
        INSERT INTO model_catalog(id,name,adapter,model,credential_ref,tool_protocol,capabilities_json,active,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,1,?,?)
      `).run(input.id, input.name.trim(), input.adapter, input.model.trim(), input.credentialRef ?? null,
        input.toolProtocol ?? null, stringifyCapabilities(input.capabilities), now, now);
      this.snapshot(input.id, 1, now);
      return this.getModel(input.id)!;
    });
  }

  updateModel(id: string, patch: {
    expectedRevision: number;
    name?: string;
    adapter?: string;
    model?: string;
    active?: boolean;
    credentialRef?: string | null;
    toolProtocol?: ModelCatalogProvider["toolProtocol"] | null;
    capabilities?: Record<string, unknown> | null;
  }): ModelCatalogEntry {
    return this.transaction(() => {
      const current = this.requireModel(id);
      this.requireRevision(patch.expectedRevision, current.revision);
      const next = {
        id,
        name: patch.name?.trim() ?? current.name,
        adapter: patch.adapter?.trim() ?? current.adapter,
        model: patch.model?.trim() ?? current.model,
        credentialRef: patch.credentialRef === undefined ? current.credentialRef : patch.credentialRef ?? undefined,
        toolProtocol: patch.toolProtocol === undefined ? current.toolProtocol : patch.toolProtocol ?? undefined,
        capabilities: patch.capabilities === undefined ? current.capabilities : patch.capabilities ?? undefined,
        active: patch.active ?? current.active,
      };
      validateModelIdentity(id, next.name);
      validateProvider(next);
      const revision = current.revision + 1;
      const now = this.now();
      this.db.prepare(`
        UPDATE model_catalog SET name=?, adapter=?, model=?, credential_ref=?, tool_protocol=?, capabilities_json=?, active=?, revision=?, updated_at=?
        WHERE id=? AND revision=?
      `).run(next.name, next.adapter, next.model, next.credentialRef ?? null, next.toolProtocol ?? null,
        stringifyCapabilities(next.capabilities), next.active ? 1 : 0, revision, now, id, patch.expectedRevision);
      this.snapshot(id, revision, now);
      return this.getModel(id)!;
    });
  }

  setModelActive(id: string, active: boolean, expectedRevision: number): ModelCatalogEntry {
    return this.transaction(() => {
      const current = this.requireModel(id);
      this.requireRevision(expectedRevision, current.revision);
      if (current.active === active) return current;
      const revision = current.revision + 1;
      const now = this.now();
      this.db.prepare("UPDATE model_catalog SET active=?, revision=?, updated_at=? WHERE id=? AND revision=?")
        .run(active ? 1 : 0, revision, now, id, expectedRevision);
      this.snapshot(id, revision, now);
      return this.getModel(id)!;
    });
  }

  deleteModel(id: string, expectedRevision: number): boolean {
    this.transaction(() => {
      const current = this.requireModel(id);
      this.requireRevision(expectedRevision, current.revision);
      const impact = this.listModelImpact(id);
      if (impact.presetRefs.length || impact.defaultKeys.length) throw new Error("model_catalog_model_referenced");
      this.db.prepare("DELETE FROM model_catalog_history WHERE id=?").run(id);
      this.db.prepare("DELETE FROM model_catalog WHERE id=? AND revision=?").run(id, expectedRevision);
    });
    return true;
  }

  getModelHistory(id: string): Array<ModelCatalogEntry & { updatedAt: string }> {
    this.requireModel(id);
    const rows = this.db.prepare(`
      SELECT history.*, catalog.created_at,
        COALESCE((SELECT COUNT(*) FROM preset_model_catalog_bindings AS binding WHERE binding.model_id=history.id),0)
        + COALESCE((SELECT CASE WHEN default_model_id=history.id THEN 1 ELSE 0 END + CASE WHEN research_model_id=history.id THEN 1 ELSE 0 END FROM model_catalog_defaults WHERE id=1),0) AS usage_count
      FROM model_catalog_history AS history JOIN model_catalog AS catalog ON catalog.id=history.id
      WHERE history.id=? ORDER BY history.revision DESC
    `).all(id) as Array<HistoryRow & { created_at: string; usage_count: number }>;
    return rows.map((row) => ({ ...this.entry(row), updatedAt: row.updated_at }));
  }

  restoreModelRevision(id: string, revisionToRestore: number, expectedRevision: number): ModelCatalogEntry {
    const current = this.requireModel(id);
    this.requireRevision(expectedRevision, current.revision);
    const historical = this.db.prepare("SELECT * FROM model_catalog_history WHERE id=? AND revision=?")
      .get(id, revisionToRestore) as HistoryRow | undefined;
    if (!historical) throw new Error("model_catalog_revision_not_found");
    return this.updateModel(id, {
      expectedRevision,
      name: historical.name,
      adapter: historical.adapter,
      model: historical.model,
      credentialRef: historical.credential_ref,
      toolProtocol: historical.tool_protocol as ModelCatalogProvider["toolProtocol"] | null,
      capabilities: historical.capabilities_json ? JSON.parse(historical.capabilities_json) as Record<string, unknown> : null,
      active: Boolean(historical.active),
    });
  }

  getDefaults(): ModelCatalogDefaults {
    const row = this.db.prepare("SELECT default_model_id,research_model_id,revision,updated_at FROM model_catalog_defaults WHERE id=1")
      .get() as DefaultsRow | undefined;
    return row ? this.defaults(row) : { revision: 0, updatedAt: this.now() };
  }

  setDefaults(input: {
    defaultModelId?: string | null | undefined;
    researchModelId?: string | null | undefined;
    expectedRevision?: number | undefined;
  }): ModelCatalogDefaults {
    return this.transaction(() => {
      const current = this.getDefaults();
      if (input.expectedRevision !== undefined) this.requireRevision(input.expectedRevision, current.revision);
      const defaultModelId = input.defaultModelId === undefined ? current.defaultModelId : input.defaultModelId ?? undefined;
      const researchModelId = input.researchModelId === undefined ? current.researchModelId : input.researchModelId ?? undefined;
      if (current.revision > 0 && !defaultModelId) {
        throw new Error("model_catalog_default_preset_binding_required");
      }
      this.assertActiveModel(defaultModelId);
      this.assertActiveModel(researchModelId);
      const revision = current.revision + 1;
      const now = this.now();
      this.db.prepare(`
        INSERT INTO model_catalog_defaults(id,default_model_id,research_model_id,revision,updated_at)
        VALUES(1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET default_model_id=excluded.default_model_id,
          research_model_id=excluded.research_model_id,revision=excluded.revision,updated_at=excluded.updated_at
      `).run(defaultModelId ?? null, researchModelId ?? null, revision, now);
      if (defaultModelId) this.writePresetBinding(this.defaultPresetRef, defaultModelId);
      return this.getDefaults();
    });
  }

  seedDefaults(defaultModelId: string, researchModelId: string): ModelCatalogDefaults {
    const current = this.db.prepare("SELECT 1 FROM model_catalog_defaults WHERE id=1").get();
    if (current) return this.getDefaults();
    return this.setDefaults({ defaultModelId, researchModelId, expectedRevision: 0 });
  }

  ensureModel(name: string, provider: ModelCatalogProvider): string {
    validateProvider(provider);
    const normalized = normalizeProvider(provider);
    const existing = this.db.prepare("SELECT id FROM model_catalog WHERE adapter=? AND model=? AND credential_ref IS ? AND tool_protocol IS ? LIMIT 1")
      .get(normalized.adapter, normalized.model, normalized.credentialRef ?? null, normalized.toolProtocol ?? null) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = `model-${createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16)}`;
    if (!this.getModel(id)) this.createModel({ id, name: name.trim() || provider.model, ...normalized });
    return id;
  }

  seedPresetBindings(presets: readonly PresetProviderSeed[]): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO preset_model_catalog_bindings(preset_ref,model_id,revision,updated_at) VALUES(?,?,1,?)");
    this.transaction(() => {
      for (const preset of presets) {
        if (preset.status !== "published") continue;
        const existing = this.db.prepare("SELECT 1 FROM preset_model_catalog_bindings WHERE preset_ref=?").get(preset.ref);
        if (existing) continue;
        const modelId = this.ensureModel(preset.model, preset);
        insert.run(preset.ref, modelId, this.now());
      }
    });
  }

  bindPreset(ref: string, modelId: string | undefined): number {
    return this.transaction(() => {
      if (modelId) this.assertActiveModel(modelId);
      if (ref === this.defaultPresetRef && !modelId && this.getDefaults().revision > 0) {
        throw new Error("model_catalog_default_preset_binding_required");
      }
      const revision = this.writePresetBinding(ref, modelId);
      if (ref === this.defaultPresetRef && modelId) this.syncDefaultSelection(modelId);
      return revision;
    });
  }

  resolvePresetBinding(ref: string): ModelBinding | undefined {
    const row = this.db.prepare(`
      SELECT catalog.* FROM preset_model_catalog_bindings AS binding
      JOIN model_catalog AS catalog ON catalog.id=binding.model_id WHERE binding.preset_ref=?
    `).get(ref) as ModelRow | undefined;
    return row ? this.binding(row) : undefined;
  }

  getDefaultModelBinding(kind: "default" | "research"): ModelBinding | undefined {
    const defaults = this.getDefaults();
    const id = kind === "default" ? defaults.defaultModelId : defaults.researchModelId;
    if (!id) return undefined;
    const model = this.getModel(id);
    return model ? this.asBinding(model) : undefined;
  }

  listModelImpact(id: string): { modelId: string; presetRefs: string[]; defaultKeys: string[] } {
    const presetRefs = (this.db.prepare("SELECT preset_ref FROM preset_model_catalog_bindings WHERE model_id=? ORDER BY preset_ref")
      .all(id) as Array<{ preset_ref: string }>).map((row) => row.preset_ref);
    const defaults = this.getDefaults();
    const defaultKeys = [
      ...(defaults.defaultModelId === id ? ["default_model_id"] : []),
      ...(defaults.researchModelId === id ? ["research_model_id"] : []),
    ];
    return { modelId: id, presetRefs, defaultKeys };
  }

  replaceModelReferences(sourceId: string, input: {
    targetModelId: string;
    presetRefs?: readonly string[] | undefined;
    includeDefaults?: boolean | undefined;
    expectedRevision: number;
  }): { updatedPresetRefs: string[]; updatedDefaultKeys: string[] } {
    return this.transaction(() => {
      const source = this.requireModel(sourceId);
      this.requireRevision(input.expectedRevision, source.revision);
      if (sourceId === input.targetModelId) throw new Error("model_catalog_same_replacement");
      this.assertActiveModel(input.targetModelId);
      const impact = this.listModelImpact(sourceId);
      const selectedRefs = input.presetRefs === undefined
        ? impact.presetRefs
        : [...new Set(input.presetRefs)].sort();
      const unbound = selectedRefs.find((ref) => !impact.presetRefs.includes(ref));
      if (unbound) throw new Error("model_catalog_preset_binding_conflict");
      const defaultPresetSelected = selectedRefs.includes(this.defaultPresetRef);
      const updatedDefaultKeys = input.includeDefaults
        ? impact.defaultKeys
        : defaultPresetSelected && impact.defaultKeys.includes("default_model_id")
          ? ["default_model_id"]
          : [];
      for (const ref of selectedRefs) this.writePresetBinding(ref, input.targetModelId);
      if (updatedDefaultKeys.length) {
        const defaults = this.getDefaults();
        this.setDefaults({
          defaultModelId: updatedDefaultKeys.includes("default_model_id") ? input.targetModelId : defaults.defaultModelId,
          researchModelId: updatedDefaultKeys.includes("research_model_id") ? input.targetModelId : defaults.researchModelId,
          expectedRevision: defaults.revision,
        });
      }
      const updatedPresetRefs = updatedDefaultKeys.includes("default_model_id") && !selectedRefs.includes(this.defaultPresetRef)
        ? [...selectedRefs, this.defaultPresetRef].sort()
        : selectedRefs;
      return { updatedPresetRefs, updatedDefaultKeys };
    });
  }

  private assertActiveModel(id: string | undefined): void {
    if (!id) return;
    const entry = this.getModel(id);
    if (!entry) throw new Error("model_catalog_model_not_found");
    if (!entry.active) throw new Error("model_catalog_model_disabled");
  }

  private requireModel(id: string): ModelCatalogEntry {
    const model = this.getModel(id);
    if (!model) throw new Error("model_catalog_model_not_found");
    return model;
  }

  private requireRevision(expected: number, actual: number): void {
    if (expected !== actual) throw new ModelCatalogRevisionConflictError(expected, actual);
  }

  private snapshot(id: string, revision: number, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO model_catalog_history(id,revision,name,adapter,model,credential_ref,tool_protocol,capabilities_json,active,updated_at)
      SELECT id,revision,name,adapter,model,credential_ref,tool_protocol,capabilities_json,active,?
      FROM model_catalog WHERE id=? AND revision=?
    `).run(updatedAt, id, revision);
  }

  private writePresetBinding(ref: string, modelId: string | undefined): number {
    const now = this.now();
    const current = this.db.prepare("SELECT model_id,revision FROM preset_model_catalog_bindings WHERE preset_ref=?")
      .get(ref) as { model_id: string; revision: number } | undefined;
    if (!modelId) {
      this.db.prepare("DELETE FROM preset_model_catalog_bindings WHERE preset_ref=?").run(ref);
      return 0;
    }
    if (current?.model_id === modelId) return current.revision;
    const revision = (current?.revision ?? 0) + 1;
    this.db.prepare(`
      INSERT INTO preset_model_catalog_bindings(preset_ref,model_id,revision,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(preset_ref) DO UPDATE SET model_id=excluded.model_id,revision=excluded.revision,updated_at=excluded.updated_at
    `).run(ref, modelId, revision, now);
    return revision;
  }

  private syncDefaultSelection(modelId: string): void {
    const current = this.getDefaults();
    if (current.revision === 0 || current.defaultModelId === modelId) return;
    this.db.prepare("UPDATE model_catalog_defaults SET default_model_id=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?")
      .run(modelId, this.now(), current.revision);
  }

  private transaction<T>(callback: () => T): T {
    if (this.db.isTransaction) return callback();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private get defaultPresetRef(): string {
    return this.options.defaultPresetRef ?? DEFAULT_PRESET_REF;
  }

  private entry(row: ModelRow & { usage_count: number }): ModelCatalogEntry {
    return {
      id: row.id,
      name: row.name,
      adapter: row.adapter,
      model: row.model,
      ...(row.credential_ref ? { credentialRef: row.credential_ref } : {}),
      ...(row.tool_protocol ? { toolProtocol: row.tool_protocol as ModelCatalogProvider["toolProtocol"] } : {}),
      ...(row.capabilities_json ? { capabilities: JSON.parse(row.capabilities_json) as Record<string, unknown> } : {}),
      active: row.active === 1,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      usageCount: Number(row.usage_count),
    };
  }

  private binding(row: ModelRow): ModelBinding {
    return {
      id: row.id,
      adapter: row.adapter,
      model: row.model,
      ...(row.credential_ref ? { credentialRef: row.credential_ref } : {}),
      ...(row.tool_protocol ? { toolProtocol: row.tool_protocol as ModelCatalogProvider["toolProtocol"] } : {}),
      ...(row.capabilities_json ? { capabilities: JSON.parse(row.capabilities_json) as Record<string, unknown> } : {}),
      active: row.active === 1,
      revision: row.revision,
    };
  }

  private asBinding(entry: ModelCatalogEntry): ModelBinding {
    const { id, adapter, model, credentialRef, toolProtocol, capabilities, active, revision } = entry;
    return { id, adapter, model, ...(credentialRef ? { credentialRef } : {}), ...(toolProtocol ? { toolProtocol } : {}), ...(capabilities ? { capabilities } : {}), active, revision };
  }

  private defaults(row: DefaultsRow): ModelCatalogDefaults {
    return {
      ...(row.default_model_id ? { defaultModelId: row.default_model_id } : {}),
      ...(row.research_model_id ? { researchModelId: row.research_model_id } : {}),
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  }
}

function normalizeProvider(provider: ModelCatalogProvider): Required<Pick<ModelCatalogProvider, "adapter" | "model">> & ModelCatalogProvider {
  return {
    adapter: provider.adapter.trim(),
    model: provider.model.trim(),
    ...(provider.credentialRef ? { credentialRef: provider.credentialRef.trim() } : {}),
    ...(provider.toolProtocol ? { toolProtocol: provider.toolProtocol } : {}),
    ...(provider.capabilities ? { capabilities: provider.capabilities } : {}),
  };
}

function validateModelIdentity(id: string, name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error("model_catalog_invalid_id");
  if (!name.trim() || name.trim().length > 120) throw new Error("model_catalog_invalid_name");
}

function validateProvider(provider: ModelCatalogProvider): void {
  const adapter = provider.adapter.trim();
  if (!adapter || adapter.length > 80) throw new Error("model_catalog_invalid_adapter");
  if (adapter !== "openai-compatible") throw new Error("model_catalog_adapter_unsupported");
  if (!provider.model.trim() || provider.model.length > 200) throw new Error("model_catalog_invalid_provider_model");
  if (provider.credentialRef && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider.credentialRef)) throw new Error("model_catalog_invalid_credential_ref");
  if (provider.toolProtocol && !["openai", "dsml", "auto", "none"].includes(provider.toolProtocol)) throw new Error("model_catalog_invalid_tool_protocol");
}

function stringifyCapabilities(capabilities: Record<string, unknown> | undefined): string | null {
  return capabilities ? JSON.stringify(capabilities) : null;
}
