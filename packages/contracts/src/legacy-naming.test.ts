import { describe, expect, it } from "vitest";

import { LegacyNamingAdapter, canonicalizeEnvironmentName, canonicalizePresetModelName, canonicalizePresetModelRef } from "./legacy-naming.js";

describe("LegacyNamingAdapter", () => {
  it("prefers canonical environment values and reads legacy values through one seam", () => {
    const adapter = new LegacyNamingAdapter();
    expect(adapter.readEnv({ ANOMALOHARIS_ADMIN_TOKEN: "new", ANOMALO_ADMIN_TOKEN: "old" }, "ANOMALOHARIS_ADMIN_TOKEN")).toBe("new"); // naming-compat
    expect(adapter.readEnv({ ANOMALO_ADMIN_TOKEN: "old" }, "ANOMALOHARIS_ADMIN_TOKEN")).toBe("old"); // naming-compat
    expect(adapter.stats()).toEqual({ "env:ANOMALOHARIS_ADMIN_TOKEN": 1 });
  });

  it("reads old and new headers case-insensitively without exposing values in telemetry", () => {
    const adapter = new LegacyNamingAdapter();
    expect(adapter.readHeader({ "X-AnomaloHaris-Admin-Token": "new" }, "x-anomaloharis-admin-token")).toBe("new");
    expect(adapter.readHeader({ "x-anomalo-admin-token": "old" }, "x-anomaloharis-admin-token")).toBe("old"); // naming-compat
    expect(adapter.stats()).toEqual({ "header:x-anomaloharis-admin-token": 1 });
  });

  it("canonicalizes the one-time default model identity migration", () => {
    expect(canonicalizeEnvironmentName("ANOMALO_BUDDY_SERVICE_TOKEN")).toBe("ANOMALOHARIS_BUDDY_SERVICE_TOKEN"); // naming-compat
    expect(canonicalizePresetModelRef("anomalo@1")).toBe("anomaloharis@1"); // naming-compat
    expect(canonicalizePresetModelRef("fomc-brief@3")).toBe("fomc-brief@3");
    expect(canonicalizePresetModelName("anomalo")).toBe("anomaloharis"); // naming-compat
  });
});
