<template>
  <div class="app-shell">
    <main class="chat-shell">
      <header class="chat-topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <img :src="anomaloIconUrl" alt="" />
          </div>
          <div class="brand-copy">
            <h1>Anomalo</h1>
            <p>Local harness</p>
          </div>
        </div>

        <nav class="app-nav" aria-label="Primary">
          <button
            class="nav-tab"
            :class="{ active: activeView === 'agent' }"
            type="button"
            @click="setActiveView('agent')"
          >
            Agent
          </button>
          <button
            class="nav-tab"
            :class="{ active: activeView === 'dashboard' }"
            type="button"
            @click="setActiveView('dashboard')"
          >
            Dashboard
          </button>
          <button
            class="nav-tab"
            :class="{ active: activeView === 'stock-analysis' }"
            type="button"
            @click="setActiveView('stock-analysis')"
          >
            Stock Analysis
          </button>
        </nav>

        <div class="header-actions">
          <span class="credits-chip" :class="openrouterCreditsClass" :title="openrouterCreditsTitle">
            <span class="status-dot" aria-hidden="true"></span>
            {{ openrouterCreditsLabel }}
          </span>
          <span id="connectionStatus" class="connection-chip" :class="connectionClass">
            <span class="status-dot" aria-hidden="true"></span>
            {{ connectionStatus }}
          </span>
          <button
            v-if="activeView === 'agent'"
            class="toolbar-button"
            type="button"
            title="Open agent inspector"
            aria-label="Open agent inspector"
            @click="inspectorOpen = true"
          >
            <PanelRightOpen :size="18" />
            <span>Inspector</span>
          </button>
          <button
            v-else-if="activeView === 'dashboard'"
            class="toolbar-button"
            type="button"
            title="Refresh dashboard"
            aria-label="Refresh dashboard"
            :disabled="buddyActionInFlight"
            @click="refreshDashboard"
          >
            <RefreshCw :size="17" />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      <section
        v-if="activeView === 'agent'"
        id="conversation"
        ref="conversationEl"
        class="conversation"
      >
        <div v-if="!conversationTurns.length" class="empty-state">
          <div class="empty-emblem" aria-hidden="true">
            <img :src="anomaloIconUrl" alt="" />
          </div>
          <h2>Ready when you are</h2>
          <p>Send a message to start.</p>
        </div>
        <template v-for="(turn, index) in conversationTurns" :key="`${turn.role}-${index}`">
          <article
            v-if="turn.role === 'activity'"
            class="activity-row"
            :class="[`activity-${turn.kind}`, `activity-${turn.status}`]"
            aria-live="polite"
          >
            <span class="activity-icon" aria-hidden="true">
              <LoaderCircle
                v-if="turn.status === 'running'"
                :size="18"
                class="activity-spinner"
              />
              <AlertTriangle v-else-if="turn.status === 'error'" :size="18" />
              <Wrench v-else-if="turn.kind === 'tool'" :size="18" />
              <Search v-else-if="turn.kind === 'context'" :size="18" />
              <CircleCheck v-else :size="18" />
            </span>
            <div class="activity-copy">
              <div class="activity-title">{{ turn.title }}</div>
              <div v-if="turn.body" class="activity-body">{{ turn.body }}</div>
            </div>
          </article>
          <article v-else class="message-row" :class="`message-row-${turn.role}`">
            <div
              v-if="turn.role === 'assistant'"
              class="message-bubble message-bubble-assistant markdown-body"
              v-html="turn.htmlContent"
            ></div>
            <div v-else class="message-bubble" :class="`message-bubble-${turn.role}`">
              {{ turn.content }}
            </div>
          </article>
        </template>
      </section>

      <section v-else-if="activeView === 'dashboard'" class="dashboard-view" aria-label="StackChan dashboard">
        <div class="dashboard-hero">
          <span>StackChan Server</span>
          <h2>Dashboard</h2>
          <p>Monitor Buddy transport, audio activity, recent events, and manual state triggers.</p>
        </div>

        <div class="dashboard-grid">
          <section class="dashboard-panel">
            <header>
              <span>Server Status</span>
              <strong>{{ buddyStatusLabel }}</strong>
            </header>
            <div class="metric-grid">
              <div v-for="metric in buddyStatusCards" :key="metric.label" class="metric">
                <span>{{ metric.label }}</span>
                <strong>{{ metric.value }}</strong>
              </div>
            </div>
            <p class="dashboard-note">{{ buddyDashboardStatus }}</p>
          </section>

          <section class="dashboard-panel">
            <header>
              <span>Admin Access</span>
              <strong>{{ managementTokenStatus }}</strong>
            </header>
            <form class="management-token-form" @submit.prevent="saveManagementToken">
              <input
                v-model="managementTokenInput"
                type="password"
                autocomplete="off"
                placeholder="Admin token"
                aria-label="Admin token"
              />
              <button class="control-button" type="submit">Save</button>
              <button
                class="control-button"
                type="button"
                :disabled="!managementToken"
                @click="clearManagementToken"
              >
                Clear
              </button>
            </form>
            <p class="dashboard-note">{{ managementTokenHint }}</p>
          </section>

          <section class="dashboard-panel">
            <header>
              <span>Manual Control</span>
              <strong>{{ buddyActionInFlight ? "Working" : "Ready" }}</strong>
            </header>
            <div class="control-row">
              <button class="control-button" type="button" :disabled="buddyActionInFlight" @click="connectBuddy">
                Connect
              </button>
              <button
                class="control-button"
                type="button"
                :disabled="buddyActionInFlight"
                @click="disconnectBuddy"
              >
                Disconnect
              </button>
            </div>
            <div class="state-actions">
              <button
                v-for="stateAction in buddyStateActions"
                :key="stateAction.state"
                class="state-action"
                type="button"
                :disabled="buddyActionInFlight"
                @click="sendBuddyState(stateAction.state)"
              >
                {{ stateAction.label }}
              </button>
            </div>
          </section>

          <section class="dashboard-panel dashboard-panel-wide">
            <header>
              <span>Recent Events</span>
              <strong>{{ buddyEvents.length }}</strong>
            </header>
            <div v-if="buddyEvents.length" class="dashboard-events">
              <article v-for="event in buddyEvents" :key="event.id" class="dashboard-event">
                <div>
                  <strong>{{ event.type }}</strong>
                  <span>{{ event.received_at || "unknown time" }}</span>
                </div>
                <pre>{{ summarizeBuddyEvent(event) }}</pre>
              </article>
            </div>
            <div v-else class="dashboard-empty">No Buddy events recorded.</div>
          </section>
        </div>
      </section>

      <section
        v-else-if="activeView === 'stock-analysis'"
        class="stock-analysis-view"
        aria-label="Stock Analysis"
      ></section>

      <form
        v-if="activeView === 'agent'"
        id="chatForm"
        class="composer"
        @submit.prevent="submitMessage"
      >
        <div class="composer-box">
          <div ref="composerActionsEl" class="composer-actions">
            <button
              class="composer-action-trigger"
              type="button"
              title="More actions"
              aria-label="More actions"
              aria-controls="composerActionDrawer"
              :aria-expanded="composerActionsOpen"
              @click="composerActionsOpen = !composerActionsOpen"
            >
              <Plus :size="19" />
            </button>
            <Transition name="composer-drawer">
              <div
                v-if="composerActionsOpen"
                id="composerActionDrawer"
                class="composer-action-drawer"
              >
                <button class="composer-action-item" type="button" @click="startNewConversation">
                  <RefreshCw :size="16" />
                  <span>New Chat</span>
                </button>
              </div>
            </Transition>
          </div>
          <textarea
            id="messageInput"
            ref="messageInputEl"
            class="composer-input"
            v-model="messageInput"
            placeholder="Message Anomalo"
            rows="1"
            @input="resizeComposer"
            @keydown="handleComposerKeydown"
          ></textarea>
          <span class="send-button-wrap" :data-tooltip="sendShortcutTooltip" :title="sendShortcutTooltip">
            <button
              id="sendButton"
              class="send-button"
              type="submit"
              :aria-label="`Send message (${SEND_SHORTCUT})`"
              :disabled="sendDisabled"
            >
              <SendHorizontal :size="19" />
            </button>
          </span>
        </div>
      </form>
    </main>

    <Transition name="fade">
      <button
        v-if="inspectorOpen"
        class="inspector-backdrop"
        type="button"
        aria-label="Close agent inspector"
        @click="inspectorOpen = false"
      ></button>
    </Transition>

    <Transition name="drawer">
      <aside v-if="inspectorOpen" class="inspector-drawer" aria-label="Agent inspector">
        <header class="drawer-header">
          <div>
            <span class="drawer-kicker">Agent Inspector</span>
            <h2>{{ runTitle }}</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            title="Close"
            aria-label="Close agent inspector"
            @click="inspectorOpen = false"
          >
            <X :size="18" />
          </button>
        </header>

        <div class="drawer-summary">
          <div>
            <span>State</span>
            <strong id="agentState" class="state-pill" :data-state="normalizedAgentState">
              {{ agentState }}
            </strong>
          </div>
          <div>
            <span>Run</span>
            <strong id="runId">{{ runId }}</strong>
          </div>
          <div>
            <span>Skills</span>
            <strong>{{ activeSkillCount }}/{{ skills.length }}</strong>
          </div>
          <div>
            <span>MCP</span>
            <strong>{{ activeMcpCount }}/{{ mcpServers.length }}</strong>
          </div>
        </div>

        <div id="stateDetail" class="state-detail">{{ stateDetail }}</div>

        <details class="drawer-card" open>
          <summary>
            <span>Session State</span>
            <SlidersHorizontal :size="16" />
          </summary>
          <div class="state-grid">
            <div>
              <span class="field-label">Profile</span>
              <strong id="promptProfile">{{ promptProfile }}</strong>
            </div>
            <div>
              <span class="field-label">Iteration</span>
              <strong id="iterationCount">{{ iterationCount }}</strong>
            </div>
            <div>
              <span class="field-label">Tools</span>
              <strong>{{ tools.length }}</strong>
            </div>
            <div>
              <span class="field-label">Events</span>
              <strong>{{ events.length }}</strong>
            </div>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>OpenRouter Credits</span>
            <button
              class="mini-icon-button"
              type="button"
              title="Refresh OpenRouter credits"
              aria-label="Refresh OpenRouter credits"
              :disabled="openrouterCreditsRefreshInFlight"
              @click.stop.prevent="refreshOpenRouterCredits"
            >
              <RefreshCw :size="15" />
              <span>{{ openrouterCreditsRefreshLabel }}</span>
            </button>
          </summary>
          <div class="state-grid">
            <div>
              <span class="field-label">Remaining</span>
              <strong>{{ openrouterCreditsRemainingText }}</strong>
            </div>
            <div>
              <span class="field-label">Total</span>
              <strong>{{ openrouterCreditsTotalText }}</strong>
            </div>
            <div>
              <span class="field-label">Used</span>
              <strong>{{ openrouterCreditsUsedText }}</strong>
            </div>
            <div>
              <span class="field-label">Updated</span>
              <strong>{{ openrouterCreditsUpdatedText }}</strong>
            </div>
          </div>
          <div class="panel-note">{{ openrouterCreditsMessage }}</div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Session Skills</span>
            <Layers3 :size="16" />
          </summary>
          <div id="skillStatus" class="panel-note">{{ skillStatus }}</div>
          <div id="skillList" class="stack-list">
            <label
              v-for="skill in skills"
              :key="skill.name"
              class="switch-card"
              :class="{ disabled: !skill.enabled }"
            >
              <input
                v-model="skill.active"
                type="checkbox"
                :data-skill-name="skill.name"
                :disabled="!skill.enabled || skillsUpdateInFlight"
                @change="updateSessionSkills"
              />
              <span class="switch-track" aria-hidden="true"></span>
              <span class="switch-card-body">
                <strong>{{ skill.display_name || skill.name }}</strong>
                <span>{{ skill.description || "No description" }}</span>
                <span>Use when: {{ skill.when_to_use || "No routing hint" }}</span>
                <span>{{ skill.tool_count || 0 }} tools</span>
              </span>
            </label>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Session MCP</span>
            <Database :size="16" />
          </summary>
          <div id="mcpStatus" class="panel-note">{{ mcpStatus }}</div>
          <div id="mcpList" class="stack-list">
            <label
              v-for="server in mcpServers"
              :key="server.name"
              class="switch-card"
              :class="{ disabled: !server.enabled }"
            >
              <input
                v-model="server.active"
                type="checkbox"
                :data-mcp-server-name="server.name"
                :disabled="!server.enabled || mcpUpdateInFlight"
                @change="updateSessionMcpServers"
              />
              <span class="switch-track" aria-hidden="true"></span>
              <span class="switch-card-body">
                <strong>{{ server.name }}</strong>
                <span>{{ server.description || "No description" }}</span>
                <span>Loads this MCP tool pack only for the current session.</span>
              </span>
            </label>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>AGENTS.md Memory</span>
            <Upload :size="16" />
          </summary>
          <form id="memoryForm" class="memory-form" @submit.prevent="uploadMemory">
            <input
              id="memoryFile"
              ref="memoryFileInput"
              type="file"
              accept=".md,text/markdown,text/plain"
            />
            <button
              id="memoryUploadButton"
              class="icon-button"
              type="submit"
              title="Upload memory"
              aria-label="Upload memory"
              :disabled="memoryUploadDisabled"
            >
              <Upload :size="16" />
            </button>
          </form>
          <div id="memoryStatus" class="panel-note">{{ memoryStatus }}</div>
          <pre id="memoryPreview" class="memory-preview">{{ memoryPreview }}</pre>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Context Assembly</span>
            <button
              id="copyMessagesButton"
              class="mini-icon-button"
              type="button"
              title="Copy messages"
              aria-label="Copy messages"
              :disabled="copyMessagesDisabled"
              @click.stop.prevent="copyMessages"
            >
              <Copy :size="15" />
              <span>{{ copyMessagesLabel }}</span>
            </button>
          </summary>
          <div id="contextStats" class="context-stats">
            <template v-if="contextStats.length">
              <div v-for="stat in contextStats" :key="stat.label" class="stat">
                <span>{{ stat.label }}</span>
                <strong>{{ stat.value }}</strong>
              </div>
            </template>
            <template v-else>
              <div class="empty-panel">No LLM request yet.</div>
            </template>
          </div>
          <div id="contextSegments" class="context-segments">
            <div
              v-for="segment in contextSegments"
              :key="segment.name"
              class="segment"
              :class="`segment-${segment.name}`"
            >
              {{ segment.label }}: [{{ segment.start }}, {{ segment.end }}) · {{ segment.count }}
            </div>
          </div>
          <div id="messageArray" class="message-array">
            <article
              v-for="message in contextMessages"
              :key="message.index"
              class="context-message"
              :class="`role-${message.role || 'unknown'}`"
            >
              <div class="context-message-header">
                <strong>#{{ message.index }} · {{ message.role || "unknown" }}</strong>
                <span>{{ message.source }}</span>
              </div>
              <pre>{{ message.summary }}</pre>
            </article>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Raw LLM Request</span>
            <button
              id="copyPromptButton"
              class="mini-icon-button"
              type="button"
              title="Copy prompt"
              aria-label="Copy prompt"
              :disabled="copyPromptDisabled"
              @click.stop.prevent="copyPrompt"
            >
              <Copy :size="15" />
              <span>{{ copyPromptLabel }}</span>
            </button>
          </summary>
          <pre id="promptOutput" class="prompt-output">{{ promptOutput }}</pre>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Tools</span>
            <Wrench :size="16" />
          </summary>
          <div id="toolList" class="stack-list">
            <div v-for="tool in tools" :key="`${tool.source}:${tool.name}`" class="tool">
              <div class="tool-name">{{ tool.name }}</div>
              <div class="tool-source">{{ tool.source }} · {{ tool.description || "" }}</div>
            </div>
          </div>
        </details>

        <details class="drawer-card">
          <summary>
            <span>Agent Events</span>
            <Activity :size="16" />
          </summary>
          <div id="eventLog" class="event-log">
            <div v-for="event in events" :key="event.id" class="event">
              <div class="event-title" :class="{ error: event.isError }">{{ event.title }}</div>
              <div class="event-body">{{ event.body }}</div>
            </div>
          </div>
        </details>
      </aside>
    </Transition>
  </div>
</template>

<script setup>
import {
  Activity,
  AlertTriangle,
  CircleCheck,
  Copy,
  Database,
  Layers3,
  LoaderCircle,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  SlidersHorizontal,
  Upload,
  Wrench,
  X,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import anomaloIconUrl from "./assets/anomalo-shrimp.png";

const SEND_SHORTCUT = "Alt+Enter";
const sendShortcutTooltip = SEND_SHORTCUT;

const sessionId = ref(loadSessionId());

const connectionStatus = ref("Disconnected");
const connectionClass = ref("error");
const sendDisabled = ref(true);
const socket = ref(null);
const reconnectTimer = ref(null);
const dashboardRefreshTimer = ref(null);
const creditsRefreshTimer = ref(null);
const shuttingDown = ref(false);
const inspectorOpen = ref(false);
const composerActionsOpen = ref(false);
const activeView = ref("agent");
const managementToken = ref(loadManagementToken());
const managementTokenInput = ref(managementToken.value);
const managementAccessRequired = ref(false);

const tools = ref([]);
const events = ref([]);
const eventSequence = ref(0);
const conversationTurns = ref([]);
const activeAssistantIndex = ref(null);
const activeThinkingActivityIndex = ref(null);
const activeToolActivityIndexes = new Map();
const markdownRenderTimers = new Map();
const conversationEl = ref(null);
const composerActionsEl = ref(null);
const messageInputEl = ref(null);
const messageInput = ref("");

const MARKDOWN_RENDER_INTERVAL_MS = 160;
const CREDITS_REFRESH_INTERVAL_MS = 82800000;

const openrouterCredits = ref(null);
const openrouterCreditsStatus = ref("loading");
const openrouterCreditsMessage = ref("Loading OpenRouter credits...");
const openrouterCreditsRefreshInFlight = ref(false);

const promptOutput = ref("Loading prompt profile...");
const latestPromptJson = ref("");
const latestMessagesJson = ref("");
const copyPromptDisabled = ref(true);
const copyMessagesDisabled = ref(true);
const copyPromptLabel = ref("Copy");
const copyMessagesLabel = ref("Copy Messages");

const agentState = ref("Idle");
const runStatus = ref("Idle");
const runId = ref("none");
const promptProfile = ref("default");
const iterationCount = ref("0");
const stateDetail = ref("Waiting for input.");
const runTitle = ref("Ready");
const contextStats = ref([]);
const contextSegments = ref([]);
const contextMessages = ref([]);

const skills = ref([]);
const skillStatus = ref("Loading skills...");
const skillsUpdateInFlight = ref(false);
const mcpServers = ref([]);
const mcpStatus = ref("Loading MCP servers...");
const mcpUpdateInFlight = ref(false);

const memoryFileInput = ref(null);
const memoryStatus = ref("No memory loaded.");
const memoryPreview = ref("");
const memoryUploadDisabled = ref(false);

const buddyStatus = ref(null);
const buddyEvents = ref([]);
const buddyDashboardStatus = ref("Dashboard idle.");
const buddyActionInFlight = ref(false);
const buddyStateActions = [
  { state: "idle", label: "Idle" },
  { state: "listening", label: "Listen" },
  { state: "thinking", label: "Think" },
  { state: "speaking", label: "Speak" },
  { state: "done", label: "Done" },
  { state: "stop", label: "Stop" },
];

const normalizedAgentState = computed(() => normalizeState(agentState.value));
const normalizedRunStatus = computed(() => normalizeState(runStatus.value));
const activeSkillCount = computed(() => skills.value.filter((skill) => skill.active).length);
const activeMcpCount = computed(() => mcpServers.value.filter((server) => server.active).length);
const openrouterCreditsLabel = computed(() => {
  const remaining = openrouterCredits.value?.remaining_credits;
  if (openrouterCreditsStatus.value === "ready" || openrouterCreditsStatus.value === "stale") {
    return typeof remaining === "number" ? `Credits $${remaining.toFixed(2)}` : "Credits ?";
  }
  if (openrouterCreditsStatus.value === "loading") {
    return "Credits ...";
  }
  return "Credits --";
});
const openrouterCreditsClass = computed(() => {
  if (openrouterCreditsStatus.value === "ready") {
    return "ok";
  }
  if (openrouterCreditsStatus.value === "error") {
    return "error";
  }
  return "muted";
});
const openrouterCreditsTitle = computed(() => {
  const credits = openrouterCredits.value;
  if (!credits) {
    return openrouterCreditsMessage.value;
  }
  const parts = [openrouterCreditsMessage.value];
  if (typeof credits.total_credits === "number") {
    parts.push(`Total: $${credits.total_credits.toFixed(2)}`);
  }
  if (typeof credits.total_usage === "number") {
    parts.push(`Used: $${credits.total_usage.toFixed(2)}`);
  }
  if (credits.updated_at) {
    parts.push(`Updated: ${new Date(credits.updated_at).toLocaleString()}`);
  }
  return parts.join(" · ");
});
const openrouterCreditsRefreshLabel = computed(() =>
  openrouterCreditsRefreshInFlight.value ? "Refreshing" : "Refresh",
);
const openrouterCreditsRemainingText = computed(() =>
  formatCurrency(openrouterCredits.value?.remaining_credits),
);
const openrouterCreditsTotalText = computed(() =>
  formatCurrency(openrouterCredits.value?.total_credits),
);
const openrouterCreditsUsedText = computed(() => formatCurrency(openrouterCredits.value?.total_usage));
const openrouterCreditsUpdatedText = computed(() => {
  const updatedAt = openrouterCredits.value?.updated_at;
  if (!updatedAt) {
    return "--";
  }
  return new Date(updatedAt).toLocaleString();
});
const buddyStatusLabel = computed(() => {
  if (!buddyStatus.value) {
    return "Unknown";
  }
  if (buddyStatus.value.connected) {
    return "Connected";
  }
  if (buddyStatus.value.listening) {
    return "Listening";
  }
  return "Offline";
});
const buddyStatusCards = computed(() => {
  const status = buddyStatus.value || {};
  return [
    { label: "Connection", value: buddyStatusLabel.value },
    { label: "Transport", value: status.transport || "none" },
    { label: "Client", value: status.client_address || status.tcp_client_ip || "none" },
    { label: "Audio", value: status.audio_input_active ? "active" : "idle" },
    { label: "Queued", value: String(status.queued_audio_turns ?? 0) },
    { label: "Events", value: String(status.recent_event_count ?? buddyEvents.value.length) },
  ];
});
const managementTokenStatus = computed(() => (managementToken.value ? "Token saved" : "Token missing"));
const managementTokenHint = computed(() => {
  if (managementAccessRequired.value && !managementToken.value) {
    return "Remote dashboard access needs an admin token.";
  }
  if (managementAccessRequired.value) {
    return "Saved token was rejected by the server.";
  }
  if (managementToken.value) {
    return "Token saved in this browser.";
  }
  return "Set ANOMALO_ADMIN_TOKEN, then save it here.";
});

onMounted(() => {
  sendDisabled.value = true;
  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("pointerdown", handleGlobalPointerdown);
  connect();
  void loadTools();
  void loadSkills();
  void loadMcpServers();
  void loadPromptProfile();
  void loadMemory();
  void loadOpenRouterCredits();
  void refreshDashboard();
  creditsRefreshTimer.value = setInterval(() => {
    void loadOpenRouterCredits({ silent: true });
  }, CREDITS_REFRESH_INTERVAL_MS);
  dashboardRefreshTimer.value = setInterval(() => {
    if (activeView.value === "dashboard" && !buddyActionInFlight.value) {
      void pollDashboard();
    }
  }, 10000);
});

onBeforeUnmount(() => {
  shuttingDown.value = true;
  document.removeEventListener("keydown", handleGlobalKeydown);
  document.removeEventListener("pointerdown", handleGlobalPointerdown);
  clearTimeout(reconnectTimer.value);
  clearInterval(dashboardRefreshTimer.value);
  clearInterval(creditsRefreshTimer.value);
  clearMarkdownRenderTimers();
  socket.value?.close();
});

function handleGlobalKeydown(event) {
  if (event.key === "Escape") {
    inspectorOpen.value = false;
    composerActionsOpen.value = false;
  }
}

function handleGlobalPointerdown(event) {
  if (!composerActionsOpen.value) {
    return;
  }
  if (composerActionsEl.value?.contains(event.target)) {
    return;
  }
  composerActionsOpen.value = false;
}

function setActiveView(view) {
  activeView.value = view;
  inspectorOpen.value = false;
  composerActionsOpen.value = false;
  if (view === "dashboard") {
    void refreshDashboard();
  }
}

function loadManagementToken() {
  return localStorage.getItem("anomalo.adminToken") || "";
}

function saveManagementToken() {
  const nextToken = managementTokenInput.value.trim();
  managementToken.value = nextToken;
  managementAccessRequired.value = false;
  if (nextToken) {
    localStorage.setItem("anomalo.adminToken", nextToken);
    buddyDashboardStatus.value = "Admin token saved.";
  } else {
    localStorage.removeItem("anomalo.adminToken");
    buddyDashboardStatus.value = "Admin token cleared.";
  }
  if (activeView.value === "dashboard") {
    void refreshDashboard();
  }
}

function clearManagementToken() {
  managementTokenInput.value = "";
  saveManagementToken();
}

function loadSessionId() {
  const existing = localStorage.getItem("anomalo.session");
  if (existing) {
    return existing;
  }
  const generated = createSessionId();
  localStorage.setItem("anomalo.session", generated);
  return generated;
}

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

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const nextSocket = new WebSocket(`${protocol}://${location.host}/ws/chat/${sessionId.value}`);
  socket.value = nextSocket;

  nextSocket.addEventListener("open", () => {
    if (socket.value !== nextSocket) {
      return;
    }
    connectionStatus.value = "Connected";
    connectionClass.value = "ok";
    sendDisabled.value = false;
    setAgentState("Idle", "Connected. Waiting for input.");
  });

  nextSocket.addEventListener("close", () => {
    if (socket.value !== nextSocket || shuttingDown.value) {
      return;
    }
    connectionStatus.value = "Disconnected";
    connectionClass.value = "error";
    sendDisabled.value = true;
    setAgentState("Offline", "WebSocket disconnected. Reconnecting...");
    clearTimeout(reconnectTimer.value);
    reconnectTimer.value = setTimeout(connect, 1000);
  });

  nextSocket.addEventListener("message", (message) => {
    if (socket.value !== nextSocket) {
      return;
    }
    try {
      handleAgentEvent(JSON.parse(message.data));
    } catch (error) {
      addEventLog("ws.error", String(error), true);
    }
  });
}

async function loadTools() {
  const currentSessionId = sessionId.value;
  try {
    const response = await fetch(`/api/tools?session_id=${encodeURIComponent(currentSessionId)}`);
    const data = await response.json();
    if (sessionId.value !== currentSessionId) {
      return;
    }
    tools.value = data.tools || [];
  } catch (error) {
    addEventLog("tools.error", String(error), true);
  }
}

async function loadSkills() {
  const currentSessionId = sessionId.value;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/skills`);
    const data = await response.json();
    if (sessionId.value !== currentSessionId) {
      return;
    }
    renderSkills(data.skills || []);
  } catch (error) {
    skillStatus.value = `Skill load failed: ${error}`;
  }
}

async function loadMcpServers() {
  const currentSessionId = sessionId.value;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/mcp`);
    const data = await response.json();
    if (sessionId.value !== currentSessionId) {
      return;
    }
    renderMcpServers(data.servers || []);
  } catch (error) {
    mcpStatus.value = `MCP load failed: ${error}`;
  }
}

async function loadPromptProfile() {
  try {
    const response = await fetch("/api/prompts");
    const data = await response.json();
    promptProfile.value = data.profile || "default";
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
    memoryStatus.value = `Memory load failed: ${error}`;
  }
}

async function loadOpenRouterCredits({ silent = false, force = false } = {}) {
  if (!silent) {
    openrouterCreditsStatus.value = "loading";
    openrouterCreditsMessage.value = "Loading OpenRouter credits...";
  }

  try {
    const payload = await fetchJson(force ? "/api/openrouter/credits?force=true" : "/api/openrouter/credits");
    openrouterCredits.value = payload.configured ? payload : null;
    openrouterCreditsStatus.value = payload.status || "error";
    openrouterCreditsMessage.value = openrouterCreditsMessageFor(payload);
  } catch (error) {
    openrouterCreditsStatus.value = "error";
    openrouterCreditsMessage.value = `OpenRouter credits failed: ${formatError(error)}`;
  }
}

async function refreshOpenRouterCredits() {
  openrouterCreditsRefreshInFlight.value = true;
  try {
    await loadOpenRouterCredits({ force: true });
  } finally {
    openrouterCreditsRefreshInFlight.value = false;
  }
}

function openrouterCreditsMessageFor(payload) {
  if (payload.status === "ready") {
    return payload.cached ? "OpenRouter credits cached." : "OpenRouter credits updated.";
  }
  if (payload.status === "stale") {
    return payload.message || "OpenRouter credits are stale.";
  }
  if (payload.status === "config_missing") {
    return payload.message || "OpenRouter management key is not configured.";
  }
  return payload.message || "OpenRouter credits unavailable.";
}

function formatCurrency(value) {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "--";
}

async function refreshDashboard() {
  buddyActionInFlight.value = true;
  buddyDashboardStatus.value = "Refreshing Buddy dashboard...";
  try {
    await Promise.all([loadBuddyStatus(), loadBuddyEvents()]);
    managementAccessRequired.value = false;
    buddyDashboardStatus.value = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    markManagementAccessError(error);
    buddyDashboardStatus.value = `Dashboard refresh failed: ${formatError(error)}`;
  } finally {
    buddyActionInFlight.value = false;
  }
}

async function pollDashboard() {
  try {
    await Promise.all([loadBuddyStatus(), loadBuddyEvents()]);
    managementAccessRequired.value = false;
    buddyDashboardStatus.value = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    markManagementAccessError(error);
    buddyDashboardStatus.value = `Dashboard refresh failed: ${formatError(error)}`;
  }
}

async function loadBuddyStatus() {
  const payload = await fetchJson("/api/buddy/status");
  buddyStatus.value = payload;
}

async function loadBuddyEvents() {
  const payload = await fetchJson("/api/buddy/events?limit=30");
  buddyEvents.value = payload.events || [];
}

async function connectBuddy() {
  await runBuddyAction("Connecting Buddy...", async () => {
    buddyStatus.value = await fetchJson("/api/buddy/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  });
}

async function disconnectBuddy() {
  await runBuddyAction("Disconnecting Buddy...", async () => {
    buddyStatus.value = await fetchJson("/api/buddy/disconnect", { method: "POST" });
  });
}

async function sendBuddyState(state) {
  await runBuddyAction(`Sending ${state} state...`, async () => {
    buddyStatus.value = await fetchJson("/api/buddy/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
  });
}

async function runBuddyAction(progressMessage, action) {
  buddyActionInFlight.value = true;
  buddyDashboardStatus.value = progressMessage;
  try {
    await action();
    await loadBuddyEvents();
    managementAccessRequired.value = false;
    buddyDashboardStatus.value = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    markManagementAccessError(error);
    buddyDashboardStatus.value = formatError(error);
  } finally {
    buddyActionInFlight.value = false;
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, withManagementAccess(url, options));
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON from ${url}: ${error}`);
    }
  }
  if (!response.ok) {
    const error = new Error(payload.detail || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.detail = payload.detail;
    throw error;
  }
  return payload;
}

function withManagementAccess(url, options = {}) {
  if (!requiresManagementAccess(url) || !managementToken.value) {
    return options;
  }
  const headers = new Headers(options.headers || {});
  headers.set("X-Anomalo-Admin-Token", managementToken.value);
  return { ...options, headers };
}

function requiresManagementAccess(url) {
  return url.startsWith("/api/buddy") || url.startsWith("/api/manage") || url.startsWith("/api/copilot-hooks");
}

function markManagementAccessError(error) {
  if (isManagementAccessError(error)) {
    managementAccessRequired.value = true;
  }
}

function isManagementAccessError(error) {
  return (
    error?.status === 403 &&
    String(error?.detail || error?.message || "").includes("Management API requires")
  );
}

function submitMessage() {
  const content = messageInput.value.trim();
  if (!content || socket.value?.readyState !== WebSocket.OPEN) {
    return;
  }

  conversationTurns.value.push({ role: "user", content });
  messageInput.value = "";
  void nextTick(resizeComposer);
  activeAssistantIndex.value = null;
  activeThinkingActivityIndex.value = null;
  activeToolActivityIndexes.clear();
  setAgentState("Queued", "Message sent. Waiting for run start.");
  socket.value.send(JSON.stringify({ type: "user.message", content }));
  void scrollConversation();
}

function startNewConversation() {
  composerActionsOpen.value = false;
  clearTimeout(reconnectTimer.value);
  clearMarkdownRenderTimers();

  const previousSocket = socket.value;
  socket.value = null;
  previousSocket?.close();

  const nextSessionId = createSessionId();
  sessionId.value = nextSessionId;
  localStorage.setItem("anomalo.session", nextSessionId);

  resetConversationState();
  connectionStatus.value = "Connecting";
  connectionClass.value = "muted";
  sendDisabled.value = true;
  connect();
  void loadTools();
  void loadSkills();
  void loadMcpServers();
  void nextTick(() => messageInputEl.value?.focus());
}

function resetConversationState() {
  messageInput.value = "";
  conversationTurns.value = [];
  activeAssistantIndex.value = null;
  activeThinkingActivityIndex.value = null;
  activeToolActivityIndexes.clear();
  events.value = [];
  eventSequence.value = 0;
  runId.value = "none";
  runTitle.value = "Ready";
  iterationCount.value = "0";
  latestMessagesJson.value = "";
  copyMessagesDisabled.value = true;
  contextStats.value = [];
  contextSegments.value = [];
  contextMessages.value = [];
  tools.value = [];
  skills.value = [];
  mcpServers.value = [];
  skillStatus.value = "Loading skills...";
  mcpStatus.value = "Loading MCP servers...";
  setAgentState("Idle", "New conversation ready.");
  void nextTick(resizeComposer);
}

function handleComposerKeydown(event) {
  if (event.key === "Enter" && event.altKey && !event.isComposing) {
    event.preventDefault();
    submitMessage();
  }
}

function resizeComposer() {
  const input = messageInputEl.value;
  if (!input) {
    return;
  }
  input.style.height = "42px";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

async function uploadMemory() {
  const file = memoryFileInput.value?.files?.[0];
  if (!file) {
    memoryStatus.value = "Choose an AGENTS.md file first.";
    return;
  }

  memoryUploadDisabled.value = true;
  memoryStatus.value = "Uploading memory...";
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
    memoryFileInput.value.value = "";
  } catch (error) {
    memoryStatus.value = `Memory upload failed: ${error}`;
  } finally {
    memoryUploadDisabled.value = false;
  }
}

async function copyPrompt() {
  await copyToClipboard(latestPromptJson.value, copyPromptLabel, "Copy");
}

async function copyMessages() {
  await copyToClipboard(latestMessagesJson.value, copyMessagesLabel, "Copy Messages");
}

async function copyToClipboard(value, labelRef, defaultText) {
  if (!value) {
    return;
  }
  await navigator.clipboard.writeText(value);
  labelRef.value = "Copied";
  setTimeout(() => {
    labelRef.value = defaultText;
  }, 1200);
}

function handleAgentEvent(event) {
  switch (event.type) {
    case "run.started":
      runId.value = event.run_id;
      runTitle.value = "Running";
      setAgentState("Thinking", "Building context and preparing tools.");
      addEventLog("run.started", event.run_id);
      break;
    case "llm.request":
      renderLlmRequest(event.data.request, event.data.context, event.data.iteration);
      setAgentState("LLM Request", summarizeLlmRequest(event.data.request));
      activeThinkingActivityIndex.value = addConversationActivity({
        kind: "thinking",
        status: "running",
        title: "正在思考",
        body: summarizeLlmRequest(event.data.request),
      });
      addEventLog("llm.request", summarizeLlmRequest(event.data.request));
      break;
    case "message.delta":
      finishThinkingActivity({
        status: "done",
        title: "已开始回答",
      });
      appendAssistantContent(event.data.content || "");
      setAgentState("Streaming", "Receiving assistant output.");
      break;
    case "message.done":
      flushMarkdownRender(activeAssistantIndex.value);
      activeAssistantIndex.value = null;
      setAgentState("Finalizing", "Assistant message completed.");
      break;
    case "tool.started":
      flushMarkdownRender(activeAssistantIndex.value);
      activeAssistantIndex.value = null;
      finishThinkingActivity({
        status: "done",
        title: "已决定使用工具",
      });
      setAgentState("Tool", event.data.tool || "Tool call started.");
      activeToolActivityIndexes.set(
        event.data.tool || "tool",
        addConversationActivity({
          kind: "tool",
          status: "running",
          title: `正在使用 ${event.data.tool || "工具"}`,
          body: summarizeToolArguments(event.data.arguments),
        }),
      );
      addEventLog(`tool.started · ${event.data.tool}`, JSON.stringify(event.data.arguments || {}));
      break;
    case "tool.finished":
      setAgentState("Tool Result", event.data.tool || "Tool call finished.");
      updateToolActivity(event.data.tool || "tool", {
        status: "done",
        title: `已使用 ${event.data.tool || "工具"}`,
        body: summarizeToolResult(event.data.content),
      });
      addEventLog(`tool.finished · ${event.data.tool}`, event.data.content || "");
      if (event.data.data?.skill_action) {
        void loadSkills();
        void loadTools();
      }
      if (event.data.data?.mcp_action) {
        void loadMcpServers();
        void loadTools();
      }
      break;
    case "tool.error":
      updateToolActivity(event.data.tool || "tool", {
        status: "error",
        title: `${event.data.tool || "工具"} 失败`,
        body: summarizeToolResult(event.data.content),
      });
      setAgentState("Tool Error", event.data.content || "Tool call failed.");
      addEventLog(event.type, event.data.content || "tool error", true);
      break;
    case "run.error":
      runTitle.value = "Error";
      flushMarkdownRender(activeAssistantIndex.value);
      activeAssistantIndex.value = null;
      finishThinkingActivity({
        status: "error",
        title: "思考中断",
        body: event.data.error || "Run error.",
      });
      activeToolActivityIndexes.clear();
      setAgentState("Error", event.data.error || "Run error.");
      addEventLog(event.type, event.data.error || "error", true);
      break;
    case "run.finished":
      runTitle.value = "Complete";
      reconcileFinalAssistantContent(event.data.final_text || "");
      finishThinkingActivity({
        status: "done",
        title: "已完成思考",
      });
      activeToolActivityIndexes.clear();
      setAgentState("Done", "Run finished.");
      addEventLog("run.finished", "done");
      void loadTools();
      void loadSkills();
      void loadMcpServers();
      break;
    default:
      addEventLog(event.type, JSON.stringify(event.data || {}));
  }
}

async function updateSessionSkills() {
  skillsUpdateInFlight.value = true;
  skillStatus.value = "Updating session skills...";
  const activeSkills = skills.value.filter((skill) => skill.active).map((skill) => skill.name);

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId.value)}/skills`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_skills: activeSkills }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "Skill update failed.");
    }
    renderSkills(payload.skills || []);
    void loadTools();
  } catch (error) {
    skillStatus.value = `Skill update failed: ${error}`;
    void loadSkills();
  } finally {
    skillsUpdateInFlight.value = false;
  }
}

async function updateSessionMcpServers() {
  mcpUpdateInFlight.value = true;
  mcpStatus.value = "Updating session MCP servers...";
  const activeServers = mcpServers.value
    .filter((server) => server.active)
    .map((server) => server.name);

  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId.value)}/mcp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active_servers: activeServers }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "MCP update failed.");
    }
    renderMcpServers(payload.servers || []);
    void loadTools();
  } catch (error) {
    mcpStatus.value = `MCP update failed: ${error}`;
    void loadMcpServers();
  } finally {
    mcpUpdateInFlight.value = false;
  }
}

function renderSkills(nextSkills) {
  skills.value = nextSkills;

  if (!nextSkills.length) {
    skillStatus.value = "No skills configured.";
    return;
  }

  const activeCount = nextSkills.filter((skill) => skill.active).length;
  skillStatus.value = `${activeCount} active · ${nextSkills.length} available`;
}

function renderMcpServers(servers) {
  mcpServers.value = servers;

  if (!servers.length) {
    mcpStatus.value = "No MCP servers configured.";
    return;
  }

  const activeCount = servers.filter((server) => server.active).length;
  mcpStatus.value = `${activeCount} active · ${servers.length} available`;
}

function addConversationActivity({ kind, status, title, body = "" }) {
  const index =
    conversationTurns.value.push({
      role: "activity",
      kind,
      status,
      title,
      body,
    }) - 1;
  void scrollConversation();
  return index;
}

function updateConversationActivity(index, updates) {
  if (typeof index !== "number") {
    return;
  }
  const turn = conversationTurns.value[index];
  if (!turn || turn.role !== "activity") {
    return;
  }
  conversationTurns.value[index] = {
    ...turn,
    ...updates,
  };
  void scrollConversation();
}

function finishThinkingActivity(updates) {
  if (typeof activeThinkingActivityIndex.value === "number") {
    updateConversationActivity(activeThinkingActivityIndex.value, updates);
    activeThinkingActivityIndex.value = null;
    return;
  }

  const fallbackIndex = findLatestRunningThinkingActivityIndex();
  if (typeof fallbackIndex === "number") {
    updateConversationActivity(fallbackIndex, updates);
  }
  activeThinkingActivityIndex.value = null;
}

function findLatestRunningThinkingActivityIndex() {
  const latestUserIndex = findLatestUserTurnIndex();
  for (let index = conversationTurns.value.length - 1; index > latestUserIndex; index -= 1) {
    const turn = conversationTurns.value[index];
    if (turn?.role === "activity" && turn.kind === "thinking" && turn.status === "running") {
      return index;
    }
  }
  return null;
}

function updateToolActivity(toolName, updates) {
  const key = toolName || "tool";
  const index = activeToolActivityIndexes.get(key);
  if (typeof index === "number") {
    updateConversationActivity(index, updates);
    activeToolActivityIndexes.delete(key);
    return;
  }
  addConversationActivity({
    kind: "tool",
    ...updates,
  });
}

function appendAssistantContent(content) {
  if (activeAssistantIndex.value === null) {
    activeAssistantIndex.value =
      conversationTurns.value.push({ role: "assistant", content: "", htmlContent: "" }) - 1;
  }
  conversationTurns.value[activeAssistantIndex.value].content += content;
  scheduleMarkdownRender(activeAssistantIndex.value);
  void scrollConversation();
}

function reconcileFinalAssistantContent(content) {
  const finalContent = String(content || "");

  if (typeof activeAssistantIndex.value === "number") {
    if (finalContent) {
      setAssistantContent(activeAssistantIndex.value, finalContent);
    } else {
      flushMarkdownRender(activeAssistantIndex.value);
    }
    activeAssistantIndex.value = null;
    return;
  }

  if (!finalContent) {
    return;
  }

  const currentAssistantIndex = findLatestAssistantTurnIndexAfterLatestUser();
  if (typeof currentAssistantIndex === "number") {
    const turn = conversationTurns.value[currentAssistantIndex];
    if (turn.content === finalContent) {
      flushMarkdownRender(currentAssistantIndex);
      return;
    }
    if (!turn.content || finalContent.startsWith(turn.content)) {
      setAssistantContent(currentAssistantIndex, finalContent);
    } else {
      flushMarkdownRender(currentAssistantIndex);
    }
    return;
  }

  conversationTurns.value.push({
    role: "assistant",
    content: finalContent,
    htmlContent: renderMarkdown(finalContent),
  });
  void scrollConversation();
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

  const timer = markdownRenderTimers.get(index);
  if (timer) {
    clearTimeout(timer);
    markdownRenderTimers.delete(index);
  }

  conversationTurns.value[index] = {
    ...turn,
    content,
    htmlContent: renderMarkdown(content),
  };
  void scrollConversation();
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

  const timer = markdownRenderTimers.get(index);
  if (timer) {
    clearTimeout(timer);
    markdownRenderTimers.delete(index);
  }
  renderConversationMarkdown(index);
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
    htmlContent: renderMarkdown(turn.content),
  };
  void scrollConversation();
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
  contextStats.value = [
    { label: "Prompt Parts", value: messages.length },
    { label: "Prompt", value: context?.prompt_message_count ?? 0 },
    { label: "Memory", value: context?.memory_message_count ?? 0 },
    { label: "Skills", value: context?.active_skill_count ?? 0 },
    { label: "MCP", value: context?.active_mcp_server_count ?? 0 },
    { label: "History", value: context?.history_message_count ?? 0 },
    { label: "Tools", value: context?.tool_count ?? request?.tools?.length ?? 0 },
  ];
}

function renderContextSegments(context) {
  contextSegments.value = context?.segments || [];
}

function renderMessageArray(messages, context) {
  contextMessages.value = messages.map((message, index) => ({
    index,
    role: message.role || "unknown",
    source: sourceForIndex(index, context),
    summary: summarizeMessageContent(message),
  }));
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
      typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2),
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

function renderMarkdown(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n");
  if (!text.trim()) {
    return "";
  }

  const lines = text.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = matchCodeFence(line);
    if (fence) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence.marker)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const languageClass = fence.language ? ` class="language-${escapeAttribute(fence.language)}"` : "";
      blocks.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    if (isMarkdownTable(lines, index)) {
      const table = renderMarkdownTable(lines, index);
      blocks.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const list = matchListItem(line);
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      const items = [];
      while (index < lines.length) {
        const item = matchListItem(lines[index]);
        if (!item || item.ordered !== list.ordered) {
          break;
        }
        items.push(`<li>${renderInlineMarkdown(item.content.trim())}</li>`);
        index += 1;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (paragraphLines.length) {
      blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(" "))}</p>`);
      continue;
    }

    blocks.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
    index += 1;
  }

  return blocks.join("");
}

function renderInlineMarkdown(value) {
  const codeTokens = [];
  const linkTokens = [];
  let html = String(value);

  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_match, label, url) => {
    const token = `\u0000LINK${linkTokens.length}\u0000`;
    linkTokens.push(
      `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`,
    );
    return token;
  });

  html = escapeHtml(html);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");

  return html
    .replace(/\u0000CODE(\d+)\u0000/g, (_match, tokenIndex) => codeTokens[Number(tokenIndex)] || "")
    .replace(/\u0000LINK(\d+)\u0000/g, (_match, tokenIndex) => linkTokens[Number(tokenIndex)] || "");
}

function renderMarkdownTable(lines, startIndex) {
  const headers = splitMarkdownTableRow(lines[startIndex]);
  const alignments = splitMarkdownTableRow(lines[startIndex + 1]).map(tableAlignment);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].trim().includes("|")) {
    rows.push(splitMarkdownTableRow(lines[index]));
    index += 1;
  }

  const headerHtml = headers
    .map((cell, cellIndex) => {
      const attrs = tableCellAttributes(alignments[cellIndex]);
      return `<th${attrs}>${renderInlineMarkdown(cell)}</th>`;
    })
    .join("");
  const bodyHtml = rows
    .map((row) => {
      const cells = headers
        .map((_, cellIndex) => {
          const attrs = tableCellAttributes(alignments[cellIndex]);
          return `<td${attrs}>${renderInlineMarkdown(row[cellIndex] || "")}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return {
    html: `<div class="markdown-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: index,
  };
}

function isMarkdownBlockStart(lines, index) {
  const line = lines[index] || "";
  return (
    Boolean(matchCodeFence(line)) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    Boolean(matchListItem(line)) ||
    isMarkdownTable(lines, index)
  );
}

function matchCodeFence(line) {
  const match = line.trim().match(/^(```|~~~)\s*([A-Za-z0-9_-]+)?\s*$/);
  if (!match) {
    return null;
  }
  return {
    marker: match[1],
    language: match[2] || "",
  };
}

function matchListItem(line) {
  const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unordered) {
    return { ordered: false, content: unordered[1] };
  }
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) {
    return { ordered: true, content: ordered[1] };
  }
  return null;
}

function isMarkdownTable(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|")) {
    return false;
  }
  const headers = splitMarkdownTableRow(lines[index]);
  const divider = splitMarkdownTableRow(lines[index + 1]);
  return headers.length > 1 && divider.length === headers.length && divider.every(isMarkdownTableDividerCell);
}

function splitMarkdownTableRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|")) {
    row = row.slice(0, -1);
  }
  return row.split("|").map((cell) => cell.trim());
}

function isMarkdownTableDividerCell(cell) {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function tableAlignment(cell) {
  const value = cell.trim();
  if (/^:-{3,}:$/.test(value)) {
    return "center";
  }
  if (/^-{3,}:$/.test(value)) {
    return "right";
  }
  if (/^:-{3,}$/.test(value)) {
    return "left";
  }
  return "";
}

function tableCellAttributes(alignment) {
  return alignment ? ` style="text-align: ${alignment}"` : "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function addEventLog(title, body, isError = false) {
  events.value.unshift({
    id: eventSequence.value++,
    title,
    body: String(body).slice(0, 1000),
    isError,
  });
}

function renderMemory(memory) {
  if (!memory?.exists) {
    memoryStatus.value = "No AGENTS.md uploaded.";
    memoryPreview.value = "";
    return;
  }

  memoryStatus.value = `${memory.size_bytes || 0} bytes · ${memory.path}`;
  memoryPreview.value = String(memory.content || "").trim() || "(empty AGENTS.md)";
}

function setAgentState(state, detail) {
  agentState.value = state;
  runStatus.value = state;
  stateDetail.value = detail || "";
}

function setPromptOutput(value) {
  latestPromptJson.value = JSON.stringify(value, null, 2);
  promptOutput.value = latestPromptJson.value;
  copyPromptDisabled.value = false;
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
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function summarizeBuddyEvent(event) {
  const payload = event?.payload || {};
  const summary = Object.keys(payload).length ? JSON.stringify(payload, null, 2) : event?.raw || "";
  return summary || "No payload.";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function scrollConversation() {
  await nextTick();
  if (conversationEl.value) {
    conversationEl.value.scrollTop = conversationEl.value.scrollHeight;
  }
}

function normalizeState(state) {
  return state.toLowerCase().replaceAll(" ", "-");
}
</script>
