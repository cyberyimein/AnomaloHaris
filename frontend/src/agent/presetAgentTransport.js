import { ref } from "vue";

const TERMINAL_EVENTS = new Set(["run.finished", "run.error", "run.stopped"]);

export function createPresetAgentTransport({
  onEvent,
  onError,
  fetchImpl = globalThis.fetch,
  checkpointPollAttempts = 10,
  checkpointPollDelayMs = 100,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const sessionId = ref("");
  const runActive = ref(false);
  const resumeAvailable = ref(false);

  let activeController = null;
  let activeRunId = "unknown";
  let terminalEventSeen = false;

  async function send(agentRef, message, nextSessionId) {
    return request(agentRef, nextSessionId, { message, resume: false });
  }

  async function resume(agentRef, nextSessionId) {
    return request(agentRef, nextSessionId, { message: null, resume: true });
  }

  function stopRun() {
    if (!activeController || !runActive.value) {
      return false;
    }
    activeController.abort();
    return true;
  }

  function switchSession(nextSessionId, { canResume = false } = {}) {
    const normalized = String(nextSessionId || "").trim();
    sessionId.value = normalized;
    runActive.value = false;
    resumeAvailable.value = Boolean(normalized && canResume);
    activeRunId = "unknown";
    terminalEventSeen = false;
    return normalized;
  }

  async function request(agentRef, nextSessionId, { message, resume: isResume }) {
    if (runActive.value || !agentRef || !nextSessionId || !fetchImpl) {
      return false;
    }

    switchSession(nextSessionId);
    runActive.value = true;
    resumeAvailable.value = false;
    activeRunId = "unknown";
    terminalEventSeen = false;
    const controller = new AbortController();
    activeController = controller;

    try {
      const response = await fetchImpl(
        `/api/agents/${encodeURIComponent(agentRef)}/chat/stream`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            session_id: nextSessionId,
            resume: isResume,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const payload = await readErrorPayload(response);
        throw new Error(payload.detail || payload.error || `Preset agent request failed (${response.status}).`);
      }

      const responseSessionId = response.headers?.get("X-Anomalo-Session-Id");
      if (responseSessionId) {
        switchSession(responseSessionId);
      }
      await readNdjson(response.body?.getReader?.(), (event) => {
        activeRunId = event.run_id || activeRunId;
        if (TERMINAL_EVENTS.has(event.type)) {
          terminalEventSeen = true;
          runActive.value = false;
          resumeAvailable.value = Boolean(event.data?.can_resume);
        } else if (event.type === "run.started") {
          runActive.value = true;
          resumeAvailable.value = false;
        }
        onEvent?.(event);
      }, response);
      if (!terminalEventSeen) {
        runActive.value = false;
      }
      return true;
    } catch (error) {
      if (controller.signal.aborted) {
        const checkpointed = await waitForCheckpoint(nextSessionId);
        runActive.value = false;
        resumeAvailable.value = checkpointed;
        if (!terminalEventSeen) {
          onEvent?.({
            type: "run.stopped",
            session_id: nextSessionId,
            run_id: activeRunId,
            data: { reason: "user_stop", checkpointed, can_resume: checkpointed },
          });
        }
        return true;
      }

      runActive.value = false;
      resumeAvailable.value = false;
      onError?.(error);
      onEvent?.({
        type: "run.error",
        session_id: nextSessionId,
        run_id: activeRunId,
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      return false;
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
  }

  async function waitForCheckpoint(nextSessionId) {
    const attempts = Math.max(1, Number(checkpointPollAttempts) || 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(
          `/api/sessions/${encodeURIComponent(nextSessionId)}`,
        );
        if (response.ok) {
          const payload = await response.json();
          if (payload?.can_resume) {
            return true;
          }
        }
      } catch {
        // The stream abort and checkpoint write can race; retry briefly.
      }
      if (attempt + 1 < attempts) {
        await delayImpl(checkpointPollDelayMs);
      }
    }
    return false;
  }

  return {
    state: { sessionId, runActive, resumeAvailable },
    send,
    resume,
    stopRun,
    switchSession,
  };
}

async function readNdjson(reader, onEvent, response) {
  if (!reader) {
    const text = await response.text();
    parseNdjson(text, onEvent);
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    lines.forEach((line) => parseNdjsonLine(line, onEvent));
    if (done) {
      parseNdjsonLine(buffer, onEvent);
      return;
    }
  }
}

function parseNdjson(text, onEvent) {
  String(text || "")
    .split(/\r?\n/)
    .forEach((line) => parseNdjsonLine(line, onEvent));
}

function parseNdjsonLine(line, onEvent) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return;
  }
  try {
    onEvent(JSON.parse(trimmed));
  } catch (error) {
    throw new Error(`Invalid preset agent event: ${error.message}`);
  }
}

async function readErrorPayload(response) {
  try {
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}
