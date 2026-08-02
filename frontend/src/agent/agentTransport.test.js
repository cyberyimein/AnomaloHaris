import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentTransport } from "./agentTransport";

class FakeSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, value = {}) {
    this.listeners.get(type)?.(value);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.closed = true;
  }
}

function createStorage(sessionId = "session_existing") {
  const values = new Map([["anomalo.session", sessionId]]);
  return {
    getItem: vi.fn((key) => values.get(key) || null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentTransport", () => {
  it("connects, projects messages, and sends user turns", () => {
    const sockets = [];
    const onEvent = vi.fn();
    const onState = vi.fn();
    const transport = createAgentTransport({
      onEvent,
      onState,
      storage: createStorage(),
      location: { protocol: "http:", host: "anomalo.test" },
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    transport.connect();
    sockets[0].readyState = FakeSocket.OPEN;
    sockets[0].emit("open");
    sockets[0].emit("message", { data: JSON.stringify({ type: "run.started" }) });

    expect(sockets[0].url).toBe("ws://anomalo.test/ws/chat/session_existing");
    expect(transport.state.connectionStatus.value).toBe("Connected");
    expect(onState).toHaveBeenCalledWith("Idle", "Connected. Waiting for input.");
    expect(onEvent).toHaveBeenCalledWith({ type: "run.started" });
    expect(transport.send("hello")).toBe(true);
    expect(transport.state.runActive.value).toBe(true);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: "user.message",
      content: "hello",
    });
    expect(transport.stopRun()).toBe(true);
    expect(JSON.parse(sockets[0].sent[1])).toEqual({ type: "run.stop" });
    sockets[0].emit("message", {
      data: JSON.stringify({ type: "run.stopped", data: { can_resume: true } }),
    });
    expect(transport.state.runActive.value).toBe(false);
    expect(transport.state.resumeAvailable.value).toBe(true);
    expect(transport.resumeRun()).toBe(true);
    expect(JSON.parse(sockets[0].sent[2])).toEqual({ type: "run.resume" });
    expect(transport.state.runActive.value).toBe(true);
    sockets[0].emit("message", {
      data: JSON.stringify({ type: "run.error", data: { can_resume: true } }),
    });
    expect(transport.state.runActive.value).toBe(false);
    expect(transport.state.resumeAvailable.value).toBe(true);
  });

  it("reconnects after the active socket closes and ignores stale sockets", () => {
    vi.useFakeTimers();
    const sockets = [];
    const onEvent = vi.fn();
    const transport = createAgentTransport({
      onEvent,
      storage: createStorage(),
      location: { protocol: "https:", host: "anomalo.test" },
      reconnectDelayMs: 25,
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    transport.connect();
    sockets[0].emit("close");
    vi.advanceTimersByTime(25);
    sockets[0].emit("message", { data: JSON.stringify({ type: "stale" }) });
    sockets[1].emit("message", { data: JSON.stringify({ type: "current" }) });

    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toMatch(/^wss:\/\/anomalo\.test/);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: "current" });
  });

  it("starts a fresh persisted session and closes the previous socket", () => {
    const sockets = [];
    const storage = createStorage();
    const transport = createAgentTransport({
      storage,
      location: { protocol: "http:", host: "anomalo.test" },
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    transport.connect();
    const nextSessionId = transport.startNewSession();

    expect(sockets[0].closed).toBe(true);
    expect(nextSessionId).toMatch(/^session_[a-f0-9]{32}$/);
    expect(storage.setItem).toHaveBeenLastCalledWith("anomalo.session", nextSessionId);
    expect(sockets[1].url).toContain(nextSessionId);
  });

  it("switches to an existing persisted session", () => {
    const sockets = [];
    const storage = createStorage();
    const transport = createAgentTransport({
      storage,
      location: { protocol: "http:", host: "anomalo.test" },
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    transport.connect();
    const activeSessionId = transport.switchSession("session_history");

    expect(activeSessionId).toBe("session_history");
    expect(sockets[0].closed).toBe(true);
    expect(sockets[1].url).toContain("session_history");
    expect(storage.setItem).toHaveBeenLastCalledWith("anomalo.session", "session_history");
    expect(transport.state.runActive.value).toBe(false);
    expect(transport.state.resumeAvailable.value).toBe(false);
  });
});
