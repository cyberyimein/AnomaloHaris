import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_PRESET_MODEL_REF, SqlitePresetModelRegistry } from "./preset-models.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqlitePresetModelRegistry", () => {
  it("publishes immutable versions and keeps the compiled hash stable across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "anomalo-preset-model-"));
    directories.push(directory);
    const databasePath = join(directory, "preset-models.sqlite3");
    const first = new SqlitePresetModelRegistry(databasePath, { now: () => "2026-08-22T00:00:00.000Z" });
    const definition = {
      name: "luna",
      version: 1,
      description: "Coding preset",
      provider: { adapter: "openai-compatible", model: "deepseek/deepseek-chat", tool_protocol: "auto" as const },
      prompt: { profile: "agent" },
      plugins: { fixed: ["host-core", "web"], allowed_tools: ["web_search"] },
    };
    first.createDraft(definition);
    const published = first.publish("luna@1");
    expect(published.ref).toBe("luna@1");
    expect(first.resolve("luna@1").compiledHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => first.createDraft({ ...definition, description: "changed" })).toThrow("preset_model_version_exists");
    const hash = published.compiledHash;
    first.close();

    const restarted = new SqlitePresetModelRegistry(databasePath);
    expect(restarted.resolve("luna@1").compiledHash).toBe(hash);
    expect(restarted.list()).toEqual([
      expect.objectContaining({ ref: "luna@1", status: "published", provider_model: "deepseek/deepseek-chat" }),
    ]);
    restarted.close();
  });

  it("freezes resolved prompt profile content in the published snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "anomalo-preset-prompt-"));
    directories.push(directory);
    const databasePath = join(directory, "preset-models.sqlite3");
    let prompt = "first prompt";
    const first = new SqlitePresetModelRegistry(databasePath, { resolvePrompt: () => prompt });
    const published = first.publish(first.createDraft({
      name: "prompt-model",
      version: 1,
      description: "Prompt snapshot test",
      provider: { adapter: "openai-compatible", model: "provider", tool_protocol: "auto" },
      prompt: { profile: "agent" },
      plugins: { fixed: [] },
    }).ref);
    expect(published.systemPrompt).toBe("first prompt");
    const compiledHash = published.compiledHash;
    first.close();

    prompt = "changed prompt";
    const restarted = new SqlitePresetModelRegistry(databasePath, { resolvePrompt: () => prompt });
    expect(restarted.resolve("prompt-model@1")).toMatchObject({
      systemPrompt: "first prompt",
      promptHash: published.promptHash,
      compiledHash,
    });
    restarted.close();
  });

  it("seeds the built-in default and provides a dry-run legacy migration", () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    const builtin = registry.ensureBuiltinDefault({ model: "openai/gpt-4o-mini" });
    expect(builtin.ref).toBe(DEFAULT_PRESET_MODEL_REF);
    expect(registry.resolve("anomalo").providerModel).toBe("openai/gpt-4o-mini");

    const report = registry.migrationDryRun([
      { name: "Luna", description: "writer", model: "deepseek/deepseek-chat", tool_names: ["web_search"] },
      { name: "anomalo", model: "openai/gpt-4o-mini" },
      { name: "", model: "broken" },
    ]);
    expect(report.dryRun).toBe(true);
    expect(report.created.map((item) => item.ref)).toEqual(["luna@1"]);
    expect(report.skipped).toEqual([{ ref: "anomalo@1", reason: "already_exists" }]);
    expect(report.errors[0]?.name).toBe("");
    expect(registry.list()).toHaveLength(1);
    registry.close();
  });

  it("compiles provider and policy behavior into the immutable snapshot", () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    const first = registry.publish(registry.createDraft({
      name: "policy-model",
      version: 1,
      description: "Policy test",
      provider: {
        adapter: "openai-compatible",
        model: "provider-a",
        credential_ref: "credential-a",
        tool_protocol: "dsml",
      },
      plugins: { fixed: [] },
      policy: {
        temperature: 0.2,
        max_tool_iterations: 8,
        run_timeout_ms: 20_000,
        tool_timeout_ms: 4_000,
        response_format: { type: "json_object" },
        search_mode: "diy",
      },
    }).ref);
    expect(first.policy).toMatchObject({
      temperature: 0.2,
      maxToolIterations: 8,
      runTimeoutMs: 20_000,
      toolTimeoutMs: 4_000,
      responseFormat: { type: "json_object" },
      searchMode: "diy",
    });

    const second = registry.publish(registry.createDraft({
      ...first.definition,
      version: 2,
      provider: { ...first.definition.provider, credential_ref: "credential-b" },
    }).ref);
    expect(second.compiledHash).not.toBe(first.compiledHash);
    registry.close();
  });

  it("keeps retired models available only to bound-session resolution", () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    const model = registry.publish(registry.createDraft({
      name: "retirable",
      version: 1,
      description: "Retire test",
      provider: { adapter: "openai-compatible", model: "provider", tool_protocol: "auto" },
      plugins: { fixed: [] },
    }).ref);
    registry.retire(model.ref);
    expect(() => registry.resolve(model.ref)).toThrow("preset_model_not_found");
    expect(registry.resolveForBoundSession(model.ref).status).toBe("retired");

    registry.ensureBuiltinDefault({ model: "provider" });
    expect(() => registry.retire(DEFAULT_PRESET_MODEL_REF, { defaultRef: DEFAULT_PRESET_MODEL_REF })).toThrow("preset_model_default_cannot_retire");
    registry.retire(DEFAULT_PRESET_MODEL_REF);
    expect(registry.ensureBuiltinDefault({ model: "provider" }).status).toBe("retired");
    registry.close();
  });

  it("rejects tool bindings for a text-only provider protocol", () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    expect(() => registry.createDraft({
      name: "text-only",
      version: 1,
      description: "Text-only model",
      provider: { adapter: "openai-compatible", model: "provider", tool_protocol: "none" },
      plugins: { fixed: ["host-core"] },
    })).toThrow("tool_protocol_none_with_tools");
    registry.close();
  });
});
