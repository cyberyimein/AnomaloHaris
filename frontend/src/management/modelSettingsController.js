import { computed, ref } from "vue";

export function createModelSettingsController({
  requestJson,
  markAccessError = () => {},
  clearAccessError = () => {},
} = {}) {
  const model = ref("");
  const draft = ref("");
  const source = ref("");
  const updatedAt = ref(null);
  const status = ref("idle");
  const statusMessage = ref("Model settings are not loaded.");
  const saveInFlight = ref(false);

  const statusLabel = computed(() => {
    if (status.value === "loading") {
      return "Loading";
    }
    if (status.value === "saving") {
      return "Saving";
    }
    if (status.value === "error") {
      return "Unavailable";
    }
    if (source.value === "runtime") {
      return "Runtime override";
    }
    if (source.value === "environment") {
      return "Environment default";
    }
    return "Not loaded";
  });

  async function load() {
    status.value = "loading";
    try {
      const payload = await requestJson("/api/manage/model");
      model.value = String(payload.model || "");
      draft.value = model.value;
      source.value = payload.source || "";
      updatedAt.value = payload.updated_at || null;
      status.value = "ready";
      statusMessage.value =
        source.value === "runtime"
          ? "This model is persisted in the deployment data volume."
          : "This model comes from the deployment environment configuration.";
      clearAccessError();
      return payload;
    } catch (error) {
      markAccessError(error);
      status.value = "error";
      statusMessage.value = `Model settings failed to load: ${formatError(error)}`;
      return null;
    }
  }

  async function save() {
    const nextModel = draft.value.trim();
    if (!nextModel) {
      status.value = "error";
      statusMessage.value = "Enter a model identifier first.";
      return false;
    }

    saveInFlight.value = true;
    status.value = "saving";
    statusMessage.value = "Applying model to new runs...";
    try {
      const payload = await requestJson("/api/manage/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: nextModel }),
      });
      model.value = String(payload.model || nextModel);
      draft.value = model.value;
      source.value = payload.source || "runtime";
      updatedAt.value = payload.updated_at || null;
      status.value = "ready";
      statusMessage.value = "Model updated. New conversations will use it.";
      clearAccessError();
      return true;
    } catch (error) {
      markAccessError(error);
      status.value = "error";
      statusMessage.value = `Model update failed: ${formatError(error)}`;
      return false;
    } finally {
      saveInFlight.value = false;
    }
  }

  return {
    state: {
      model,
      draft,
      source,
      updatedAt,
      status,
      statusLabel,
      statusMessage,
      saveInFlight,
    },
    load,
    save,
  };
}

function formatError(error) {
  return String(error?.detail || error?.message || error || "Unknown error");
}
