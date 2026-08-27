import type { PresetModelRef, RunId, SessionId } from "@anomaloharis/contracts";
import { describe, expect, it } from "vitest";

import { ResourceContextBuilder } from "./context.js";
import { FileResourceLoader } from "./resources.js";
import { parseSkillSnapshot, SkillRuntime, SkillToolRuntime } from "./skills.js";
import { InMemorySessionAdapter } from "./session.js";
import { AgentCore } from "./core.js";
import { ReplayModelAdapter } from "./model.js";
import { asToolAdapter, CompositeToolRuntime } from "./tools.js";

const invoiceSkill = [
  "---",
  "name: invoice-review",
  "description: Review invoice totals and tax calculations.",
  "---",
  "",
  "# Invoice review",
  "Use the invoice rules.",
].join("\n");

const contractSkill = [
  "---",
  "name: contract-review",
  "description: Review contract clauses and obligations.",
  "---",
  "",
  "# Contract review",
  "Use the contract rules.",
].join("\n");

const buddySkill = [
  "---",
  "name: buddy",
  "description: Control the optional Buddy device.",
  "requires_plugins: buddy-bridge",
  "---",
  "",
  "# Buddy control",
  "Use the Buddy tools.",
].join("\n");

describe("SkillRuntime", () => {
  it("parses metadata and compiles multiple Skills without eager prompt text", () => {
    const runtime = new SkillRuntime();
    const snapshot = runtime.compile([
      { content: contractSkill },
      { content: invoiceSkill },
    ]);

    expect(snapshot?.skills.map((skill) => skill.name)).toEqual(["contract-review", "invoice-review"]);
    expect(snapshot?.skills[0]?.description).toContain("contract clauses");
    expect(snapshot?.skills[0]?.body).toContain("Use the contract rules.");
    expect(runtime.catalogMessage(snapshot)).toContain("invoice-review");
    expect(runtime.catalogMessage(snapshot)).not.toContain("Use the invoice rules.");
  });

  it("rejects missing metadata and duplicate names", () => {
    const runtime = new SkillRuntime();
    expect(() => runtime.compile([{ content: "# Missing frontmatter" }])).toThrow("skill_frontmatter_required");
    expect(() => runtime.compile([{ content: invoiceSkill }, { content: invoiceSkill }])).toThrow("skill_duplicate_name:invoice-review");
  });

  it("rejects a tampered or unordered persisted snapshot", () => {
    const runtime = new SkillRuntime();
    const snapshot = runtime.compile([{ content: invoiceSkill }, { content: contractSkill }]);
    expect(parseSkillSnapshot({ ...snapshot, catalogHash: "0".repeat(64) })).toBeUndefined();
    expect(parseSkillSnapshot({ ...snapshot, skills: [...snapshot!.skills].reverse() })).toBeUndefined();
  });

  it("exposes an enum-constrained activation tool and records activation", async () => {
    const runtime = new SkillRuntime();
    const snapshot = runtime.compile([{ content: invoiceSkill }, { content: contractSkill }]);
    const tools = new SkillToolRuntime(runtime, snapshot);
    const context = {
      sessionId: "skill-session",
      runId: "skill-run",
      searchMode: "diy",
      model: "replay",
      activeSkills: new Set<string>(),
      activeMcpServers: new Set<string>(),
    };

    const definitions = await tools.list(context);
    expect(definitions[0]?.parameters).toMatchObject({
      properties: { name: { enum: ["contract-review", "invoice-review"] } },
    });
    const result = await tools.call(
      { id: "skill-call", name: "skill_activate", arguments: { name: "invoice-review" } },
      context,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { skill_action: "activate", skill_name: "invoice-review" },
    });
    expect(result.content).not.toContain("Use the invoice rules.");
  });

  it("hides a Skill whose required plugin is not bound to the model", async () => {
    const runtime = new SkillRuntime();
    const snapshot = runtime.compile([{ content: buddySkill }, { content: invoiceSkill }]);
    const tools = new SkillToolRuntime(runtime, snapshot);
    const context = {
      sessionId: "skill-capability-session",
      runId: "skill-capability-run",
      searchMode: "diy",
      model: "replay",
      activeSkills: new Set<string>(),
      activeMcpServers: new Set<string>(),
      allowedPluginIds: new Set(["host-core"]),
    };

    const definitions = await tools.list(context);

    expect(definitions[0]?.parameters).toMatchObject({
      properties: { name: { enum: ["invoice-review"] } },
    });
  });

  it("lets the Agent select one of two Skills and injects only the selected body", async () => {
    const runtime = new SkillRuntime();
    const snapshot = runtime.compile([{ content: invoiceSkill }, { content: contractSkill }]);
    const tools = new CompositeToolRuntime([
      asToolAdapter("agent-skills", 110, new SkillToolRuntime(runtime, snapshot), { alwaysAvailable: true }),
    ]);
    const root = `/tmp/anomaloharis-skills-${Date.now()}`;
    const resources = new FileResourceLoader({ projectRoot: root, skillDirs: [] });
    const model = new ReplayModelAdapter([
      [{ type: "tool.calls", calls: [{ id: "activate-invoice", name: "skill_activate", arguments: { name: "invoice-review" } }] }],
      [{ type: "text.delta", text: "Done." }, { type: "done" }],
    ]);
    const sessions = new InMemorySessionAdapter();
    const core = new AgentCore({
      model,
      tools,
      sessions,
      context: new ResourceContextBuilder(tools, resources),
    });

    const sessionId = "skill-e2e-session" as SessionId;
    for await (const _event of core.execute({
      sessionId,
      runId: "skill-e2e-run" as RunId,
      message: "Review this invoice.",
      resume: false,
      promptProfile: "agent",
      model: "replay",
      presetModelRef: "skill-model@1" as PresetModelRef,
      compiledHash: "skill-hash",
      skillSnapshot: snapshot,
      searchMode: "diy",
      allowedToolNames: new Set(["skill_activate"]),
      allowedPluginIds: new Set(),
    }, new AbortController().signal)) {
      // Consume the run so both model turns complete.
    }

    const firstContents = model.streamCalls[0]?.messages.map((message) => message.content).join("\n") ?? "";
    const secondContents = model.streamCalls[1]?.messages.map((message) => message.content).join("\n") ?? "";
    expect(firstContents).toContain("invoice-review");
    expect(firstContents).toContain("contract-review");
    expect(firstContents).not.toContain("Use the invoice rules.");
    expect(firstContents).not.toContain("Use the contract rules.");
    expect(secondContents).toContain("Use the invoice rules.");
    expect(secondContents).not.toContain("Use the contract rules.");
    expect((await sessions.open(sessionId)).activeSkills).toEqual(["invoice-review"]);
  });
});
