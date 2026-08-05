<template>
  <section class="dashboard-view" aria-label="StackChan dashboard">
    <div class="dashboard-hero">
      <div class="dashboard-hero-copy">
        <span>StackChan Server</span>
        <h2>Dashboard</h2>
        <p>Monitor Buddy transport, audio activity, recent events, and manual state triggers.</p>
      </div>
      <section class="dashboard-admin-compact" aria-label="Admin Access">
        <header>
          <span>Admin Token</span>
          <strong>{{ managementTokenStatus }}</strong>
        </header>
        <form class="management-token-form" @submit.prevent="$emit('save-management-token')">
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
            @click="$emit('clear-management-token')"
          >
            Clear
          </button>
        </form>
        <p>{{ managementTokenHint }}</p>
      </section>
    </div>

    <div class="dashboard-grid">
      <section class="dashboard-panel">
        <header>
          <span>Server Status</span>
          <strong>{{ statusLabel }}</strong>
        </header>
        <div class="metric-grid">
          <div v-for="metric in statusCards" :key="metric.label" class="metric">
            <span>{{ metric.label }}</span>
            <strong>{{ metric.value }}</strong>
          </div>
        </div>
        <p class="dashboard-note">{{ dashboardStatus }}</p>
      </section>

      <section class="dashboard-panel dashboard-control-panel">
        <header>
          <span>Manual Control</span>
          <strong>{{ actionInFlight ? "Working" : "Ready" }}</strong>
        </header>
        <div class="control-row">
          <button class="control-button" type="button" :disabled="actionInFlight" @click="controller.connect">
            Connect
          </button>
          <button class="control-button" type="button" :disabled="actionInFlight" @click="controller.disconnect">
            Disconnect
          </button>
        </div>
        <div class="state-actions">
          <button
            v-for="stateAction in BUDDY_STATE_ACTIONS"
            :key="stateAction.state"
            class="state-action"
            type="button"
            :disabled="actionInFlight"
            @click="controller.sendState(stateAction.state)"
          >
            {{ stateAction.label }}
          </button>
        </div>
        <div class="vision-controls">
          <button
            class="vision-start-button"
            type="button"
            :disabled="actionInFlight || !visionStatus?.enabled || visionStatus?.active"
            @click="controller.startVision"
          >
            {{ visionStatus?.active ? "Face Detection Ready" : "Start Face Detection" }}
          </button>
          <label
            class="vision-toggle"
            :class="{ active: visionStatus?.enabled, disabled: actionInFlight }"
          >
            <span>
              <strong>Vision</strong>
              <em>{{ visionStatus?.enabled ? "Enabled" : "Disabled" }}</em>
            </span>
            <input
              type="checkbox"
              :checked="Boolean(visionStatus?.enabled)"
              :disabled="actionInFlight"
              @change="controller.setVisionEnabled(Boolean($event.target.checked))"
            />
            <span class="vision-toggle-radio" aria-hidden="true"></span>
          </label>
        </div>
        <p class="control-hint">{{ visionHint }}</p>
      </section>

      <section class="dashboard-panel dashboard-panel-wide" aria-label="LLM model settings">
        <header>
          <span>LLM Model</span>
          <strong>{{ modelSettings.state.statusLabel.value }}</strong>
        </header>
        <form class="model-settings-form" @submit.prevent="modelSettings.save">
          <label class="model-settings-field">
            <span>OpenRouter model ID</span>
            <input
              v-model="modelInput"
              type="text"
              maxlength="200"
              autocomplete="off"
              placeholder="deepseek/deepseek-v4-flash-0731"
              :disabled="modelSettings.state.saveInFlight.value"
            />
          </label>
          <button
            class="control-button model-settings-save"
            type="submit"
            :disabled="modelSettings.state.saveInFlight.value"
          >
            {{ modelSettings.state.saveInFlight.value ? "Applying..." : "Apply model" }}
          </button>
        </form>
        <p class="dashboard-note">{{ modelSettings.state.statusMessage.value }} Active runs keep their current model.</p>
      </section>

      <section class="dashboard-panel dashboard-panel-wide">
        <header>
          <span>Recent Events</span>
          <strong>{{ filteredEvents.length }} / {{ buddyEvents.length }}</strong>
        </header>
        <div class="event-toolbar">
          <input
            v-model.trim="eventFilter"
            type="search"
            placeholder="Filter by event type or content"
            aria-label="Filter recent events"
          />
          <button
            class="control-button"
            type="button"
            :disabled="!eventFilter"
            @click="eventFilter = ''"
          >
            Clear
          </button>
        </div>
        <div v-if="filteredEvents.length" class="dashboard-events">
          <article v-for="event in filteredEvents" :key="event.id" class="dashboard-event">
            <div>
              <strong>{{ event.type }}</strong>
              <span :title="event.received_at || ''">{{ formatBuddyEventTime(event.received_at) }}</span>
            </div>
            <dl v-if="buddyEventDetails(event).length" class="event-details">
              <div v-for="detail in buddyEventDetails(event)" :key="detail.label">
                <dt>{{ detail.label }}</dt>
                <dd>{{ detail.value }}</dd>
              </div>
            </dl>
            <p v-else class="event-message">{{ event.raw || "No additional details." }}</p>
          </article>
        </div>
        <div v-else class="dashboard-empty">
          {{ buddyEvents.length ? "No events match this filter." : "No Buddy events recorded." }}
        </div>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted } from "vue";

import {
  BUDDY_STATE_ACTIONS,
  buddyEventDetails,
  formatBuddyEventTime,
} from "./buddyDashboardController";

const props = defineProps({
  controller: { type: Object, required: true },
  management: { type: Object, required: true },
  modelSettings: { type: Object, required: true },
});

defineEmits(["save-management-token", "clear-management-token"]);

const {
  buddyEvents,
  eventFilter,
  visionStatus,
  dashboardStatus,
  actionInFlight,
  statusLabel,
  statusCards,
  filteredEvents,
  visionHint,
} = props.controller.state;
const { token: managementToken, input: managementInput, accessRequired } = props.management.state;

const managementTokenInput = computed({
  get: () => managementInput.value,
  set: (value) => {
    managementInput.value = value;
  },
});
const managementTokenStatus = computed(() =>
  managementToken.value ? "Token saved" : "Token missing",
);
const managementTokenHint = computed(() => {
  if (accessRequired.value && !managementToken.value) {
    return "Remote dashboard access needs an admin token.";
  }
  if (accessRequired.value) {
    return "Saved token was rejected by the server.";
  }
  if (managementToken.value) {
    return "Token saved in this browser.";
  }
  return "Set ANOMALO_ADMIN_TOKEN, then save it here.";
});

const modelInput = computed({
  get: () => props.modelSettings.state.draft.value,
  set: (value) => {
    props.modelSettings.state.draft.value = value;
  },
});

onMounted(() => {
  props.controller.startPolling();
  void props.controller.refresh();
  void props.modelSettings.load();
});

onBeforeUnmount(() => {
  props.controller.stopPolling();
});
</script>
