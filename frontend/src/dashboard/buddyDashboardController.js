import { computed, ref } from "vue";

const POLL_INTERVAL_MS = 10000;

export const BUDDY_STATE_ACTIONS = [
  { state: "idle", label: "Idle" },
  { state: "listening", label: "Listen" },
  { state: "thinking", label: "Think" },
  { state: "speaking", label: "Speak" },
  { state: "done", label: "Done" },
  { state: "stop", label: "Stop" },
];

export function createBuddyDashboardController({
  requestJson,
  markAccessError = () => {},
  clearAccessError = () => {},
  now = () => new Date(),
  scheduler = globalThis,
} = {}) {
  const buddyStatus = ref(null);
  const buddyEvents = ref([]);
  const eventFilter = ref("");
  const dashboardStatus = ref("Dashboard idle.");
  const actionInFlight = ref(false);
  let pollTimer = null;

  const statusLabel = computed(() => {
    if (!buddyStatus.value) return "Unknown";
    if (buddyStatus.value.connected) return "Connected";
    if (buddyStatus.value.listening) return "Listening";
    return "Offline";
  });
  const statusCards = computed(() => {
    const status = buddyStatus.value || {};
    return [
      { label: "Connection", value: statusLabel.value },
      { label: "Transport", value: status.transport || "none" },
      { label: "Client", value: status.client_address || status.tcp_client_ip || "none" },
      { label: "Audio", value: status.audio_input_active ? "active" : "idle" },
      { label: "Queued", value: String(status.queued_audio_turns ?? 0) },
      { label: "Events", value: String(status.recent_event_count ?? buddyEvents.value.length) },
    ];
  });
  const filteredEvents = computed(() => {
    const query = eventFilter.value.trim().toLowerCase();
    if (!query) return buddyEvents.value;
    return buddyEvents.value.filter((event) =>
      [event?.type, event?.raw, event?.received_at, JSON.stringify(event?.payload || {})]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  });

  async function refresh() {
    actionInFlight.value = true;
    dashboardStatus.value = "Refreshing Buddy dashboard...";
    try {
      await loadSnapshot();
      clearAccessError();
      dashboardStatus.value = updatedMessage(now());
    } catch (error) {
      markAccessError(error);
      dashboardStatus.value = `Dashboard refresh failed: ${formatError(error)}`;
    } finally {
      actionInFlight.value = false;
    }
  }

  async function poll() {
    if (actionInFlight.value) return;
    try {
      await loadSnapshot();
      clearAccessError();
      dashboardStatus.value = updatedMessage(now());
    } catch (error) {
      markAccessError(error);
      dashboardStatus.value = `Dashboard refresh failed: ${formatError(error)}`;
    }
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = scheduler.setInterval(() => void poll(), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer === null) return;
    scheduler.clearInterval(pollTimer);
    pollTimer = null;
  }

  async function connect() {
    await runAction("Connecting Buddy...", async () => {
      buddyStatus.value = await requestJson("/api/buddy/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    });
  }

  async function disconnect() {
    await runAction("Disconnecting Buddy...", async () => {
      buddyStatus.value = await requestJson("/api/buddy/disconnect", { method: "POST" });
    });
  }

  async function sendState(state) {
    await runAction(`Sending ${state} state...`, async () => {
      buddyStatus.value = await requestJson("/api/buddy/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
    });
  }

  function notify(message) {
    dashboardStatus.value = message;
  }

  async function loadSnapshot() {
    const [status, events] = await Promise.all([
      requestJson("/api/buddy/status"),
      requestJson("/api/buddy/events?limit=30"),
    ]);
    buddyStatus.value = status;
    buddyEvents.value = events.events || [];
  }

  async function loadEvents() {
    const payload = await requestJson("/api/buddy/events?limit=30");
    buddyEvents.value = payload.events || [];
  }

  async function runAction(progressMessage, action) {
    actionInFlight.value = true;
    dashboardStatus.value = progressMessage;
    try {
      await action();
      await loadEvents();
      clearAccessError();
      dashboardStatus.value = updatedMessage(now());
    } catch (error) {
      markAccessError(error);
      dashboardStatus.value = formatError(error);
    } finally {
      actionInFlight.value = false;
    }
  }

  return {
    state: {
      buddyStatus,
      buddyEvents,
      eventFilter,
      dashboardStatus,
      actionInFlight,
      statusLabel,
      statusCards,
      filteredEvents,
    },
    refresh,
    poll,
    startPolling,
    stopPolling,
    connect,
    disconnect,
    sendState,
    notify,
  };
}

export function buddyEventDetails(event) {
  return flattenEventDetails(event?.payload || {});
}

export function flattenEventDetails(value, path = [], details = []) {
  if (details.length >= 48) return details;
  if (Array.isArray(value)) {
    if (!value.length) {
      details.push({ label: eventDetailLabel(path), value: "None" });
    } else if (value.every((item) => item === null || typeof item !== "object")) {
      details.push({ label: eventDetailLabel(path), value: value.map(formatEventDetailValue).join(", ") });
    } else {
      value.forEach((item, index) => flattenEventDetails(item, [...path, String(index + 1)], details));
    }
    return details;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length && path.length) details.push({ label: eventDetailLabel(path), value: "None" });
    entries.forEach(([key, item]) => flattenEventDetails(item, [...path, key], details));
    return details;
  }
  details.push({ label: eventDetailLabel(path), value: formatEventDetailValue(value) });
  return details;
}

export function formatBuddyEventTime(value, currentTime = Date.now()) {
  if (!value) return "Unknown time";
  const absolute = formatDateTime(value);
  const relative = formatRelativeTime(value, currentTime);
  return relative ? `${absolute} · ${relative}` : absolute;
}

function eventDetailLabel(path) {
  if (!path.length) return "Detail";
  return path
    .map((part) =>
      /^\d+$/.test(part)
        ? `Item ${part}`
        : String(part).replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase()),
    )
    .join(" › ");
}

function formatEventDetailValue(value) {
  if (isIsoDateTime(value)) return formatDateTime(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function isIsoDateTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function formatRelativeTime(value, currentTime) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const deltaSeconds = Math.round((date.getTime() - currentTime) / 1000);
  const absoluteSeconds = Math.abs(deltaSeconds);
  if (absoluteSeconds < 45) return "just now";
  const units = [["day", 86400], ["hour", 3600], ["minute", 60]];
  const [unit, seconds] = units.find(([, size]) => absoluteSeconds >= size) || ["minute", 60];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(deltaSeconds / seconds),
    unit,
  );
}

function updatedMessage(date) {
  return `Updated ${date.toLocaleTimeString()}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
