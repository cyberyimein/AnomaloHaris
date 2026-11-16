import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "./core.js";
import { RunController } from "./controller.js";
import { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";
import { ReplayModelAdapter } from "./model.js";
import { SqlitePresetModelRegistry } from "./preset-models.js";
import { InMemorySessionAdapter } from "./session.js";
import { DeterministicToolRuntime } from "./tools.js";

const registries: SqlitePresetModelRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
});

describe("AgentRuntimeAdapter model snapshots", () => {
  it("discards caller supplied model bindings when preparing a run", () => {
    const registry = new SqlitePresetModelRegistry(":memory:");
    registries.push(registry);
    registry.createDraft({
      name: "luna",
      version: 1,
      description: "Coding preset",
      provider: { adapter: "openai-compatible", model: "preset-provider", tool_protocol: "auto" },
      plugins: { fixed: [] },
    });
    registry.publish("luna@1");
    const model = registry.modelCatalog.createModel({
      id: "catalog-primary",
      name: "Catalog primary",
      adapter: "openai-compatible",
      model: "catalog-provider",
      toolProtocol: "openai",
    });
    registry.modelCatalog.bindPreset("luna@1", model.id);

    const sessions = new InMemorySessionAdapter();
    const controller = new RunController(new AgentCore({
      model: new ReplayModelAdapter([]),
      tools: new DeterministicToolRuntime([]),
      sessions,
    }));
    const adapter = new AgentRuntimeAdapter({ registry, controller });
    const fakeBinding = {
      id: "caller-controlled",
      adapter: "openai-compatible",
      model: "caller-model",
      credentialRef: "caller-credential",
      toolProtocol: "none" as const,
      revision: 99,
      active: true,
    };

    const input = adapter.prepareInput({
      runId: "run-1",
      target: adapter.resolve("luna@1"),
      request: {
        clientId: "client",
        input: {
          model_binding: fakeBinding,
          research_model_binding: fakeBinding,
          agent_input: {
            model: "caller-agent-model",
            modelBinding: fakeBinding,
            researchModelBinding: fakeBinding,
            toolProtocol: "none",
          },
        },
      },
    }) as Record<string, unknown>;

    expect(input.model_binding).toMatchObject({ id: "catalog-primary", model: "catalog-provider", toolProtocol: "openai" });
    expect(input).not.toHaveProperty("research_model_binding");
    expect(input.agent_input).toMatchObject({
      model: "catalog-provider",
      modelBinding: { id: "catalog-primary", model: "catalog-provider" },
      toolProtocol: "openai",
    });
    expect(input.agent_input).not.toHaveProperty("researchModelBinding");
  });
});
