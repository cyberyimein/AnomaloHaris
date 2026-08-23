import { describe, expect, it } from "vitest";

import { SqliteSessionAdapter } from "./sqlite.js";
import type { AgentPolicy, EntryId, SessionCheckpoint, SessionId, RunId } from "./types.js";

const sessionId = "sqlite-session" as SessionId;
const runId = "sqlite-run" as RunId;
const clock = { now: () => "2026-08-22T00:00:00.000Z" };

describe("SqliteSessionAdapter", () => {
  it("persists entry chains, resources, traces, and resumable checkpoints", async () => {
    const adapter = new SqliteSessionAdapter(":memory:", { clock });
    await adapter.open(sessionId);
    await adapter.setResources(sessionId, ["zeta", "zeta"], ["mcp-a"]);
    await adapter.setPresetModel(sessionId, "anomalo@1");
    await adapter.beginRun({
      runId,
      sessionId,
      status: "active",
      config: { model: "replay" },
      startedAt: clock.now(),
    });
    await adapter.append([
      {
        entryId: "entry-user" as EntryId,
        sessionId,
        runId,
        kind: "message",
        role: "user",
        payload: { content: "Hello" },
        createdAt: clock.now(),
      },
      {
        entryId: "entry-assistant" as EntryId,
        sessionId,
        parentEntryId: "entry-user" as EntryId,
        runId,
        kind: "message",
        role: "assistant",
        payload: { content: "Hi" },
        createdAt: clock.now(),
      },
    ]);
    await adapter.appendWebTrace(sessionId, { id: "trace-1", run_id: runId, content: "ok" });
    const checkpoint: SessionCheckpoint = {
      runId,
      sessionId,
      reason: "stopped",
      iteration: 1,
      state: {
        promptProfile: "agent",
        originalUserContent: "Hello",
        currentUserMessage: { role: "user", content: "Hello" },
        assistantText: "",
        pendingToolCalls: [],
        completedToolCallIds: [],
        loopMessages: [],
        bootstrapContext: [],
        model: "replay",
        toolProtocol: "dsml",
        policy: {
          maxToolIterations: 8,
          runTimeoutMs: 20_000,
          bootstrapToolTimeoutMs: 2_000,
          toolTimeoutMs: 4_000,
          structuredOutputRetryCount: 1,
          toolExecution: "sequential",
          temperature: 0.2,
          responseFormat: { type: "json_object" },
          searchMode: "diy",
        } satisfies AgentPolicy,
        searchMode: "diy",
      },
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };
    await adapter.checkpoint(checkpoint);

    const snapshot = await adapter.open(sessionId);
    expect(snapshot.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    expect(snapshot.activeSkills).toEqual(["zeta"]);
    expect(snapshot.metadata).toEqual({ preset_model_ref: "anomalo@1" });
    expect(snapshot.webTraces).toEqual([{ id: "trace-1", run_id: runId, content: "ok", timestamp: clock.now() }]);
    expect((await adapter.resume(sessionId)).checkpoint.state.originalUserContent).toBe("Hello");
    expect((await adapter.resume(sessionId)).checkpoint.state.toolProtocol).toBe("dsml");
    expect((await adapter.resume(sessionId)).checkpoint.state.policy).toMatchObject({
      maxToolIterations: 8,
      toolTimeoutMs: 4_000,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });
    expect((await adapter.list()).at(0)).toMatchObject({
      sessionId,
      title: "Hello",
      canResume: true,
      presetModelRef: "anomalo@1",
    });

    await adapter.finishRun({ runId, sessionId, lastEntryId: "entry-assistant" as EntryId, endedAt: clock.now() });
    expect((await adapter.getCheckpoint(sessionId))).toBeUndefined();
    adapter.close();
  });
});
