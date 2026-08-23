import { afterEach, describe, expect, it, vi } from "vitest";

import createBuddyBridge from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANOMALO_BUDDY_SERVICE_URL;
  delete process.env.ANOMALO_BUDDY_SERVICE_TOKEN;
});

describe("buddy bridge plugin", () => {
  it("exposes bounded control tools and calls the Buddy service", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: { connected: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.ANOMALO_BUDDY_SERVICE_URL = "http://buddy.test";
    process.env.ANOMALO_BUDDY_SERVICE_TOKEN = "secret";
    const extension = createBuddyBridge({} as never);
    const result = await extension.callTool(
      { id: "call-1", name: "buddy_set_state", arguments: { state: "coding", text: "working" } },
      { sessionId: "session-1", runId: "run-1" },
      new AbortController().signal,
    );

    expect(extension.tools.map((tool) => tool.name)).toContain("buddy_status");
    expect(result).toMatchObject({ name: "buddy_set_state", ok: true });
    expect(fetchMock).toHaveBeenCalledWith("http://buddy.test/v1/buddy/state", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({ session_id: "session-1", run_id: "run-1" });
  });

  it("fails closed at the tool boundary without leaking service details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "device offline" }), { status: 503 })));
    const extension = createBuddyBridge({} as never);
    const result = await extension.callTool(
      { id: "call-2", name: "buddy_status", arguments: {} },
      { sessionId: "session-1", runId: "run-1" },
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toBe("device offline");
    expect(result.data).toEqual({ error_code: "buddy_unavailable" });
  });

  it("serializes lifecycle notifications for one session", async () => {
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const names: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { name: string };
      names.push(body.name);
      if (names.length === 1) await firstRequest;
      return new Response("{}", { status: 200 });
    }));
    const extension = createBuddyBridge({} as never);
    const context = { sessionId: "session-1", runId: "run-1" };

    const prompt = extension.hooks.before_agent_start({ type: "before_agent_start", context });
    await waitFor(() => names.length === 1);
    const end = extension.hooks.agent_end({ type: "agent_end", context, eventType: "run.finished" });
    await Promise.resolve();
    expect(names).toEqual(["userPromptSubmitted"]);

    releaseFirst();
    await Promise.all([prompt, end]);
    expect(names).toEqual(["userPromptSubmitted", "agentStop"]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!predicate()) throw new Error("Timed out waiting for Buddy bridge notification");
}
