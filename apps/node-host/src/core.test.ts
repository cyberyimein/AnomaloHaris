import { describe, expect, it } from "vitest";

import { ReplayContextBuilder } from "./context.js";
import { AgentCore, defaultPolicy } from "./core.js";
import { RunController } from "./controller.js";
import { ModelInterruptedError, ReplayModelAdapter, type ModelAdapter, type ModelRequest, type ModelStreamEvent } from "./model.js";
import { InMemorySessionAdapter } from "./session.js";
import { DeterministicToolRuntime } from "./tools.js";
import type { AgentRunInput } from "./types.js";

const input: AgentRunInput = {
  sessionId: "session-replay" as AgentRunInput["sessionId"],
  runId: "run-replay" as AgentRunInput["runId"],
  message: "Use the tool.",
  resume: false,
  promptProfile: "agent",
  model: "replay-model",
  searchMode: "diy",
};

describe("AgentCore", () => {
  it("runs a deterministic tool loop and emits the canonical event sequence", async () => {
    const tools = new DeterministicToolRuntime(
      [{ name: "echo", description: "Echo", parameters: { type: "object" }, source: "test" }],
      { echo: (arguments_) => ({ name: "echo", ok: true, content: String(arguments_.value), data: {} }) },
    );
    const model = new ReplayModelAdapter([
      [{ type: "tool.calls", calls: [{ id: "call-1", name: "echo", arguments: { value: "ok" } }] }],
      [{ type: "text.delta", text: "Done." }, { type: "done" }],
    ]);
    const sessions = new InMemorySessionAdapter();
    const core = new AgentCore({
      model,
      tools,
      sessions,
      context: new ReplayContextBuilder(tools),
    });

    const events = [];
    for await (const event of core.execute(input, new AbortController().signal)) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "llm.request",
      "tool.started",
      "tool.finished",
      "llm.request",
      "message.delta",
      "message.done",
      "run.finished",
    ]);
    expect(events.at(-1)?.data.final_text).toBe("Done.");
    expect((await sessions.open(input.sessionId)).messages).toEqual([
      { role: "user", content: "Use the tool." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", name: "echo", arguments: { value: "ok" } }],
      },
      { role: "tool", tool_call_id: "call-1", name: "echo", content: "ok" },
      { role: "assistant", content: "Done." },
    ]);
  });

  it("uses a bounded finalizer for structured output", async () => {
    const tools = new DeterministicToolRuntime([]);
    const model = new ReplayModelAdapter(
      [[{ type: "text.delta", text: "research draft" }, { type: "done" }]],
      { completions: ["not-json", '{"answer":"ok"}'] },
    );
    const sessions = new InMemorySessionAdapter();
    const core = new AgentCore({ model, tools, sessions });

    const events = [];
    for await (const event of core.execute({
      ...input,
      runId: "run-structured" as AgentRunInput["runId"],
      responseFormat: { type: "json_object" },
    }, new AbortController().signal)) events.push(event);

    expect(events.filter((event) => event.type === "llm.request").map((event) => event.data.phase)).toEqual([
      "agent",
      "finalizer",
      "finalizer",
    ]);
    expect(events.at(-1)?.data).toMatchObject({
      final_text: '{"answer":"ok"}',
      output: { answer: "ok" },
      output_format: "json_object",
    });
  });

  it("keeps a checkpoint when the model is aborted", async () => {
    const tools = new DeterministicToolRuntime([]);
    const model = new ReplayModelAdapter([[{ type: "text.delta", text: "partial" }, { type: "done" }]]);
    const sessions = new InMemorySessionAdapter();
    const core = new AgentCore({ model, tools, sessions });
    const controller = new AbortController();
    controller.abort();

    const events = [];
    for await (const event of core.execute({ ...input, runId: "run-abort" as AgentRunInput["runId"] }, controller.signal)) events.push(event);

    expect(events.at(-1)?.type).toBe("run.stopped");
    expect((await sessions.open(input.sessionId)).checkpoint?.runId).toBe("run-abort");
  });

  it("resumes a stopped run from the saved checkpoint", async () => {
    const tools = new DeterministicToolRuntime([]);
    const model = new ReplayModelAdapter([
      [{ type: "text.delta", text: "partial" }, { type: "done" }],
      [{ type: "text.delta", text: "resumed" }, { type: "done" }],
    ]);
    const sessions = new InMemorySessionAdapter();
    const controller = new RunController(
      new AgentCore({ model, tools, sessions }),
    );
    const events = [];
    for await (const event of controller.start({ ...input, runId: "run-stop" as AgentRunInput["runId"] })) {
      events.push(event);
      if (event.type === "run.started") await controller.stop(input.sessionId, "user_stop");
    }
    expect(events.at(-1)?.type).toBe("run.stopped");

    const resumed = [];
    for await (const event of controller.start({
      ...input,
      runId: "run-resume" as AgentRunInput["runId"],
      message: null,
      resume: true,
    })) resumed.push(event);
    expect(resumed.at(-1)?.type).toBe("run.finished");
    expect(resumed.at(-1)?.data.final_text).toBe("resumed");
  });

  it("turns the core timeout policy into a resumable run error", async () => {
    const slowModel: ModelAdapter = {
      model: "slow-model",
      async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal.aborted) throw new ModelInterruptedError("", []);
        yield { type: "done" };
      },
      async complete(_request: ModelRequest, _signal: AbortSignal): Promise<string> {
        return "";
      },
    };
    const sessions = new InMemorySessionAdapter();
    const core = new AgentCore({
      model: slowModel,
      tools: new DeterministicToolRuntime([]),
      sessions,
      policy: { ...defaultPolicy, runTimeoutMs: 1 },
    });
    const events = [];
    for await (const event of core.execute({ ...input, runId: "run-timeout" as AgentRunInput["runId"] }, new AbortController().signal)) events.push(event);
    expect(events.at(-1)?.type).toBe("run.error");
    expect(events.at(-1)?.data.error_code).toBe("run_timeout");
    expect((await sessions.open(input.sessionId)).checkpoint?.runId).toBe("run-timeout");
  });
});
