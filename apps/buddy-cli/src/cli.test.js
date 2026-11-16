import { describe, expect, it, vi } from "vitest";

import { runBuddyCli } from "./cli.js";

describe("buddy CLI", () => {
  it("reads device status with the service credential", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ connected: true, deviceId: "buddy-room", capabilities: [] }));
    const stdout = vi.fn();

    await runBuddyCli(["status", "--json"], {
      env: { BUDDY_SERVICE_URL: "http://buddy.local:8765", BUDDY_SERVICE_TOKEN: "service-secret" },
      fetchImpl,
      stdout,
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://buddy.local:8765/v1/buddy/status", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer service-secret" }),
    }));
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ connected: true, deviceId: "buddy-room", capabilities: [] }, null, 2));
  });

  it("invokes a capability and writes returned image bytes when requested", async () => {
    const response = { requestId: "req-2", result: { direction: "left", image: { mimeType: "image/png", data: "aGVsbG8=", width: 1, height: 1 } } };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(response));
    const writeFile = vi.fn();
    const stdout = vi.fn();

    await runBuddyCli(["observe", "--direction", "left", "--out", "left.png", "--json"], {
      env: { ANOMALOHARIS_BUDDY_SERVICE_URL: "http://buddy.local:8765" },
      fetchImpl,
      writeFile,
      stdout,
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://buddy.local:8765/v1/buddy/invoke", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ capability: "head.observe", args: { direction: "left" } }),
    }));
    expect(writeFile).toHaveBeenCalledWith("left.png", Buffer.from("aGVsbG8=", "base64"));
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({
      requestId: "req-2",
      result: { direction: "left", image: { mimeType: "image/png", width: 1, height: 1, path: "left.png" } },
    }, null, 2));
  });

  it("maps the look shortcut to a head movement without capturing an image", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ requestId: "req-3", result: { pan: -45 } }));

    await runBuddyCli(["look", "left", "--tilt", "30", "--json"], {
      env: {},
      fetchImpl,
      stdout: vi.fn(),
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8765/v1/buddy/invoke", expect.objectContaining({
      body: JSON.stringify({ capability: "head.move", args: { pan: -45, tilt: 30 } }),
    }));
  });

  it("does not expose permission administration through the agent CLI", async () => {
    const fetchImpl = vi.fn();
    await expect(runBuddyCli(["permissions"], { fetchImpl, env: {} })).rejects.toThrow(/Unknown Buddy command/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function jsonResponse(payload, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    text: async () => JSON.stringify(payload),
  };
}
