import { describe, expect, it } from "vitest";

import { WebToolRuntime } from "./web.js";
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
