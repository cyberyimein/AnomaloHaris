import { describe, expect, it, vi } from "vitest";

import {
  buddyEventDetails,
  createBuddyDashboardController,
  flattenEventDetails,
} from "./buddyDashboardController";

function createController(overrides = {}) {
  const requestJson = vi.fn(async (url) => {
    if (url === "/api/buddy/status") {
      return {
        connected: true,
        transport: "tcp",
        client_address: "192.0.2.20",
        recent_event_count: 1,
      };
    }
    if (url === "/api/buddy/events?limit=30") {
      return { events: [{ id: 1, type: "touch.click", payload: { side: "back" } }] };
    }
    if (url === "/api/buddy/vision/status") {
      return { enabled: true, active: false, provider: "OpenCV" };
    }
    return { connected: true, enabled: true };
  });
  return {
    requestJson,
    controller: createBuddyDashboardController({
      requestJson,
      now: () => new Date("2026-07-31T09:00:00+09:00"),
      ...overrides,
    }),
  };
}

describe("BuddyDashboardController", () => {
  it("refreshes and projects one coherent Buddy snapshot", async () => {
    const { controller, requestJson } = createController();

    await controller.refresh();

    expect(requestJson.mock.calls.map(([url]) => url)).toEqual([
      "/api/buddy/status",
      "/api/buddy/events?limit=30",
      "/api/buddy/vision/status",
    ]);
    expect(controller.state.statusLabel.value).toBe("Connected");
    expect(controller.state.statusCards.value).toContainEqual({
      label: "Transport",
      value: "tcp",
    });
    expect(controller.state.visionHint.value).toContain("start it");
    expect(controller.state.actionInFlight.value).toBe(false);
    expect(controller.state.dashboardStatus.value).toMatch(/^Updated /);
  });

  it("filters events across type, raw text, and payload", async () => {
    const { controller } = createController();
    await controller.refresh();

    controller.state.eventFilter.value = "BACK";
    expect(controller.state.filteredEvents.value).toHaveLength(1);
    controller.state.eventFilter.value = "missing";
    expect(controller.state.filteredEvents.value).toEqual([]);
  });

  it("uses the expected command endpoints and reloads events", async () => {
    const { controller, requestJson } = createController();

    await controller.sendState("thinking");
    await controller.setVisionEnabled(false);

    expect(requestJson).toHaveBeenCalledWith(
      "/api/buddy/state",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ state: "thinking" }),
      }),
    );
    expect(requestJson).toHaveBeenCalledWith("/api/buddy/vision/disable", { method: "POST" });
    expect(
      requestJson.mock.calls.filter(([url]) => url === "/api/buddy/events?limit=30"),
    ).toHaveLength(2);
  });

  it("reports failures, marks access errors, and always clears busy state", async () => {
    const error = Object.assign(new Error("token required"), { status: 403 });
    const markAccessError = vi.fn();
    const controller = createBuddyDashboardController({
      requestJson: vi.fn().mockRejectedValue(error),
      markAccessError,
    });

    await controller.refresh();

    expect(markAccessError).toHaveBeenCalledWith(error);
    expect(controller.state.dashboardStatus.value).toContain("token required");
    expect(controller.state.actionInFlight.value).toBe(false);
  });

  it("starts and stops one polling timer", () => {
    const scheduler = {
      setInterval: vi.fn(() => 42),
      clearInterval: vi.fn(),
    };
    const { controller } = createController({ scheduler });

    controller.startPolling();
    controller.startPolling();
    controller.stopPolling();

    expect(scheduler.setInterval).toHaveBeenCalledTimes(1);
    expect(scheduler.clearInterval).toHaveBeenCalledWith(42);
  });
});

describe("Buddy event projection", () => {
  it("flattens nested event details with readable labels and values", () => {
    expect(
      buddyEventDetails({
        payload: {
          call_buddy: { online: true },
          choices: ["approve", "deny"],
          empty: null,
        },
      }),
    ).toEqual([
      { label: "Call Buddy › Online", value: "Yes" },
      { label: "Choices", value: "approve, deny" },
      { label: "Empty", value: "—" },
    ]);
  });

  it("caps pathological payloads at 48 details", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`field_${index}`, index]),
    );
    expect(flattenEventDetails(payload)).toHaveLength(48);
  });
});
