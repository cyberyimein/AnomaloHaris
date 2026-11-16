import { afterEach, describe, expect, it } from "vitest";

import { SqlitePresetModelRegistry } from "./preset-models.js";
import { PresetModelAdapter } from "./preset-model-adapter.js";
import type { ModelRequest } from "./model.js";

const registries: SqlitePresetModelRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
});

describe("PresetModelAdapter model snapshots", () => {
  it("uses the request snapshot's model, credential, and tool protocol after catalog edits", async () => {
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
    const initial = registry.modelCatalog.createModel({
      id: "catalog-primary",
      name: "Catalog primary",
      adapter: "openai-compatible",
      model: "catalog-model-v1",
      credentialRef: "credential-v1",
      toolProtocol: "openai",
    });
    registry.modelCatalog.bindPreset("luna@1", initial.id);
    const calls: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
    const adapter = new PresetModelAdapter({
      registry,
      model: "fallback-model",
      baseUrl: "https://fallback.example/v1",
      resolveProvider: (binding) => binding.credentialRef === "credential-v1"
        ? { apiKey: "key-v1", baseUrl: "https://provider-v1.example/v1" }
        : { apiKey: "key-v2", baseUrl: "https://provider-v2.example/v1" },
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("Authorization") ?? "",
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const oldBinding = registry.resolvePresetBinding("luna@1")!;
    const oldRequest = requestFor(oldBinding.model, oldBinding);

    await collect(adapter.stream(oldRequest, new AbortController().signal));
    registry.modelCatalog.updateModel(initial.id, {
      expectedRevision: initial.revision,
      model: "catalog-model-v2",
      credentialRef: "credential-v2",
      toolProtocol: "none",
    });
    await collect(adapter.stream(oldRequest, new AbortController().signal));
    const currentBinding = registry.resolvePresetBinding("luna@1")!;
    await collect(adapter.stream(requestFor(currentBinding.model, currentBinding), new AbortController().signal));

    expect(calls.map((call) => call.url)).toEqual([
      "https://provider-v1.example/v1/chat/completions",
      "https://provider-v1.example/v1/chat/completions",
      "https://provider-v2.example/v1/chat/completions",
    ]);
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer key-v1", "Bearer key-v1", "Bearer key-v2"]);
    expect(calls.map((call) => call.body.model)).toEqual(["catalog-model-v1", "catalog-model-v1", "catalog-model-v2"]);
    expect(calls[0]?.body.tools).toBeDefined();
    expect(calls[1]?.body.tools).toBeDefined();
    expect(calls[2]?.body.tools).toBeUndefined();
  });
});

function requestFor(model: string, modelBinding: NonNullable<ModelRequest["modelBinding"]>): ModelRequest {
  return {
    model,
    modelBinding,
    presetModelRef: "luna@1",
    toolProtocol: modelBinding.toolProtocol,
    messages: [{ role: "user", content: "hello" }],
    tools: [{
      name: "lookup",
      description: "Lookup a value",
      parameters: { type: "object", properties: {} },
      source: "test",
    }],
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {}
}
