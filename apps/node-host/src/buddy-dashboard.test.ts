import { describe, expect, it, vi } from "vitest";

import { BuddyDashboardClient } from "./buddy-dashboard.js";

function response(payload: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

describe("BuddyDashboardClient", () => {
  it("returns independent service status and forwards its service token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ connected: true, transport: "tcp" }));
    const client = new BuddyDashboardClient({
      baseUrl: "http://buddy.test/",
      token: "service-secret",
      fetchImpl,
    });

    await expect(client.status()).resolves.toEqual({ connected: true, transport: "tcp" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://buddy.test/v1/buddy/status",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer service-secret" }) }),
    );
  });

  it("maps upstream failures to an unavailable dependency", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: "unauthorized" }, { ok: false, status: 401 }));
    const client = new BuddyDashboardClient({ baseUrl: "http://buddy.test", fetchImpl });

    await expect(client.observation()).rejects.toMatchObject({ statusCode: 503, errorCode: "buddy_unavailable" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://buddy.test/v1/buddy/observation");
  });

  it("forwards observation and capability invocation to the device service", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ observation: { requestId: "obs-1", result: { image: { mimeType: "image/jpeg", data: "abc" } } } }))
      .mockResolvedValueOnce(response({ requestId: "req-1", result: { ok: true } }));
    const client = new BuddyDashboardClient({ baseUrl: "http://buddy.test", token: "service-secret", adminToken: "admin-secret", fetchImpl });

    await expect(client.observation()).resolves.toEqual({ observation: { requestId: "obs-1", result: { image: { mimeType: "image/jpeg", data: "abc" } } } });
    await expect(client.invoke({ capability: "camera.capture", args: { resolution: "VGA" } })).resolves.toEqual({ requestId: "req-1", result: { ok: true } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://buddy.test/v1/buddy/observation");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://buddy.test/v1/buddy/manual");
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer admin-secret" }),
      body: JSON.stringify({ capability: "camera.capture", args: { resolution: "VGA" } }),
    }));
  });

  it("starts Buddy agent tools through the administration endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ agentEnabled: true }));
    const client = new BuddyDashboardClient({ baseUrl: "http://buddy.test", adminToken: "admin-secret", fetchImpl });
    await client.setAgentEnabled(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://buddy.test/v1/buddy/agent", expect.objectContaining({
      body: JSON.stringify({ enabled: true }),
      headers: expect.objectContaining({ Authorization: "Bearer admin-secret" }),
    }));
  });

  it("uses the isolated admin credential for permission updates", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ observation: null }))
      .mockResolvedValueOnce(response({ capability: "camera.capture", allowed: true }));
    const client = new BuddyDashboardClient({
      baseUrl: "http://buddy.test",
      token: "service-secret",
      adminToken: "buddy-admin-secret",
      fetchImpl,
    });

    await client.observation();
    await expect(client.setPermission({ deviceId: "buddy-room", capability: "camera.capture", allowed: true }))
      .resolves.toEqual({ capability: "camera.capture", allowed: true });
    expect(fetchImpl).toHaveBeenCalledWith("http://buddy.test/v1/buddy/permissions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer buddy-admin-secret" }),
    }));
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer buddy-admin-secret" }),
    }));
  });
});
