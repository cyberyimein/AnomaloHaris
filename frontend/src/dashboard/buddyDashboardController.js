import { computed, ref } from "vue";

const POLL_INTERVAL_MS = 5000;

export function createBuddyDashboardController({
  requestJson,
  markAccessError = () => {},
  clearAccessError = () => {},
  now = () => new Date(),
  scheduler = globalThis,
} = {}) {
  const buddyStatus = ref(null);
  const observation = ref(null);
  const lastAction = ref(null);
  const dashboardStatus = ref("Waiting for Buddy.");
  const actionInFlight = ref(false);
  const statusFresh = ref(false);
  let pollTimer = null;
  let snapshotSequence = 0;
  let activeDeviceId;
  let pollInFlight = false;

  const statusLabel = computed(() => {
    if (!buddyStatus.value || !statusFresh.value) return "Unknown";
    return buddyStatus.value.connected ? "Online" : "Offline";
  });
  const capabilities = computed(() => buddyStatus.value?.capabilities || []);

  async function refresh() {
    if (actionInFlight.value) return;
    actionInFlight.value = true;
    dashboardStatus.value = "Checking Buddy...";
    try {
      reportSnapshotResult(await loadSnapshot());
    } catch (error) {
      markSnapshotUnavailable(error);
    } finally {
      actionInFlight.value = false;
    }
  }

  async function poll() {
    if (actionInFlight.value || pollInFlight) return;
    pollInFlight = true;
    try {
      reportSnapshotResult(await loadSnapshot());
    } catch (error) {
      markSnapshotUnavailable(error);
    } finally {
      pollInFlight = false;
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
    snapshotSequence += 1;
  }

  async function setPermission(capability, allowed) {
    const deviceId = buddyStatus.value?.deviceId;
    if (!deviceId || actionInFlight.value) return;
    await runAction(`${allowed ? "Allowing" : "Revoking"} ${capability}...`, async () => {
      const response = await requestJson("/api/buddy/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, capability, allowed }),
      });
      if (buddyStatus.value?.deviceId !== deviceId) return;
      if (Array.isArray(response.capabilities)) {
        buddyStatus.value = { ...buddyStatus.value, capabilities: response.capabilities };
      }
      if (!allowed && ["camera.capture", "head.observe"].includes(capability)) {
        observation.value = null;
        if (lastAction.value?.result?.image) lastAction.value = null;
      }
    });
  }

  async function setAgentEnabled(enabled) {
    if (actionInFlight.value) return;
    await runAction(`${enabled ? "Starting" : "Stopping"} Buddy agent...`, async () => {
      const response = await requestJson("/api/buddy/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (typeof response.agentEnabled !== "boolean") {
        throw new Error("Buddy agent response did not include agentEnabled.");
      }
      if (buddyStatus.value) {
        buddyStatus.value = { ...buddyStatus.value, agentEnabled: response.agentEnabled };
      }
    });
  }

  async function invoke(capability, args = {}) {
    const deviceId = buddyStatus.value?.deviceId;
    if (!deviceId || actionInFlight.value) return;
    await runAction(`Running ${capability}...`, async () => {
      const response = await requestJson("/api/buddy/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, capability, args }),
      });
      if (buddyStatus.value?.deviceId !== deviceId) return;
      lastAction.value = { capability, requestId: response.requestId, result: response.result };
    });
  }

  function notify(message) {
    dashboardStatus.value = message;
  }

  async function loadSnapshot() {
    const sequence = ++snapshotSequence;
    let status;
    try {
      status = await requestJson("/api/buddy/status");
    } catch (error) {
      return { sequence, error };
    }
    if (sequence !== snapshotSequence) return { sequence, stale: true };

    statusFresh.value = true;
    buddyStatus.value = status;
    const deviceId = status.deviceId;
    if (activeDeviceId !== deviceId) {
      observation.value = null;
      lastAction.value = null;
      activeDeviceId = deviceId;
    }
    if (!deviceId) {
      observation.value = null;
      return { sequence };
    }

    try {
      const response = await requestJson("/api/buddy/observation");
      if (sequence !== snapshotSequence || buddyStatus.value?.deviceId !== deviceId) return { sequence, stale: true };
      const candidate = response.observation;
      observation.value = candidate?.deviceId === deviceId ? candidate : null;
    } catch {
      if (sequence === snapshotSequence && buddyStatus.value?.deviceId === deviceId) observation.value = null;
    }
    return { sequence };
  }

  function reportSnapshotResult(result) {
    if (result.sequence !== snapshotSequence) return false;
    if (result.error) {
      markSnapshotUnavailable(result.error);
      return false;
    }
    clearAccessError();
    dashboardStatus.value = updatedMessage(now());
    return true;
  }

  function markSnapshotUnavailable(error) {
    statusFresh.value = false;
    observation.value = null;
    lastAction.value = null;
    markAccessError(error);
    dashboardStatus.value = `Refresh failed: ${formatError(error)}`;
  }

  async function runAction(progressMessage, action) {
    if (actionInFlight.value) return;
    actionInFlight.value = true;
    dashboardStatus.value = progressMessage;
    try {
      await action();
      reportSnapshotResult(await loadSnapshot());
    } catch (error) {
      const snapshot = await loadSnapshot();
      if (snapshot.sequence === snapshotSequence && snapshot.error) {
        markSnapshotUnavailable(snapshot.error);
      }
      markAccessError(error);
      dashboardStatus.value = formatError(error);
    } finally {
      actionInFlight.value = false;
    }
  }

  return {
    state: {
      buddyStatus,
      observation,
      lastAction,
      dashboardStatus,
      actionInFlight,
      statusFresh,
      statusLabel,
      capabilities,
    },
    refresh,
    poll,
    startPolling,
    stopPolling,
    setPermission,
    setAgentEnabled,
    invoke,
    notify,
  };
}

function updatedMessage(date) {
  return `Updated ${date.toLocaleTimeString()}.`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
