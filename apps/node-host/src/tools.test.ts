import { describe, expect, it } from "vitest";

import { CoreToolRuntime, TimeZoneToolRuntime } from "./tools.js";
import type { ToolContext } from "./types.js";

const context: ToolContext = {
  sessionId: "time-tools-session",
  runId: "time-tools-run",
  searchMode: "diy",
  model: "fixture-model",
  activeSkills: new Set(),
  activeMcpServers: new Set(),
};

describe("time tools", () => {
  it("keeps the existing time_now tool available while accepting a timezone", async () => {
    const runtime = new CoreToolRuntime();
    const result = await runtime.call(
      { id: "time-now-call", name: "time_now", arguments: { timezone: "Asia/Tokyo" } },
      context,
      new AbortController().signal,
    );

    expect(result).toMatchObject({ ok: true, data: { timezone: "Asia/Tokyo" } });
    expect(result.content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]09:00$/);
  });

  it("converts local event times deterministically", async () => {
    const runtime = new TimeZoneToolRuntime();
    const result = await runtime.call(
      {
        id: "convert-call",
        name: "core_convert_time",
        arguments: {
          datetime: "2026-08-22T12:00:00",
          from_timezone: "America/New_York",
          to_timezone: "Asia/Tokyo",
        },
      },
      context,
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      source_timezone: "America/New_York",
      target_timezone: "Asia/Tokyo",
      converted_iso: "2026-08-23T01:00:00.000+09:00",
      utc_iso: "2026-08-22T16:00:00.000Z",
    });
  });

  it("rejects nonexistent daylight-saving local times", async () => {
    const runtime = new TimeZoneToolRuntime();
    const result = await runtime.call(
      {
        id: "dst-call",
        name: "core_convert_time",
        arguments: {
          datetime: "2026-03-08T02:30:00",
          from_timezone: "America/New_York",
          to_timezone: "UTC",
        },
      },
      context,
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("does not exist");
  });
});
