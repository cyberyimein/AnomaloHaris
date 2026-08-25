import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InProcessPluginBackend, PiPluginHost, resolvePluginModuleSpecifier } from "./plugins.js";
import { builtinPluginCatalog, createPluginManifest, PluginCatalog } from "./plugin-catalog.js";
import { SqlitePresetModelRegistry } from "./preset-models.js";
import type { ToolContext } from "./types.js";

const directories: string[] = [];
const context: ToolContext = {
  sessionId: "catalog-session",
  runId: "catalog-run",
  searchMode: "diy",
  model: "fixture-model",
  activeSkills: new Set(),
  activeMcpServers: new Set(),
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PluginCatalog", () => {
  it("only exposes explicitly declared workflow-callable operations", () => {
    const catalog = new PluginCatalog([createPluginManifest({
      id: "workflow-fixture",
      version: "1.0.0",
      package: "workflow-fixture",
      entry: "builtin:workflow-fixture",
      compatibility: "L2",
      workflowOperations: [{
        id: "workflow-fixture.lookup",
        version: 1,
        workflow_callable: true,
        description: "Read a fixture value.",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        permissions: ["fixture.read"],
        timeout_ms: 1_000,
        idempotency: "supported",
      }],
    })]);

    expect(catalog.listWorkflowOperations()).toEqual([
      expect.objectContaining({ id: "workflow-fixture.lookup", plugin_id: "workflow-fixture", plugin_version: "1.0.0" }),
    ]);
    expect(catalog.listWorkflowOperations()).not.toContainEqual(expect.objectContaining({ id: "time_now" }));
  });

  it("catalogues Buddy as an optional fixed plugin without loading it by default", () => {
    const manifest = builtinPluginCatalog().get("buddy-bridge");

    expect(manifest).toMatchObject({
      id: "buddy-bridge",
      package: "@anomaloharis/buddy-bridge",
      packageRoot: expect.stringMatching(/[\\/]apps[\\/]buddy-bridge[\\/]dist$/),
      capabilities: ["buddy"],
      toolNames: expect.arrayContaining(["buddy_status", "buddy_set_state"]),
    });
  });

  it("keeps the Buddy package lock stable when the host cwd changes", () => {
    const catalog = builtinPluginCatalog();
    const locks = catalog.compile(["buddy-bridge@1.0.0"]).locks;
    const originalCwd = process.cwd();
    process.chdir(join(originalCwd, "..", ".."));
    try {
      expect(() => catalog.assertCurrent(locks)).not.toThrow();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("locks an on-disk plugin and blocks source drift before invocation", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".anomaloharis-real-plugin-"));
    directories.push(directory);
    const entry = join(directory, "index.mjs");
    writeFileSync(entry, `export default { tools: [{ name: "real_echo", description: "Echo", parameters: { type: "object" }, source: "fixture-real" }], callTool(call) { return { name: call.name, ok: true, content: "real", data: {} }; } };`);
    const manifest = createPluginManifest({
      id: "fixture-real",
      version: "1.0.0",
      package: "fixture-real",
      entry,
      packageRoot: directory,
      compatibility: "L2",
      permissions: ["tools.register"],
      toolNames: ["real_echo"],
    });
    const catalog = new PluginCatalog([manifest]);
    expect(resolvePluginModuleSpecifier({ entry })).toMatch(/^file:/);
    const graph = catalog.compile(["fixture-real@1.0.0"]);
    const host = new PiPluginHost({ catalog, backend: new InProcessPluginBackend() });
    const report = await host.load({
      plugins: [{
        id: manifest.id,
        version: manifest.version,
        entry,
        compatibility: manifest.compatibility,
        packageHash: manifest.packageHash,
        manifestHash: manifest.manifestHash,
      }],
      locks: graph.locks,
    });
    expect(report.errors).toEqual([]);
    await expect(host.callTool({ id: "real-call", name: "real_echo", arguments: {} }, context, new AbortController().signal))
      .resolves.toMatchObject({ ok: true, content: "real" });

    writeFileSync(entry, `export default { tools: [{ name: "real_echo", description: "Changed", parameters: { type: "object" }, source: "fixture-real" }] };`);
    expect(() => catalog.assertCurrent(graph.locks)).toThrow("plugin_hash_mismatch:fixture-real");
  });

  it("makes preset resolution fail when a locked plugin changes", () => {
    const directory = mkdtempSync(join(process.cwd(), ".anomaloharis-locked-model-"));
    directories.push(directory);
    const entry = join(directory, "index.mjs");
    writeFileSync(entry, "export default {};");
    const catalog = new PluginCatalog([createPluginManifest({
      id: "locked-plugin",
      version: "1.0.0",
      package: "locked-plugin",
      entry,
      packageRoot: directory,
      compatibility: "L1",
    })]);
    const registry = new SqlitePresetModelRegistry(":memory:", { catalog });
    registry.createDraft({
      name: "locked",
      version: 1,
      description: "Locked",
      provider: { adapter: "openai-compatible", model: "fixture" },
      plugins: { fixed: ["locked-plugin"] },
    });
    registry.publish("locked@1");
    writeFileSync(entry, "export default { changed: true };");
    expect(() => registry.resolve("locked@1")).toThrow("plugin_hash_mismatch:locked-plugin");
    registry.close();
  });
});
