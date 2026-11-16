import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuddyService, credentialForBuddyRoute, settingsFromEnv, type BuddyServerSettings } from "./service.js";

const capability = {
  name: "camera.capture",
  description: "Capture a fresh image",
  inputSchema: { type: "object", properties: {} },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function settings(overrides: Partial<BuddyServerSettings> = {}): BuddyServerSettings {
  return {
    host: "127.0.0.1",
    port: 0,
    serviceToken: "agent-secret",
    adminToken: "admin-secret",
    deviceUrl: "http://192.168.1.40:8080",
    deviceToken: "device-secret",
    pollIntervalMs: 10_000,
    freshnessMs: 30_000,
    requestTimeoutMs: 1_000,
    invokeTimeoutMs: 1_000,
    permissionsFile: undefined,
    ...overrides,
  };
}

describe("BuddyService device control", () => {
  let permissionDirectory: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    if (permissionDirectory) await rm(permissionDirectory, { recursive: true, force: true });
    permissionDirectory = undefined;
  });

  it("polls the configured device with its own credential and exposes reported capabilities", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://192.168.1.40:8080/v1/status");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer device-secret");
      return response({ deviceId: "stackchan-office", state: { mode: "idle" }, capabilities: [capability] });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });

    await service.pollDevice();
    const [status, body] = await service.handleGet("/v1/buddy/status", new URLSearchParams());

    expect(status).toBe(200);
    expect(body).toMatchObject({
      connected: true,
      deviceId: "stackchan-office",
      state: { mode: "idle" },
      capabilities: [{ name: "camera.capture", allowed: false }],
    });
  });

  it("keeps discovered capabilities denied until an admin persists permission", async () => {
    permissionDirectory = await mkdtemp(join(tmpdir(), "buddy-permissions-"));
    const permissionsFile = join(permissionDirectory, "permissions.json");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { image: { mimeType: "image/jpeg", data: "ZmFrZQ==" } } });
      }
      return response({ deviceId: "stackchan-office", state: "idle", capabilities: [capability] });
    });
    const service = new BuddyService(settings({ permissionsFile }), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    service.setAgentEnabled(true);

    await expect(service.invoke("camera.capture", {})).rejects.toMatchObject({ code: "permission_denied" });
    await service.setPermission("stackchan-office", "camera.capture", true);
    const invoked = await service.invoke("camera.capture", {});

    expect(invoked.result).toMatchObject({ image: { mimeType: "image/jpeg", data: "ZmFrZQ==" } });
    const persisted = JSON.parse(await readFile(permissionsFile, "utf8"));
    expect(persisted).toEqual({
      schemaVersion: 2,
      agentEnabled: true,
      permissions: { "stackchan-office": { "camera.capture": true } },
    });

    const restoredService = new BuddyService(settings({ permissionsFile }), { fetchImpl: fetchImpl as typeof fetch });
    await restoredService.pollDevice();
    expect(restoredService.status().capabilities).toMatchObject([{ name: "camera.capture", allowed: true, effectiveAllowed: true }]);
  });

  it("validates capability input schemas before sending hardware commands", async () => {
    let invocationCount = 0;
    const capabilityWithLimits = {
      name: "led.express",
      description: "Set a bounded emotion",
      inputSchema: {
        type: "object",
        properties: { intensity: { type: "number", minimum: 0.1, maximum: 1 } },
        required: ["intensity"],
        additionalProperties: false,
      },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        invocationCount += 1;
        return response({ requestId: JSON.parse(String(init.body)).requestId, result: { ok: true } });
      }
      return response({ deviceId: "stackchan-office", state: "ready", capabilities: [capabilityWithLimits] });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    await service.setPermission("stackchan-office", "led.express", true);
    service.setAgentEnabled(true);

    await expect(service.invoke("led.express", { intensity: 2 }))
      .rejects.toMatchObject({ code: "invalid_capability_arguments" });
    await expect(service.invoke("led.express", { intensity: 0.5, extra: true }))
      .rejects.toMatchObject({ code: "invalid_capability_arguments" });
    await expect(service.invoke("led.express", { intensity: 0.5 }))
      .resolves.toMatchObject({ result: { ok: true } });
    expect(invocationCount).toBe(1);
  });

  it("converts device RGB565 frames and records receive time separately from exposure time", async () => {
    let now = 10_000;
    const rawImage = {
      mimeType: "application/x-rgb565",
      encoding: "rgb565-be",
      data: Buffer.from([0xf8, 0x00]).toString("base64"),
      width: 1,
      height: 1,
      capturedAtMs: 4567,
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { image: rawImage } });
      }
      return response({ deviceId: "stackchan-office", state: "ready", capabilities: [capability] });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch, now: () => now++ });
    await service.pollDevice();
    await service.setPermission("stackchan-office", "camera.capture", true);
    service.setAgentEnabled(true);

    const invoked = await service.invoke("camera.capture", {});
    const observation = (await service.handleGet("/v1/buddy/observation"))[1].observation;

    expect(invoked.result).toMatchObject({
      image: {
        mimeType: "image/png",
        width: 1,
        height: 1,
        capturedAtMs: 4567,
        captureClock: "device_monotonic",
      },
    });
    expect(observation).toMatchObject({
      capturedAt: null,
      receivedAt: expect.any(String),
      processedAt: expect.any(String),
      result: { image: { mimeType: "image/png", capturedAtMs: 4567 } },
    });
    const receivedAtMs = new Date((observation as Record<string, unknown>).receivedAt as string).getTime();
    const processedAtMs = new Date((observation as Record<string, unknown>).processedAt as string).getTime();
    expect(processedAtMs).toBe(receivedAtMs + 1);
    expect(rawImage.mimeType).toBe("application/x-rgb565");
  });

  it("preserves legacy camera images and does not present receipt time as capture time", async () => {
    const legacyImage = { mimeType: "image/jpeg", data: "ZmFrZQ==", width: 320, height: 240 };
    let now = 20_000;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { image: legacyImage } });
      }
      return response({ deviceId: "stackchan-office", state: "ready", capabilities: [capability] });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch, now: () => now });
    await service.pollDevice();
    await service.setPermission("stackchan-office", "camera.capture", true);
    service.setAgentEnabled(true);

    const invoked = await service.invoke("camera.capture", {});
    const observation = (await service.handleGet("/v1/buddy/observation"))[1].observation;
    expect(invoked.result.image).toEqual(legacyImage);
    expect(observation).toMatchObject({ capturedAt: null, receivedAt: expect.any(String), result: { image: legacyImage } });
    expect((observation as Record<string, unknown>).capturedAt).toBeNull();
  });

  it("rejects malformed RGB565 frames from the device as invalid responses", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { image: {
          mimeType: "application/x-rgb565", encoding: "rgb565-be", data: "AA==", width: 640, height: 480,
        } } });
      }
      return response({ deviceId: "stackchan-office", state: "ready", capabilities: [capability] });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    await service.setPermission("stackchan-office", "camera.capture", true);
    service.setAgentEnabled(true);

    await expect(service.invoke("camera.capture", {})).rejects.toMatchObject({ code: "invalid_device_image" });
  });

  it("requires an individual grant for discovered LED emotion and lifecycle controls", async () => {
    const invocationBodies: Array<Record<string, unknown>> = [];
    const ledCapabilities = [
      {
        name: "led.express",
        description: "Show a temporary status emotion.",
        inputSchema: {
          type: "object",
          properties: {
            emotion: { type: "string", enum: ["happy", "curious", "thinking", "listening", "speaking", "concerned", "calm"] },
            intensity: { type: "number", minimum: 0.1, maximum: 1, default: 0.5 },
            durationMs: { type: "integer", minimum: 1000, maximum: 60000, default: 8000 },
          },
          required: ["emotion"],
          additionalProperties: false,
        },
      },
      {
        name: "led.resume",
        description: "Resume automatic lifecycle lighting.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        invocationBodies.push(body);
        return response({ requestId: body.requestId, result: { accepted: body.capability } });
      }
      return response({ deviceId: "stackchan-office", state: { mode: "ready" }, capabilities: ledCapabilities });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    service.setAgentEnabled(true);

    expect(service.status().capabilities).toMatchObject([
      { name: "led.express", allowed: false, effectiveAllowed: false },
      { name: "led.resume", allowed: false, effectiveAllowed: false },
    ]);
    const expressionArgs = { emotion: "curious", intensity: 0.5, durationMs: 8000 };
    await expect(service.invoke("led.express", expressionArgs)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.invoke("led.resume", {})).rejects.toMatchObject({ code: "permission_denied" });
    expect(invocationBodies).toEqual([]);

    await service.setPermission("stackchan-office", "led.express", true);
    await expect(service.invoke("led.express", expressionArgs)).resolves.toMatchObject({ result: { accepted: "led.express" } });
    expect(service.status().capabilities).toMatchObject([
      { name: "led.express", allowed: true, effectiveAllowed: true },
      { name: "led.resume", allowed: false, effectiveAllowed: false },
    ]);
    await expect(service.invoke("led.resume", {})).rejects.toMatchObject({ code: "permission_denied" });

    await service.setPermission("stackchan-office", "led.resume", true);
    await expect(service.invoke("led.resume", {})).resolves.toMatchObject({ result: { accepted: "led.resume" } });
    expect(invocationBodies.map((body) => [body.capability, body.args])).toEqual([
      ["led.express", expressionArgs],
      ["led.resume", {}],
    ]);
  });

  it("checks permission dependencies and rejects concurrent physical actions", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    let releaseAction: (() => void) | undefined;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await actionGate;
        activeCalls -= 1;
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      return response({
        deviceId: "stackchan-office",
        state: "idle",
        capabilities: [
          { name: "head.move", description: "Move the head", inputSchema: { type: "object" } },
          { ...capability, name: "camera.observe", requires: ["head.move", "camera.capture"] },
          capability,
        ],
      });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    service.setAgentEnabled(true);
    await service.setPermission("stackchan-office", "camera.observe", true);
    await service.setPermission("stackchan-office", "head.move", true);

    await expect(service.invoke("camera.observe", {})).rejects.toMatchObject({ code: "permission_dependency_denied" });
    await service.setPermission("stackchan-office", "camera.capture", true);
    const firstAction = service.invoke("camera.observe", {});
    await Promise.resolve();
    await expect(service.invoke("camera.observe", {})).rejects.toMatchObject({ code: "buddy_busy", statusCode: 409 });
    releaseAction?.();
    await firstAction;

    expect(maxActiveCalls).toBe(1);
  });

  it("exposes the active action while the device request is pending and clears it on completion", async () => {
    let finishAction: (() => void) | undefined;
    const actionResponse = new Promise<void>((resolve) => { finishAction = resolve; });
    let actionRequestId: string | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        actionRequestId = body.requestId;
        await actionResponse;
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      return response({ deviceId: "stackchan-office", state: { mode: "ready" }, capabilities: [capability] });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch, now: () => 5_000 });
    await service.pollDevice();
    service.setAgentEnabled(true);
    await service.setPermission("stackchan-office", "camera.capture", true);
    const action = service.invoke("camera.capture", {});
    await Promise.resolve();

    expect(service.status()).toMatchObject({
      actionInProgress: true,
      activeAction: {
        requestId: actionRequestId,
        capability: "camera.capture",
        startedAt: new Date(5_000).toISOString(),
      },
      state: { mode: "ready" },
    });

    finishAction?.();
    await action;
    expect(service.status()).toMatchObject({ actionInProgress: false, activeAction: null });
  });

  it("keeps a previously connected device online only while its bounded action is active", async () => {
    let now = 1_000;
    let finishAction: (() => void) | undefined;
    const actionResponse = new Promise<void>((resolve) => { finishAction = resolve; });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        await actionResponse;
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      return response({ deviceId: "stackchan-office", state: { mode: "ready" }, capabilities: [capability] });
    });
    const service = new BuddyService(settings({ freshnessMs: 8_000, invokeTimeoutMs: 30_000 }), {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
    });
    await service.pollDevice();
    service.setAgentEnabled(true);
    await service.setPermission("stackchan-office", "camera.capture", true);
    const action = service.invoke("camera.capture", {});
    await Promise.resolve();

    now += 23_000;
    expect(service.status()).toMatchObject({ connected: true, actionInProgress: true, activeAction: { capability: "camera.capture" } });

    now += 8_000;
    expect(service.status().connected).toBe(false);
    finishAction?.();
    await action;
  });

  it("refreshes device state asynchronously after an action without changing its result on poll failure", async () => {
    let statusPollCount = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      statusPollCount += 1;
      if (statusPollCount === 1) {
        return response({ deviceId: "stackchan-office", state: { mode: "ready" }, capabilities: [capability] });
      }
      return response({ error: "status_unavailable" }, 503);
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    service.setAgentEnabled(true);
    await service.setPermission("stackchan-office", "camera.capture", true);

    const result = await service.invoke("camera.capture", {});
    expect(result.result).toEqual({ ok: true });
    await vi.waitFor(() => expect(service.status().lastPollError).toBe("buddy_unavailable"));
    expect(statusPollCount).toBe(2);
    expect(service.status().connected).toBe(true);
    expect(service.status().lastPollError).toBe("buddy_unavailable");
  });

  it("refreshes the reported robot mode after an action completes", async () => {
    let statusPollCount = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      statusPollCount += 1;
      return response({
        deviceId: "stackchan-office",
        state: { mode: statusPollCount === 1 ? "ready" : "sleeping" },
        capabilities: [capability],
      });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    service.setAgentEnabled(true);
    await service.setPermission("stackchan-office", "camera.capture", true);

    await service.invoke("camera.capture", {});
    await vi.waitFor(() => expect(service.status().state).toEqual({ mode: "sleeping" }));
  });

  it("clears active-action feedback when the device returns an invalid action response", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") return response({ requestId: "wrong-id", result: {} });
      return response({ deviceId: "stackchan-office", state: "ready", capabilities: [capability] });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    service.setAgentEnabled(true);
    await service.setPermission("stackchan-office", "camera.capture", true);

    await expect(service.invoke("camera.capture", {})).rejects.toMatchObject({ code: "invalid_device_response" });
    expect(service.status()).toMatchObject({ actionInProgress: false, activeAction: null });
  });

  it("denies unknown and cyclic permission dependencies", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      return response({
        deviceId: "stackchan-office",
        state: "idle",
        capabilities: [
          { name: "head.move", inputSchema: { type: "object" }, requires: ["camera.observe"] },
          { name: "camera.observe", inputSchema: { type: "object" }, requires: ["head.move"] },
          { ...capability, requires: ["infrared.send"] },
        ],
      });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    service.setAgentEnabled(true);
    await service.setPermission("stackchan-office", "head.move", true);
    await service.setPermission("stackchan-office", "camera.observe", true);
    await service.setPermission("stackchan-office", "camera.capture", true);

    expect(service.status().capabilities).toMatchObject([
      { name: "head.move", effectiveAllowed: false },
      { name: "camera.observe", effectiveAllowed: false },
      { name: "camera.capture", allowed: true, effectiveAllowed: false },
    ]);
    await expect(service.invoke("head.move", {})).rejects.toMatchObject({ code: "permission_dependency_denied" });
    await expect(service.invoke("camera.capture", {})).rejects.toMatchObject({ code: "permission_dependency_denied" });
  });

  it("fails closed when the device reports malformed dependencies", async () => {
    const fetchImpl = vi.fn(async () => response({
      deviceId: "stackchan-office",
      state: "idle",
      capabilities: [{ ...capability, requires: [null] }],
    }));
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });

    await service.pollDevice();

    expect(service.status()).toMatchObject({ connected: false, deviceId: null, lastPollError: "invalid_device_response" });
  });

  it("loads reserved-looking device and capability keys from persisted grants safely", async () => {
    permissionDirectory = await mkdtemp(join(tmpdir(), "buddy-prototype-keys-"));
    const permissionsFile = join(permissionDirectory, "permissions.json");
    await writeFile(permissionsFile, '{"__proto__":{"constructor":true}}');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      return response({ deviceId: "__proto__", state: "idle", capabilities: [{ name: "constructor", inputSchema: { type: "object" } }] });
    });
    const service = new BuddyService(settings({ permissionsFile }), { fetchImpl: fetchImpl as typeof fetch });

    await service.pollDevice();
    service.setAgentEnabled(true);
    expect(service.status().capabilities).toMatchObject([{ name: "constructor", allowed: true, effectiveAllowed: true }]);
    expect(await service.invoke("constructor", {})).toMatchObject({ result: { ok: true } });
  });

  it("aborts the device request when its caller disconnects", async () => {
    let actionCount = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        actionCount += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
      return response({ deviceId: "stackchan-office", state: "idle", capabilities: [capability] });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    await service.setPermission("stackchan-office", "camera.capture", true);
    service.setAgentEnabled(true);
    const controller = new AbortController();
    const action = service.invoke("camera.capture", {}, undefined, { permissionMode: "agent", signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(action).rejects.toMatchObject({ code: "request_cancelled", statusCode: 499 });
    expect(actionCount).toBe(1);
    expect(service.status()).toMatchObject({ actionInProgress: false, activeAction: null });
  });

  it("refreshes device freshness after a successful long-running capture response", async () => {
    let now = 1_000;
    let statusPollFails = false;
    let finishCapture: (() => void) | undefined;
    const captureResponse = new Promise<void>((resolve) => { finishCapture = resolve; });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        now += 30_000;
        await captureResponse;
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { image: { mimeType: "image/png", data: "ZmFrZQ==" } } });
      }
      return statusPollFails
        ? response({ error: "capture_busy" }, 503)
        : response({ deviceId: "stackchan-office", state: "idle", capabilities: [capability] });
    });
    const service = new BuddyService(settings({ freshnessMs: 8_000 }), {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
    });
    await service.pollDevice();
    await service.setPermission("stackchan-office", "camera.capture", true);
    service.setAgentEnabled(true);
    const capture = service.invoke("camera.capture", {});
    await Promise.resolve();

    statusPollFails = true;
    await service.pollDevice();
    expect(service.status()).toMatchObject({ connected: false, lastPollError: "buddy_unavailable" });

    finishCapture?.();
    await capture;

    expect(service.status().connected).toBe(true);
    expect(service.status()).not.toHaveProperty("lastPollError");
  });

  it("clears a previous image when a different device identity appears", async () => {
    let currentDeviceId = "stackchan-office";
    let statusPollCount = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { image: { mimeType: "image/jpeg", data: "ZmFrZQ==" } } });
      }
      statusPollCount += 1;
      return response({
        deviceId: currentDeviceId,
        state: { mode: statusPollCount === 1 ? "ready" : "post-capture" },
        capabilities: [capability],
      });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    await service.setPermission("stackchan-office", "camera.capture", true);
    service.setAgentEnabled(true);
    await service.invoke("camera.capture", {});
    expect(await service.handleGet("/v1/buddy/observation")).toMatchObject([200, { observation: { result: { image: { data: "ZmFrZQ==" } } } }]);
    await vi.waitFor(() => expect(service.status().state).toEqual({ mode: "post-capture" }));

    currentDeviceId = "stackchan-bedroom";
    await service.pollDevice();
    expect(await service.handleGet("/v1/buddy/observation")).toEqual([200, { observation: null }]);
  });

  it("clears a cached image when an image capability is revoked", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { image: { mimeType: "image/jpeg", data: "ZmFrZQ==" } } });
      }
      return response({
        deviceId: "stackchan-office",
        state: "idle",
        capabilities: [
          { name: "head.move", inputSchema: { type: "object" } },
          { name: "camera.capture", inputSchema: { type: "object" } },
          { name: "head.observe", inputSchema: { type: "object" }, requires: ["head.move", "camera.capture"] },
        ],
      });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    await service.setPermission("stackchan-office", "head.move", true);
    await service.setPermission("stackchan-office", "camera.capture", true);
    await service.setPermission("stackchan-office", "head.observe", true);
    service.setAgentEnabled(true);
    await service.invoke("head.observe", {});
    expect((await service.handleGet("/v1/buddy/observation"))[1].observation).toMatchObject({
      deviceId: "stackchan-office",
      capability: "head.observe",
      capturedAt: null,
      receivedAt: expect.any(String),
    });

    await service.setPermission("stackchan-office", "camera.capture", false);
    expect(await service.handleGet("/v1/buddy/observation")).toEqual([200, { observation: null }]);
  });

  it("marks the robot disconnected after heartbeat freshness expires", async () => {
    vi.useFakeTimers();
    let available = true;
    const fetchImpl = vi.fn(async () => available
      ? response({ deviceId: "stackchan-office", state: "idle", capabilities: [] })
      : response({ error: "offline" }, 503));
    const service = new BuddyService(settings({ freshnessMs: 1_000 }), { fetchImpl: fetchImpl as typeof fetch, now: () => Date.now() });
    await service.pollDevice();
    expect(service.status().connected).toBe(true);

    available = false;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(service.status().connected).toBe(false);
  });

  it("keeps permission writes and cached observations on a distinct admin credential", () => {
    const configured = settings();
    expect(credentialForBuddyRoute("POST", "/v1/buddy/permissions", configured)).toBe("admin-secret");
    expect(credentialForBuddyRoute("GET", "/v1/buddy/observation", configured)).toBe("admin-secret");
    expect(credentialForBuddyRoute("GET", "/v1/buddy/status", configured)).toBe("agent-secret");
    expect(credentialForBuddyRoute("POST", "/v1/buddy/invoke", configured)).toBe("agent-secret");
    expect(credentialForBuddyRoute("POST", "/v1/buddy/manual", configured)).toBe("admin-secret");
    expect(credentialForBuddyRoute("POST", "/v1/buddy/agent", configured)).toBe("admin-secret");
  });

  it("allows an admin manual action without changing agent grants", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const capabilities = [
      { name: "head.move", description: "Move the head", inputSchema: { type: "object" } },
      capability,
      { name: "head.observe", description: "Observe a direction", inputSchema: { type: "object" }, requires: ["head.move", "camera.capture"] },
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      return response({ deviceId: "stackchan-office", state: "idle", capabilities });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();
    service.setAgentEnabled(true);
    await expect(service.invoke("head.observe", { direction: "left" }))
      .rejects.toMatchObject({ code: "permission_denied" });

    const [status, result] = await service.handlePost("/v1/buddy/manual", {
      deviceId: "stackchan-office",
      capability: "head.observe",
      args: { direction: "left" },
    });

    expect(status).toBe(200);
    expect(result.result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ capability: "head.observe", args: { direction: "left" } });
    expect(service.status().capabilities).toMatchObject([
      { name: "head.move", allowed: false },
      { name: "camera.capture", allowed: false },
      { name: "head.observe", allowed: false },
    ]);
  });

  it("persists Agent activation separately from legacy grants and leaves manual control available", async () => {
    permissionDirectory = await mkdtemp(join(tmpdir(), "buddy-agent-enabled-"));
    const permissionsFile = join(permissionDirectory, "permissions.json");
    await writeFile(permissionsFile, '{"stackchan-office":{"camera.capture":true}}');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        return response({ requestId: body.requestId, result: { ok: true } });
      }
      return response({ deviceId: "stackchan-office", state: "idle", capabilities: [capability] });
    });
    const service = new BuddyService(settings({ permissionsFile }), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();

    expect(service.status()).toMatchObject({ agentEnabled: false, capabilities: [{ name: "camera.capture", allowed: true }] });
    await expect(service.invoke("camera.capture", {})).rejects.toMatchObject({ code: "buddy_agent_disabled" });
    expect(await service.handlePost("/v1/buddy/manual", {
      deviceId: "stackchan-office", capability: "camera.capture", args: {},
    })).toMatchObject([200, { result: { ok: true } }]);

    expect(await service.handlePost("/v1/buddy/agent", { enabled: true })).toEqual([200, { agentEnabled: true }]);
    const persisted = JSON.parse(await readFile(permissionsFile, "utf8"));
    expect(persisted).toEqual({
      schemaVersion: 2,
      agentEnabled: true,
      permissions: { "stackchan-office": { "camera.capture": true } },
    });

    const restoredService = new BuddyService(settings({ permissionsFile }), { fetchImpl: fetchImpl as typeof fetch });
    await restoredService.pollDevice();
    expect(restoredService.status()).toMatchObject({ agentEnabled: true, capabilities: [{ name: "camera.capture", allowed: true }] });
    expect(await restoredService.invoke("camera.capture", {})).toMatchObject({ result: { ok: true } });
  });

  it("rejects manual actions with missing capability dependencies", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? "GET") === "POST") return response({ requestId: "unexpected", result: {} });
      return response({
        deviceId: "stackchan-office",
        state: "idle",
        capabilities: [{ name: "head.observe", inputSchema: { type: "object" }, requires: ["camera.capture"] }],
      });
    });
    const service = new BuddyService(settings(), { fetchImpl: fetchImpl as typeof fetch });
    await service.pollDevice();

    await expect(service.handlePost("/v1/buddy/manual", {
      deviceId: "stackchan-office",
      capability: "head.observe",
      args: {},
    })).rejects.toMatchObject({ code: "buddy_dependency_unavailable", statusCode: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires tokens for public listeners and reads the static device URL", () => {
    expect(() => settingsFromEnv({ BUDDY_HOST: "0.0.0.0", BUDDY_SERVICE_TOKEN: "agent" }))
      .toThrow("BUDDY_ADMIN_TOKEN is required");
    expect(settingsFromEnv({
      BUDDY_DEVICE_URL: "http://192.168.1.40:8080",
      BUDDY_DEVICE_TOKEN: "device",
      BUDDY_SERVICE_TOKEN: "agent",
      BUDDY_ADMIN_TOKEN: "admin",
    })).toMatchObject({ deviceUrl: "http://192.168.1.40:8080", adminToken: "admin" });
  });

  it("budgets status polling for native device work without changing action timeout", () => {
    const env = { BUDDY_ADMIN_TOKEN: "admin", BUDDY_SERVICE_TOKEN: "agent" };
    expect(settingsFromEnv(env)).toMatchObject({
      requestTimeoutMs: 4_000, invokeTimeoutMs: 30_000,
    });
    expect(settingsFromEnv({ ...env, BUDDY_REQUEST_TIMEOUT_MS: "2500" }).requestTimeoutMs).toBe(2_500);
  });

  it("requires an admin credential on loopback and rejects credential reuse", () => {
    expect(() => settingsFromEnv({})).toThrow("BUDDY_ADMIN_TOKEN is required");
    expect(() => settingsFromEnv({ BUDDY_ADMIN_TOKEN: "same", BUDDY_SERVICE_TOKEN: "same" }))
      .toThrow("must be distinct");
  });
});
