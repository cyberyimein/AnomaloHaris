import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { ModelCatalog, ModelCatalogRevisionConflictError } from "./model-catalog.js";
import { DEFAULT_PRESET_MODEL_REF, SqlitePresetModelRegistry } from "./preset-models.js";

describe("ModelCatalog", () => {
  it("keeps stable bindings while model edits create restorable revisions", () => {
    const database = new DatabaseSync(":memory:");
    const catalog = new ModelCatalog(database, { now: () => "2026-11-16T00:00:00.000Z" });
    const created = catalog.createModel({
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      adapter: "openai-compatible",
      model: "deepseek/deepseek-v4-flash-0731",
      credentialRef: "openrouter-primary",
      toolProtocol: "auto",
    });

    catalog.bindPreset("anomaloharis@1", created.id);
    catalog.setDefaults({ defaultModelId: created.id, researchModelId: created.id });
    const edited = catalog.updateModel(created.id, {
      expectedRevision: created.revision,
      model: "deepseek/deepseek-v4.1-flash-1017",
    });

    expect(catalog.resolvePresetBinding("anomaloharis@1")).toMatchObject({
      id: "deepseek-flash",
      model: "deepseek/deepseek-v4.1-flash-1017",
      revision: edited.revision,
      active: true,
    });
    expect(catalog.getDefaultModelBinding("default")?.model).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(catalog.listModelImpact(created.id)).toEqual({
      modelId: created.id,
      presetRefs: ["anomaloharis@1"],
      defaultKeys: ["default_model_id", "research_model_id"],
    });

    expect(() => catalog.updateModel(created.id, {
      expectedRevision: created.revision,
      name: "Stale write",
    })).toThrow(ModelCatalogRevisionConflictError);

    const restored = catalog.restoreModelRevision(created.id, 1, edited.revision);
    expect(restored).toMatchObject({ model: "deepseek/deepseek-v4-flash-0731", revision: 3, active: true });
    expect(catalog.getModelHistory(created.id).map((entry) => entry.revision)).toEqual([3, 2, 1]);
    database.close();
  });

  it("moves selected references transactionally, keeps unused entries deletable, and blocks disabled bindings", () => {
    const database = new DatabaseSync(":memory:");
    const catalog = new ModelCatalog(database);
    const source = catalog.createModel({ id: "source", name: "Source", adapter: "openai-compatible", model: "source/model" });
    const target = catalog.createModel({ id: "target", name: "Target", adapter: "openai-compatible", model: "target/model" });
    catalog.bindPreset("one@1", source.id);
    catalog.bindPreset("two@1", source.id);
    catalog.setDefaults({ defaultModelId: source.id, researchModelId: target.id });

    const impact = catalog.listModelImpact(source.id);
    expect(impact.presetRefs).toEqual(["anomaloharis@1", "one@1", "two@1"]);
    expect(impact.defaultKeys).toEqual(["default_model_id"]);

    const replaced = catalog.replaceModelReferences(source.id, {
      targetModelId: target.id,
      presetRefs: ["one@1"],
      includeDefaults: true,
      expectedRevision: source.revision,
    });
    expect(replaced).toEqual({ updatedPresetRefs: ["anomaloharis@1", "one@1"], updatedDefaultKeys: ["default_model_id"] });
    expect(catalog.resolvePresetBinding("one@1")?.id).toBe(target.id);
    expect(catalog.resolvePresetBinding("two@1")?.id).toBe(source.id);
    expect(catalog.getDefaultModelBinding("default")?.id).toBe(target.id);

    expect(() => catalog.deleteModel(source.id, source.revision)).toThrow("model_catalog_model_referenced");
    const disabled = catalog.setModelActive(target.id, false, target.revision);
    expect(catalog.resolvePresetBinding("one@1")?.active).toBe(false);
    expect(() => catalog.deleteModel(target.id, disabled.revision)).toThrow("model_catalog_model_referenced");

    catalog.bindPreset("one@1", undefined);
    catalog.bindPreset("two@1", undefined);
    expect(catalog.deleteModel(source.id, catalog.getModel(source.id)!.revision)).toBe(true);
    database.close();
  });

  it("keeps the configured default preset and default selection in sync", () => {
    const registry = new SqlitePresetModelRegistry(":memory:", { defaultPresetModelRef: "custom-default@1" });
    const definition = {
      name: "custom-default",
      version: 1,
      description: "Configured default",
      provider: { adapter: "openai-compatible", model: "provider/original" },
      prompt: { system: "Custom default" },
      plugins: { fixed: [] },
    };
    registry.publish(registry.createDraft(definition).ref);
    registry.seedModelCatalogBindings({ defaultModel: "provider/environment", researchModel: "provider/research" });
    const seeded = registry.modelCatalog.getDefaults();
    expect(registry.resolvePresetBinding("custom-default@1")?.id).toBe(seeded.defaultModelId);

    const alternate = registry.modelCatalog.createModel({
      id: "alternate",
      name: "Alternate",
      adapter: "openai-compatible",
      model: "provider/alternate",
    });
    registry.bindPresetModel("custom-default@1", alternate.id);
    expect(registry.modelCatalog.getDefaults().defaultModelId).toBe(alternate.id);
    expect(registry.resolvePresetBinding("custom-default@1")?.id).toBe(alternate.id);
    registry.close();
  });

  it("merges legacy default-provider duplicates and canonicalizes legacy default refs on restart", () => {
    const aliasRegistry = new SqlitePresetModelRegistry(":memory:", { defaultPresetModelRef: "anomalo@1" }); // naming-compat
    expect(aliasRegistry.defaultPresetModelRef).toBe("anomaloharis@1");
    aliasRegistry.close();

    const database = new DatabaseSync(":memory:");
    const existing = new ModelCatalog(database);
    const preferred = existing.createModel({
      id: "flash-primary",
      name: "Flash",
      adapter: "openai-compatible",
      model: "deepseek/flash",
      credentialRef: "openrouter-primary",
      toolProtocol: "auto",
    });
    const duplicate = existing.createModel({
      id: "flash-implicit",
      name: "Flash legacy",
      adapter: "openai-compatible",
      model: "deepseek/flash",
      toolProtocol: "auto",
    });
    const implicitOnly = existing.createModel({
      id: "research-implicit",
      name: "Research",
      adapter: "openai-compatible",
      model: "deepseek/research",
      toolProtocol: "auto",
    });
    const customCredential = existing.createModel({
      id: "custom-credential",
      name: "Custom credential",
      adapter: "openai-compatible",
      model: "deepseek/custom",
      credentialRef: "custom-provider-credential",
      toolProtocol: "auto",
    });
    for (const ref of ["preset-a@1", "preset-b@1"]) existing.bindPreset(ref, preferred.id);
    for (const ref of ["urus-one@1", "urus-two@1"]) existing.bindPreset(ref, duplicate.id);
    existing.bindPreset("custom@1", customCredential.id);
    existing.setDefaults({ defaultModelId: preferred.id, researchModelId: preferred.id });
    database.prepare("UPDATE model_catalog SET credential_ref=NULL WHERE id IN (?,?)").run(duplicate.id, implicitOnly.id);
    database.prepare("INSERT INTO preset_model_catalog_bindings(preset_ref,model_id,revision,updated_at) VALUES(?,?,1,?)")
      .run("anomalo@1", duplicate.id, "2026-11-17T00:00:00.000Z"); // naming-compat

    const migrated = new ModelCatalog(database, { defaultPresetRef: "anomalo@1" }); // naming-compat
    expect(migrated.resolvePresetBinding("anomaloharis@1")?.id).toBe(preferred.id);
    expect(migrated.resolvePresetBinding("anomalo@1")).toBeUndefined(); // naming-compat
    expect(migrated.listModelImpact(preferred.id)).toEqual({
      modelId: preferred.id,
      presetRefs: ["anomaloharis@1", "preset-a@1", "preset-b@1", "urus-one@1", "urus-two@1"],
      defaultKeys: ["default_model_id", "research_model_id"],
    });
    expect(migrated.getModel(duplicate.id)).toMatchObject({ active: false, credentialRef: "openrouter-primary", usageCount: 0 });
    expect(migrated.getModel(duplicate.id)?.name).toContain("archived duplicate");
    expect(migrated.getModelHistory(duplicate.id).map(({ revision }) => revision)).toContain(2);
    expect(migrated.getModel(implicitOnly.id)).toMatchObject({ active: true, credentialRef: "openrouter-primary", revision: 2 });
    expect(migrated.getModel(customCredential.id)).toMatchObject({ active: true, credentialRef: "custom-provider-credential", revision: 1 });
    expect(migrated.ensureModel("Flash alias", {
      adapter: "openai-compatible",
      model: "deepseek/flash",
      toolProtocol: "auto",
    })).toBe(preferred.id);

    const restarted = new ModelCatalog(database, { defaultPresetRef: "anomalo@1" }); // naming-compat
    expect(restarted.listModelImpact(preferred.id).presetRefs).toHaveLength(5);
    expect(restarted.getModel(duplicate.id)).toMatchObject({ active: false, revision: 2 });
    expect(restarted.getModel(implicitOnly.id)).toMatchObject({ active: true, revision: 2 });
    database.close();
  });

  it("seeds published preset bindings idempotently and deduplicates provider configuration", () => {
    const database = new DatabaseSync(":memory:");
    const catalog = new ModelCatalog(database);
    const presets = [
      { ref: "a@1", status: "published", adapter: "openai-compatible", model: "deepseek/flash", credentialRef: "openrouter-primary", toolProtocol: "auto" },
      { ref: "b@1", status: "published", adapter: "openai-compatible", model: "deepseek/flash", credentialRef: "openrouter-primary", toolProtocol: "auto" },
      { ref: "c@1", status: "retired", adapter: "openai-compatible", model: "old/model", credentialRef: "openrouter-primary", toolProtocol: "auto" },
    ] as const;

    catalog.seedPresetBindings(presets);
    const models = catalog.listModels();
    expect(models).toHaveLength(1);
    expect(catalog.resolvePresetBinding("a@1")?.id).toBe(catalog.resolvePresetBinding("b@1")?.id);
    expect(catalog.resolvePresetBinding("c@1")).toBeUndefined();
    catalog.seedPresetBindings(presets);
    expect(catalog.listModels()).toHaveLength(1);
    database.close();
  });

  it("migrates active presets without changing their compiled hash", () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    const preset = registry.ensureBuiltinDefault({ model: "deepseek/deepseek-v4.1-flash-1017" });
    const compiledHash = preset.compiledHash;
    registry.seedModelCatalogBindings({
      defaultModel: "deepseek/deepseek-v4.1-flash-1017",
      researchModel: "deepseek/research-flash",
    });
    const binding = registry.resolvePresetBinding(DEFAULT_PRESET_MODEL_REF)!;
    const entry = registry.modelCatalog.getModel(binding.id)!;
    registry.modelCatalog.updateModel(binding.id, {
      expectedRevision: entry.revision,
      model: "deepseek/deepseek-next-flash",
    });

    expect(registry.resolvePresetBinding(DEFAULT_PRESET_MODEL_REF)?.model).toBe("deepseek/deepseek-next-flash");
    expect(registry.resolve(DEFAULT_PRESET_MODEL_REF).compiledHash).toBe(compiledHash);
    registry.seedModelCatalogBindings({
      defaultModel: "deepseek/deepseek-v4.1-flash-1017",
      researchModel: "deepseek/research-flash",
    });
    expect(registry.modelCatalog.listModels()).toHaveLength(2);
    registry.close();
  });

  it("persists entries, bindings, defaults, and revisions across catalog instances", () => {
    const database = new DatabaseSync(":memory:");
    const catalog = new ModelCatalog(database);
    const entry = catalog.createModel({ id: "persistent", name: "Persistent", adapter: "openai-compatible", model: "provider/one" });
    catalog.bindPreset("preset@1", entry.id);
    catalog.setDefaults({ defaultModelId: entry.id, researchModelId: entry.id });
    catalog.updateModel(entry.id, { expectedRevision: entry.revision, model: "provider/two" });

    const restarted = new ModelCatalog(database);
    expect(restarted.resolvePresetBinding("preset@1")?.model).toBe("provider/two");
    expect(restarted.getDefaultModelBinding("research")?.id).toBe(entry.id);
    expect(restarted.getModelHistory(entry.id).map(({ revision }) => revision)).toEqual([2, 1]);
    database.close();
  });

  it("removes retired preset bindings while preserving their compiled provider model", () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    const builtin = registry.ensureBuiltinDefault({ model: "deepseek/default" });
    const firstDefinition = {
      ...builtin.definition,
      name: "retirable",
      version: 1,
      description: "First version",
      provider: { ...builtin.definition.provider, model: "provider/old" },
    };
    registry.publish(registry.createDraft(firstDefinition).ref);
    registry.ensurePresetModelBinding("retirable@1", firstDefinition.provider.model, firstDefinition.provider);
    const secondDefinition = { ...firstDefinition, version: 2, description: "Second version" };
    const secondDraft = registry.createDraft(secondDefinition);
    registry.ensurePresetModelBinding("retirable@2", secondDefinition.provider.model, secondDefinition.provider);
    registry.publish(secondDraft.ref);

    expect(registry.resolve("retirable@1", { allowRetired: true }).definition.provider.model).toBe("provider/old");
    expect(registry.resolvePresetBinding("retirable@1")).toBeUndefined();
    expect(registry.resolvePresetBinding("retirable@2")?.model).toBe("provider/old");
    registry.close();
  });
});
