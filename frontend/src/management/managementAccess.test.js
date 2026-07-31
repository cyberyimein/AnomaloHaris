import { describe, expect, it, vi } from "vitest";

import { createManagementAccess } from "./managementAccess";

function response(payload, { ok = true, status = 200, statusText = "OK" } = {}) {
  return {
    ok,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(payload === null ? "" : JSON.stringify(payload)),
  };
}

function storageWith(value = "") {
  return {
    getItem: vi.fn(() => value || null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
}

describe("ManagementAccess", () => {
  it("adds the admin token only to protected management requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: true }));
    const management = createManagementAccess({
      fetchImpl,
      storage: storageWith("secret"),
    });

    await management.requestJson("/api/buddy/status");
    await management.requestJson("/api/stocks/reports/latest");
    await management.requestJson("/api/stocks/scan", { method: "POST" });

    expect(fetchImpl.mock.calls[0][1].headers.get("X-Anomalo-Admin-Token")).toBe("secret");
    expect(fetchImpl.mock.calls[1][1]).toEqual({});
    expect(fetchImpl.mock.calls[2][1].headers.get("X-Anomalo-Admin-Token")).toBe("secret");
  });

  it("persists and clears browser-local credentials", () => {
    const storage = storageWith();
    const management = createManagementAccess({ fetchImpl: vi.fn(), storage });

    management.state.input.value = " new-token ";
    expect(management.save()).toBe("new-token");
    expect(storage.setItem).toHaveBeenCalledWith("anomalo.adminToken", "new-token");

    management.clear();
    expect(management.state.token.value).toBe("");
    expect(storage.removeItem).toHaveBeenCalledWith("anomalo.adminToken");
  });

  it("maps management authorization failures without claiming unrelated errors", () => {
    const management = createManagementAccess({
      fetchImpl: vi.fn(),
      storage: storageWith(),
    });

    expect(
      management.markError({
        status: 403,
        detail: "Management API requires X-Anomalo-Admin-Token.",
      }),
    ).toBe(true);
    expect(management.state.accessRequired.value).toBe(true);
    expect(management.markError({ status: 500, detail: "offline" })).toBe(false);
  });

  it("preserves HTTP error metadata and rejects invalid JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { detail: "Management API requires X-Anomalo-Admin-Token." },
          { ok: false, status: 403, statusText: "Forbidden" },
        ),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: vi.fn().mockResolvedValue("<html>"),
      });
    const management = createManagementAccess({ fetchImpl, storage: storageWith() });

    await expect(management.requestJson("/api/buddy/status")).rejects.toMatchObject({
      status: 403,
      detail: "Management API requires X-Anomalo-Admin-Token.",
    });
    await expect(management.requestJson("/api/buddy/status")).rejects.toThrow(
      "Invalid JSON from /api/buddy/status",
    );
  });
});
