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
});
