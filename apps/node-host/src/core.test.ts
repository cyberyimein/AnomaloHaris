import { describe, expect, it } from "vitest";

import { ReplayContextBuilder } from "./context.js";
import { AgentCore, defaultPolicy } from "./core.js";
import { RunController } from "./controller.js";
import { ModelInterruptedError, ReplayModelAdapter, type ModelAdapter, type ModelRequest, type ModelStreamEvent } from "./model.js";
import { InMemorySessionAdapter } from "./session.js";
import { SqliteSessionAdapter } from "./sqlite.js";
import { DeterministicToolRuntime } from "./tools.js";
import type { PluginEvent, PluginHost } from "./plugins.js";
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

  it("honors a tool-declared timeout above the model policy timeout", async () => {
    const tools = new DeterministicToolRuntime(
      [{ name: "slow", description: "Slow", parameters: { type: "object" }, source: "test", timeout_ms: 80 }],
      {
        slow: (_arguments_, _context, signal) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ name: "slow", ok: true, content: "finished", data: {} }), 30);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("slow tool was aborted"));
          }, { once: true });
        }),
      },
    );
    const model = new ReplayModelAdapter([
      [{ type: "tool.calls", calls: [{ id: "slow-call", name: "slow", arguments: {} }] }],
      [{ type: "text.delta", text: "Done." }, { type: "done" }],
    ]);
    const sessions = new InMemorySessionAdapter();
    const core = new AgentCore({
      model,
      tools,
      sessions,
      policy: { ...defaultPolicy, runTimeoutMs: 500, toolTimeoutMs: 10 },
    });

    const events = [];
    for await (const event of core.execute({ ...input, runId: "run-tool-timeout" as AgentRunInput["runId"] }, new AbortController().signal)) events.push(event);

    expect(events.at(-1)?.type).toBe("run.finished");
    expect(events.find((event) => event.type === "tool.finished")?.data.ok).toBe(true);
  });

  it("enforces the tool allowlist at call time", async () => {
    const tools = new DeterministicToolRuntime(
      [{ name: "echo", description: "Echo", parameters: { type: "object" }, source: "test" }],
      { echo: () => ({ name: "echo", ok: true, content: "called", data: {} }) },
    );
    const model = new ReplayModelAdapter([
      [{ type: "tool.calls", calls: [{ id: "call-disallowed", name: "echo", arguments: {} }] }],
      [{ type: "text.delta", text: "Done." }, { type: "done" }],
    ]);
    const sessions = new InMemorySessionAdapter();
    const core = new AgentCore({ model, tools, sessions });

    const events = [];
    for await (const event of core.execute({
      ...input,
      runId: "run-allowlist" as AgentRunInput["runId"],
      allowedToolNames: new Set(["other"]),
    }, new AbortController().signal)) events.push(event);

    expect(tools.calls).toHaveLength(0);
    expect(events.find((event) => event.type === "tool.error")?.data).toMatchObject({
      data: { error_code: "tool_not_allowed" },
    });
  });

  it("applies before_agent_start messages before the first model request", async () => {
    const tools = new DeterministicToolRuntime([]);
    const model = new ReplayModelAdapter([[{ type: "text.delta", text: "Done." }, { type: "done" }]]);
    const sessions = new InMemorySessionAdapter();
    const pluginEvents: PluginEvent["type"][] = [];
    const plugins: PluginHost = {
      load: async () => ({ plugins: [], errors: [], unsupported: [] }),
      unload: async () => undefined,
      tools: async () => [],
      callTool: async (call) => ({ name: call.name, ok: false, content: "unused", data: {} }),
      dispatch: async (event) => {
        pluginEvents.push(event.type);
        if (event.type === "before_agent_start") {
          return { messages: [...event.messages, { role: "system", content: "plugin context" }] };
        }
        return {};
      },
      status: () => [],
    };
    const core = new AgentCore({ model, tools, sessions, plugins });

    for await (const _event of core.execute({ ...input, runId: "run-plugin-context" as AgentRunInput["runId"] }, new AbortController().signal)) {
      // Consume the run so the hook and model request complete.
    }

    expect(model.streamCalls[0]?.messages.map((message) => message.content)).toContain("plugin context");
    expect(pluginEvents).toContain("before_agent_start");
    expect(pluginEvents).toContain("agent_end");
  });

  it("persists skill and MCP activation results for the next model turn", async () => {
    const tools = new DeterministicToolRuntime(
      [{ name: "skill_activate", description: "Activate", parameters: { type: "object" }, source: "skill-router" }],
      {
        skill_activate: () => ({
          name: "skill_activate",
          ok: true,
          content: "activated",
          data: { skill_action: "activate", skill_name: "skill-a" },
        }),
      },
    );
    const model = new ReplayModelAdapter([
      [{ type: "tool.calls", calls: [{ id: "call-activate", name: "skill_activate", arguments: { skill_name: "skill-a" } }] }],
      [{ type: "text.delta", text: "Done." }, { type: "done" }],
    ]);
    const sessions = new InMemorySessionAdapter();
    const core = new AgentCore({ model, tools, sessions });

    for await (const _event of core.execute({ ...input, runId: "run-resource-action" as AgentRunInput["runId"] }, new AbortController().signal)) {
      // Consume the run so the resource update is persisted.
    }

    expect((await sessions.open(input.sessionId)).activeSkills).toEqual(["skill-a"]);
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
    for await (const event of controller.start({
      ...input,
      runId: "run-stop" as AgentRunInput["runId"],
      model: "frozen-model",
      temperature: 0.2,
      systemPrompt: "Keep this system instruction.",
      allowedToolNames: new Set(["echo"]),
    })) {
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
      model: "new-model",
      temperature: 0.9,
      systemPrompt: "Replace this system instruction.",
      allowedToolNames: new Set(["other"]),
    })) resumed.push(event);
    expect(resumed.at(-1)?.type).toBe("run.finished");
    expect(resumed.at(-1)?.data.final_text).toBe("resumed");
    expect(model.streamCalls[1]?.model).toBe("frozen-model");
    expect(model.streamCalls[1]?.temperature).toBe(0.2);
    expect(model.streamCalls[1]?.messages[0]).toEqual({ role: "system", content: "Keep this system instruction." });
  });

  it("reuses the persisted run id and clears a SQLite checkpoint on resume", async () => {
    const tools = new DeterministicToolRuntime([]);
    const model = new ReplayModelAdapter([
      [{ type: "text.delta", text: "partial" }, { type: "done" }],
      [{ type: "text.delta", text: "resumed" }, { type: "done" }],
    ]);
    const sessions = new SqliteSessionAdapter(":memory:");
    const controller = new RunController(new AgentCore({ model, tools, sessions }));
    const firstRun = [];
    for await (const event of controller.start({ ...input, runId: "run-sqlite-stop" as AgentRunInput["runId"] })) {
      firstRun.push(event);
      if (event.type === "run.started") await controller.stop(input.sessionId, "user_stop");
    }
    expect(firstRun.at(-1)?.type).toBe("run.stopped");

    const resumed = [];
    for await (const event of controller.start({
      ...input,
      runId: "run-sqlite-resume" as AgentRunInput["runId"],
      message: null,
      resume: true,
    })) resumed.push(event);

    expect(resumed.find((event) => event.type === "run.started")?.run_id).toBe("run-sqlite-stop");
    expect(resumed.at(-1)?.type).toBe("run.finished");
    expect(await sessions.getCheckpoint(input.sessionId)).toBeUndefined();
    sessions.close();
  });

  it("reports a user stop during structured finalization as run.stopped", async () => {
    const model: ModelAdapter = {
      model: "finalizer-stop-model",
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: "text.delta", text: "draft" };
        yield { type: "done" };
      },
      async complete(_request: ModelRequest, signal: AbortSignal): Promise<string> {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        throw new ModelInterruptedError("", []);
      },
    };
    const sessions = new InMemorySessionAdapter();
    const controller = new RunController(new AgentCore({ model, tools: new DeterministicToolRuntime([]), sessions }));
    const events = [];
    for await (const event of controller.start({
      ...input,
      runId: "run-finalizer-stop" as AgentRunInput["runId"],
      responseFormat: { type: "json_object" },
    })) {
      events.push(event);
      if (event.type === "llm.request" && event.data.phase === "finalizer") {
        await controller.stop(input.sessionId, "user_stop");
      }
    }

    expect(events.at(-1)?.type).toBe("run.stopped");
    expect(events.some((event) => event.type === "run.error")).toBe(false);
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
