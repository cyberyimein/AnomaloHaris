<template>
  <section class="dashboard-view" aria-label="Buddy dashboard">
    <div class="dashboard-hero">
      <div class="dashboard-hero-copy">
        <span>Independent Buddy service</span>
        <h2>Buddy</h2>
        <p>Monitor the external Buddy connection, send lightweight visual states, and inspect recent sanitized events.</p>
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
          <button class="control-button" type="button" :disabled="!eventFilter" @click="eventFilter = ''">
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
});

defineEmits(["save-management-token", "clear-management-token"]);

const {
  buddyEvents,
  eventFilter,
  dashboardStatus,
  actionInFlight,
  statusLabel,
  statusCards,
  filteredEvents,
} = props.controller.state;
const { token: managementToken, input: managementInput, accessRequired } = props.management.state;

const managementTokenInput = computed({
  get: () => managementInput.value,
  set: (value) => { managementInput.value = value; },
});
const managementTokenStatus = computed(() => managementToken.value ? "Token saved" : "Token missing");
const managementTokenHint = computed(() => {
  if (accessRequired.value && !managementToken.value) return "Remote Buddy control needs an admin token.";
  if (accessRequired.value) return "Saved token was rejected by the server.";
  if (managementToken.value) return "Token saved in this browser.";
  return "Set ANOMALOHARIS_ADMIN_TOKEN, then save it here.";
});

onMounted(() => {
  props.controller.startPolling();
  void props.controller.refresh();
});

onBeforeUnmount(() => {
  props.controller.stopPolling();
});
</script>
