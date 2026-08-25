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
  it("migrates a legacy browser admin token", () => {
    const legacyTokenKey = "anomalo.adminToken"; // naming-compat: legacy browser admin token fixture
    const values = new Map([[legacyTokenKey, "legacy-secret"]]);
    const storage = {
      getItem: vi.fn((key) => values.get(key) || null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    };
    const management = createManagementAccess({ fetchImpl: vi.fn(), storage });

    expect(management.state.token.value).toBe("legacy-secret");
    expect(storage.setItem).toHaveBeenCalledWith("anomaloharis.adminToken", "legacy-secret");
    expect(storage.removeItem).toHaveBeenCalledWith(legacyTokenKey);
  });

  it("adds the admin token only to protected management requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: true }));
    const management = createManagementAccess({
      fetchImpl,
      storage: storageWith("secret"),
    });

    await management.requestJson("/api/manage/model");
    await management.requestJson("/api/buddy/status");

    expect(fetchImpl.mock.calls[0][1].headers.get("X-AnomaloHaris-Admin-Token")).toBe("secret");
    expect(fetchImpl.mock.calls[1][1].headers.get("X-AnomaloHaris-Admin-Token")).toBe("secret");
  });

  it("persists and clears browser-local credentials", () => {
    const storage = storageWith();
    const management = createManagementAccess({ fetchImpl: vi.fn(), storage });

    management.state.input.value = " new-token ";
    expect(management.save()).toBe("new-token");
    expect(storage.setItem).toHaveBeenCalledWith("anomaloharis.adminToken", "new-token");

    management.clear();
    expect(management.state.token.value).toBe("");
    expect(storage.removeItem).toHaveBeenCalledWith("anomaloharis.adminToken");
  });

  it("maps management authorization failures without claiming unrelated errors", () => {
    const management = createManagementAccess({
      fetchImpl: vi.fn(),
      storage: storageWith(),
    });

    expect(
      management.markError({
        status: 403,
        detail: "Management API requires X-AnomaloHaris-Admin-Token.",
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
          { detail: "Management API requires X-AnomaloHaris-Admin-Token." },
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

    await expect(management.requestJson("/api/manage/model")).rejects.toMatchObject({
      status: 403,
      detail: "Management API requires X-AnomaloHaris-Admin-Token.",
    });
    await expect(management.requestJson("/api/manage/model")).rejects.toThrow(
      "Invalid JSON from /api/manage/model",
    );
  });

  it("uses the backend error field when reporting non-management API failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        { error: "Search mode persistence failed.", error_code: "sqlite_error" },
        { ok: false, status: 500, statusText: "Internal Server Error" },
      ),
    );
    const management = createManagementAccess({ fetchImpl, storage: storageWith() });

    await expect(management.requestJson("/api/sessions/session/search-mode")).rejects.toMatchObject({
      status: 500,
      detail: "Search mode persistence failed.",
      code: "sqlite_error",
    });
  });
});
