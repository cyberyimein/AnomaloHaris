import { describe, expect, it, vi } from "vitest";

import { createPresetAgentTransport } from "./presetAgentTransport";

function runEvent(type, data = {}, runId = "run-1") {
  return {
    schema_version: 1,
    type,
    session_id: "preset_session",
    run_id: runId,
    data,
    timestamp: "2026-08-22T00:00:00Z",
  };
}

function ndjsonResponse(events) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map((item) => JSON.stringify(item)).join("\n")));
      controller.close();
    },
  });
  return {
    ok: true,
    headers: { get: () => "preset_session" },
    body,
  };
}

describe("PresetAgentTransport", () => {
  it("streams NDJSON events and tracks terminal state", async () => {
    const events = [];
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([
        runEvent("run.started"),
        runEvent("message.delta", { content: "Done" }),
        runEvent("run.finished"),
      ]),
    );
    const transport = createPresetAgentTransport({
      fetchImpl,
      onEvent: (event) => events.push(event),
    });

    expect(await transport.send("agent_1", "Summarize this", "preset_session")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/agents/agent_1/chat/stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          message: "Summarize this",
          session_id: "preset_session",
          resume: false,
        }),
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "run.finished",
    ]);
    expect(transport.state.runActive.value).toBe(false);
    expect(transport.state.resumeAvailable.value).toBe(false);
  });

  it("turns an aborted stream into a resumable stop", async () => {
    const events = [];
    const fetchImpl = vi.fn((url, options) => {
      if (url.startsWith("/api/sessions/")) {
        return Promise.resolve({ ok: true, json: async () => ({ can_resume: true }) });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const transport = createPresetAgentTransport({
      fetchImpl,
      onEvent: (event) => events.push(event),
      checkpointPollAttempts: 1,
    });

    const request = transport.send("agent_1", "Long task", "preset_session");
    await Promise.resolve();
    expect(transport.stopRun()).toBe(true);
    expect(await request).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "run.stopped",
      data: { can_resume: true },
    });
    expect(transport.state.runActive.value).toBe(false);
    expect(transport.state.resumeAvailable.value).toBe(true);
  });

  it("does not claim a checkpoint when an aborted request never reached the server", async () => {
    const events = [];
    const fetchImpl = vi.fn((url, options) => {
      if (url.startsWith("/api/sessions/")) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const transport = createPresetAgentTransport({
      fetchImpl,
      onEvent: (event) => events.push(event),
      checkpointPollAttempts: 1,
    });

    const request = transport.send("agent_1", "Long task", "preset_session");
    await Promise.resolve();
    transport.stopRun();
    await request;

    expect(events.at(-1)).toMatchObject({
      type: "run.stopped",
      data: { checkpointed: false, can_resume: false },
    });
    expect(transport.state.resumeAvailable.value).toBe(false);
  });

  it("resets resume state when switching sessions", () => {
    const transport = createPresetAgentTransport({ fetchImpl: vi.fn() });
    transport.state.resumeAvailable.value = true;

    transport.switchSession("new_session");

    expect(transport.state.sessionId.value).toBe("new_session");
    expect(transport.state.resumeAvailable.value).toBe(false);
  });
});
