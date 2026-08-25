import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InProcessPluginBackend, PiPluginHost, readPluginLoadConfig, resolvePluginModuleSpecifier } from "./plugins.js";
import { createPluginManifest, PluginCatalog } from "./plugin-catalog.js";
import type { ToolContext } from "./types.js";

const tempDirectories: string[] = [];
const context: ToolContext = {
  sessionId: "plugin-session",
  runId: "plugin-run",
  searchMode: "diy",
  model: "replay",
  activeSkills: new Set(),
  activeMcpServers: new Set(),
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PiPluginHost", () => {
  it("loads an explicitly configured L2 extension and dispatches tool/lifecycle hooks", async () => {
    const entry = writeFixture(`
      export default {
        tools: [{ name: "pi_echo", description: "Echo", parameters: { type: "object" }, source: "pi" }],
        callTool(call) { return { name: call.name, ok: true, content: String(call.arguments.value || ""), data: { source: "fixture" } }; },
        hooks: { tool_call(event) { return event.call.arguments.block ? { allow: false } : undefined; } }
      };
    `);
    const secondEntry = writeFixture(`
      export default {
        tools: [{ name: "pi_status", description: "Status", parameters: { type: "object" }, source: "pi-second" }],
        callTool(call) { return { name: call.name, ok: true, content: "ready", data: {} }; }
      };
    `);
    const host = new PiPluginHost({ backend: new InProcessPluginBackend() });
    const report = await host.load({ plugins: [
      { id: "fixture", entry, compatibility: "L2", trust: "local-code" },
      { id: "fixture-second", entry: secondEntry, compatibility: "L2", trust: "local-code", priority: 10 },
    ] });

    expect(report.errors).toEqual([]);
    expect(report.plugins[0]).toMatchObject({ id: "fixture", loaded: true, tools: ["pi_echo"] });
    expect((await host.tools({ pluginId: "host" })).map((tool) => [tool.name, tool.source])).toEqual([
      ["pi_echo", "fixture"],
      ["pi_status", "fixture-second"],
    ]);
    expect((await host.callTool({ id: "call-1", name: "pi_echo", arguments: { value: "ok" } }, context, new AbortController().signal)).content).toBe("ok");
    expect((await host.dispatch({ type: "tool_call", context: { pluginId: "fixture" }, call: { id: "call-2", name: "pi_echo", arguments: { block: true } } })).allow).toBe(false);
  });

  it("supports Pi registerTool setup functions without requiring a returned extension", async () => {
    const entry = writeFixture(`
      export default (api) => {
        api.registerTool(
          { name: "pi_registered", description: "Registered", parameters: { type: "object" }, source: "pi" },
          (call) => ({ name: call.name, ok: true, content: "registered", data: {} }),
        );
      };
    `);
    const host = new PiPluginHost({ backend: new InProcessPluginBackend() });
    const report = await host.load({ plugins: [{ id: "fixture-registered", entry, compatibility: "L2" }] });

    expect(report.plugins[0]).toMatchObject({ loaded: true, tools: ["pi_registered"] });
    expect((await host.callTool({ id: "call-registered", name: "pi_registered", arguments: {} }, context, new AbortController().signal)).content).toBe("registered");
  });

  it("publishes discovered tool ownership into the compiled plugin catalog", async () => {
    const entry = writeFixture(`
      export default {
        tools: [{ name: "pi_catalogued", description: "Catalogued", parameters: { type: "object" }, source: "untrusted-source" }],
        callTool(call) { return { name: call.name, ok: true, content: "ok", data: {} }; }
      };
    `);
    const catalog = new PluginCatalog([createPluginManifest({
      id: "catalogued-plugin",
      version: "1.0.0",
      package: "@local/catalogued-plugin",
      entry,
      compatibility: "L2",
    })]);
    const host = new PiPluginHost({ backend: new InProcessPluginBackend(), catalog });
    await host.load({ plugins: [{ id: "catalogued-plugin", entry, compatibility: "L2" }] });
    const graph = catalog.compile(["catalogued-plugin"]);

    expect(graph.toolNames).toEqual(["pi_catalogued"]);
    await expect(host.tools({ pluginId: "host" }, {
      pluginIds: new Set(["catalogued-plugin"]),
      locks: graph.locks,
    })).resolves.toEqual([expect.objectContaining({ name: "pi_catalogued", source: "catalogued-plugin" })]);
  });

  it("does not expose or execute plugins outside the compiled run scope", async () => {
    const firstEntry = writeFixture(`
      export default {
        tools: [{ name: "pi_scoped_first", description: "First", parameters: { type: "object" }, source: "first" }],
        callTool(call) { return { name: call.name, ok: true, content: "first", data: {} }; },
        hooks: { session_start() { return { metadata: { first: true } }; } }
      };
    `);
    const secondEntry = writeFixture(`
      export default {
        tools: [{ name: "pi_scoped_second", description: "Second", parameters: { type: "object" }, source: "second" }],
        callTool(call) { return { name: call.name, ok: true, content: "second", data: {} }; },
        hooks: { session_start() { return { metadata: { second: true } }; } }
      };
    `);
    const host = new PiPluginHost({ backend: new InProcessPluginBackend() });
    await host.load({ plugins: [
      { id: "scoped-first", entry: firstEntry, compatibility: "L2" },
      { id: "scoped-second", entry: secondEntry, compatibility: "L2" },
    ] });
    const scope = { pluginIds: new Set(["scoped-first"]) };

    expect((await host.tools({ pluginId: "host" }, scope)).map((tool) => tool.name)).toEqual(["pi_scoped_first"]);
    expect((await host.callTool({ id: "call-scoped", name: "pi_scoped_second", arguments: {} }, context, new AbortController().signal, scope).then((result) => result.data.error_code))).toBe("tool_not_found");
    expect((await host.dispatch({ type: "session_start", context: { pluginId: "host" } }, scope)).metadata).toEqual({ first: true });
  });

  it("keeps optional hardware and media capabilities inside the plugin boundary", async () => {
    const entry = writeFixture(`
      export default {
        capabilities: [{ id: "buddy", kind: "service", description: "Optional Buddy transport" }],
        tools: [{ name: "buddy.status", description: "Read Buddy status", parameters: { type: "object" }, source: "buddy-plugin" }],
        callTool(call) { return { name: call.name, ok: true, content: "plugin-owned", data: {} }; }
      };
    `);
    const host = new PiPluginHost({ backend: new InProcessPluginBackend() });
    const report = await host.load({ plugins: [{ id: "buddy-plugin", entry, compatibility: "L2", capabilities: ["buddy"] }] });

    expect(report.errors).toEqual([]);
    expect(report.plugins[0]).toMatchObject({ id: "buddy-plugin", loaded: true, capabilities: ["buddy"] });
    expect((await host.callTool({ id: "buddy-call", name: "buddy.status", arguments: {} }, context, new AbortController().signal)).content).toBe("plugin-owned");
  });

  it("opens a circuit after repeated plugin failures", async () => {
    const entry = writeFixture(`
      export default {
        tools: [{ name: "pi_fail", description: "Fail", parameters: { type: "object" }, source: "pi" }],
        callTool() { throw new Error("fixture failure"); }
      };
    `);
    const host = new PiPluginHost({ backend: new InProcessPluginBackend() });
    await host.load({ plugins: [{ id: "fixture-fail", entry, compatibility: "L2" }] });
    for (let index = 0; index < 3; index += 1) {
      const result = await host.callTool({ id: `call-${index}`, name: "pi_fail", arguments: {} }, context, new AbortController().signal);
      expect(result.ok).toBe(false);
    }
    expect(host.status()[0]).toMatchObject({ failures: 3, circuitOpen: true });
  });

  it("reads the allowlist without discovering executable files", () => {
    const directory = mkdtempSync(join(tmpdir(), "anomaloharis-plugin-config-"));
    tempDirectories.push(directory);
    const path = join(directory, "plugins.yaml");
    writeFileSync(path, `plugins:\n  - id: sample\n    entry: ./sample.mjs\n    compatibility: L3\n    enabled: true\n    environment: [ANOMALOHARIS_BUDDY_SERVICE_URL, ANOMALOHARIS_BUDDY_SERVICE_TOKEN]\n`);
    expect(readPluginLoadConfig(path)).toEqual({
      plugins: [{
        id: "sample",
        entry: "./sample.mjs",
        compatibility: "L3",
        enabled: true,
        environment: ["ANOMALOHARIS_BUDDY_SERVICE_URL", "ANOMALOHARIS_BUDDY_SERVICE_TOKEN"],
      }],
    });
  });

  it("resolves a package entry relative to the configured package", () => {
    expect(resolvePluginModuleSpecifier({ package: "@example/pi-extension", entry: "dist/index.js" }))
      .toBe("@example/pi-extension/dist/index.js");
  });
});

function writeFixture(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
