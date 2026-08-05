import { describe, expect, it, vi } from "vitest";

import { createModelSettingsController } from "./modelSettingsController";

describe("ModelSettingsController", () => {
  it("loads the effective model and source", async () => {
    const requestJson = vi.fn().mockResolvedValue({
      model: "deepseek/deepseek-v4-flash-0731",
      source: "runtime",
      updated_at: "2026-08-04T01:02:03Z",
    });
    const controller = createModelSettingsController({ requestJson });

    await controller.load();

    expect(requestJson).toHaveBeenCalledWith("/api/manage/model");
    expect(controller.state.model.value).toBe("deepseek/deepseek-v4-flash-0731");
    expect(controller.state.draft.value).toBe("deepseek/deepseek-v4-flash-0731");
    expect(controller.state.statusLabel.value).toBe("Runtime override");
  });

  it("saves a trimmed model identifier and reports success", async () => {
    const requestJson = vi.fn().mockResolvedValue({
      model: "new/model",
      source: "runtime",
      updated_at: "2026-08-04T01:02:03Z",
    });
    const controller = createModelSettingsController({ requestJson });
    controller.state.draft.value = "  new/model  ";

    await expect(controller.save()).resolves.toBe(true);

    expect(requestJson).toHaveBeenCalledWith(
      "/api/manage/model",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ model: "new/model" }),
      }),
    );
    expect(controller.state.model.value).toBe("new/model");
    expect(controller.state.statusMessage.value).toContain("New conversations");
  });

  it("marks authorization failures and does not submit a blank model", async () => {
    const requestJson = vi.fn();
    const markAccessError = vi.fn();
    const controller = createModelSettingsController({ requestJson, markAccessError });

    controller.state.draft.value = "   ";
    await expect(controller.save()).resolves.toBe(false);
    expect(requestJson).not.toHaveBeenCalled();

    const error = Object.assign(new Error("token required"), { status: 403 });
    requestJson.mockRejectedValue(error);
    controller.state.draft.value = "new/model";
    await expect(controller.save()).resolves.toBe(false);
    expect(markAccessError).toHaveBeenCalledWith(error);
  });
});
