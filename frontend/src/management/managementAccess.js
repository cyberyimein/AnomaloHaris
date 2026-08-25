import { computed, ref } from "vue";

const ADMIN_TOKEN_STORAGE_KEY = "anomaloharis.adminToken";
const LEGACY_ADMIN_TOKEN_STORAGE_KEY = "anomalo.adminToken"; // naming-compat: legacy browser admin token key

export function createManagementAccess({
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
} = {}) {
  const canonicalToken = storage?.getItem(ADMIN_TOKEN_STORAGE_KEY) || "";
  const legacyToken = canonicalToken ? "" : storage?.getItem(LEGACY_ADMIN_TOKEN_STORAGE_KEY) || "";
  const token = ref(canonicalToken || legacyToken);
  if (!canonicalToken && legacyToken) {
    storage?.setItem(ADMIN_TOKEN_STORAGE_KEY, legacyToken);
    storage?.removeItem?.(LEGACY_ADMIN_TOKEN_STORAGE_KEY);
  }
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
    return "Only required when the backend has ANOMALOHARIS_ADMIN_TOKEN configured.";
  });

  function save() {
    token.value = input.value.trim();
    accessRequired.value = false;
    if (token.value) {
      storage?.setItem(ADMIN_TOKEN_STORAGE_KEY, token.value);
      storage?.removeItem?.(LEGACY_ADMIN_TOKEN_STORAGE_KEY);
    } else {
      storage?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      storage?.removeItem?.(LEGACY_ADMIN_TOKEN_STORAGE_KEY);
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
      const detail = payload.detail || payload.error || payload.message;
      const error = new Error(detail || `${response.status} ${response.statusText}`);
      error.status = response.status;
      error.detail = detail;
      error.code = payload.error_code || payload.code;
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
  headers.set("X-AnomaloHaris-Admin-Token", token);
  return { ...options, headers };
}

function requiresManagementAccess(url) {
  return (
    url.startsWith("/api/buddy") ||
    url.startsWith("/api/manage")
  );
}

function isManagementAccessError(error) {
  return (
    error?.status === 403 &&
    String(error?.detail || error?.message || "").includes("Management API requires")
  );
}
