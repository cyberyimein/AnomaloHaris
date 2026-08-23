import { computed, ref } from "vue";

export function createManagementAccess({
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
} = {}) {
  const token = ref(storage?.getItem("anomalo.adminToken") || "");
  const input = ref(token.value);
  const accessRequired = ref(false);

  const status = computed(() =>
    token.value ? "Configured for this browser" : "Not configured",
  );
  const hint = computed(() => {
    if (accessRequired.value) {
      return "Remote dashboard access needs an admin token.";
    }
    if (token.value) {
      return "Stored only in this browser and sent with management requests.";
    }
    return "Only required when the backend has ANOMALO_ADMIN_TOKEN configured.";
  });

  function save() {
    token.value = input.value.trim();
    accessRequired.value = false;
    if (token.value) {
      storage?.setItem("anomalo.adminToken", token.value);
    } else {
      storage?.removeItem("anomalo.adminToken");
    }
    return token.value;
  }

  function clear() {
    input.value = "";
    return save();
  }

  function markError(error) {
    if (isManagementAccessError(error)) {
      accessRequired.value = true;
      return true;
    }
    return false;
  }

  function request(url, options) {
    return fetchImpl(url, withManagementAccess(url, options, token.value));
  }

  async function requestJson(url, options) {
    const response = await request(url, options);
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

  return {
    state: {
      token,
      input,
      accessRequired,
      status,
      hint,
    },
    save,
    clear,
    markError,
    request,
    requestJson,
  };
}

function withManagementAccess(url, options = {}, token) {
  if (!requiresManagementAccess(url) || !token) {
    return options;
  }
  const headers = new Headers(options.headers || {});
  headers.set("X-Anomalo-Admin-Token", token);
  return { ...options, headers };
}

function requiresManagementAccess(url) {
  return (
    url.startsWith("/api/manage")
  );
}

function isManagementAccessError(error) {
  return (
    error?.status === 403 &&
    String(error?.detail || error?.message || "").includes("Management API requires")
  );
}
