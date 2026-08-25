<template>
  <div class="app-shell">
    <main class="chat-shell">
      <header class="chat-topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <img :src="anomaloharisIconUrl" alt="" />
          </div>
          <div class="brand-copy">
            <h1>AnomaloHaris</h1>
            <p>A Caris · Local Harness</p>
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
            :class="{ active: activeView === 'buddy' }"
            type="button"
            @click="setActiveView('buddy')"
          >
            Buddy
          </button>
          <button
            class="nav-tab"
            :class="{ active: activeView === 'preset-agents' }"
            type="button"
            @click="setActiveView('preset-agents')"
          >
            Preset Models
          </button>
          <button
            class="nav-tab"
            :class="{ active: activeView === 'workflows' }"
            type="button"
            @click="setActiveView('workflows')"
          >
            Workflows
          </button>
          <button
            class="nav-tab"
            :class="{ active: activeView === 'dashboard' }"
            type="button"
            @click="setActiveView('dashboard')"
          >
            Plugins
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
            title="Open conversation history"
            aria-label="Open conversation history"
            @click="toggleHistory"
          >
            <History :size="18" />
            <span>History</span>
          </button>
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
            @click="refreshDashboard"
          >
            <RefreshCw :size="17" />
            <span>Refresh</span>
          </button>
          <button
            v-else-if="activeView === 'buddy'"
            class="toolbar-button"
            type="button"
            title="Refresh Buddy dashboard"
            aria-label="Refresh Buddy dashboard"
            @click="refreshBuddyDashboard"
          >
            <RefreshCw :size="17" />
            <span>Refresh</span>
          </button>
          <button
            v-else-if="activeView === 'workflows'"
            class="toolbar-button"
            type="button"
            title="Refresh workflows"
            aria-label="Refresh workflows"
            @click="refreshWorkflows"
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
            <img :src="anomaloharisIconUrl" alt="" />
          </div>
          <h2>Ready when you are</h2>
          <p>Send a message to start.</p>
        </div>
        <template v-for="(turn, index) in conversationTurns" :key="`${turn.role}-${index}`">
          <section
            v-if="turn.role === 'activity-group' && turn.status === 'running'"
            class="activity-group activity-group-live"
            aria-live="polite"
          >
            <article
              v-if="activityGroupFading(turn)"
              :key="activityGroupFading(turn).id"
              class="activity-row activity-row-fading"
              :class="[
                `activity-${activityGroupFading(turn).kind}`,
                `activity-${activityGroupFading(turn).status}`,
              ]"
            >
              <span class="activity-icon" aria-hidden="true">
                <AlertTriangle
                  v-if="activityGroupFading(turn).status === 'error'"
                  :size="17"
                />
                <Wrench v-else-if="activityGroupFading(turn).kind === 'tool'" :size="17" />
                <Search
                  v-else-if="activityGroupFading(turn).kind === 'context'"
                  :size="17"
                />
                <CircleCheck v-else :size="17" />
              </span>
              <div class="activity-copy">
                <div class="activity-title">{{ activityGroupFading(turn).title }}</div>
              </div>
            </article>
            <article
              v-if="activityGroupPrevious(turn)"
              :key="activityGroupPrevious(turn).id"
              class="activity-row activity-row-recent"
              :class="[
                `activity-${activityGroupPrevious(turn).kind}`,
                `activity-${activityGroupPrevious(turn).status}`,
              ]"
            >
              <span class="activity-icon" aria-hidden="true">
                <LoaderCircle
                  v-if="activityGroupPrevious(turn).status === 'running'"
                  :size="18"
                  class="activity-spinner"
                />
                <AlertTriangle
                  v-else-if="activityGroupPrevious(turn).status === 'error'"
                  :size="18"
                />
                <Wrench v-else-if="activityGroupPrevious(turn).kind === 'tool'" :size="18" />
                <Search
                  v-else-if="activityGroupPrevious(turn).kind === 'context'"
                  :size="18"
                />
                <CircleCheck v-else :size="18" />
              </span>
              <div class="activity-copy">
                <div class="activity-title">{{ activityGroupPrevious(turn).title }}</div>
                <div v-if="activityGroupPrevious(turn).body" class="activity-body">
                  {{ activityGroupPrevious(turn).body }}
                </div>
              </div>
            </article>
            <article
              v-if="activityGroupCurrent(turn)"
              :key="activityGroupCurrent(turn).id"
              class="activity-row activity-row-current"
              :class="[
                `activity-${activityGroupCurrent(turn).kind}`,
                `activity-${activityGroupCurrent(turn).status}`,
              ]"
            >
              <span class="activity-icon" aria-hidden="true">
                <LoaderCircle
                  v-if="activityGroupCurrent(turn).status === 'running'"
                  :size="18"
                  class="activity-spinner"
                />
                <AlertTriangle
                  v-else-if="activityGroupCurrent(turn).status === 'error'"
                  :size="18"
                />
                <Wrench v-else-if="activityGroupCurrent(turn).kind === 'tool'" :size="18" />
                <Search
                  v-else-if="activityGroupCurrent(turn).kind === 'context'"
                  :size="18"
                />
                <CircleCheck v-else :size="18" />
              </span>
              <div class="activity-copy">
                <div class="activity-title">{{ activityGroupCurrent(turn).title }}</div>
                <div v-if="activityGroupCurrent(turn).body" class="activity-body">
                  {{ activityGroupCurrent(turn).body }}
                </div>
              </div>
            </article>
          </section>
          <details
            v-else-if="turn.role === 'activity-group'"
            class="activity-group activity-group-complete"
            :class="`activity-group-${turn.status}`"
          >
            <summary class="activity-group-summary">
              <span class="activity-icon" aria-hidden="true">
                <AlertTriangle v-if="turn.status === 'error'" :size="18" />
                <CircleCheck v-else :size="18" />
              </span>
              <span class="activity-copy">
                <span class="activity-title">{{ activityGroupSummary(turn) }}</span>
                <span class="activity-body">{{ activityGroupSubtitle(turn) }}</span>
              </span>
              <ChevronRight :size="16" class="activity-group-chevron" />
            </summary>
            <div class="activity-history">
              <article
                v-for="item in turn.items"
                :key="item.id"
                class="activity-row"
                :class="[`activity-${item.kind}`, `activity-${item.status}`]"
              >
                <span class="activity-icon" aria-hidden="true">
                  <AlertTriangle v-if="item.status === 'error'" :size="17" />
                  <Wrench v-else-if="item.kind === 'tool'" :size="17" />
                  <Search v-else-if="item.kind === 'context'" :size="17" />
                  <CircleCheck v-else :size="17" />
                </span>
                <span class="activity-copy">
                  <span class="activity-title">{{ item.title }}</span>
                  <span v-if="item.body" class="activity-body">{{ item.body }}</span>
                </span>
              </article>
            </div>
          </details>
          <article
            v-else-if="turn.role === 'activity'"
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
            <div v-if="turn.role === 'assistant'" class="message-bubble message-bubble-assistant">
              <div class="markdown-body" v-html="turn.htmlContent"></div>
              <div v-if="visibleTurnArtifacts(turn).length" class="message-artifacts">
                <a
                  v-for="artifact in visibleTurnArtifacts(turn)"
                  :key="artifact.url"
                  class="message-artifact"
                  :href="artifact.url"
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    v-if="artifact.media_type?.startsWith('image/')"
                    :src="artifact.url"
                    :alt="artifact.name || 'Tool output image'"
                    loading="lazy"
                  />
                  <span v-else>{{ artifact.name || "Open artifact" }}</span>
                </a>
              </div>
            </div>
            <div v-else class="message-bubble" :class="`message-bubble-${turn.role}`">
              {{ turn.content }}
            </div>
          </article>
        </template>
      </section>

      <PresetAgents
        v-else-if="activeView === 'preset-agents'"
        ref="presetAgentsEl"
        :management="managementAccess"
        @save-management-token="saveManagementToken"
      />

      <Workflows
        v-else-if="activeView === 'workflows'"
        ref="workflowsEl"
        :management="managementAccess"
        @save-management-token="saveManagementToken"
      />

      <BuddyDashboard
        v-else-if="activeView === 'buddy'"
        :controller="buddyDashboard"
        :management="managementAccess"
        @save-management-token="saveManagementToken"
        @clear-management-token="clearManagementToken"
      />

      <CapabilityDashboard
        v-else-if="activeView === 'dashboard'"
        ref="capabilityDashboardEl"
      />

      <form
        v-if="activeView === 'agent'"
        id="chatForm"
        class="composer"
        @submit.prevent="submitMessage"
      >
        <div class="composer-box" :class="{ 'composer-box-preset': presetMode }">
          <div v-if="presetMode" class="composer-preset-bar">
            <div class="composer-preset-heading">
              <Bot :size="16" />
              <span>Preset Model</span>
            </div>
            <div ref="presetPickerEl" class="composer-preset-picker">
              <button
                class="composer-preset-select"
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-controls="presetAgentOptions"
                aria-label="Select preset model"
                :aria-expanded="presetPickerOpen"
                :disabled="chatRunActive || presetAgentsLoading"
                @click="presetPickerOpen = !presetPickerOpen"
                @keydown="handlePresetPickerKeydown"
              >
                <span
                  class="composer-preset-selected"
                  :class="{ placeholder: !selectedPresetAgent }"
                >
                  <span v-if="selectedPresetAgent" class="composer-preset-selected-ghost">
                    {{ selectedPresetAgent.ghost || "👻" }}
                  </span>
                  <span>{{ selectedPresetAgent?.name || "Select a preset model…" }}</span>
                </span>
                <ChevronDown :size="16" aria-hidden="true" />
              </button>
              <Transition name="composer-select">
                <div
                  v-if="presetPickerOpen"
                  id="presetAgentOptions"
                  class="composer-preset-options"
                  role="listbox"
                  aria-label="Preset models"
                >
                  <div v-if="!presetAgents.length" class="composer-preset-empty">
                    {{ presetAgentsError || "No preset models yet." }}
                  </div>
                  <button
                    v-for="agent in presetAgents"
                    :key="agent.id"
                    class="composer-preset-option"
                    type="button"
                    role="option"
                    :aria-selected="agent.id === selectedPresetAgentId"
                    @click="choosePresetAgent(agent.id)"
                  >
                    <span class="composer-preset-option-ghost">{{ agent.ghost || "👻" }}</span>
                    <span class="composer-preset-option-copy">
                      <strong>{{ agent.name }}</strong>
                      <small>{{ agent.description || agent.model }}</small>
                    </span>
                    <CircleCheck
                      v-if="agent.id === selectedPresetAgentId"
                      :size="16"
                      aria-hidden="true"
                    />
                  </button>
                </div>
              </Transition>
            </div>
            <button
              class="composer-preset-close"
              type="button"
              title="Exit preset model mode"
              aria-label="Exit preset model mode"
              :disabled="chatRunActive"
              @click="closePresetMode"
            >
              <X :size="16" />
            </button>
            <p v-if="presetAgentsLoading" class="composer-preset-note">Loading preset models…</p>
            <p v-else-if="presetAgentsError" class="composer-preset-note error">
              {{ presetAgentsError }}
            </p>
            <p v-else-if="!presetAgents.length" class="composer-preset-note">
              No preset models yet. Create one in Preset Models.
            </p>
            <p v-else-if="selectedPresetAgent" class="composer-preset-note">
              {{ selectedPresetAgent.description || selectedPresetAgent.model }}
            </p>
          </div>
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
                <button class="composer-action-item" type="button" @click="openPresetPicker">
                  <Bot :size="16" />
                  <span>Use Preset Model</span>
                </button>
              </div>
            </Transition>
          </div>
          <textarea
            id="messageInput"
            ref="messageInputEl"
            class="composer-input"
            v-model="messageInput"
            :disabled="chatRunActive"
            :placeholder="composerPlaceholder"
            rows="1"
            @input="resizeComposer"
            @keydown="handleComposerKeydown"
          ></textarea>
          <span
            v-if="chatRunActive"
            class="send-button-wrap"
            data-tooltip="Stop run"
            title="Stop run"
          >
            <button
              id="stopButton"
              class="send-button stop-button"
              type="button"
              aria-label="Stop run"
              @click="stopRun"
            >
              <Square :size="17" fill="currentColor" />
            </button>
          </span>
          <span
            v-else-if="chatResumeAvailable"
            class="send-button-wrap"
            data-tooltip="Resume run"
            title="Resume run"
          >
            <button
              id="resumeButton"
              class="send-button resume-button"
              type="button"
              aria-label="Resume run"
              :disabled="chatSendDisabled"
              @click="resumeRun"
            >
              <Play :size="18" fill="currentColor" />
            </button>
          </span>
          <span
            v-else
            class="send-button-wrap"
            :data-tooltip="sendShortcutTooltip"
            :title="sendShortcutTooltip"
          >
            <button
              id="sendButton"
              class="send-button"
              type="submit"
              :aria-label="`Send message (${SEND_SHORTCUT})`"
              :disabled="chatSendDisabled || chatResumeAvailable"
            >
              <SendHorizontal :size="19" />
            </button>
          </span>
        </div>
      </form>
    </main>

    <Transition name="fade">
      <button
        v-if="inspectorOpen || historyOpen"
        class="inspector-backdrop"
        type="button"
        aria-label="Close panel"
        @click="closePanels"
      ></button>
    </Transition>

    <Transition name="history-drawer">
      <aside
        v-if="historyOpen"
        class="inspector-drawer history-drawer"
        aria-label="Conversation history"
      >
        <header class="drawer-header">
          <div>
            <span class="drawer-kicker">Saved sessions</span>
            <h2>Conversation history</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            title="Close"
            aria-label="Close conversation history"
            @click="historyOpen = false"
          >
            <X :size="18" />
          </button>
        </header>

        <div class="history-content">
          <button class="history-new-button" type="button" @click="startNewConversation">
            <Plus :size="17" />
            <span>New conversation</span>
          </button>

          <p v-if="historyError" class="history-message history-message-error">
            {{ historyError }}
          </p>
          <p v-else-if="historyLoading && !historySessions.length" class="history-message">
            Loading conversations...
          </p>
          <p v-else-if="!historySessions.length" class="history-message">
            No saved conversations yet.
          </p>

          <div v-else class="history-list">
            <div
              v-for="historySession in historySessions"
              :key="historySession.session_id"
              class="history-item"
              :class="{ active: historySession.session_id === sessionId }"
            >
              <button
                class="history-item-main"
                type="button"
                :disabled="chatRunActive"
                @click="switchHistorySession(historySession)"
              >
                <strong>{{ historySession.title }}</strong>
                <span>
                  {{ formatHistoryDate(historySession.updated_at) }} ·
                  {{ historySession.message_count }} messages
                  <em v-if="historySession.preset_model">
                    · {{ historySession.preset_model }}
                  </em>
                  <em v-if="historySession.can_resume"> · Paused</em>
                </span>
              </button>
              <button
                class="history-delete-button"
                type="button"
                title="Delete conversation"
                :aria-label="`Delete ${historySession.title}`"
                :disabled="chatRunActive"
                @click="deleteHistorySession(historySession)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>
        </div>
      </aside>
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

        <details class="drawer-card retrieval-mode-card" open>
          <summary>
            <span>Retrieval Mode</span>
            <Globe2 :size="16" />
          </summary>
          <div class="search-mode-list" role="radiogroup" aria-label="Retrieval mode">
            <label
              v-for="option in searchModeOptions"
              :key="option.id"
              class="search-mode-option"
              :class="{ active: displayedSearchMode === option.id }"
            >
              <input
                type="radio"
                name="anomaloharis-search-mode"
                :value="option.id"
                :checked="displayedSearchMode === option.id"
                :disabled="chatRunActive || searchModeSaveInFlight || presetMode"
                @change="selectSearchMode(option.id)"
              />
              <span class="search-mode-radio" aria-hidden="true"></span>
              <span class="search-mode-copy">
                <strong>{{ option.label }}</strong>
                <span>{{ option.description }}</span>
              </span>
            </label>
          </div>
          <div class="panel-note">{{ displayedSearchModeStatusMessage }}</div>
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

        <details class="drawer-card web-activity-card" open>
          <summary>
            <span class="summary-label">
              <span>Web Activity</span>
              <strong>{{ webTraceCount }}</strong>
            </span>
            <Globe2 :size="16" />
          </summary>
          <div v-if="webTraces.length" class="web-trace-list">
            <article
              v-for="trace in webTraces"
              :key="trace.id || trace.tool_call_id"
              class="web-trace"
              :data-status="webTraceStatus(trace)"
            >
              <header class="web-trace-header">
                <div>
                  <span>{{ webTraceKindLabel(trace) }}</span>
                  <strong>{{ webTraceTitle(trace) }}</strong>
                </div>
                <span class="web-trace-status">{{ webTraceStatus(trace) }}</span>
              </header>

              <div class="web-trace-meta">
                <span>{{ trace.data?.provider || "pending" }}</span>
                <span v-if="trace.data?.duration_ms != null">{{ trace.data.duration_ms }} ms</span>
                <span v-if="trace.data?.cached">cached</span>
                <span>{{ formatDateTime(trace.timestamp) }}</span>
              </div>

              <template v-if="trace.data?.trace_kind === 'web_search'">
                <div v-if="trace.data?.results?.length" class="web-result-list">
                  <a
                    v-for="(result, index) in trace.data.results"
                    :key="`${trace.id}-${result.url}`"
                    :href="safeWebUrl(result.url)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="web-result"
                  >
                    <span>{{ index + 1 }}</span>
                    <span>
                      <strong>{{ result.title || result.url }}</strong>
                      <small>{{ result.url }}</small>
                      <em v-if="result.snippet">{{ result.snippet }}</em>
                    </span>
                    <ExternalLink :size="13" />
                  </a>
                </div>
                <div v-else-if="trace.ok !== null" class="panel-note">
                  {{ trace.content || "No search results returned." }}
                </div>
              </template>

              <template v-else-if="trace.data?.trace_kind === 'web_fetch'">
                <a
                  v-if="trace.data?.final_url || trace.data?.requested_url"
                  :href="safeWebUrl(trace.data.final_url || trace.data.requested_url)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="web-fetch-url"
                >
                  <span>{{ trace.data.final_url || trace.data.requested_url }}</span>
                  <ExternalLink :size="13" />
                </a>
                <div class="web-fetch-stats">
                  <span v-if="trace.data?.status_code">HTTP {{ trace.data.status_code }}</span>
                  <span v-if="trace.data?.markdown_chars != null">
                    {{ trace.data.markdown_chars }} chars
                  </span>
                  <span v-if="trace.data?.rendered">rendered</span>
                  <span v-if="trace.data?.truncated">truncated</span>
                </div>
                <details v-if="trace.content" class="web-trace-content">
                  <summary>Returned Markdown</summary>
                  <button
                    class="mini-icon-button"
                    type="button"
                    @click.stop.prevent="copyWebTrace(trace)"
                  >
                    <Copy :size="13" />
                    <span>{{ copiedWebTraceId === trace.id ? "Copied" : "Copy" }}</span>
                  </button>
                  <pre>{{ trace.content }}</pre>
                </details>
                <div v-else-if="trace.ok === false" class="panel-note error">
                  Fetch failed before content was returned.
                </div>
              </template>
            </article>
          </div>
          <div v-else class="empty-panel">
            Search and fetch calls from this conversation will appear here.
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
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  Database,
  ExternalLink,
  Globe2,
  History,
  Layers3,
  LoaderCircle,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  Wrench,
  X,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import {
  activityGroupCurrent,
  activityGroupFading,
  activityGroupPrevious,
  activityGroupSubtitle,
  activityGroupSummary,
  createAgentSessionProjection,
} from "./agent/agentSessionProjection";
import { createAgentTransport } from "./agent/agentTransport";
import { createPresetAgentTransport } from "./agent/presetAgentTransport";
import anomaloharisIconUrl from "./assets/anomaloharis-shrimp.png";
import BuddyDashboard from "./dashboard/BuddyDashboard.vue";
import CapabilityDashboard from "./dashboard/CapabilityDashboard.vue";
import { createBuddyDashboardController } from "./dashboard/buddyDashboardController";
import { createManagementAccess } from "./management/managementAccess";
import { createSearchModeController } from "./management/searchModeController";
import PresetAgents from "./preset-agents/PresetAgents.vue";
import Workflows from "./workflows/Workflows.vue";

const SEND_SHORTCUT = "Alt+Enter";
const sendShortcutTooltip = SEND_SHORTCUT;

const creditsRefreshTimer = ref(null);
const inspectorOpen = ref(false);
const historyOpen = ref(false);
const composerActionsOpen = ref(false);
const activeView = ref("agent");
const presetAgentsEl = ref(null);
const workflowsEl = ref(null);
const capabilityDashboardEl = ref(null);
const managementAccess = createManagementAccess();
const { input: managementTokenInput } = managementAccess.state;
const fetchJson = managementAccess.requestJson;
const refreshDashboard = () => capabilityDashboardEl.value?.refresh();
const refreshWorkflows = () => workflowsEl.value?.refresh();
const buddyDashboard = createBuddyDashboardController({
  requestJson: fetchJson,
  markAccessError: managementAccess.markError,
  clearAccessError: () => { managementAccess.state.accessRequired.value = false; },
});
const refreshBuddyDashboard = buddyDashboard.refresh;

const tools = ref([]);
const historySessions = ref([]);
const historyLoading = ref(false);
const historyError = ref("");
let historyRequestSequence = 0;
const copiedWebTraceId = ref("");
const conversationEl = ref(null);
const composerActionsEl = ref(null);
const presetPickerEl = ref(null);
const messageInputEl = ref(null);
const messageInput = ref("");
const presetMode = ref(false);
const presetAgents = ref([]);
const presetAgentsLoading = ref(false);
const presetAgentsError = ref("");
const selectedPresetAgentId = ref("");
const presetPickerOpen = ref(false);
const presetSessionId = ref("");
const presetReturnSessionId = ref("");
let presetAgentsRequest = null;

const CREDITS_REFRESH_INTERVAL_MS = 82800000;

const openrouterCredits = ref(null);
const openrouterCreditsStatus = ref("loading");
const openrouterCreditsMessage = ref("Loading OpenRouter credits...");
const openrouterCreditsRefreshInFlight = ref(false);

const copyPromptLabel = ref("Copy");
const copyMessagesLabel = ref("Copy Messages");

const agentProjection = createAgentSessionProjection({
  renderMarkdown,
  onScroll: scrollConversation,
  onRefresh: refreshAgentSurfaces,
});
const {
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
  contextStats,
  contextSegments,
  contextMessages,
} = agentProjection.state;
const {
  addEventLog,
  beginUserTurn,
  clearMarkdownRenderTimers,
  handle: handleAgentEvent,
  replaceConversation,
  replaceWebTraces,
  reset: resetAgentProjection,
  setAgentState,
  setPromptOutput,
} = agentProjection;
const agentTransport = createAgentTransport({
  onEvent: handleAgentEventAndRefresh,
  onState: setAgentState,
  onError: (error) => addEventLog("ws.error", String(error), true),
});
const {
  sessionId: defaultSessionId,
  connectionStatus,
  connectionClass,
  sendDisabled,
  runActive,
  resumeAvailable,
} = agentTransport.state;
const presetAgentTransport = createPresetAgentTransport({
  onEvent: handleAgentEventAndRefresh,
  onError: (error) => addEventLog("preset.error", String(error), true),
});
const {
  runActive: presetRunActive,
  resumeAvailable: presetResumeAvailable,
} = presetAgentTransport.state;

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

const sessionId = computed(() =>
  presetMode.value ? presetSessionId.value : defaultSessionId.value,
);
const normalizedAgentState = computed(() => normalizeState(agentState.value));
const normalizedRunStatus = computed(() => normalizeState(runStatus.value));
const selectedPresetAgent = computed(
  () => presetAgents.value.find((agent) => agent.id === selectedPresetAgentId.value) || null,
);
const presetSearchMode = computed(() => selectedPresetAgent.value?.search_mode || null);
const displayedSearchMode = computed(() =>
  presetMode.value ? presetSearchMode.value : searchModeValue.value,
);
const displayedSearchModeStatusMessage = computed(() => {
  if (!presetMode.value) {
    return searchModeStatusMessage.value;
  }
  if (!selectedPresetAgent.value) {
    return "Select a preset Agent to see its retrieval mode.";
  }
  if (!presetSearchMode.value) {
    return "This preset does not include the web_search tool.";
  }
  const option = searchModeOptions.value.find(
    (candidate) => candidate.id === presetSearchMode.value,
  );
  return `Locked by preset Agent: ${option?.label || presetSearchMode.value}.`;
});
const chatRunActive = computed(() =>
  presetMode.value ? presetRunActive.value : runActive.value,
);
const searchModeController = createSearchModeController({
  requestJson: fetchJson,
  getSessionId: () => sessionId.value,
  isDisabled: () => chatRunActive.value || chatResumeAvailable.value,
});
const {
  mode: searchModeValue,
  options: searchModeOptions,
  saveInFlight: searchModeSaveInFlight,
  statusMessage: searchModeStatusMessage,
} = searchModeController.state;
const chatResumeAvailable = computed(() =>
  presetMode.value ? presetResumeAvailable.value : resumeAvailable.value,
);
const chatSendDisabled = computed(() =>
  presetMode.value
    ? !selectedPresetAgent.value || presetAgentsLoading.value || Boolean(presetAgentsError.value)
    : sendDisabled.value,
);
const composerPlaceholder = computed(() => {
  if (selectedPresetAgent.value) {
    return `Message ${selectedPresetAgent.value.name}`;
  }
  if (presetMode.value) {
    return "Select a preset model";
  }
  return "Message AnomaloHaris";
});
const activeSkillCount = computed(() => skills.value.filter((skill) => skill.active).length);
const activeMcpCount = computed(() => mcpServers.value.filter((server) => server.active).length);
const webTraceCount = computed(() => webTraces.value.length);
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
onMounted(() => {
  document.addEventListener("keydown", handleGlobalKeydown);
  document.addEventListener("pointerdown", handleGlobalPointerdown);
  agentTransport.connect();
  void loadConversationHistory();
  void searchModeController.load();
  void loadHistorySessions();
  void loadTools();
  void loadWebTraces();
  void loadSkills();
  void loadMcpServers();
  void loadPromptProfile();
  void loadMemory();
  void loadOpenRouterCredits();
  creditsRefreshTimer.value = setInterval(() => {
    void loadOpenRouterCredits({ silent: true });
  }, CREDITS_REFRESH_INTERVAL_MS);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleGlobalKeydown);
  document.removeEventListener("pointerdown", handleGlobalPointerdown);
  clearInterval(creditsRefreshTimer.value);
  clearMarkdownRenderTimers();
  agentTransport.stop();
});

function handleGlobalKeydown(event) {
  if (event.key === "Escape") {
    inspectorOpen.value = false;
    historyOpen.value = false;
    composerActionsOpen.value = false;
    presetPickerOpen.value = false;
  }
}

function handleGlobalPointerdown(event) {
  if (
    composerActionsOpen.value &&
    !composerActionsEl.value?.contains(event.target)
  ) {
    composerActionsOpen.value = false;
  }
  if (presetPickerOpen.value && !presetPickerEl.value?.contains(event.target)) {
    presetPickerOpen.value = false;
  }
}

function setActiveView(view) {
  activeView.value = view;
  inspectorOpen.value = false;
  historyOpen.value = false;
  composerActionsOpen.value = false;
  presetPickerOpen.value = false;
}

function toggleHistory() {
  inspectorOpen.value = false;
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value) {
    void loadHistorySessions({ silent: true });
  }
}

function closePanels() {
  inspectorOpen.value = false;
  historyOpen.value = false;
}

function handleAgentEventAndRefresh(event) {
  handleAgentEvent(event);
  if (event.type === "session.state" && event.data?.search_mode) {
    searchModeController.applyEvent(event.data.search_mode);
  }
  if (event.type === "run.started" && event.data?.search_mode) {
    searchModeController.applyEvent(event.data.search_mode);
  }
  if (["run.started", "run.finished", "run.stopped", "run.error"].includes(event.type)) {
    void loadHistorySessions({ silent: true });
  }
}

function saveManagementToken() {
  const nextToken = managementTokenInput.value.trim();
  managementAccess.save();
  void loadOpenRouterCredits({ silent: true });
  if (activeView.value === "dashboard") {
    void refreshDashboard();
  }
  if (activeView.value === "buddy") {
    void refreshBuddyDashboard();
  }
  if (activeView.value === "preset-agents") {
    void presetAgentsEl.value?.refresh();
  }
  if (activeView.value === "workflows") {
    void workflowsEl.value?.refresh();
  }
}

function clearManagementToken() {
  managementAccess.clear();
  openrouterCredits.value = null;
  openrouterCreditsStatus.value = "muted";
  openrouterCreditsMessage.value = "Admin token required to show OpenRouter credits.";
  if (activeView.value === "dashboard") {
    void refreshDashboard();
  }
  if (activeView.value === "buddy") {
    void refreshBuddyDashboard();
  }
  if (activeView.value === "workflows") {
    void workflowsEl.value?.refresh();
  }
}

async function loadPresetAgents() {
  if (presetAgentsRequest) {
    return presetAgentsRequest;
  }
  presetAgentsRequest = (async () => {
    presetAgentsLoading.value = true;
    presetAgentsError.value = "";
    try {
      const response = await fetch("/api/preset-models");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Preset models failed to load.");
      }
      presetAgents.value = Array.isArray(data.preset_models)
        ? data.preset_models.map((model) => ({
          id: model.ref,
          ref: model.ref,
          name: model.name,
          version: model.version,
          description: model.description,
          ghost: "👻",
          model: model.provider_model,
          tool_names: Array.isArray(model.allowed_tools) && model.allowed_tools.length
            ? [...model.allowed_tools]
            : Array.isArray(model.tool_catalog)
              ? [...model.tool_catalog]
              : [],
          bootstrap_tools: Array.isArray(model.bootstrap_tools) ? [...model.bootstrap_tools] : [],
          search_mode: model.policy?.searchMode || model.policy?.search_mode || null,
        }))
        : [];
      if (
        selectedPresetAgentId.value &&
        !presetAgents.value.some((agent) => agent.id === selectedPresetAgentId.value)
      ) {
        selectedPresetAgentId.value = "";
      }
    } catch (error) {
      presetAgentsError.value = `Preset models failed to load: ${formatError(error)}`;
    } finally {
      presetAgentsLoading.value = false;
    }
  })();
  try {
    await presetAgentsRequest;
  } finally {
    presetAgentsRequest = null;
  }
}

async function loadTools() {
  const currentSessionId = sessionId.value;
  try {
    const query = new URLSearchParams({ session_id: currentSessionId });
    if (presetMode.value && selectedPresetAgentId.value) {
      query.set("preset_model", selectedPresetAgentId.value);
    }
    const response = await fetch(`/api/tools?${query.toString()}`);
    const data = await response.json();
    if (sessionId.value !== currentSessionId) {
      return;
    }
    tools.value = data.tools || [];
  } catch (error) {
    addEventLog("tools.error", String(error), true);
  }
}

async function selectSearchMode(nextMode) {
  if (presetMode.value) {
    return;
  }
  const changed = await searchModeController.select(nextMode);
  if (changed) {
    addEventLog("search-mode", `Retrieval mode set to ${nextMode}.`);
    void loadTools();
  }
}

async function loadHistorySessions({ silent = false } = {}) {
  const requestId = ++historyRequestSequence;
  if (!silent) {
    historyLoading.value = true;
  }
  try {
    const response = await fetch("/api/sessions");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Conversation history failed to load.");
    }
    if (requestId !== historyRequestSequence) {
      return;
    }
    historySessions.value = Array.isArray(data.sessions) ? data.sessions : [];
    historyError.value = "";
  } catch (error) {
    if (requestId === historyRequestSequence) {
      historyError.value = `History load failed: ${formatError(error)}`;
    }
  } finally {
    if (requestId === historyRequestSequence) {
      historyLoading.value = false;
    }
  }
}

async function loadConversationHistory(targetSessionId = sessionId.value) {
  await searchModeController.load(targetSessionId);
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(targetSessionId)}`,
    );
    if (response.status === 404) {
      return;
    }
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Conversation failed to load.");
    }
    if (sessionId.value !== targetSessionId) {
      return;
    }
    replaceConversation(data.messages || [], { canResume: Boolean(data.can_resume) });
    await nextTick(scrollConversation);
  } catch (error) {
    if (sessionId.value === targetSessionId) {
      historyError.value = `Conversation load failed: ${formatError(error)}`;
    }
  }
}

async function loadWebTraces() {
  const currentSessionId = sessionId.value;
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(currentSessionId)}/web-traces`,
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Web traces failed to load.");
    }
    if (sessionId.value !== currentSessionId) {
      return;
    }
    replaceWebTraces([...(data.traces || [])].reverse());
  } catch (error) {
    addEventLog("web-traces.error", String(error), true);
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

function refreshAgentSurfaces(targets) {
  if (targets.includes("tools")) {
    void loadTools();
  }
  if (targets.includes("skills")) {
    void loadSkills();
  }
  if (targets.includes("mcp")) {
    void loadMcpServers();
  }
}

async function loadPromptProfile() {
  try {
    const response = await fetch("/api/prompts");
    const data = await response.json();
    promptProfile.value = data.profile || "agent";
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
  if (!managementAccess.state.token.value) {
    openrouterCredits.value = null;
    openrouterCreditsStatus.value = "muted";
    openrouterCreditsMessage.value = "Admin token required to show OpenRouter credits.";
    return;
  }
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
    openrouterCreditsStatus.value = error?.status === 403 ? "muted" : "error";
    openrouterCreditsMessage.value = error?.status === 403
      ? "Admin token was rejected; credits are unavailable."
      : `OpenRouter credits failed: ${formatError(error)}`;
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

function formatDateTime(value, { includeSeconds = false } = {}) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
    timeZoneName: "short",
  });
}

async function submitMessage() {
  const content = messageInput.value.trim();
  if (presetMode.value) {
    if (
      !content ||
      chatSendDisabled.value ||
      chatRunActive.value ||
      chatResumeAvailable.value ||
      !selectedPresetAgent.value
    ) {
      return;
    }
    beginUserTurn(content);
    messageInput.value = "";
    await presetAgentTransport.send(
      selectedPresetAgent.value.id,
      content,
      presetSessionId.value,
    );
    void nextTick(resizeComposer);
    return;
  }

  if (
    !content ||
    sendDisabled.value ||
    runActive.value ||
    resumeAvailable.value ||
    !agentTransport.send(content)
  ) {
    return;
  }

  beginUserTurn(content);
  messageInput.value = "";
  void nextTick(resizeComposer);
}

function stopRun() {
  if (presetMode.value) {
    presetAgentTransport.stopRun();
    return;
  }
  agentTransport.stopRun();
}

function resumeRun() {
  if (presetMode.value) {
    if (selectedPresetAgent.value && presetSessionId.value) {
      void presetAgentTransport.resume(
        selectedPresetAgent.value.id,
        presetSessionId.value,
      );
    }
    return;
  }
  agentTransport.resumeRun();
}

function openPresetPicker() {
  composerActionsOpen.value = false;
  presetPickerOpen.value = false;
  if (chatRunActive.value) {
    return;
  }
  if (!presetMode.value) {
    presetReturnSessionId.value = sessionId.value;
    presetSessionId.value = "";
    selectedPresetAgentId.value = "";
    presetMode.value = true;
  }
  void loadPresetAgents();
  void nextTick(() => messageInputEl.value?.focus());
}

function handlePresetPickerKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    presetPickerOpen.value = false;
    return;
  }
  if (event.key === "ArrowDown" && !presetPickerOpen.value) {
    event.preventDefault();
    presetPickerOpen.value = true;
  }
}

function choosePresetAgent(agentId) {
  if (chatRunActive.value || !agentId) {
    return;
  }
  selectedPresetAgentId.value = agentId;
  presetPickerOpen.value = false;
  selectPresetAgent();
}

function selectPresetAgent() {
  if (chatRunActive.value || !selectedPresetAgent.value) {
    return;
  }
  if (!presetReturnSessionId.value) {
    presetReturnSessionId.value = sessionId.value;
  }
  presetMode.value = true;
  startPresetConversation();
  void nextTick(() => messageInputEl.value?.focus());
}

function startPresetConversation() {
  if (!selectedPresetAgent.value) {
    return;
  }
  presetPickerOpen.value = false;
  const nextSessionId = `preset_${selectedPresetAgent.value.id}_${createClientId()}`;
  presetSessionId.value = nextSessionId;
  presetAgentTransport.switchSession(nextSessionId);
  void searchModeController.load(nextSessionId);
  clearMarkdownRenderTimers();
  resetConversationState();
  void loadTools();
  void loadWebTraces();
  void loadSkills();
  void loadMcpServers();
  void loadHistorySessions({ silent: true });
}

async function closePresetMode() {
  if (chatRunActive.value) {
    return;
  }
  await leavePresetMode({ restoreDefaultSession: true });
  void nextTick(() => messageInputEl.value?.focus());
}

async function leavePresetMode({ restoreDefaultSession }) {
  presetPickerOpen.value = false;
  const returnSessionId = presetReturnSessionId.value;
  presetAgentTransport.switchSession("");
  presetMode.value = false;
  selectedPresetAgentId.value = "";
  presetSessionId.value = "";
  presetReturnSessionId.value = "";
  if (restoreDefaultSession && returnSessionId) {
    agentTransport.switchSession(returnSessionId);
    resetConversationState();
    await loadConversationHistory(returnSessionId);
    void loadTools();
    void loadWebTraces();
    void loadSkills();
    void loadMcpServers();
    void loadHistorySessions({ silent: true });
  }
}

function startNewConversation() {
  composerActionsOpen.value = false;
  historyOpen.value = false;
  if (presetMode.value) {
    if (selectedPresetAgent.value) {
      startPresetConversation();
    } else {
      openPresetPicker();
    }
    void nextTick(() => messageInputEl.value?.focus());
    return;
  }
  clearMarkdownRenderTimers();
  agentTransport.startNewSession();
  void searchModeController.load(sessionId.value);

  resetConversationState();
  void loadTools();
  void loadWebTraces();
  void loadSkills();
  void loadMcpServers();
  void loadHistorySessions({ silent: true });
  void nextTick(() => messageInputEl.value?.focus());
}

async function switchHistorySession(historySession) {
  const nextSessionId = historySession?.session_id;
  if (chatRunActive.value) {
    historyError.value = "Stop the active run before switching conversations.";
    return;
  }

  if (historySession?.preset_model) {
    await switchPresetHistorySession(historySession);
    return;
  }

  const exitedPresetMode = presetMode.value;
  if (exitedPresetMode) {
    await leavePresetMode({ restoreDefaultSession: false });
  }
  if (!nextSessionId || (!exitedPresetMode && nextSessionId === sessionId.value)) {
    historyOpen.value = false;
    return;
  }

  historyOpen.value = false;
  inspectorOpen.value = false;
  clearMarkdownRenderTimers();
  resetConversationState();
  agentTransport.switchSession(nextSessionId);
  await loadConversationHistory(nextSessionId);
  void loadTools();
  void loadWebTraces();
  void loadSkills();
  void loadMcpServers();
  void nextTick(() => messageInputEl.value?.focus());
}

async function switchPresetHistorySession(historySession) {
  const nextSessionId = historySession.session_id;
  const presetModelRef = historySession.preset_model;
  if (!nextSessionId || !presetModelRef) {
    return;
  }

  if (!presetMode.value) {
    presetReturnSessionId.value = defaultSessionId.value;
  }
  await loadPresetAgents();
  if (!presetAgents.value.some((agent) => agent.id === presetModelRef)) {
    historyError.value = "The preset model for this conversation is no longer available.";
    return;
  }

  historyOpen.value = false;
  inspectorOpen.value = false;
  presetMode.value = true;
  selectedPresetAgentId.value = presetModelRef;
  presetSessionId.value = nextSessionId;
  presetAgentTransport.switchSession(nextSessionId, {
    canResume: Boolean(historySession.can_resume),
  });
  clearMarkdownRenderTimers();
  resetConversationState();
  await loadConversationHistory(nextSessionId);
  void loadTools();
  void loadWebTraces();
  void loadSkills();
  void loadMcpServers();
  void nextTick(() => messageInputEl.value?.focus());
}

async function deleteHistorySession(historySession) {
  if (!historySession?.session_id || chatRunActive.value) {
    return;
  }
  if (
    typeof window !== "undefined" &&
    !window.confirm(`Delete conversation “${historySession.title}”?`)
  ) {
    return;
  }

  const deletingCurrentSession = sessionId.value === historySession.session_id;
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(historySession.session_id)}`,
      { method: "DELETE" },
    );
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      throw new Error(data?.detail || "Conversation deletion failed.");
    }
    historySessions.value = historySessions.value.filter(
      (item) => item.session_id !== historySession.session_id,
    );
    historyError.value = "";
    if (deletingCurrentSession) {
      if (presetMode.value) {
        await closePresetMode();
      } else {
        startNewConversation();
      }
    }
  } catch (error) {
    historyError.value = `Delete failed: ${formatError(error)}`;
  }
}

function formatHistoryDate(value) {
  if (!value) {
    return "Unknown date";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function createClientId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replaceAll("-", "");
  }
  return Math.random().toString(16).slice(2).padEnd(24, "0");
}

function resetConversationState() {
  messageInput.value = "";
  resetAgentProjection();
  copiedWebTraceId.value = "";
  tools.value = [];
  skills.value = [];
  mcpServers.value = [];
  skillStatus.value = "Loading skills...";
  mcpStatus.value = "Loading MCP servers...";
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

function webTraceStatus(trace) {
  if (trace.ok === null || trace.ok === undefined) {
    return "running";
  }
  return trace.ok ? "done" : "error";
}

function webTraceKindLabel(trace) {
  return trace.data?.trace_kind === "web_search" ? "SEARCH" : "FETCH";
}

function webTraceTitle(trace) {
  if (trace.data?.trace_kind === "web_search") {
    return trace.data?.query || trace.arguments?.query || "Web search";
  }
  return (
    trace.data?.title ||
    trace.data?.final_url ||
    trace.data?.requested_url ||
    trace.arguments?.url ||
    "Web fetch"
  );
}

function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
}

async function copyWebTrace(trace) {
  if (!trace?.content) {
    return;
  }
  await navigator.clipboard.writeText(trace.content);
  copiedWebTraceId.value = trace.id;
  setTimeout(() => {
    if (copiedWebTraceId.value === trace.id) {
      copiedWebTraceId.value = "";
    }
  }, 1200);
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

function visibleTurnArtifacts(turn) {
  const referencedSources = Array.from(
    String(turn.content || "").matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/g),
    (match) => match[1],
  );
  return (turn.artifacts || []).filter((artifact) => {
    return !referencedSources.includes(artifact.name) && !referencedSources.includes(artifact.url);
  });
}

function renderMarkdown(value, artifacts = []) {
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
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim(), artifacts)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"), artifacts)}</blockquote>`);
      continue;
    }

    if (isMarkdownTable(lines, index)) {
      const table = renderMarkdownTable(lines, index, artifacts);
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
        items.push(`<li>${renderInlineMarkdown(item.content.trim(), artifacts)}</li>`);
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
      blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(" "), artifacts)}</p>`);
      continue;
    }

    blocks.push(`<p>${renderInlineMarkdown(trimmed, artifacts)}</p>`);
    index += 1;
  }

  return blocks.join("");
}

function renderInlineMarkdown(value, artifacts = []) {
  const codeTokens = [];
  const linkTokens = [];
  const imageTokens = [];
  let html = String(value);

  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = html.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (match, label, source) => {
    const artifact = artifacts.find((candidate) => candidate.name === source || candidate.url === source);
    const url = artifact?.url || "";
    if (!url) {
      return match;
    }
    const token = `\u0000IMAGE${imageTokens.length}\u0000`;
    imageTokens.push(
      `<a class="markdown-image-link" href="${escapeAttribute(url)}" target="_blank" rel="noreferrer"><img src="${escapeAttribute(url)}" alt="${escapeAttribute(label || artifact?.name || "Tool output image")}" loading="lazy"></a>`,
    );
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
    .replace(/\u0000LINK(\d+)\u0000/g, (_match, tokenIndex) => linkTokens[Number(tokenIndex)] || "")
    .replace(/\u0000IMAGE(\d+)\u0000/g, (_match, tokenIndex) => imageTokens[Number(tokenIndex)] || "");
}

function renderMarkdownTable(lines, startIndex, artifacts = []) {
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
      return `<th${attrs}>${renderInlineMarkdown(cell, artifacts)}</th>`;
    })
    .join("");
  const bodyHtml = rows
    .map((row) => {
      const cells = headers
        .map((_, cellIndex) => {
          const attrs = tableCellAttributes(alignments[cellIndex]);
          return `<td${attrs}>${renderInlineMarkdown(row[cellIndex] || "", artifacts)}</td>`;
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

function renderMemory(memory) {
  if (!memory?.exists) {
    memoryStatus.value = "No AGENTS.md uploaded.";
    memoryPreview.value = "";
    return;
  }

  memoryStatus.value = `${memory.size_bytes || 0} bytes · ${memory.path}`;
  memoryPreview.value = String(memory.content || "").trim() || "(empty AGENTS.md)";
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
