import { describe, expect, it, vi } from "vitest";

import { createSearchModeController } from "./searchModeController";

describe("SearchModeController", () => {
  it("loads the session mode and provider options", async () => {
    const requestJson = vi.fn().mockResolvedValue({
      mode: "subagent",
      subagent_model: "deepseek/deepseek-v4-flash-0731",
      modes: [
        {
          id: "subagent",
          label: "Web research subagent",
          description: "Delegates research.",
          provider: "responses_api_subagent",
        },
      ],
    });
    const controller = createSearchModeController({
      requestJson,
      getSessionId: () => "session-1",
    });

    await controller.load();

    expect(requestJson).toHaveBeenCalledWith("/api/sessions/session-1/search-mode");
    expect(controller.state.mode.value).toBe("subagent");
    expect(controller.state.selectedOption.value.label).toBe("Web research subagent");
    expect(controller.state.status.value).toBe("ready");
  });

  it("persists a changed mode for the current session", async () => {
    const requestJson = vi.fn().mockResolvedValue({
      mode: "native",
      modes: [],
    });
    const controller = createSearchModeController({
      requestJson,
      getSessionId: () => "session-2",
    });

    await expect(controller.select("native")).resolves.toBe(true);

    expect(requestJson).toHaveBeenCalledWith(
      "/api/sessions/session-2/search-mode",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ mode: "native" }),
      }),
    );
    expect(controller.state.mode.value).toBe("native");
  });

  it("ignores a stale load response after a mode save", async () => {
    let resolveLoad;
    const requestJson = vi.fn((url, request = {}) => {
      if (request.method === "PATCH") {
        return Promise.resolve({ mode: "native", modes: [] });
      }
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    });
    const controller = createSearchModeController({
      requestJson,
      getSessionId: () => "session-4",
    });

    const pendingLoad = controller.load();
    await expect(controller.select("native")).resolves.toBe(true);
    resolveLoad({ mode: "diy", modes: [] });
    await pendingLoad;

    expect(controller.state.mode.value).toBe("native");
  });

  it("does not switch while a run is active", async () => {
    const requestJson = vi.fn();
    const controller = createSearchModeController({
      requestJson,
      getSessionId: () => "session-3",
      isDisabled: () => true,
    });

    await expect(controller.select("native")).resolves.toBe(false);
    expect(requestJson).not.toHaveBeenCalled();
  });
});
