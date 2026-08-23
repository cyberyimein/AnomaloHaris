import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ResourceContextBuilder } from "./context.js";
import { FileResourceLoader } from "./resources.js";
import { DeterministicToolRuntime } from "./tools.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("FileResourceLoader", () => {
  it("captures memory, skill, and MCP resources in a run snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "anomalo-resources-"));
    temporary.push(root);
    mkdirSync(join(root, "skills", "skill-a"), { recursive: true });
    mkdirSync(join(root, "config", "mcp"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "Use the repository memory.");
    writeFileSync(join(root, "config", "prompts.yaml"), "profiles:\n  agent:\n    messages:\n      - id: identity\n        role: system\n        content: |\n          Be precise.\n");
    writeFileSync(join(root, "skills", "skill-a", "SKILL.md"), "# Skill A\nDo the useful thing.");
    writeFileSync(join(root, "config", "mcp_servers.yaml"), "servers:\n  - name: mcp-a\n");
    writeFileSync(join(root, "config", "mcp", "mcp-a.md"), "MCP instruction.");

    const loader = new FileResourceLoader({
      projectRoot: root,
      skillDirs: [join(root, "skills")],
      promptConfigPath: join(root, "config", "prompts.yaml"),
    });
    const snapshot = await loader.snapshot({
      promptProfile: "agent",
      searchMode: "diy",
      activeSkills: new Set(["skill-a"]),
      activeMcpServers: new Set(["mcp-a"]),
    });

    expect(snapshot.activeSkillNames).toEqual(["skill-a"]);
    expect(snapshot.activeMcpServers).toEqual(["mcp-a"]);
    expect(snapshot.messages.map((message) => message.content).join("\n")).toContain("Use the repository memory.");
    expect(snapshot.messages.map((message) => message.content).join("\n")).toContain("Available Skill catalog:");
    expect(snapshot.skillInstructions["skill-a"]).toContain("Do the useful thing.");
    expect(snapshot.mcpInstructions["mcp-a"]).toContain("MCP instruction.");
  });

  it("does not mutate an already captured snapshot when files change", async () => {
    const root = mkdtempSync(join(tmpdir(), "anomalo-resources-stable-"));
    temporary.push(root);
    writeFileSync(join(root, "AGENTS.md"), "before");
    const loader = new FileResourceLoader({ projectRoot: root });
    const snapshot = await loader.snapshot({ promptProfile: "agent", searchMode: "diy", activeSkills: new Set(), activeMcpServers: new Set() });
    writeFileSync(join(root, "AGENTS.md"), "after");
    expect(snapshot.messages.map((message) => message.content).join("\n")).toContain("before");
    expect(snapshot.messages.map((message) => message.content).join("\n")).not.toContain("after");
  });

  it("keeps resource files frozen while refreshing active resource selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "anomalo-resources-dynamic-"));
    temporary.push(root);
    mkdirSync(join(root, "skills", "skill-a"), { recursive: true });
    writeFileSync(join(root, "skills", "skill-a", "SKILL.md"), "# Skill A\nStable instructions.");
    const loader = new FileResourceLoader({ projectRoot: root, skillDirs: [join(root, "skills")] });
    const tools = new DeterministicToolRuntime([]);
    const builder = new ResourceContextBuilder(tools, loader);
    const base = {
      baseMessages: [],
      loopMessages: [],
      promptProfile: "agent",
      toolContext: {
        sessionId: "resource-session",
        runId: "resource-run",
        searchMode: "diy",
        model: "replay",
        activeSkills: new Set<string>(),
        activeMcpServers: new Set<string>(),
      },
    };
    const snapshot = await builder.prepare(base);
    const inactive = await builder.build({ ...base, resourceSnapshot: snapshot });
    const active = await builder.build({
      ...base,
      toolContext: { ...base.toolContext, activeSkills: new Set(["skill-a"]) },
      resourceSnapshot: snapshot,
    });

    expect(inactive.messages.map((message) => message.content).join("\n")).not.toContain("Active Skill: skill-a");
    expect(active.messages.map((message) => message.content).join("\n")).toContain("Active Skill: skill-a");
  });

  it("assembles prompt, bootstrap, memory, skills, MCP, and history in order", async () => {
    const root = mkdtempSync(join(tmpdir(), "anomalo-resources-order-"));
    temporary.push(root);
    mkdirSync(join(root, "skills", "skill-a"), { recursive: true });
    mkdirSync(join(root, "config", "mcp"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "memory");
    writeFileSync(join(root, "skills", "skill-a", "SKILL.md"), "# Skill A\nskill instructions");
    writeFileSync(join(root, "config", "mcp_servers.yaml"), "servers:\n  - name: mcp-a\n");
    writeFileSync(join(root, "config", "mcp", "mcp-a.md"), "mcp instructions");
    const loader = new FileResourceLoader({ projectRoot: root, skillDirs: [join(root, "skills")] });
    const builder = new ResourceContextBuilder(new DeterministicToolRuntime([]), loader);
    const base = {
      baseMessages: [],
      loopMessages: [{ role: "assistant" as const, content: "loop" }],
      systemPrompt: "preset",
      promptProfile: "agent",
      bootstrapMessages: [{ role: "system" as const, content: "bootstrap" }],
      sessionMessages: [{ role: "user" as const, content: "history" }],
      currentUserMessage: { role: "user" as const, content: "current" },
      toolContext: {
        sessionId: "order-session",
        runId: "order-run",
        searchMode: "diy",
        model: "replay",
        activeSkills: new Set(["skill-a"]),
        activeMcpServers: new Set(["mcp-a"]),
      },
    };
    const snapshot = await builder.prepare(base);
    const context = await builder.build({ ...base, resourceSnapshot: snapshot });
    const contents = context.messages.map((message) => message.content);

    expect(contents.findIndex((value) => value === "preset")).toBeLessThan(contents.findIndex((value) => value === "bootstrap"));
    expect(contents.findIndex((value) => value === "bootstrap")).toBeLessThan(contents.findIndex((value) => value.includes("memory")));
    expect(contents.findIndex((value) => value.includes("Active Skill: skill-a"))).toBeLessThan(contents.findIndex((value) => value.includes("Available MCP catalog")));
    expect(contents.findIndex((value) => value.includes("Available MCP catalog"))).toBeLessThan(contents.findIndex((value) => value.includes("Active MCP server: mcp-a")));
    expect(contents.indexOf("history")).toBeLessThan(contents.indexOf("current"));
    expect(contents.indexOf("current")).toBeLessThan(contents.indexOf("loop"));
  });
});
