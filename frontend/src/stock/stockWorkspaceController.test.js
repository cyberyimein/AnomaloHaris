import { describe, expect, it, vi } from "vitest";

import { createStockWorkspaceController } from "./stockWorkspaceController";

function jsonResponse(payload, { status = 200, headers } = {}) {
  return new Response(payload === null ? "" : JSON.stringify(payload), {
    status,
    headers,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("createStockWorkspaceController", () => {
  it("loads reports, preserves selection, and sends the ETag", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            revision: 3,
            received_at: "2026-07-31T01:00:00Z",
            report: {
              stocks: [
                { symbol: "US.A", attention_score: 1 },
                { symbol: "US.B", attention_score: 9 },
              ],
            },
          },
          { headers: { etag: "report-3" } },
        ),
      )
      .mockResolvedValueOnce({
        status: 304,
        ok: false,
        headers: new Headers(),
        text: vi.fn(),
      });
    const controller = createStockWorkspaceController({ request });

    await controller.load();
    expect(controller.state.status.value).toBe("ready");
    expect(controller.state.selectedSymbol.value).toBe("US.B");
    expect(controller.state.etag.value).toBe("report-3");

    await controller.load({ silent: true });
    expect(request.mock.calls[1][1].headers).toEqual({
      "If-None-Match": "report-3",
    });
  });

  it("keeps the last successful report when silent polling fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          revision: 1,
          report: { stocks: [{ symbol: "US.A", attention_score: 1 }] },
        }),
      )
      .mockRejectedValueOnce(new Error("offline"));
    const controller = createStockWorkspaceController({ request });

    await controller.load();
    await controller.load({ silent: true });

    expect(controller.state.report.value.stocks[0].symbol).toBe("US.A");
    expect(controller.state.status.value).toBe("error");
    expect(controller.state.statusMessage.value).toContain("offline");
  });

  it("runs a managed scan and reloads the latest report", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ accepted: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          revision: 4,
          report: { stocks: [{ symbol: "US.NEW", attention_score: 20 }] },
        }),
      );
    const controller = createStockWorkspaceController({ request });

    await controller.refresh();

    expect(request.mock.calls[0]).toEqual([
      "/api/stocks/scan",
      {
        method: "POST",
        headers: { Accept: "application/json" },
      },
    ]);
    expect(controller.state.selectedSymbol.value).toBe("US.NEW");
    expect(controller.state.refreshInFlight.value).toBe(false);
  });

  it("waits for an active poll before scanning and always reloads afterward", async () => {
    const activePoll = deferred();
    const request = vi
      .fn()
      .mockImplementationOnce(() => activePoll.promise)
      .mockResolvedValueOnce(jsonResponse({ accepted: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          revision: 2,
          report: { stocks: [{ symbol: "US.NEW", attention_score: 20 }] },
        }),
      );
    const controller = createStockWorkspaceController({ request });

    const pollPromise = controller.load({ silent: true });
    const refreshPromise = controller.refresh();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);

    activePoll.resolve(
      jsonResponse({
        revision: 1,
        report: { stocks: [{ symbol: "US.OLD", attention_score: 5 }] },
      }),
    );
    await Promise.all([pollPromise, refreshPromise]);

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "/api/stocks/reports/latest",
      "/api/stocks/scan",
      "/api/stocks/reports/latest",
    ]);
    expect(controller.state.selectedSymbol.value).toBe("US.NEW");
    expect(controller.state.revision.value).toBe(2);
  });

  it("retries without an ETag when a 304 has no local report", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 304,
        ok: false,
        headers: new Headers(),
        text: vi.fn(),
      })
      .mockResolvedValueOnce(
        jsonResponse({
          revision: 5,
          report: { stocks: [{ symbol: "US.RECOVERED", attention_score: 8 }] },
        }),
      );
    const controller = createStockWorkspaceController({ request });
    controller.state.etag.value = "orphaned-etag";

    await controller.load();

    expect(request.mock.calls[0][1].headers).toEqual({
      "If-None-Match": "orphaned-etag",
    });
    expect(request.mock.calls[1][1].headers).toBeUndefined();
    expect(controller.state.status.value).toBe("ready");
    expect(controller.state.selectedSymbol.value).toBe("US.RECOVERED");
  });

  it("clears validators when a non-silent load discards the cached report", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            revision: 6,
            received_at: "2026-07-31T01:00:00Z",
            report: { stocks: [{ symbol: "US.CACHED", attention_score: 4 }] },
          },
          { headers: { etag: "report-6" } },
        ),
      )
      .mockRejectedValueOnce(new Error("offline"));
    const controller = createStockWorkspaceController({ request });
    await controller.load();

    await controller.load();

    expect(controller.state.report.value).toBeNull();
    expect(controller.state.etag.value).toBeNull();
    expect(controller.state.revision.value).toBe(0);
    expect(controller.state.receivedAt.value).toBeNull();
  });

  it("marks management access errors and owns one polling timer", async () => {
    const forbidden = jsonResponse(
      { detail: "Management API requires an admin token" },
      { status: 403 },
    );
    const request = vi.fn().mockResolvedValue(forbidden);
    const markAccessError = vi.fn(() => true);
    const setIntervalImpl = vi.fn(() => 42);
    const clearIntervalImpl = vi.fn();
    const controller = createStockWorkspaceController({
      request,
      markAccessError,
      setIntervalImpl,
      clearIntervalImpl,
    });

    await controller.refresh();
    expect(markAccessError).toHaveBeenCalledOnce();
    expect(controller.state.statusMessage.value).toContain("admin token");

    controller.start();
    controller.start();
    controller.stop();

    expect(setIntervalImpl).toHaveBeenCalledOnce();
    expect(clearIntervalImpl).toHaveBeenCalledWith(42);
  });

  it("keeps selection inside the active bucket", async () => {
    const controller = createStockWorkspaceController({
      request: vi.fn().mockResolvedValue(
        jsonResponse({
          report: {
            stocks: [
              { symbol: "US.WATCH", bucket: "watch", attention_score: 9 },
              { symbol: "US.OBSERVE", bucket: "observe", attention_score: 5 },
            ],
          },
        }),
      ),
    });
    await controller.load();

    controller.selectBucket("observe");

    expect(controller.state.bucketFilter.value).toBe("observe");
    expect(controller.state.selectedSymbol.value).toBe("US.OBSERVE");
  });
});
