const sessionId = localStorage.getItem("anomalo.session") || createSessionId();
localStorage.setItem("anomalo.session", sessionId);

function createSessionId() {
  return `session_${createUuid().replaceAll("-", "")}`;
}

function createUuid() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }

  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = char === "x" ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

const statusEl = document.querySelector("#connectionStatus");
const toolListEl = document.querySelector("#toolList");
const eventLogEl = document.querySelector("#eventLog");
const conversationEl = document.querySelector("#conversation");
const formEl = document.querySelector("#chatForm");
const inputEl = document.querySelector("#messageInput");
const sendButtonEl = document.querySelector("#sendButton");
const promptOutputEl = document.querySelector("#promptOutput");
const copyPromptButtonEl = document.querySelector("#copyPromptButton");
const copyMessagesButtonEl = document.querySelector("#copyMessagesButton");
const agentStateEl = document.querySelector("#agentState");
const runStatusBadgeEl = document.querySelector("#runStatusBadge");
const runIdEl = document.querySelector("#runId");
const promptProfileEl = document.querySelector("#promptProfile");
const iterationCountEl = document.querySelector("#iterationCount");
const stateDetailEl = document.querySelector("#stateDetail");
const runTitleEl = document.querySelector("#runTitle");
const contextStatsEl = document.querySelector("#contextStats");
const contextSegmentsEl = document.querySelector("#contextSegments");
const messageArrayEl = document.querySelector("#messageArray");
const skillListEl = document.querySelector("#skillList");
const skillStatusEl = document.querySelector("#skillStatus");
const mcpListEl = document.querySelector("#mcpList");
const mcpStatusEl = document.querySelector("#mcpStatus");
const memoryFormEl = document.querySelector("#memoryForm");
const memoryFileEl = document.querySelector("#memoryFile");
const memoryStatusEl = document.querySelector("#memoryStatus");
const memoryPreviewEl = document.querySelector("#memoryPreview");
const memoryUploadButtonEl = document.querySelector("#memoryUploadButton");

let socket;
let activeAssistantOutput = null;
let reconnectTimer = null;
let latestPromptJson = "";
let latestMessagesJson = "";
let skillsUpdateInFlight = false;
let mcpUpdateInFlight = false;

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws/chat/${sessionId}`);

  socket.addEventListener("open", () => {
    statusEl.textContent = "Connected";
    statusEl.className = "ok";
    sendButtonEl.disabled = false;
    setAgentState("Idle", "Connected. Waiting for input.");
  });

  socket.addEventListener("close", () => {
    statusEl.textContent = "Disconnected";
    statusEl.className = "error";
    sendButtonEl.disabled = true;
    setAgentState("Offline", "WebSocket disconnected. Reconnecting...");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  });

  socket.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    handleAgentEvent(event);
  });
}

async function loadTools() {
  try {
    const response = await fetch(`/api/tools?session_id=${encodeURIComponent(sessionId)}`);
    const data = await response.json();
    toolListEl.innerHTML = "";
    for (const tool of data.tools || []) {
      const item = document.createElement("div");
      item.className = "tool";
      item.innerHTML = `
        <div class="tool-name">${escapeHtml(tool.name)}</div>
        <div class="tool-source">${escapeHtml(tool.source)} · ${escapeHtml(tool.description || "")}</div>
      `;
      toolListEl.appendChild(item);
    }
  } catch (error) {
    addEventLog("tools.error", String(error), true);
  }
}

async function loadSkills() {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/skills`);
    const data = await response.json();
    renderSkills(data.skills || []);
  } catch (error) {
    skillStatusEl.textContent = `Skill load failed: ${error}`;
  }
}

async function loadMcpServers() {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`);
    const data = await response.json();
    renderMcpServers(data.servers || []);
  } catch (error) {
    mcpStatusEl.textContent = `MCP load failed: ${error}`;
  }
}

async function loadPromptProfile() {
  try {
    const response = await fetch("/api/prompts");
    const data = await response.json();
    promptProfileEl.textContent = data.profile || "default";
    setPromptOutput({
      source: "config",
      profile: data.profile,
      config_path: data.config_path,
      messages: data.messages || [],
    });
  } catch (error) {
    setPromptOutput({ error: String(error) });
  }
}

async function loadMemory() {
  try {
    const response = await fetch("/api/memory");
    renderMemory(await response.json());
  } catch (error) {
    memoryStatusEl.textContent = `Memory load failed: ${error}`;
  }
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const content = inputEl.value.trim();
  if (!content || socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  removeEmptyState();
  addUserBubble(content);
  inputEl.value = "";
  activeAssistantOutput = addAssistantOutput();
  setAgentState("Queued", "Message sent. Waiting for run start.");
  socket.send(JSON.stringify({ type: "user.message", content }));
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

memoryFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = memoryFileEl.files?.[0];
  if (!file) {
    memoryStatusEl.textContent = "Choose an AGENTS.md file first.";
    return;
  }

  memoryUploadButtonEl.disabled = true;
  memoryStatusEl.textContent = "Uploading memory...";
  const data = new FormData();
  data.append("file", file);

  try {
    const response = await fetch("/api/memory/upload", {
      method: "POST",
      body: data,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Upload failed.");
    }
    renderMemory(payload);
    memoryFileEl.value = "";
  } catch (error) {
    memoryStatusEl.textContent = `Memory upload failed: ${error}`;
  } finally {
    memoryUploadButtonEl.disabled = false;
  }
});

copyPromptButtonEl.addEventListener("click", async () => {
  if (!latestPromptJson) {
    return;
  }
  await navigator.clipboard.writeText(latestPromptJson);
  flashCopyButton(copyPromptButtonEl);
});

copyMessagesButtonEl.addEventListener("click", async () => {
  if (!latestMessagesJson) {
    return;
  }
  await navigator.clipboard.writeText(latestMessagesJson);
  flashCopyButton(copyMessagesButtonEl);
});

function handleAgentEvent(event) {
  switch (event.type) {
    case "run.started":
      runIdEl.textContent = event.run_id;
      runTitleEl.textContent = "Running";
      setAgentState("Thinking", "Building context and preparing tools.");
      addEventLog("run.started", event.run_id);
      break;
    case "llm.request":
      renderLlmRequest(event.data.request, event.data.context, event.data.iteration);
      setAgentState("LLM Request", summarizeLlmRequest(event.data.request));
      addEventLog("llm.request", summarizeLlmRequest(event.data.request));
      break;
    case "message.delta":
      if (!activeAssistantOutput) {
        activeAssistantOutput = addAssistantOutput();
      }
      setAgentState("Streaming", "Receiving assistant output.");
      activeAssistantOutput.textContent += event.data.content || "";
      conversationEl.scrollTop = conversationEl.scrollHeight;
      break;
    case "message.done":
      activeAssistantOutput = null;
      setAgentState("Finalizing", "Assistant message completed.");
      break;
    case "tool.started":
      setAgentState("Tool", event.data.tool || "Tool call started.");
      addEventLog(`tool.started · ${event.data.tool}`, JSON.stringify(event.data.arguments || {}));
      break;
    case "tool.finished":
      setAgentState("Tool Result", event.data.tool || "Tool call finished.");
      addEventLog(`tool.finished · ${event.data.tool}`, event.data.content || "");
      if (event.data.data?.skill_action) {
        loadSkills();
        loadTools();
      }
      if (event.data.data?.mcp_action) {
        loadMcpServers();
        loadTools();
      }
      break;
    case "tool.error":
      setAgentState("Tool Error", event.data.content || "Tool call failed.");
      addEventLog(event.type, event.data.content || "tool error", true);
      break;
    case "run.error":
      runTitleEl.textContent = "Error";
      activeAssistantOutput = null;
      setAgentState("Error", event.data.error || "Run error.");
      addEventLog(event.type, event.data.error || "error", true);
      break;
    case "run.finished":
      runTitleEl.textContent = "Complete";
      setAgentState("Done", "Run finished.");
      addEventLog("run.finished", "done");
      loadTools();
      loadSkills();
      loadMcpServers();
      break;
    default:
      addEventLog(event.type, JSON.stringify(event.data || {}));
  }
}

async function updateSessionSkills() {
  skillsUpdateInFlight = true;
  setSkillInputsDisabled(true);
  skillStatusEl.textContent = "Updating session skills...";
  const activeSkills = Array.from(skillListEl.querySelectorAll("input[data-skill-name]:checked")).map(
    (input) => input.dataset.skillName,
  );

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_skills: activeSkills }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Skill update failed.");
    }
    renderSkills(payload.skills || []);
    loadTools();
  } catch (error) {
    skillStatusEl.textContent = `Skill update failed: ${error}`;
    loadSkills();
  } finally {
    skillsUpdateInFlight = false;
    setSkillInputsDisabled(false);
  }
}

async function updateSessionMcpServers() {
  mcpUpdateInFlight = true;
  setMcpInputsDisabled(true);
  mcpStatusEl.textContent = "Updating session MCP servers...";
  const activeServers = Array.from(mcpListEl.querySelectorAll("input[data-mcp-server-name]:checked")).map(
    (input) => input.dataset.mcpServerName,
  );

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mcp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_servers: activeServers }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "MCP update failed.");
    }
    renderMcpServers(payload.servers || []);
    loadTools();
  } catch (error) {
    mcpStatusEl.textContent = `MCP update failed: ${error}`;
    loadMcpServers();
  } finally {
    mcpUpdateInFlight = false;
    setMcpInputsDisabled(false);
  }
}

function renderSkills(skills) {
  skillListEl.innerHTML = "";

  if (!skills.length) {
    skillStatusEl.textContent = "No skills configured.";
    return;
  }

  const activeCount = skills.filter((skill) => skill.active).length;
  skillStatusEl.textContent = `${activeCount} active · ${skills.length} available`;

  for (const skill of skills) {
    const item = document.createElement("label");
    item.className = `skill-card${skill.enabled ? "" : " disabled"}`;
    item.innerHTML = `
      <input
        type="checkbox"
        data-skill-name="${escapeHtml(skill.name)}"
        ${skill.active ? "checked" : ""}
        ${skill.enabled ? "" : "disabled"}
      />
      <div class="skill-card-body">
        <div class="skill-card-name">${escapeHtml(skill.display_name || skill.name)}</div>
        <div class="skill-card-meta">${escapeHtml(skill.description || "No description")}</div>
        <div class="skill-card-meta">Use when: ${escapeHtml(skill.when_to_use || "No routing hint")}</div>
        <div class="skill-card-tools">${escapeHtml(String(skill.tool_count || 0))} tools</div>
      </div>
    `;

    const checkbox = item.querySelector("input");
    if (checkbox) {
      checkbox.disabled = checkbox.disabled || skillsUpdateInFlight;
      checkbox.addEventListener("change", () => {
        void updateSessionSkills();
      });
    }
    skillListEl.appendChild(item);
  }
}

function setSkillInputsDisabled(disabled) {
  for (const input of skillListEl.querySelectorAll("input[data-skill-name]")) {
    input.disabled = disabled || input.closest(".skill-card")?.classList.contains("disabled");
  }
}

function renderMcpServers(servers) {
  mcpListEl.innerHTML = "";

  if (!servers.length) {
    mcpStatusEl.textContent = "No MCP servers configured.";
    return;
  }

  const activeCount = servers.filter((server) => server.active).length;
  mcpStatusEl.textContent = `${activeCount} active · ${servers.length} available`;

  for (const server of servers) {
    const item = document.createElement("label");
    item.className = `skill-card${server.enabled ? "" : " disabled"}`;
    item.innerHTML = `
      <input
        type="checkbox"
        data-mcp-server-name="${escapeHtml(server.name)}"
        ${server.active ? "checked" : ""}
        ${server.enabled ? "" : "disabled"}
      />
      <div class="skill-card-body">
        <div class="skill-card-name">${escapeHtml(server.name)}</div>
        <div class="skill-card-meta">${escapeHtml(server.description || "No description")}</div>
        <div class="skill-card-meta">Loads this MCP tool pack only for the current session.</div>
      </div>
    `;

    const checkbox = item.querySelector("input");
    if (checkbox) {
      checkbox.disabled = checkbox.disabled || mcpUpdateInFlight;
      checkbox.addEventListener("change", () => {
        void updateSessionMcpServers();
      });
    }
    mcpListEl.appendChild(item);
  }
}

function setMcpInputsDisabled(disabled) {
  for (const input of mcpListEl.querySelectorAll("input[data-mcp-server-name]")) {
    input.disabled = disabled || input.closest(".skill-card")?.classList.contains("disabled");
  }
}

function addUserBubble(content) {
  const row = document.createElement("div");
  row.className = "turn user-turn";

  const bubble = document.createElement("div");
  bubble.className = "user-bubble";
  bubble.textContent = content;

  row.appendChild(bubble);
  conversationEl.appendChild(row);
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

function addAssistantOutput() {
  const output = document.createElement("div");
  output.className = "assistant-output";
  output.textContent = "";
  conversationEl.appendChild(output);
  conversationEl.scrollTop = conversationEl.scrollHeight;
  return output;
}

function renderLlmRequest(request, context, iteration) {
  const safeRequest = request || {};
  const messages = Array.isArray(safeRequest.messages) ? safeRequest.messages : [];
  latestMessagesJson = JSON.stringify(messages, null, 2);
  copyMessagesButtonEl.disabled = messages.length === 0;
  promptProfileEl.textContent = context?.profile || "default";
  iterationCountEl.textContent = String(iteration || 0);

  setPromptOutput({
    source: "llm.request",
    iteration,
    context,
    request: safeRequest,
  });
  renderContextStats(safeRequest, context, messages);
  renderContextSegments(context);
  renderMessageArray(messages, context);
}

function renderContextStats(request, context, messages) {
  contextStatsEl.innerHTML = "";
  const stats = [
    ["Messages", messages.length],
    ["Prompt", context?.prompt_message_count ?? 0],
    ["Memory", context?.memory_message_count ?? 0],
    ["Skills", context?.active_skill_count ?? 0],
    ["MCP", context?.active_mcp_server_count ?? 0],
    ["History", context?.history_message_count ?? 0],
    ["Tools", context?.tool_count ?? request?.tools?.length ?? 0],
  ];

  for (const [label, value] of stats) {
    const item = document.createElement("div");
    item.className = "stat";
    item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
    contextStatsEl.appendChild(item);
  }
}

function renderContextSegments(context) {
  contextSegmentsEl.innerHTML = "";
  for (const segment of context?.segments || []) {
    const item = document.createElement("div");
    item.className = `segment segment-${segment.name}`;
    item.textContent = `${segment.label}: [${segment.start}, ${segment.end}) · ${segment.count}`;
    contextSegmentsEl.appendChild(item);
  }
}

function renderMessageArray(messages, context) {
  messageArrayEl.innerHTML = "";
  messages.forEach((message, index) => {
    const item = document.createElement("article");
    item.className = `context-message role-${message.role || "unknown"}`;

    const header = document.createElement("div");
    header.className = "context-message-header";

    const title = document.createElement("strong");
    title.textContent = `#${index} · ${message.role || "unknown"}`;

    const source = document.createElement("span");
    source.textContent = sourceForIndex(index, context);

    header.append(title, source);

    const body = document.createElement("pre");
    body.textContent = summarizeMessageContent(message);

    item.append(header, body);
    messageArrayEl.appendChild(item);
  });
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
    parts.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2));
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

function addEventLog(title, body, isError = false) {
  const item = document.createElement("div");
  item.className = "event";
  item.innerHTML = `
    <div class="event-title ${isError ? "error" : ""}">${escapeHtml(title)}</div>
    <div class="event-body">${escapeHtml(body).slice(0, 1000)}</div>
  `;
  eventLogEl.prepend(item);
}

function renderMemory(memory) {
  if (!memory?.exists) {
    memoryStatusEl.textContent = "No AGENTS.md uploaded.";
    memoryPreviewEl.textContent = "";
    return;
  }

  memoryStatusEl.textContent = `${memory.size_bytes || 0} bytes · ${memory.path}`;
  memoryPreviewEl.textContent = String(memory.content || "").trim() || "(empty AGENTS.md)";
}

function setAgentState(state, detail) {
  agentStateEl.textContent = state;
  runStatusBadgeEl.textContent = state;
  stateDetailEl.textContent = detail || "";
  agentStateEl.dataset.state = state.toLowerCase().replaceAll(" ", "-");
  runStatusBadgeEl.dataset.state = state.toLowerCase().replaceAll(" ", "-");
}

function setPromptOutput(value) {
  latestPromptJson = JSON.stringify(value, null, 2);
  promptOutputEl.textContent = latestPromptJson;
  copyPromptButtonEl.disabled = false;
}

function summarizeLlmRequest(request) {
  const messageCount = request?.messages?.length || 0;
  const toolCount = request?.tools?.length || 0;
  return `${messageCount} messages · ${toolCount} tools · ${request?.model || "unknown model"}`;
}

function removeEmptyState() {
  const emptyState = conversationEl.querySelector(".empty-state");
  if (emptyState) {
    emptyState.remove();
  }
}

function flashCopyButton(button) {
  const originalText = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = originalText;
  }, 1200);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

sendButtonEl.disabled = true;
connect();
loadTools();
loadSkills();
loadMcpServers();
loadPromptProfile();
loadMemory();
