import { describe, expect, it } from "vitest";

import { ModelProtocolError, OpenAICompatibleAdapter, type ModelStreamEvent } from "./model.js";

describe("OpenAICompatibleAdapter", () => {
  it("normalizes DSML tool calls without leaking markup into text", async () => {
    const block = '<｜DSML｜tool_calls><｜DSML｜invoke name="web_search"><｜DSML｜parameter name="query" string="true">latest 2026 World Cup result</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
    const events = await collect(
      new OpenAICompatibleAdapter({
        model: "deepseek/deepseek-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        fetchImpl: async () => sseResponse([
          { choices: [{ delta: { content: `我会搜索。${block.slice(0, 27)}` } }] },
          { choices: [{ delta: { content: block.slice(27) } }] },
          "[DONE]",
        ], 11),
      }).stream({ model: "deepseek/deepseek-chat", messages: [], tools: [], }, new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "text.delta", text: "我会搜索。" },
      {
        type: "tool.calls",
        calls: [{
          id: "dsml_call_1",
          name: "web_search",
          arguments: { query: "latest 2026 World Cup result" },
        }],
      },
    ]);
  });

  it("keeps native OpenAI tool-call deltas working", async () => {
    const events = await collect(
      new OpenAICompatibleAdapter({
        model: "native-model",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        fetchImpl: async () => sseResponse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "time_now", arguments: "{\"timezone\":\"UTC\"}" } }] } }] },
          "[DONE]",
        ]),
      }).stream({ model: "native-model", messages: [], tools: [], }, new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "tool.calls", calls: [{ id: "call-1", name: "time_now", arguments: { timezone: "UTC" } }] },
    ]);
  });

  it("turns incomplete provider markup into a protocol error", async () => {
    const stream = new OpenAICompatibleAdapter({
      model: "broken-model",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      fetchImpl: async () => sseResponse([
        { choices: [{ delta: { content: "<｜DSML｜tool_calls>" } }] },
        "[DONE]",
      ]),
    }).stream({ model: "broken-model", messages: [], tools: [] }, new AbortController().signal);

    await expect(collect(stream)).rejects.toBeInstanceOf(ModelProtocolError);
  });
});

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function sseResponse(payloads: Array<Record<string, unknown> | string>, chunkSize = 1_000_000): Response {
  const body = payloads.map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`).join("");
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
