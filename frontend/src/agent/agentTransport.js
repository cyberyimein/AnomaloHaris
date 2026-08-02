import { ref } from "vue";

const DEFAULT_RECONNECT_DELAY_MS = 1000;

export function createAgentTransport({
  onEvent,
  onState,
  onError,
  socketFactory = (url) => new WebSocket(url),
  storage = globalThis.localStorage,
  location = globalThis.location,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
} = {}) {
  const sessionId = ref(loadSessionId(storage));
  const connectionStatus = ref("Disconnected");
  const connectionClass = ref("error");
  const sendDisabled = ref(true);
  const runActive = ref(false);
  const resumeAvailable = ref(false);

  let socket = null;
  let reconnectTimer = null;
  let stopped = false;

  function connect() {
    stopped = false;
    clearReconnectTimer();
    const nextSocket = socketFactory(socketUrl(location, sessionId.value));
    socket = nextSocket;

    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket || stopped) {
        return;
      }
      connectionStatus.value = "Connected";
      connectionClass.value = "ok";
      sendDisabled.value = false;
      onState?.("Idle", "Connected. Waiting for input.");
    });

    nextSocket.addEventListener("close", () => {
      if (socket !== nextSocket || stopped) {
        return;
      }
      connectionStatus.value = "Disconnected";
      connectionClass.value = "error";
      sendDisabled.value = true;
      runActive.value = false;
      onState?.("Offline", "WebSocket disconnected. Reconnecting...");
      clearReconnectTimer();
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    });

    nextSocket.addEventListener("message", (message) => {
      if (socket !== nextSocket || stopped) {
        return;
      }
      try {
        const event = JSON.parse(message.data);
        if (event.type === "session.state") {
          runActive.value = false;
          resumeAvailable.value = Boolean(event.data?.can_resume);
        } else if (event.type === "run.started") {
          runActive.value = true;
          resumeAvailable.value = false;
        } else if (event.type === "run.finished") {
          runActive.value = false;
          resumeAvailable.value = false;
        } else if (event.type === "run.error") {
          runActive.value = false;
          resumeAvailable.value = Boolean(event.data?.can_resume);
        } else if (event.type === "run.stopped") {
          runActive.value = false;
          resumeAvailable.value = Boolean(event.data?.can_resume);
        }
        onEvent?.(event);
      } catch (error) {
        onError?.(error);
      }
    });
  }

  function send(content) {
    const value = String(content || "");
    if (!value.trim() || socket?.readyState !== socketOpenState(socket)) {
      return false;
    }
    runActive.value = true;
    resumeAvailable.value = false;
    socket.send(JSON.stringify({ type: "user.message", content: value }));
    return true;
  }

  function stopRun() {
    if (!runActive.value || socket?.readyState !== socketOpenState(socket)) {
      return false;
    }
    socket.send(JSON.stringify({ type: "run.stop" }));
    return true;
  }

  function resumeRun() {
    if (
      !resumeAvailable.value ||
      runActive.value ||
      socket?.readyState !== socketOpenState(socket)
    ) {
      return false;
    }
    runActive.value = true;
    resumeAvailable.value = false;
    socket.send(JSON.stringify({ type: "run.resume" }));
    return true;
  }

  function switchSession(nextSessionId) {
    const normalizedSessionId = String(nextSessionId || "").trim();
    if (!normalizedSessionId) {
      return sessionId.value;
    }
    clearReconnectTimer();
    const previousSocket = socket;
    socket = null;
    previousSocket?.close();
    sessionId.value = normalizedSessionId;
    storage?.setItem("anomalo.session", sessionId.value);
    connectionStatus.value = "Connecting";
    connectionClass.value = "muted";
    sendDisabled.value = true;
    runActive.value = false;
    resumeAvailable.value = false;
    connect();
    return sessionId.value;
  }

  function startNewSession() {
    return switchSession(createSessionId());
  }

  function stop() {
    stopped = true;
    clearReconnectTimer();
    const previousSocket = socket;
    socket = null;
    previousSocket?.close();
    sendDisabled.value = true;
    runActive.value = false;
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  return {
    state: {
      sessionId,
      connectionStatus,
      connectionClass,
      sendDisabled,
      runActive,
      resumeAvailable,
    },
    connect,
    send,
    stopRun,
    resumeRun,
    switchSession,
    startNewSession,
    stop,
  };
}

function loadSessionId(storage) {
  const existing = storage?.getItem("anomalo.session");
  if (existing) {
    return existing;
  }
  const generated = createSessionId();
  storage?.setItem("anomalo.session", generated);
  return generated;
}

function createSessionId() {
  return `session_${createUuid().replaceAll("-", "")}`;
}

function createUuid() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = char === "x" ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

function socketUrl(location, sessionId) {
  const protocol = location?.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location?.host || "127.0.0.1"}/ws/chat/${sessionId}`;
}

function socketOpenState(socket) {
  return socket?.OPEN ?? globalThis.WebSocket?.OPEN ?? 1;
}
