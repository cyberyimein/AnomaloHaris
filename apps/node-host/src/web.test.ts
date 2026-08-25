import { describe, expect, it } from "vitest";

import { createPinnedLookup, WebToolRuntime } from "./web.js";
import type { ToolContext } from "./types.js";

const context: ToolContext = {
  sessionId: "web-session",
  runId: "web-run",
  toolCallId: "web-call",
  searchMode: "diy",
  model: "replay",
  activeSkills: new Set(),
  activeMcpServers: new Set(),
};

describe("WebToolRuntime", () => {
  it("returns the all-address lookup shape required by Node's HTTP client", () => {
    const lookup = createPinnedLookup({ address: "93.184.216.34", family: 4 });
    let result: unknown;

    lookup("example.com", { all: true }, (_error, address) => {
      result = address;
    });

    expect(result).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("uses a GET query for DuckDuckGo HTML search", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const runtime = new WebToolRuntime({
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(
          '<a class="result__a" href="https://example.com/result">Example result</a><div class="result__snippet">A useful snippet.</div>',
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
    });

    const result = await runtime.call(
      { id: "web-call", name: "web_search", arguments: { query: "OpenAI web", count: 1 } },
      context,
      new AbortController().signal,
    );

    expect(new URL(requestUrl).searchParams.get("q")).toBe("OpenAI web");
    expect(requestInit?.method).toBe("GET");
    expect(requestInit?.body).toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      data: { query: "OpenAI web", results: [{ url: "https://example.com/result", title: "Example result" }] },
    });
  });

  it("normalizes DuckDuckGo redirect links before returning search results", async () => {
    const runtime = new WebToolRuntime({
      fetchImpl: async () => new Response(
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&amp;rut=fixture">Example result</a><div class="result__snippet">A useful snippet.</div>',
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    });

    const result = await runtime.call(
      { id: "web-call", name: "web_search", arguments: { query: "OpenAI web", count: 1 } },
      context,
      new AbortController().signal,
    );

    expect(result).toMatchObject({ data: { results: [{ url: "https://example.com/article" }] } });
  });

  it("rejects local and private fetch targets before making a request", async () => {
    let requests = 0;
    const runtime = new WebToolRuntime({ fetchImpl: async () => {
      requests += 1;
      return new Response("unexpected");
    } });

    const result = await runtime.call({ id: "web-call", name: "web_fetch", arguments: { url: "http://127.0.0.1/admin" } }, context, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("non-public address");
    expect(requests).toBe(0);
  });

  it("rejects IPv4-mapped IPv6 loopback targets", async () => {
    let requests = 0;
    const runtime = new WebToolRuntime({ fetchImpl: async () => {
      requests += 1;
      return new Response("unexpected");
    } });

    const result = await runtime.call({ id: "web-call", name: "web_fetch", arguments: { url: "http://[::ffff:7f00:1]/admin" } }, context, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("non-public address");
    expect(requests).toBe(0);
  });

  it("validates redirect targets before following them", async () => {
    let requests = 0;
    const runtime = new WebToolRuntime({
      lookupImpl: async () => ["93.184.216.34"],
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
      },
    });

    const result = await runtime.call({ id: "web-call", name: "web_fetch", arguments: { url: "https://example.com" } }, context, new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("non-public address");
    expect(requests).toBe(1);
  });
});
