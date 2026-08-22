import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InProcessPluginBackend, PiPluginHost, readPluginLoadConfig, resolvePluginModuleSpecifier } from "./plugins.js";
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
    expect((await host.tools({ pluginId: "host" })).map((tool) => tool.name)).toEqual(["pi_echo", "pi_status"]);
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
    const directory = mkdtempSync(join(tmpdir(), "anomalo-plugin-config-"));
    tempDirectories.push(directory);
    const path = join(directory, "plugins.yaml");
    writeFileSync(path, `plugins:\n  - id: sample\n    entry: ./sample.mjs\n    compatibility: L3\n    enabled: true\n`);
    expect(readPluginLoadConfig(path)).toEqual({
      plugins: [{ id: "sample", entry: "./sample.mjs", compatibility: "L3", enabled: true }],
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
