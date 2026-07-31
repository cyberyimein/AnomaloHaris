import { ref } from "vue";

const MARKDOWN_RENDER_INTERVAL_MS = 160;

export function createAgentSessionProjection({
  renderMarkdown,
  onScroll = () => {},
  onRefresh = () => {},
} = {}) {
  const markdownRenderer = renderMarkdown || ((value) => String(value || ""));

  const events = ref([]);
  const webTraces = ref([]);
  const conversationTurns = ref([]);
  const promptOutput = ref("Loading prompt profile...");
  const latestPromptJson = ref("");
  const latestMessagesJson = ref("");
  const copyPromptDisabled = ref(true);
  const copyMessagesDisabled = ref(true);
  const agentState = ref("Idle");
  const runStatus = ref("Idle");
  const runId = ref("none");
  const promptProfile = ref("default");
  const iterationCount = ref("0");
  const stateDetail = ref("Waiting for input.");
  const runTitle = ref("Ready");
  const resumeAvailable = ref(false);
  const contextStats = ref([]);
  const contextSegments = ref([]);
  const contextMessages = ref([]);

  let eventSequence = 0;
  let activitySequence = 0;
  let activeAssistantIndex = null;
  let pendingAssistantArtifacts = [];
  let activeThinkingActivityId = "";
  let activeActivityGroupIndex = null;
  const activeToolActivityIds = new Map();
  const markdownRenderTimers = new Map();

  function handle(event) {
    const data = event.data || {};
    switch (event.type) {
      case "run.started":
        runId.value = event.run_id;
        runTitle.value = data.resumed ? "Resuming" : "Running";
        resumeAvailable.value = false;
        activeActivityGroupIndex = null;
        setAgentState("Thinking", "Building context and preparing tools.");
        addEventLog("run.started", event.run_id);
        break;
      case "llm.request": {
        renderLlmRequest(data.request, data.context, data.iteration);
        const summary = summarizeLlmRequest(data.request);
        setAgentState("LLM Request", summary);
        activeThinkingActivityId = addConversationActivity({
          kind: "thinking",
          status: "running",
          title: "正在思考",
          body: summary,
        });
        addEventLog("llm.request", summary);
        break;
      }
      case "message.delta":
        finishThinkingActivity({ status: "done", title: "已开始回答" });
        appendAssistantContent(data.content || "");
        setAgentState("Streaming", "Receiving assistant output.");
        break;
      case "message.done":
        flushMarkdownRender(activeAssistantIndex);
        activeAssistantIndex = null;
        setAgentState("Finalizing", "Assistant message completed.");
        break;
      case "tool.started":
        flushMarkdownRender(activeAssistantIndex);
        activeAssistantIndex = null;
        finishThinkingActivity({ status: "done", title: "已决定使用工具" });
        setAgentState("Tool", data.tool || "Tool call started.");
        activeToolActivityIds.set(
          toolActivityKey(event),
          addConversationActivity({
            kind: "tool",
            status: "running",
            title: `正在使用 ${data.tool || "工具"}`,
            body: summarizeToolArguments(data.arguments),
          }),
        );
        if (isWebTool(data.tool)) {
          upsertWebTrace(event, null);
        }
        addEventLog(`tool.started · ${data.tool}`, JSON.stringify(data.arguments || {}));
        break;
      case "tool.finished":
        setAgentState("Tool Result", data.tool || "Tool call finished.");
        updateToolActivity(toolActivityKey(event), {
          status: "done",
          title: `已使用 ${data.tool || "工具"}`,
          body: summarizeToolResult(data.content),
        });
        if (isWebTool(data.tool) || isWebTraceData(data.data)) {
          upsertWebTrace(event, true);
        }
        addEventLog(`tool.finished · ${data.tool}`, data.content || "");
        queueAssistantArtifacts(data.data?.artifacts);
        onRefresh(refreshTargets(data.data));
        break;
      case "tool.error":
        updateToolActivity(toolActivityKey(event), {
          status: "error",
          title: `${data.tool || "工具"} 失败`,
          body: summarizeToolResult(data.content),
        });
        if (isWebTool(data.tool) || isWebTraceData(data.data)) {
          upsertWebTrace(event, false);
        }
        setAgentState("Tool Error", data.content || "Tool call failed.");
        addEventLog(event.type, data.content || "tool error", true);
        break;
      case "run.error":
        runTitle.value = "Error";
        resumeAvailable.value = Boolean(data.can_resume);
        flushMarkdownRender(activeAssistantIndex);
        activeAssistantIndex = null;
        finishThinkingActivity({
          status: "error",
          title: "思考中断",
          body: data.error || "Run error.",
        });
        completeActivityGroup("error");
        activeToolActivityIds.clear();
        setAgentState("Error", data.error || "Run error.");
        addEventLog(event.type, data.error || "error", true);
        break;
      case "run.stopped":
        runTitle.value = "Paused";
        resumeAvailable.value = Boolean(data.can_resume);
        flushMarkdownRender(activeAssistantIndex);
        finishThinkingActivity({ status: "done", title: "已暂停" });
        completeActivityGroup("stopped");
        activeToolActivityIds.clear();
        setAgentState("Stopped", "Run paused. Resume to continue.");
        addEventLog(event.type, data.reason || "user_stop");
        break;
      case "run.finished":
        runTitle.value = "Complete";
        resumeAvailable.value = false;
        reconcileFinalAssistantContent(data.final_text || "");
        finishThinkingActivity({ status: "done", title: "已完成思考" });
        completeActivityGroup("done");
        activeToolActivityIds.clear();
        setAgentState("Done", "Run finished.");
        addEventLog("run.finished", "done");
        onRefresh(["tools", "skills", "mcp"]);
        break;
      default:
        addEventLog(event.type, JSON.stringify(data));
    }
  }

  function beginUserTurn(content) {
    conversationTurns.value.push({ role: "user", content });
    activeAssistantIndex = null;
    pendingAssistantArtifacts = [];
    activeThinkingActivityId = "";
    activeActivityGroupIndex = null;
    activeToolActivityIds.clear();
    setAgentState("Queued", "Message sent. Waiting for run start.");
    void onScroll();
  }

  function reset() {
    clearMarkdownRenderTimers();
    events.value = [];
    webTraces.value = [];
    conversationTurns.value = [];
    latestMessagesJson.value = "";
    copyMessagesDisabled.value = true;
    runId.value = "none";
    iterationCount.value = "0";
    runTitle.value = "Ready";
    resumeAvailable.value = false;
    contextStats.value = [];
    contextSegments.value = [];
    contextMessages.value = [];
    eventSequence = 0;
    activitySequence = 0;
    activeAssistantIndex = null;
    pendingAssistantArtifacts = [];
    activeThinkingActivityId = "";
    activeActivityGroupIndex = null;
    activeToolActivityIds.clear();
    setAgentState("Idle", "New conversation ready.");
  }

  function setAgentState(state, detail) {
    agentState.value = state;
    runStatus.value = state;
    stateDetail.value = detail || "";
  }

  function replaceWebTraces(traces) {
    webTraces.value = [...traces];
  }

  function addConversationActivity({ kind, status, title, body = "" }) {
    const group = ensureActivityGroup();
    const id = `activity-${++activitySequence}`;
    group.items.push({ id, kind, status, title, body });
    group.status = "running";
    void onScroll();
    return id;
  }

  function ensureActivityGroup() {
    const activeGroup =
      typeof activeActivityGroupIndex === "number"
        ? conversationTurns.value[activeActivityGroupIndex]
        : null;
    if (activeGroup?.role === "activity-group" && activeGroup.status === "running") {
      return activeGroup;
    }
    const group = { role: "activity-group", status: "running", items: [] };
    activeActivityGroupIndex = conversationTurns.value.push(group) - 1;
    return group;
  }

  function updateConversationActivity(activityId, updates) {
    if (!activityId) {
      return;
    }
    for (const turn of conversationTurns.value) {
      if (turn?.role !== "activity-group") {
        continue;
      }
      const itemIndex = turn.items.findIndex((item) => item.id === activityId);
      if (itemIndex >= 0) {
        turn.items[itemIndex] = { ...turn.items[itemIndex], ...updates };
        void onScroll();
        return;
      }
    }
  }

  function finishThinkingActivity(updates) {
    const activityId = activeThinkingActivityId || findLatestRunningThinkingActivityId();
    if (activityId) {
      updateConversationActivity(activityId, updates);
    }
    activeThinkingActivityId = "";
  }

  function findLatestRunningThinkingActivityId() {
    const latestUserIndex = findLatestUserTurnIndex();
    for (let index = conversationTurns.value.length - 1; index > latestUserIndex; index -= 1) {
      const turn = conversationTurns.value[index];
      if (turn?.role !== "activity-group") {
        continue;
      }
      for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const item = turn.items[itemIndex];
        if (item.kind === "thinking" && item.status === "running") {
          return item.id;
        }
      }
    }
    return "";
  }

  function updateToolActivity(toolName, updates) {
    const key = toolName || "tool";
    const activityId = activeToolActivityIds.get(key);
    if (activityId) {
      updateConversationActivity(activityId, updates);
      activeToolActivityIds.delete(key);
      return;
    }
    addConversationActivity({ kind: "tool", ...updates });
  }

  function completeActivityGroup(status) {
    const group =
      typeof activeActivityGroupIndex === "number"
        ? conversationTurns.value[activeActivityGroupIndex]
        : null;
    if (group?.role === "activity-group") {
      group.status = status;
      if (status === "error") {
        for (const item of group.items) {
          if (item.status === "running") {
            item.status = "error";
          }
        }
      } else if (status === "stopped") {
        for (const item of group.items) {
          if (item.status === "running") {
            item.status = "stopped";
          }
        }
      }
    }
    activeActivityGroupIndex = null;
  }

  function appendAssistantContent(content) {
    if (activeAssistantIndex === null) {
      const artifacts = consumePendingAssistantArtifacts();
      activeAssistantIndex =
        conversationTurns.value.push({
          role: "assistant",
          content: "",
          htmlContent: "",
          artifacts,
        }) - 1;
    }
    conversationTurns.value[activeAssistantIndex].content += content;
    scheduleMarkdownRender(activeAssistantIndex);
    void onScroll();
  }

  function reconcileFinalAssistantContent(content) {
    const finalContent = String(content || "");
    if (typeof activeAssistantIndex === "number") {
      attachPendingArtifacts(activeAssistantIndex);
      if (finalContent) {
        setAssistantContent(activeAssistantIndex, finalContent);
      } else {
        flushMarkdownRender(activeAssistantIndex);
      }
      activeAssistantIndex = null;
      return;
    }
    if (!finalContent) {
      return;
    }
    const currentAssistantIndex = findLatestAssistantTurnIndexAfterLatestUser();
    if (typeof currentAssistantIndex === "number") {
      attachPendingArtifacts(currentAssistantIndex);
      const turn = conversationTurns.value[currentAssistantIndex];
      if (turn.content === finalContent) {
        flushMarkdownRender(currentAssistantIndex);
      } else if (!turn.content || finalContent.startsWith(turn.content)) {
        setAssistantContent(currentAssistantIndex, finalContent);
      } else {
        flushMarkdownRender(currentAssistantIndex);
      }
      return;
    }
    const artifacts = consumePendingAssistantArtifacts();
    conversationTurns.value.push({
      role: "assistant",
      content: finalContent,
      artifacts,
      htmlContent: markdownRenderer(finalContent, artifacts),
    });
    void onScroll();
  }

  function findLatestAssistantTurnIndexAfterLatestUser() {
    const latestUserIndex = findLatestUserTurnIndex();
    for (let index = conversationTurns.value.length - 1; index > latestUserIndex; index -= 1) {
      if (conversationTurns.value[index]?.role === "assistant") {
        return index;
      }
    }
    return null;
  }

  function findLatestUserTurnIndex() {
    for (let index = conversationTurns.value.length - 1; index >= 0; index -= 1) {
      if (conversationTurns.value[index]?.role === "user") {
        return index;
      }
    }
    return -1;
  }

  function setAssistantContent(index, content) {
    const turn = conversationTurns.value[index];
    if (!turn || turn.role !== "assistant") {
      return;
    }
    cancelMarkdownRender(index);
    conversationTurns.value[index] = {
      ...turn,
      content,
      htmlContent: markdownRenderer(content, turn.artifacts),
    };
    void onScroll();
  }

  function scheduleMarkdownRender(index) {
    if (typeof index !== "number" || markdownRenderTimers.has(index)) {
      return;
    }
    const timer = setTimeout(() => {
      markdownRenderTimers.delete(index);
      renderConversationMarkdown(index);
    }, markdownRenderDelay(index));
    markdownRenderTimers.set(index, timer);
  }

  function flushMarkdownRender(index) {
    if (typeof index !== "number") {
      return;
    }
    cancelMarkdownRender(index);
    renderConversationMarkdown(index);
  }

  function cancelMarkdownRender(index) {
    const timer = markdownRenderTimers.get(index);
    if (timer) {
      clearTimeout(timer);
      markdownRenderTimers.delete(index);
    }
  }

  function clearMarkdownRenderTimers() {
    for (const timer of markdownRenderTimers.values()) {
      clearTimeout(timer);
    }
    markdownRenderTimers.clear();
  }

  function renderConversationMarkdown(index) {
    const turn = conversationTurns.value[index];
    if (!turn || turn.role !== "assistant") {
      return;
    }
    conversationTurns.value[index] = {
      ...turn,
      htmlContent: markdownRenderer(turn.content, turn.artifacts),
    };
    void onScroll();
  }

  function markdownRenderDelay(index) {
    const contentLength = conversationTurns.value[index]?.content?.length || 0;
    if (contentLength > 16000) {
      return 480;
    }
    if (contentLength > 6000) {
      return 280;
    }
    return MARKDOWN_RENDER_INTERVAL_MS;
  }

  function renderLlmRequest(request, context, iteration) {
    const safeRequest = request || {};
    const messages = Array.isArray(safeRequest.messages) ? safeRequest.messages : [];
    latestMessagesJson.value = JSON.stringify(messages, null, 2);
    copyMessagesDisabled.value = messages.length === 0;
    promptProfile.value = context?.profile || "default";
    iterationCount.value = String(iteration || 0);
    setPromptOutput({ source: "llm.request", iteration, context, request: safeRequest });
    contextStats.value = contextStatRows(safeRequest, context, messages);
    contextSegments.value = context?.segments || [];
    contextMessages.value = messages.map((message, index) => ({
      index,
      role: message.role || "unknown",
      source: sourceForIndex(index, context),
      summary: summarizeMessageContent(message),
    }));
  }

  function setPromptOutput(value) {
    latestPromptJson.value = JSON.stringify(value, null, 2);
    promptOutput.value = latestPromptJson.value;
    copyPromptDisabled.value = false;
  }

  function queueAssistantArtifacts(artifacts) {
    if (!Array.isArray(artifacts)) {
      return;
    }
    const accepted = artifacts.filter((artifact) => artifact?.url && artifact?.name);
    pendingAssistantArtifacts = uniqueArtifacts([...pendingAssistantArtifacts, ...accepted]);
  }

  function consumePendingAssistantArtifacts() {
    const artifacts = pendingAssistantArtifacts;
    pendingAssistantArtifacts = [];
    return artifacts;
  }

  function attachPendingArtifacts(index) {
    const pending = consumePendingAssistantArtifacts();
    if (!pending.length || !conversationTurns.value[index]) {
      return;
    }
    const existing = conversationTurns.value[index].artifacts || [];
    conversationTurns.value[index].artifacts = uniqueArtifacts([...existing, ...pending]);
  }

  function upsertWebTrace(event, ok) {
    const data = event.data || {};
    const toolCallId = data.tool_call_id || `${event.run_id}:${data.tool}`;
    const existingIndex = webTraces.value.findIndex(
      (trace) => (trace.tool_call_id || trace.id) === toolCallId,
    );
    const existing = existingIndex >= 0 ? webTraces.value[existingIndex] : null;
    const tool = data.tool || existing?.tool || "web";
    const argumentsValue = data.arguments || existing?.arguments || {};
    const inferredData =
      tool === "web_search"
        ? {
            trace_kind: "web_search",
            provider: "duckduckgo_html",
            query: argumentsValue.query || "",
            results: [],
          }
        : {
            trace_kind: "web_fetch",
            provider: "pending",
            requested_url: argumentsValue.url || "",
          };
    const trace = {
      ...existing,
      id: existing?.id || toolCallId,
      tool_call_id: toolCallId,
      run_id: event.run_id || existing?.run_id,
      tool,
      ok,
      arguments: argumentsValue,
      content: data.content ?? existing?.content ?? "",
      data: data.data || existing?.data || inferredData,
      timestamp: existing?.timestamp || event.timestamp || new Date().toISOString(),
    };
    if (existingIndex >= 0) {
      webTraces.value.splice(existingIndex, 1, trace);
    } else {
      webTraces.value.unshift(trace);
    }
  }

  function addEventLog(title, body, isError = false) {
    events.value.unshift({
      id: eventSequence++,
      title,
      body: String(body).slice(0, 1000),
      isError,
    });
  }

  return {
    state: {
      events,
      webTraces,
      conversationTurns,
      promptOutput,
      latestPromptJson,
      latestMessagesJson,
      copyPromptDisabled,
      copyMessagesDisabled,
      agentState,
      runStatus,
      runId,
      promptProfile,
      iterationCount,
      stateDetail,
      runTitle,
      resumeAvailable,
      contextStats,
      contextSegments,
      contextMessages,
    },
    handle,
    beginUserTurn,
    reset,
    setAgentState,
    setPromptOutput,
    addEventLog,
    replaceWebTraces,
    clearMarkdownRenderTimers,
  };
}

export function activityGroupCurrent(group) {
  return group.items[group.items.length - 1] || null;
}

export function activityGroupPrevious(group) {
  return group.items[group.items.length - 2] || null;
}

export function activityGroupFading(group) {
  return group.items[group.items.length - 3] || null;
}

export function activityGroupSummary(group) {
  if (group.status === "error") {
    return "执行中断";
  }
  if (group.status === "stopped") {
    return "已暂停";
  }
  return "已完成";
}

export function activityGroupSubtitle(group) {
  const toolCount = group.items.filter((item) => item.kind === "tool").length;
  const thinkingCount = group.items.filter((item) => item.kind === "thinking").length;
  const parts = [];
  if (thinkingCount) {
    parts.push(`${thinkingCount} 次思考`);
  }
  if (toolCount) {
    parts.push(`${toolCount} 次工具调用`);
  }
  return `${parts.join(" · ") || `${group.items.length} 个事件`} · 点击展开`;
}

function toolActivityKey(event) {
  return event.data?.tool_call_id || event.data?.tool || "tool";
}

function isWebTool(toolName) {
  return toolName === "web_search" || toolName === "web_fetch";
}

function isWebTraceData(data) {
  return data?.trace_kind === "web_search" || data?.trace_kind === "web_fetch";
}

function refreshTargets(data) {
  const targets = [];
  if (data?.skill_action) {
    targets.push("skills", "tools");
  }
  if (data?.mcp_action) {
    targets.push("mcp", "tools");
  }
  return [...new Set(targets)];
}

function summarizeLlmRequest(request) {
  const messageCount = request?.messages?.length || 0;
  const toolCount = request?.tools?.length || 0;
  return `${messageCount} prompt parts · ${toolCount} tools · ${request?.model || "unknown model"}`;
}

function summarizeToolArguments(argumentsValue) {
  if (!argumentsValue) {
    return "";
  }
  if (typeof argumentsValue === "object" && Object.keys(argumentsValue).length === 0) {
    return "";
  }
  return truncateInline(JSON.stringify(argumentsValue, null, 2), 180);
}

function summarizeToolResult(content) {
  return truncateInline(content || "", 220);
}

function truncateInline(value, maxLength) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function contextStatRows(request, context, messages) {
  return [
    { label: "Prompt Parts", value: messages.length },
    { label: "Prompt", value: context?.prompt_message_count ?? 0 },
    { label: "Memory", value: context?.memory_message_count ?? 0 },
    { label: "Skills", value: context?.active_skill_count ?? 0 },
    { label: "MCP", value: context?.active_mcp_server_count ?? 0 },
    { label: "History", value: context?.history_message_count ?? 0 },
    { label: "Tools", value: context?.tool_count ?? request?.tools?.length ?? 0 },
  ];
}

function sourceForIndex(index, context) {
  const segment = (context?.segments || []).find(
    (candidate) => index >= candidate.start && index < candidate.end,
  );
  return segment?.label || "Unclassified";
}

function summarizeMessageContent(message) {
  const parts = [];
  if (message.content !== null && message.content !== undefined) {
    parts.push(
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content, null, 2),
    );
  }
  if (message.tool_calls) {
    parts.push(`tool_calls:\n${JSON.stringify(message.tool_calls, null, 2)}`);
  }
  if (message.name) {
    parts.push(`name: ${message.name}`);
  }
  if (message.tool_call_id) {
    parts.push(`tool_call_id: ${message.tool_call_id}`);
  }
  return parts.join("\n\n") || "(empty)";
}

function uniqueArtifacts(artifacts) {
  return artifacts.filter(
    (artifact, index) => artifacts.findIndex((candidate) => candidate.url === artifact.url) === index,
  );
}
