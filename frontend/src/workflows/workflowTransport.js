export function createWorkflowTransport({ management, workflowToken = "" }) {
  const requestJson = management.requestJson;
  let serviceToken = workflowToken;

  function withWorkflowAccess(options = {}) {
    if (!serviceToken) return options;
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${serviceToken}`);
    return { ...options, headers };
  }

  function setWorkflowToken(value) {
    serviceToken = String(value || "").trim();
  }

  return {
    capabilities() {
      return requestJson("/api/manage/workflow-capabilities");
    },
    validate(definition) {
      return requestJson("/api/manage/workflows/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(definition),
      });
    },
    importDraft(definition) {
      return requestJson("/api/manage/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(definition),
      });
    },
    list() {
      return requestJson("/api/manage/workflows");
    },
    get(ref) {
      return requestJson(workflowPath(ref));
    },
    validateSaved(ref) {
      return requestJson(`${workflowPath(ref)}/validate`, { method: "POST" });
    },
    publish(ref) {
      return requestJson(`${workflowPath(ref)}/publish`, { method: "POST" });
    },
    retire(ref) {
      return requestJson(`${workflowPath(ref)}/retire`, { method: "POST" });
    },
    deleteDraft(ref) {
      return requestJson(workflowPath(ref), { method: "DELETE" });
    },
    exportDefinition(ref) {
      return requestJson(`${workflowPath(ref)}/export`);
    },
    run(ref, input, idempotencyKey) {
      return requestJson(`${runPath(ref)}/runs`, withWorkflowAccess({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          metadata: { client_id: "workflows-tab" },
        }),
      }));
    },
    async runStream(ref, input, idempotencyKey, onEvent) {
      const response = await management.request(`${runPath(ref)}/runs/stream`, withWorkflowAccess({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          metadata: { client_id: "workflows-tab" },
        }),
      }));
      if (!response.ok) {
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { /* handled by the stable HTTP status below */ }
        const error = new Error(payload.error || `${response.status} ${response.statusText}`);
        error.status = response.status;
        error.code = payload.error_code;
        throw error;
      }
      if (!response.body?.getReader) return { events: [] };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          events.push(event);
          onEvent?.(event);
        }
        if (chunk.done) break;
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer);
        events.push(event);
        onEvent?.(event);
      }
      return { events };
    },
    getRun(runId) {
      return requestJson(`/api/runs/${encodeURIComponent(runId)}`, withWorkflowAccess());
    },
    runEvents(runId, afterSequence = 0) {
      return requestJson(`/api/runs/${encodeURIComponent(runId)}/events?after_sequence=${afterSequence}`, withWorkflowAccess());
    },
    stop(runId) {
      return requestJson(`/api/runs/${encodeURIComponent(runId)}/stop`, withWorkflowAccess({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "user_stop" }) }));
    },
    setWorkflowToken,
  };
}

export function parseWorkflowJson(text) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function workflowPath(ref) {
  const separator = String(ref).lastIndexOf("@");
  if (separator <= 0) throw new Error(`Invalid Workflow Ref: ${ref}`);
  const name = encodeURIComponent(String(ref).slice(0, separator));
  const version = encodeURIComponent(String(ref).slice(separator + 1));
  return `/api/manage/workflows/${name}/versions/${version}`;
}

export function runPath(ref) {
  const separator = String(ref).lastIndexOf("@");
  if (separator <= 0) throw new Error(`Invalid Workflow Ref: ${ref}`);
  const name = encodeURIComponent(String(ref).slice(0, separator));
  const version = encodeURIComponent(String(ref).slice(separator + 1));
  return `/api/workflows/${name}/versions/${version}`;
}

export function downloadJson(value, filename, documentImpl = globalThis.document) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = documentImpl.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
