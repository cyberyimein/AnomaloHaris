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
  it("unwraps the independent service status and forwards its service token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: { connected: true, transport: "tcp" } }));
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

  it("bounds event queries and maps upstream failures to an unavailable dependency", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: "unauthorized" }, { ok: false, status: 401 }));
    const client = new BuddyDashboardClient({ baseUrl: "http://buddy.test", fetchImpl });

    await expect(client.events(999)).rejects.toMatchObject({ statusCode: 503, errorCode: "buddy_unavailable" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://buddy.test/v1/buddy/events?limit=200");
  });
});
