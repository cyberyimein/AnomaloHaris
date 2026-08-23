import { computed, ref } from "vue";

const VALID_MODES = new Set(["native", "subagent", "diy"]);
const FALLBACK_OPTIONS = [
  {
    id: "native",
    label: "Model-native search",
    description: "Use the active model's standard Responses API web_search_preview tool.",
    provider: "responses_api",
  },
  {
    id: "subagent",
    label: "Web research subagent",
    description: "Delegate research to the fixed DeepSeek V4 Flash 0731 subagent.",
    provider: "responses_api_subagent",
  },
  {
    id: "diy",
    label: "DIY web tools",
    description: "Use AnomaloHaris's existing DuckDuckGo search and page-fetch tools.",
    provider: "duckduckgo_html",
  },
];

export function createSearchModeController({
  requestJson,
  getSessionId = () => "",
  isDisabled = () => false,
} = {}) {
  const mode = ref("diy");
  const options = ref(FALLBACK_OPTIONS);
  const status = ref("idle");
  const statusMessage = ref("Retrieval mode is not loaded.");
  const saveInFlight = ref(false);
  const sessionId = ref("");
  const selectedOption = computed(
    () => options.value.find((option) => option.id === mode.value) || null,
  );
  let requestSequence = 0;

  async function load(targetSessionId = getSessionId()) {
    const nextSessionId = String(targetSessionId || "").trim();
    if (!nextSessionId) {
      return null;
    }
    const requestId = ++requestSequence;
    sessionId.value = nextSessionId;
    saveInFlight.value = false;
    status.value = "loading";
    try {
      const payload = await requestJson(
        `/api/sessions/${encodeURIComponent(nextSessionId)}/search-mode`,
      );
      if (requestId !== requestSequence) {
        return null;
      }
      if (VALID_MODES.has(payload.mode)) {
        mode.value = payload.mode;
      }
      if (Array.isArray(payload.modes) && payload.modes.length) {
        options.value = payload.modes;
      }
      status.value = "ready";
      statusMessage.value = `Current mode: ${selectedOption.value?.label || mode.value}.`;
      return payload;
    } catch (error) {
      if (requestId !== requestSequence) {
        return null;
      }
      status.value = "error";
      statusMessage.value = `Retrieval mode failed to load: ${formatError(error)}`;
      return null;
    }
  }

  async function select(nextMode) {
    const normalized = String(nextMode || "").trim().toLowerCase();
    const nextSessionId = String(getSessionId() || sessionId.value || "").trim();
    if (
      !VALID_MODES.has(normalized) ||
      !nextSessionId ||
      saveInFlight.value ||
      isDisabled()
    ) {
      return false;
    }
    if (normalized === mode.value && sessionId.value === nextSessionId) {
      return true;
    }

    const requestId = ++requestSequence;
    const isCurrentRequest = () =>
      requestId === requestSequence &&
      String(getSessionId() || sessionId.value || "").trim() === nextSessionId;
    saveInFlight.value = true;
    status.value = "saving";
    statusMessage.value = "Saving retrieval mode for this session...";
    try {
      const payload = await requestJson(
        `/api/sessions/${encodeURIComponent(nextSessionId)}/search-mode`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: normalized }),
        },
      );
      if (!isCurrentRequest()) {
        return false;
      }
      sessionId.value = nextSessionId;
      mode.value = payload.mode || normalized;
      if (Array.isArray(payload.modes) && payload.modes.length) {
        options.value = payload.modes;
      }
      status.value = "ready";
      statusMessage.value = `Saved: ${selectedOption.value?.label || mode.value}.`;
      return true;
    } catch (error) {
      if (!isCurrentRequest()) {
        return false;
      }
      status.value = "error";
      statusMessage.value = `Retrieval mode update failed: ${formatError(error)}`;
      return false;
    } finally {
      if (isCurrentRequest()) {
        saveInFlight.value = false;
      }
    }
  }

  function applyEvent(nextMode) {
    const normalized = String(nextMode || "").trim().toLowerCase();
    if (!VALID_MODES.has(normalized)) {
      return;
    }
    requestSequence += 1;
    saveInFlight.value = false;
    mode.value = normalized;
    status.value = "ready";
    statusMessage.value = `Current mode: ${selectedOption.value?.label || normalized}.`;
  }

  return {
    state: {
      mode,
      options,
      selectedOption,
      status,
      statusMessage,
      saveInFlight,
      sessionId,
    },
    load,
    select,
    applyEvent,
  };
}

function formatError(error) {
  return String(error?.detail || error?.message || error || "Unknown error");
}
