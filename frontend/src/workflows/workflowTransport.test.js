import { describe, expect, it, vi } from "vitest";

import { createWorkflowTransport, parseWorkflowJson, runPath, workflowPath } from "./workflowTransport";

describe("workflowTransport", () => {
  it("uses the management seam for validation and lifecycle operations", async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true });
    const transport = createWorkflowTransport({ management: { requestJson } });

    await transport.validate({ kind: "Workflow" });
    await transport.importDraft({ kind: "Workflow" });
    await transport.publish("daily-review@1");
    await transport.exportDefinition("daily-review@1");
    await transport.deleteDraft("daily-review@1");
    await transport.run("daily-review@1", { message: "hello" }, "run-1");
    await transport.getRun("run_1");
    await transport.runEvents("run_1", 4);
    await transport.stop("run_1");

    expect(requestJson.mock.calls.map(([url, options]) => [url, options?.method || "GET"])).toEqual([
      ["/api/manage/workflows/validate", "POST"],
      ["/api/manage/workflows/import", "POST"],
      ["/api/manage/workflows/daily-review/versions/1/publish", "POST"],
      ["/api/manage/workflows/daily-review/versions/1/export", "GET"],
      ["/api/manage/workflows/daily-review/versions/1", "DELETE"],
      ["/api/workflows/daily-review/versions/1/runs", "POST"],
      ["/api/runs/run_1", "GET"],
      ["/api/runs/run_1/events?after_sequence=4", "GET"],
      ["/api/runs/run_1/stop", "POST"],
    ]);
  });

  it("parses invalid JSON without making a request and encodes refs", () => {
    expect(parseWorkflowJson("{bad").value).toBeNull();
    expect(parseWorkflowJson("{bad").error).toBeTruthy();
    expect(workflowPath("daily-review@12")).toBe("/api/manage/workflows/daily-review/versions/12");
    expect(runPath("daily-review@12")).toBe("/api/workflows/daily-review/versions/12");
    expect(() => workflowPath("missing-version")).toThrow("Invalid Workflow Ref");
  });

  it("streams events with the workflow service token", async () => {
    const requestJson = vi.fn();
    const request = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"run_id":"run_1","sequence":1,"type":"run.started"}\n'));
          controller.enqueue(new TextEncoder().encode('{"run_id":"run_1","sequence":2,"type":"run.succeeded"}\n'));
          controller.close();
        },
      }),
    });
    const transport = createWorkflowTransport({ management: { requestJson, request }, workflowToken: "secret" });
    const events = [];
    await transport.runStream("daily-review@1", {}, "run-1", (event) => events.push(event));

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(request).toHaveBeenCalledWith(expect.stringContaining("/runs/stream"), expect.objectContaining({ headers: expect.any(Headers) }));
    expect(request.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer secret");
  });
});
