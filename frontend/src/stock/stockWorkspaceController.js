import { ref } from "vue";

import { createStockReportProjection } from "./stockReportProjection";

const DEFAULT_REFRESH_INTERVAL_MS = 15000;

export function createStockWorkspaceController({
  request,
  markAccessError = () => false,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
} = {}) {
  if (typeof request !== "function") {
    throw new TypeError("StockWorkspace requires a request function.");
  }

  const report = ref(null);
  const receivedAt = ref(null);
  const etag = ref(null);
  const revision = ref(0);
  const status = ref("idle");
  const statusMessage = ref("No stock report loaded yet.");
  const refreshInFlight = ref(false);
  const selectedSymbol = ref("");
  const bucketFilter = ref("all");
  const activeSection = ref("market");
  const projection = createStockReportProjection({
    report,
    receivedAt,
    selectedSymbol,
    bucketFilter,
    activeSection,
  });

  let refreshTimer = null;
  let loadPromise = null;

  function load({ silent = false } = {}) {
    if (loadPromise) {
      return loadPromise;
    }
    loadPromise = performLoad({ silent }).finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  async function performLoad({ silent, bypassCache = false }) {
    if (!silent) {
      status.value = "loading";
      statusMessage.value = "Fetching the latest stock analysis report.";
    }

    try {
      const headers =
        !bypassCache && etag.value ? { "If-None-Match": etag.value } : undefined;
      const response = await request("/api/stocks/reports/latest", { headers });
      if (response.status === 304) {
        if (report.value) {
          status.value = "ready";
          statusMessage.value = `Stock report is current (revision ${revision.value}).`;
          return report.value;
        }
        if (!bypassCache) {
          etag.value = null;
          return performLoad({ silent, bypassCache: true });
        }
        throw new Error("Stock report returned 304 without a local cached report.");
      }

      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw responseError(response, payload);
      }
      if (!payload) {
        throw new Error("Stock report endpoint returned an empty response.");
      }

      etag.value = response.headers.get("etag") || payload.report_id || null;
      revision.value = payload.revision || 0;
      receivedAt.value = payload.received_at || null;
      if (payload.report) {
        report.value = payload.report;
        status.value = "ready";
        statusMessage.value = `Loaded ${payload.stock_count ?? projection.stockRows.value.length} stock setups (revision ${revision.value}).`;
        ensureSelectedSymbol();
        return report.value;
      }

      report.value = null;
      etag.value = null;
      revision.value = 0;
      selectedSymbol.value = "";
      status.value = "empty";
      statusMessage.value = "Run the integrated stock scan to populate this view.";
      return null;
    } catch (error) {
      status.value = "error";
      statusMessage.value = `Stock report load failed: ${formatError(error)}`;
      if (!silent || !report.value) {
        clearCachedReport();
      }
      return report.value;
    }
  }

  async function refresh() {
    if (refreshInFlight.value) {
      return;
    }
    refreshInFlight.value = true;
    try {
      if (loadPromise) {
        await loadPromise;
      }
      status.value = "loading";
      statusMessage.value = "Running the integrated market scan.";
      const response = await request("/api/stocks/scan", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw responseError(response, payload);
      }
      etag.value = null;
      await load({ silent: true });
    } catch (error) {
      const accessRequired = markAccessError(error);
      status.value = "error";
      statusMessage.value = accessRequired
        ? "Stock scan requires an admin token. Save it in Dashboard > Admin Access."
        : `Stock scan failed: ${formatError(error)}`;
    } finally {
      refreshInFlight.value = false;
    }
  }

  function selectBucket(filterId) {
    bucketFilter.value = filterId;
    const visibleRows =
      filterId === "all"
        ? projection.stockRows.value
        : projection.stockRows.value.filter(
            (stock) => (stock.bucket || "unbucketed") === filterId,
          );
    if (!visibleRows.some((stock) => stock.symbol === selectedSymbol.value)) {
      selectedSymbol.value =
        visibleRows[0]?.symbol || projection.stockRows.value[0]?.symbol || "";
    }
  }

  function selectSymbol(symbol) {
    if (projection.stockRows.value.some((stock) => stock.symbol === symbol)) {
      selectedSymbol.value = symbol;
    }
  }

  function selectSection(section) {
    activeSection.value = section === "stocks" ? "stocks" : "market";
  }

  function start() {
    if (refreshTimer !== null) {
      return;
    }
    void load({ silent: status.value === "ready" });
    refreshTimer = setIntervalImpl(() => {
      if (!refreshInFlight.value) {
        void load({ silent: true });
      }
    }, refreshIntervalMs);
  }

  function stop() {
    if (refreshTimer === null) {
      return;
    }
    clearIntervalImpl(refreshTimer);
    refreshTimer = null;
  }

  function ensureSelectedSymbol() {
    if (
      !selectedSymbol.value ||
      !projection.stockRows.value.some((stock) => stock.symbol === selectedSymbol.value)
    ) {
      selectedSymbol.value = projection.stockRows.value[0]?.symbol || "";
    }
  }

  function clearCachedReport() {
    report.value = null;
    receivedAt.value = null;
    etag.value = null;
    revision.value = 0;
    selectedSymbol.value = "";
  }

  return {
    state: {
      report,
      receivedAt,
      etag,
      revision,
      status,
      statusMessage,
      refreshInFlight,
      selectedSymbol,
      bucketFilter,
      activeSection,
    },
    projection,
    load,
    refresh,
    selectBucket,
    selectSymbol,
    selectSection,
    start,
    stop,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function responseError(response, payload) {
  const error = new Error(
    payload?.detail || payload?.message || `HTTP ${response.status}`,
  );
  error.status = response.status;
  error.detail = payload?.detail;
  return error;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
