import { describe, expect, it } from "vitest";

import { ResponsesSearchRuntime } from "./retrieval.js";
import type { ToolContext } from "./types.js";

const context: ToolContext = {
  sessionId: "retrieval-session",
  runId: "retrieval-run",
  searchMode: "native",
  model: "openai/gpt-4o-mini",
  activeSkills: new Set(),
  activeMcpServers: new Set(),
};

describe("ResponsesSearchRuntime", () => {
  it("routes native and subagent modes to the Responses API while leaving DIY to WebToolRuntime", async () => {
    const runtime = new ResponsesSearchRuntime({
      apiKey: "test-key",
      baseUrl: "https://provider.test/v1",
      subagentModel: "deepseek/test",
      fetchImpl: async () => new Response(JSON.stringify({ output_text: "unused" }), { status: 200 }),
    });

    expect((await runtime.list(context)).map((tool) => tool.name)).toEqual(["web_search"]);
    expect((await runtime.list({ ...context, searchMode: "diy" })).map((tool) => tool.name)).toEqual([]);
    expect((await runtime.list({ ...context, searchMode: "subagent" }))[0]?.source).toBe("responses_api_subagent");
  });

  it("parses response text and URL citations for the active model", async () => {
    let request: RequestInit | undefined;
    const runtime = new ResponsesSearchRuntime({
      apiKey: "test-key",
      baseUrl: "https://provider.test/v1",
      fetchImpl: async (_url, init) => {
        request = init;
        return new Response(JSON.stringify({
          id: "resp_123",
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: "The answer is grounded.",
              annotations: [{ type: "url_citation", url: "https://example.com/source", title: "Example source" }],
            }],
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await runtime.call({ id: "call_1", name: "web_search", arguments: { query: "latest answer", count: 8 } }, context, new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("The answer is grounded.");
    expect(result.content).toContain("https://example.com/source");
    expect(result.data).toMatchObject({
      provider: "model_native_responses",
      search_mode: "native",
      model: "openai/gpt-4o-mini",
      response_id: "resp_123",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "openai/gpt-4o-mini",
      input: "latest answer",
      tools: [{ type: "web_search_preview" }],
      max_tool_calls: 1,
    });
  });

  it("uses OpenRouter's server web search tool with one bounded search", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const runtime = new ResponsesSearchRuntime({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: "openrouter-response",
          output: [{ type: "message", content: [{ type: "output_text", text: "OpenRouter search result" }] }],
        }), { status: 200 });
      },
    });

    const result = await runtime.call(
      { id: "openrouter-call", name: "web_search", arguments: { query: "OpenRouter search", count: 4 } },
      context,
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(requestBody).toMatchObject({
      max_tool_calls: 1,
      tools: [{
        type: "openrouter:web_search",
        parameters: { engine: "auto", max_results: 4, max_uses: 1, max_total_results: 4 },
      }],
    });
  });

  it("uses the provider credentials resolved for the active preset", async () => {
    let requestUrl = "";
    let requestHeaders: HeadersInit | undefined;
    const runtime = new ResponsesSearchRuntime({
      apiKey: "global-key",
      baseUrl: "https://global.test/v1",
      resolveProvider: (activeContext) => activeContext.presetModelRef
        ? { baseUrl: "https://custom.test/v1", apiKey: "custom-key" }
        : undefined,
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestHeaders = init?.headers;
        return new Response(JSON.stringify({
          id: "custom-response",
          output: [{ type: "message", content: [{ type: "output_text", text: "custom provider" }] }],
        }), { status: 200 });
      },
    });

    const result = await runtime.call(
      { id: "custom-call", name: "web_search", arguments: { query: "provider check" } },
      { ...context, presetModelRef: "custom@1" },
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(requestUrl).toBe("https://custom.test/v1/responses");
    expect(new Headers(requestHeaders).get("Authorization")).toBe("Bearer custom-key");
  });

  it("runs an isolated web-only child AgentCore in subagent mode", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const runtime = new ResponsesSearchRuntime({
      apiKey: "test-key",
      baseUrl: "https://provider.test/v1",
      subagentModel: "deepseek/test",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        requests.push({ url: requestUrl, init });
        if (requestUrl.endsWith("/chat/completions")) {
          const chatRequests = requests.filter((item) => item.url.endsWith("/chat/completions"));
          return sseResponse(chatRequests.length === 1
            ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "child-call-1", function: { name: "web_search", arguments: JSON.stringify({ query: "research this", count: 5 }) } }] } }] }, "[DONE]"]
            : [{ choices: [{ delta: { content: "subagent brief" } }] }, "[DONE]"]);
        }
        return new Response(JSON.stringify({
          id: "resp_child",
          output: [{
            type: "message",
            content: [{
              type: "output_text",
              text: "Evidence from the public web.",
              annotations: [{ type: "url_citation", url: "https://example.com/source", title: "Example source" }],
            }],
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await runtime.call(
      { id: "call_2", name: "web_search", arguments: { query: "research this" } },
      { ...context, toolCallId: "call_2", searchMode: "subagent", model: "active-model" },
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("https://example.com/source");
    expect(result.data).toMatchObject({
      provider: "responses_api_subagent",
      subagent_iterations: 2,
      subagent_tool_calls: 1,
      parent_run_id: context.runId,
      parent_tool_call_id: "call_2",
    });
    const childRequest = JSON.parse(String(requests.find((item) => item.url.endsWith("/chat/completions"))?.init?.body));
    expect(childRequest).toMatchObject({ model: "deepseek/test" });
    expect(childRequest.tools).toHaveLength(1);
    expect(childRequest.tools[0].function.name).toBe("web_search");
    expect(childRequest.messages.some((message: { role?: string; content?: string }) => message.role === "system" && message.content?.includes("only capability is the web_search tool"))).toBe(true);
    const searchRequest = JSON.parse(String(requests.find((item) => item.url.endsWith("/responses"))?.init?.body));
    expect(searchRequest).toMatchObject({ model: "deepseek/test", tools: [{ type: "web_search_preview" }], max_tool_calls: 1 });
    expect((await runtime.list({ ...context, searchMode: "subagent" }))[0]?.timeout_ms).toBe(180_000);
  });

  it("returns a capability error without making a request when credentials are missing", async () => {
    let requests = 0;
    const runtime = new ResponsesSearchRuntime({
      baseUrl: "https://provider.test/v1",
      fetchImpl: async () => {
        requests += 1;
        return new Response("unexpected");
      },
    });

    const result = await runtime.call({ id: "call_3", name: "web_search", arguments: { query: "query" } }, context, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ error_code: "missing_api_key", capability_status: "unavailable" });
    expect(requests).toBe(0);
  });
});

function sseResponse(payloads: Array<Record<string, unknown> | string>): Response {
  const body = payloads.map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
