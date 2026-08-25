import { describe, expect, it } from "vitest";

import { BuddyService, settingsFromEnv, startBuddyService, type BuddyServerSettings } from "./index.js";

class FakeGateway {
  states: Array<[string, string | undefined]> = [];

  status(): Record<string, unknown> {
    return {
      connected: true,
      transport: "fake",
      last_event: {
        id: 1,
        type: "buddy.state.changed",
        payload: { state: "coding" },
        raw: "secret device log",
        source: "fake",
        received_at: "2026-01-01T00:00:00.000Z",
      },
    };
  }

  getEvents(): Array<Record<string, unknown>> {
    return [{
      id: 1,
      type: "buddy.state.changed",
      payload: { state: "coding" },
      raw: "secret device log",
      source: "fake",
      received_at: "2026-01-01T00:00:00.000Z",
    }];
  }

  setState(state: string, text?: string): Record<string, unknown> {
    this.states.push([state, text]);
    return { state };
  }

  setText(text: string): Record<string, unknown> {
    return { text };
  }

  showApproval(): Record<string, unknown> {
    return {};
  }

  async requestApproval(): Promise<{ payload: Record<string, unknown> }> {
    return { payload: { choice: "approve" } };
  }
}

const settings: BuddyServerSettings = {
  host: "127.0.0.1",
  port: 8765,
  serviceToken: "",
  hookToken: "",
  approvalEnabled: false,
  approvalTimeoutSeconds: 30,
  autoConnect: false,
  gateway: {
    transport: "tcp",
    serialPort: undefined,
    baudRate: 115_200,
    tcpHost: "127.0.0.1",
    tcpPort: 8766,
    tcpClientIp: undefined,
    hostName: "test-host",
    eventBufferSize: 16,
  },
};

describe("BuddyService", () => {
  it("keeps health, control, and agent event routes in one Node service", async () => {
    const gateway = new FakeGateway();
    const service = new BuddyService(settings, { gateway: gateway as never });
    const [healthStatus, health] = await service.handleGet("/healthz", new URLSearchParams());
    const [stateStatus, state] = await service.handlePost("/v1/buddy/state", { state: "coding", text: "working" });
    const [eventStatus, event] = await service.handlePost("/v1/agent/events", { name: "UserPromptSubmit", session_id: "session-1", sequence: 1 });
    expect(healthStatus).toBe(200);
    expect(health).toMatchObject({ ok: true, runtime: "node" });
    expect(stateStatus).toBe(200);
    expect((state.status as Record<string, unknown>).state).toBe("coding");
    expect(eventStatus).toBe(200);
    expect(event).toMatchObject({ state: "RUNNING", buddy_state: "coding" });
    expect(gateway.states).toEqual([["coding", "working"], ["coding", undefined]]);
  });

  it("returns only the compact effect from compatibility hook routes", async () => {
    const service = new BuddyService(settings, { gateway: new FakeGateway() as never });
    const [status, effect] = await service.handlePost("/api/copilot/hooks/PreToolUse", {
      session_id: "session-1", sequence: 1, tool_name: "shell",
    });
    expect(status).toBe(200);
    expect(effect).toEqual({});
  });

  it("does not expose raw device logs through service responses", async () => {
    const service = new BuddyService(settings, { gateway: new FakeGateway() as never });
    const [statusStatus, statusPayload] = await service.handleGet("/v1/buddy/status", new URLSearchParams());
    const [eventsStatus, eventsPayload] = await service.handleGet("/v1/buddy/events", new URLSearchParams());

    expect(statusStatus).toBe(200);
    expect(eventsStatus).toBe(200);
    expect(statusPayload).not.toMatchObject({ status: { last_event: { raw: expect.anything() } } });
    expect(eventsPayload).not.toMatchObject({ events: [{ raw: expect.anything() }] });
  });

  it("uses a safe TCP default and validates public listener configuration", () => {
    const resolved = settingsFromEnv({ BUDDY_AUTO_CONNECT: "false" });
    expect(resolved.autoConnect).toBe(false);
    expect(resolved.gateway.tcpHost).toBe("127.0.0.1");
    expect(() => settingsFromEnv({ BUDDY_TCP_HOST: "0.0.0.0" }))
      .toThrow("BUDDY_TCP_CLIENT_IP is required");
  });

  it("accepts the legacy Hook token fallback for public deployments", () => {
    const resolved = settingsFromEnv({
      BUDDY_HOST: "0.0.0.0",
      BUDDY_SERVICE_TOKEN: "service-secret",
      ANOMALO_ADMIN_TOKEN: "legacy-hook-secret", // naming-compat
      BUDDY_AUTO_CONNECT: "false",
    });

    expect(resolved.hookToken).toBe("legacy-hook-secret");
  });

  it("auto-connects the local Buddy gateway without requiring hardware", async () => {
    const { service, server } = await startBuddyService({
      ...settings,
      port: 0,
      autoConnect: true,
      gateway: { ...settings.gateway, tcpPort: 0 },
    });
    try {
      expect(service.gateway.status()).toMatchObject({ transport: "tcp", listening: true });
    } finally {
      await service.gateway.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
