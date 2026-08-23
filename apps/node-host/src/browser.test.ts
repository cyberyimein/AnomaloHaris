import { describe, expect, it } from "vitest";

import { BrowserToolBridge, BrowserToolRuntime } from "./browser.js";
import type { ToolContext } from "./types.js";

const context: ToolContext = {
  sessionId: "browser-session",
  runId: "browser-run",
  toolCallId: "call-1",
  searchMode: "diy",
  model: "replay",
  activeSkills: new Set(),
  activeMcpServers: new Set(),
};

describe("BrowserToolBridge", () => {
  it("routes a browser tool call and verifies the session/run/call tuple", async () => {
    const bridge = new BrowserToolBridge(1_000);
    const messages: Record<string, unknown>[] = [];
    bridge.register(context.sessionId, (message) => { messages.push(message); });
    const pending = bridge.call({ id: "call-1", name: "browser.navigate", arguments: { url: "https://example.com" } }, context, new AbortController().signal);
    await waitFor(() => messages.length === 1);
    expect(messages[0]).toMatchObject({ type: "browser.tool.call", session_id: context.sessionId, run_id: context.runId });
    expect(bridge.complete({ session_id: context.sessionId, run_id: context.runId, data: { tool_call_id: "call-1", status: "ok", result: { url: "https://example.com" } } })).toBe(true);
    await expect(pending).resolves.toMatchObject({ name: "browser.navigate", ok: true, data: { url: "https://example.com" } });
  });

  it("only advertises browser tools for a registered connection", async () => {
    const bridge = new BrowserToolBridge();
    const runtime = new BrowserToolRuntime(bridge);
    expect(await runtime.list(context)).toEqual([]);
    bridge.register(context.sessionId, () => undefined);
    expect((await runtime.list(context)).map((tool) => tool.name)).toContain("browser.get_page_state");
  });

  it("publishes the browser action parameter schemas", async () => {
    const bridge = new BrowserToolBridge();
    bridge.register(context.sessionId, () => undefined);
    const runtime = new BrowserToolRuntime(bridge);
    const tools = await runtime.list(context);
    const navigate = tools.find((tool) => tool.name === "browser.navigate");
    const fill = tools.find((tool) => tool.name === "browser.fill");

    expect(navigate?.parameters).toMatchObject({ required: ["url"] });
    expect(fill?.parameters).toMatchObject({ required: ["target_ref", "expected_document_epoch", "text"] });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for browser bridge message.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
