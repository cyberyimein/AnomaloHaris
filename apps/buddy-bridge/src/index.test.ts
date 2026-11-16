import { afterEach, describe, expect, it, vi } from "vitest";
import createBuddyBridge from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function invoke(name: string, args: Record<string, unknown> = {}) {
  return createBuddyBridge({}).callTool({ id: "1", name, arguments: args }, {}, new AbortController().signal);
}

describe("robot capability bridge", () => {
  it("describes the discovered grant requirement and optional LED emotion feedback", () => {
    const toolDescriptions = createBuddyBridge({}).tools;
    const capabilitiesDescription = toolDescriptions.find((tool) => tool.name === "buddy_capabilities")?.description ?? "";
    const invokeDescription = toolDescriptions.find((tool) => tool.name === "buddy_invoke")?.description ?? "";

    expect(capabilitiesDescription).toMatch(/allowed|grant/i);
    expect(capabilitiesDescription).toContain("effectiveAllowed");
    expect(capabilitiesDescription).toContain("state.lighting");
    expect(invokeDescription).toContain("led.express");
    expect(invokeDescription).toContain("led.resume");
    expect(invokeDescription).toContain("state.lighting");
    expect(invokeDescription).toMatch(/sparingly|not on every turn/i);
    expect(invokeDescription).toMatch(/separately granted/i);
    expect(invokeDescription).toMatch(/never retry or bypass/i);
  });

  it("discovers newly installed modules and current grants without a lifecycle hook", async () => {
    const status = {
      connected: true,
      state: { lighting: { manualOverride: false } },
      capabilities: [
        {
          name: "led.express",
          inputSchema: {
            type: "object",
            properties: {
              emotion: { type: "string", enum: ["happy", "curious", "thinking", "listening", "speaking", "concerned", "calm"] },
              intensity: { type: "number", minimum: 0.1, maximum: 1, default: 0.5 },
              durationMs: { type: "integer", minimum: 1000, maximum: 60000, default: 8000 },
            },
          },
          allowed: false,
          effectiveAllowed: false,
        },
        { name: "led.resume", inputSchema: { type: "object", properties: {} }, allowed: false, effectiveAllowed: false },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(status)));
    expect(createBuddyBridge({}).hooks).toEqual({});
    expect(JSON.parse((await invoke("buddy_capabilities")).content)).toEqual(status);
  });

  it("returns a separate model image and excludes its bytes from textual output", async () => {
    const image = { mimeType: "image/png", data: "aW1hZ2U=" };
    const fetchMock = vi.fn(async () => Response.json({
      requestId: "r1",
      result: { direction: "left", image: { ...image, width: 320, height: 240 } },
    }));
    vi.stubEnv("ANOMALOHARIS_BUDDY_SERVICE_URL", "http://buddy.test");
    vi.stubGlobal("fetch", fetchMock);
    const args = { capability: "camera.capture", args: {} };
    const result = await invoke("buddy_invoke", args);
    expect(fetchMock).toHaveBeenCalledWith("http://buddy.test/v1/buddy/invoke", expect.objectContaining({ body: JSON.stringify(args) }));
    expect(result).toMatchObject({ ok: true, image });
    expect(JSON.stringify([result.content, result.data])).not.toContain(image.data);
    expect(result.content).toContain("left");
    expect(JSON.parse(result.content).result.image).toEqual({ mimeType: "image/png", width: 320, height: 240 });
  });

  it("reports a denied permission as a failed tool", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "permission denied" }, { status: 403 })));
    expect(await invoke("buddy_invoke", { capability: "camera.capture", args: {} })).toMatchObject({ ok: false, content: "permission denied" });
  });

  it("passes discovered LED express and resume calls through and surfaces a permission denial", async () => {
    const args = { capability: "led.express", args: { emotion: "curious", intensity: 0.5, durationMs: 8000 } };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const invocation = JSON.parse(String(init?.body));
      if (invocation.capability === "led.express") {
        return Response.json({ error: "permission denied" }, { status: 403 });
      }
      return Response.json({ requestId: "r2", result: { resumed: true } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const denied = await invoke("buddy_invoke", args);
    const resumeArgs = { capability: "led.resume", args: {} };
    const resumed = await invoke("buddy_invoke", resumeArgs);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8765/v1/buddy/invoke", expect.objectContaining({ body: JSON.stringify(args) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://127.0.0.1:8765/v1/buddy/invoke", expect.objectContaining({ body: JSON.stringify(resumeArgs) }));
    expect(denied).toMatchObject({ ok: false, content: "permission denied", data: { status: 403 } });
    expect(resumed).toMatchObject({ ok: true, data: { result: { resumed: true } } });
  });
});
