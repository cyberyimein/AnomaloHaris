import { describe, expect, it, vi } from "vitest";

import { createAgentSessionProjection } from "./agentSessionProjection";

function event(type, data = {}, runId = "run-1") {
  return { type, data, run_id: runId, timestamp: "2026-07-31T00:00:00Z" };
}

function createProjection(overrides = {}) {
  return createAgentSessionProjection({
    renderMarkdown: (content) => `<p>${content}</p>`,
    onScroll: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  });
}

describe("AgentSessionProjection", () => {
  it("projects a streamed tool run into a completed conversation snapshot", () => {
    const projection = createProjection();
    const state = projection.state;

    projection.beginUserTurn("查一下东京时间");
    projection.handle(event("run.started"));
    projection.handle(
      event("llm.request", {
        iteration: 1,
        request: {
          model: "test-model",
          messages: [{ role: "user", content: "查一下东京时间" }],
          tools: [{ function: { name: "core_get_time" } }],
        },
        context: { profile: "agent", tool_count: 1, segments: [] },
      }),
    );
    projection.handle(
      event("tool.started", {
        tool_call_id: "call-1",
        tool: "core_get_time",
        arguments: { timezone: "Asia/Tokyo" },
      }),
    );
    projection.handle(
      event("tool.finished", {
        tool_call_id: "call-1",
        tool: "core_get_time",
        content: "2026-07-31T09:00:00+09:00",
      }),
    );
    projection.handle(event("message.delta", { content: "东京现在是九点。" }));
    projection.handle(event("message.done"));
    projection.handle(event("run.finished", { final_text: "东京现在是九点。" }));

    expect(state.runId.value).toBe("run-1");
    expect(state.runTitle.value).toBe("Complete");
    expect(state.agentState.value).toBe("Done");
    expect(state.promptProfile.value).toBe("agent");
    expect(state.conversationTurns.value).toEqual([
      { role: "user", content: "查一下东京时间" },
      {
        role: "activity-group",
        status: "done",
        items: [
          expect.objectContaining({ kind: "thinking", status: "done" }),
          expect.objectContaining({
            kind: "tool",
            status: "done",
            title: "已使用 core_get_time",
          }),
        ],
      },
      {
        role: "assistant",
        content: "东京现在是九点。",
        htmlContent: "<p>东京现在是九点。</p>",
        artifacts: [],
      },
    ]);
  });

  it("marks active work as failed when the run errors", () => {
    const projection = createProjection();

    projection.beginUserTurn("执行任务");
    projection.handle(event("run.started"));
    projection.handle(
      event("llm.request", {
        request: { messages: [], tools: [] },
        context: {},
        iteration: 1,
      }),
    );
    projection.handle(event("run.error", { error: "model unavailable" }));

    const group = projection.state.conversationTurns.value[1];
    expect(projection.state.runTitle.value).toBe("Error");
    expect(projection.state.agentState.value).toBe("Error");
    expect(group.status).toBe("error");
    expect(group.items[0]).toMatchObject({
      kind: "thinking",
      status: "error",
      title: "思考中断",
      body: "model unavailable",
    });
  });

  it("reconciles web traces and artifact-producing tools", () => {
    const onRefresh = vi.fn();
    const projection = createProjection({ onRefresh });

    projection.beginUserTurn("搜索并画图");
    projection.handle(
      event("tool.started", {
        tool_call_id: "search-1",
        tool: "web_search",
        arguments: { query: "Anomalo" },
      }),
    );
    projection.handle(
      event("tool.finished", {
        tool_call_id: "search-1",
        tool: "web_search",
        content: "result",
        data: {
          trace_kind: "web_search",
          query: "Anomalo",
          results: [{ title: "Result", url: "https://example.com" }],
          skill_action: "activate",
          artifacts: [{ name: "chart.png", url: "/api/artifacts/python/chart.png" }],
        },
      }),
    );
    projection.handle(event("run.finished", { final_text: "完成" }));

    expect(projection.state.webTraces.value).toHaveLength(1);
    expect(projection.state.webTraces.value[0]).toMatchObject({
      id: "search-1",
      ok: true,
      tool: "web_search",
      content: "result",
    });
    expect(projection.state.conversationTurns.value.at(-1).artifacts).toEqual([
      { name: "chart.png", url: "/api/artifacts/python/chart.png" },
    ]);
    expect(onRefresh).toHaveBeenCalledWith(["skills", "tools"]);
    expect(onRefresh).toHaveBeenLastCalledWith(["tools", "skills", "mcp"]);
  });

  it("resets conversation state without discarding the loaded prompt profile", () => {
    const projection = createProjection();
    projection.setPromptOutput({ source: "config", profile: "agent" });
    projection.state.promptProfile.value = "agent";
    projection.beginUserTurn("hello");

    projection.reset();

    expect(projection.state.conversationTurns.value).toEqual([]);
    expect(projection.state.runId.value).toBe("none");
    expect(projection.state.agentState.value).toBe("Idle");
    expect(projection.state.promptProfile.value).toBe("agent");
    expect(projection.state.promptOutput.value).toContain('"source": "config"');
  });
});
