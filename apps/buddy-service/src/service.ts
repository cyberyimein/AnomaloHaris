import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Ajv from "ajv";

import { convertRgb565Image } from "./image-codec.js";

export type BuddyCapability = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requires?: string[];
  [key: string]: unknown;
};

type DeviceSnapshot = {
  deviceId: string;
  state: unknown;
  capabilities: BuddyCapability[];
};

type AuthorizationState = {
  agentEnabled: boolean;
  permissions: Map<string, Map<string, boolean>>;
};

type ActiveBuddyAction = {
  requestId: string;
  deviceId: string;
  capability: string;
  startedAt: string;
  startedAtMs: number;
};

export type BuddyServerSettings = {
  host: string;
  port: number;
  serviceToken: string;
  adminToken: string;
  deviceUrl: string;
  deviceToken: string;
  pollIntervalMs: number;
  freshnessMs: number;
  requestTimeoutMs: number;
  invokeTimeoutMs: number;
  permissionsFile: string | undefined;
};

type BuddyServiceOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type BuddyInvokeOptions = {
  permissionMode: "agent" | "manual";
  signal?: AbortSignal;
};

const MAX_BODY_BYTES = 16_000_000;
const capabilitySchemaValidator = new Ajv({ allErrors: true, strict: false });

export class BuddyServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BuddyServiceError";
  }
}

export class BuddyService {
  readonly settings: BuddyServerSettings;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly permissions: Map<string, Map<string, boolean>>;
  private agentEnabled: boolean;
  private snapshot: DeviceSnapshot | undefined;
  private lastSuccessAt: number | undefined;
  private lastPollError: string | undefined;
  private activeAction: ActiveBuddyAction | null = null;
  private observation: {
    requestId: string;
    deviceId: string;
    capability: string;
    capturedAt: null;
    receivedAt: string;
    processedAt?: string;
    result: Record<string, unknown>;
  } | null = null;
  private pollTimer: NodeJS.Timeout | undefined;
  private pollInFlight: Promise<Record<string, unknown>> | undefined;
  private actionInProgress = false;

  constructor(settings: BuddyServerSettings, options: BuddyServiceOptions = {}) {
    validateServerSettings(settings);
    this.settings = settings;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    const authorization = settings.permissionsFile
      ? loadAuthorizationState(settings.permissionsFile)
      : { agentEnabled: false, permissions: new Map<string, Map<string, boolean>>() };
    this.permissions = authorization.permissions;
    this.agentEnabled = authorization.agentEnabled;
  }

  start(): void {
    if (this.pollTimer) return;
    void this.pollDevice();
    this.pollTimer = setInterval(() => void this.pollDevice(), this.settings.pollIntervalMs);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  health(): Record<string, unknown> {
    return { ok: true, service: "buddy-service", runtime: "node", connected: this.isConnected() };
  }

  status(): Record<string, unknown> {
    const capabilities = (this.snapshot?.capabilities ?? []).map((capability) => {
      const allowed = this.isPermissionAllowed(capability.name);
      return {
        ...capability,
        allowed,
        effectiveAllowed: this.isEffectivelyAllowed(capability.name),
      };
    });

    return {
      connected: this.isConnected(),
      agentEnabled: this.agentEnabled,
      deviceId: this.snapshot?.deviceId ?? null,
      state: this.snapshot?.state ?? null,
      capabilities,
      actionInProgress: this.actionInProgress,
      activeAction: this.activeAction
        ? {
          requestId: this.activeAction.requestId,
          capability: this.activeAction.capability,
          startedAt: this.activeAction.startedAt,
        }
        : null,
      lastSuccessAt: this.lastSuccessAt === undefined ? null : new Date(this.lastSuccessAt).toISOString(),
      ...(this.lastPollError ? { lastPollError: this.lastPollError } : {}),
    };
  }

  async pollDevice(): Promise<Record<string, unknown>> {
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.requestDevice("/v1/status", this.settings.requestTimeoutMs)
      .then((payload) => {
        const nextSnapshot = parseDeviceSnapshot(payload);
        if (this.snapshot && this.snapshot.deviceId !== nextSnapshot.deviceId) this.observation = null;
        this.snapshot = nextSnapshot;
        this.lastSuccessAt = this.now();
        this.lastPollError = undefined;
        return this.status();
      })
      .catch((error: unknown) => {
        this.lastPollError = error instanceof BuddyServiceError ? error.code : "device_unavailable";
        return this.status();
      })
      .finally(() => {
        this.pollInFlight = undefined;
      });
    return this.pollInFlight;
  }

  async setPermission(deviceId: string, capabilityName: string, allowed: boolean): Promise<Record<string, unknown>> {
    if (!this.snapshot || deviceId !== this.snapshot.deviceId) {
      throw new BuddyServiceError(404, "buddy_device_not_found", "The requested Buddy device is not currently known.");
    }
    if (!this.snapshot.capabilities.some((capability) => capability.name === capabilityName)) {
      throw new BuddyServiceError(404, "buddy_capability_not_found", "The requested Buddy capability is not available.");
    }

    const nextPermissions = clonePermissions(this.permissions);
    const devicePermissions = nextPermissions.get(deviceId) ?? new Map<string, boolean>();
    devicePermissions.set(capabilityName, allowed);
    nextPermissions.set(deviceId, devicePermissions);
    persistAuthorizationState(this.settings.permissionsFile, nextPermissions, this.agentEnabled);
    replacePermissions(this.permissions, nextPermissions);
    if (!allowed && this.observation && this.observation.deviceId === deviceId) {
      if (this.isObservationCapabilityRelated(this.observation.capability, capabilityName)) this.observation = null;
    }
    return {
      deviceId,
      capability: capabilityName,
      allowed,
      capabilities: this.status().capabilities,
    };
  }

  setAgentEnabled(enabled: boolean): Record<string, unknown> {
    persistAuthorizationState(this.settings.permissionsFile, this.permissions, enabled);
    this.agentEnabled = enabled;
    return { agentEnabled: this.agentEnabled };
  }

  async invoke(
    capabilityName: string,
    args: Record<string, unknown>,
    deviceId?: string,
    options: BuddyInvokeOptions = { permissionMode: "agent" },
  ): Promise<Record<string, unknown>> {
    if (this.actionInProgress) throw new BuddyServiceError(409, "buddy_busy", "Buddy is already executing an action.");
    if (options.signal?.aborted) throw new BuddyServiceError(499, "request_cancelled", "The Buddy action request was cancelled.");
    this.actionInProgress = true;
    try {
      const deviceSnapshot = this.requireCurrentDevice(deviceId);
      const capability = deviceSnapshot.capabilities.find((entry) => entry.name === capabilityName);
      if (!capability) {
        throw new BuddyServiceError(404, "buddy_capability_not_found", "The requested Buddy capability is not available.");
      }
      if (options.permissionMode === "agent") {
        if (!this.agentEnabled) {
          throw new BuddyServiceError(403, "buddy_agent_disabled", "Buddy tools are not enabled for the Agent.");
        }
        if (!this.isPermissionAllowed(capabilityName)) {
          throw new BuddyServiceError(403, "permission_denied", "This Buddy capability has not been allowed in the Buddy page.");
        }
        if (!this.isEffectivelyAllowed(capabilityName)) {
          throw new BuddyServiceError(403, "permission_dependency_denied", "A required Buddy capability is unavailable, denied, or depends on a cycle.");
        }
      } else if (options.permissionMode === "manual") {
        if (!this.hasCompleteDependencyGraph(capabilityName)) {
          throw new BuddyServiceError(422, "buddy_dependency_unavailable", "A required Buddy capability is missing or the dependency graph contains a cycle.");
        }
      } else {
        throw new BuddyServiceError(400, "invalid_permission_mode", "The Buddy action permission mode is invalid.");
      }
      validateCapabilityArguments(capability, args);

      const requestId = randomUUID();
      const startedAtMs = this.now();
      this.activeAction = {
        requestId,
        deviceId: deviceSnapshot.deviceId,
        capability: capabilityName,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
      };
      const payload = await this.requestDevice("/v1/invoke", this.settings.invokeTimeoutMs, {
        requestId,
        capability: capabilityName,
        args,
      }, options.signal);
      const receivedAt = new Date(this.now()).toISOString();
      if (payload.requestId !== requestId || !isRecord(payload.result)) {
        throw new BuddyServiceError(502, "invalid_device_response", "The Buddy device returned an invalid action response.");
      }
      const result = normalizeDeviceResult(payload.result);
      const processedAt = isRecord(result.image) ? new Date(this.now()).toISOString() : undefined;
      if (this.snapshot?.deviceId === deviceSnapshot.deviceId) {
        this.lastSuccessAt = this.now();
        this.lastPollError = undefined;
      }
      if (isRecord(result.image) && this.snapshot?.deviceId === deviceSnapshot.deviceId) {
        this.observation = {
          requestId,
          deviceId: deviceSnapshot.deviceId,
          capability: capabilityName,
          capturedAt: null,
          receivedAt,
          ...(processedAt ? { processedAt } : {}),
          result,
        };
      }
      if (this.snapshot?.deviceId === deviceSnapshot.deviceId) {
        this.refreshStatusAfterAction(deviceSnapshot.deviceId);
      }
      return { requestId, result };
    } finally {
      this.activeAction = null;
      this.actionInProgress = false;
    }
  }

  async handleGet(path: string, query: URLSearchParams = new URLSearchParams()): Promise<[number, Record<string, unknown>]> {
    if (path === "/healthz") return [200, this.health()];
    if (path === "/v1/buddy/status") return [200, this.status()];
    if (path === "/v1/buddy/observation" && query.get("deviceId") && query.get("deviceId") !== this.snapshot?.deviceId) {
      return [404, { error: "buddy_device_not_found" }];
    }
    if (path === "/v1/buddy/observation") return [200, { observation: this.observation }];
    return [404, { error: "not_found" }];
  }

  async handlePost(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<[number, Record<string, unknown>]> {
    if (path === "/v1/buddy/agent") {
      if (typeof body.enabled !== "boolean") throw new BuddyServiceError(400, "invalid_request", "enabled must be a boolean.");
      return [200, this.setAgentEnabled(body.enabled)];
    }
    if (path === "/v1/buddy/permissions") {
      const deviceId = requiredString(body, "deviceId");
      const capability = requiredString(body, "capability");
      if (typeof body.allowed !== "boolean") throw new BuddyServiceError(400, "invalid_request", "allowed must be a boolean.");
      return [200, await this.setPermission(deviceId, capability, body.allowed)];
    }
    if (path === "/v1/buddy/invoke" || path === "/v1/buddy/manual") {
      const isManual = path === "/v1/buddy/manual";
      const args = body.args === undefined ? {} : body.args;
      if (!isRecord(args)) throw new BuddyServiceError(400, "invalid_request", "args must be an object.");
      const deviceId = isManual
        ? requiredString(body, "deviceId")
        : typeof body.deviceId === "string" ? body.deviceId : undefined;
      const permissionMode = isManual ? "manual" : "agent";
      return [200, await this.invoke(requiredString(body, "capability"), args, deviceId, {
        permissionMode,
        ...(signal ? { signal } : {}),
      })];
    }
    return [404, { error: "not_found" }];
  }

  private isConnected(): boolean {
    if (!this.snapshot) return false;
    if (this.lastSuccessAt !== undefined && this.now() - this.lastSuccessAt <= this.settings.freshnessMs) return true;
    return this.activeAction !== null
      && this.activeAction.deviceId === this.snapshot.deviceId
      && this.now() - this.activeAction.startedAtMs < this.settings.invokeTimeoutMs;
  }

  private refreshStatusAfterAction(deviceId: string): void {
    const pollInFlight = this.pollInFlight;
    if (pollInFlight) {
      void pollInFlight.then(() => {
        if (this.snapshot?.deviceId === deviceId && !this.pollInFlight) void this.pollDevice();
      });
      return;
    }
    if (this.snapshot?.deviceId === deviceId) void this.pollDevice();
  }

  private isPermissionAllowed(capabilityName: string): boolean {
    if (!this.snapshot) return false;
    return this.permissions.get(this.snapshot.deviceId)?.get(capabilityName) === true;
  }

  private isEffectivelyAllowed(capabilityName: string, visiting = new Set<string>()): boolean {
    if (visiting.has(capabilityName)) return false;
    const capability = this.snapshot?.capabilities.find((entry) => entry.name === capabilityName);
    if (!capability || !this.isPermissionAllowed(capabilityName)) return false;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(capabilityName);
    return (capability.requires ?? []).every((dependency) => this.isEffectivelyAllowed(dependency, nextVisiting));
  }

  private hasCompleteDependencyGraph(capabilityName: string, visiting = new Set<string>()): boolean {
    if (visiting.has(capabilityName)) return false;
    const capability = this.snapshot?.capabilities.find((entry) => entry.name === capabilityName);
    if (!capability) return false;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(capabilityName);
    return (capability.requires ?? []).every((dependency) => this.hasCompleteDependencyGraph(dependency, nextVisiting));
  }

  private isObservationCapabilityRelated(observationCapability: string, disabledCapability: string): boolean {
    if (observationCapability === disabledCapability) return true;
    if (observationCapability.startsWith("camera.") || observationCapability.includes("observe")) {
      if (disabledCapability.startsWith("camera.") || disabledCapability.includes("observe")) return true;
    }
    return this.capabilityDependsOn(observationCapability, disabledCapability);
  }

  private capabilityDependsOn(capabilityName: string, dependencyName: string, visiting = new Set<string>()): boolean {
    if (visiting.has(capabilityName)) return false;
    const capability = this.snapshot?.capabilities.find((entry) => entry.name === capabilityName);
    if (!capability) return false;
    if ((capability.requires ?? []).includes(dependencyName)) return true;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(capabilityName);
    return (capability.requires ?? []).some((dependency) => this.capabilityDependsOn(dependency, dependencyName, nextVisiting));
  }

  private requireCurrentDevice(deviceId?: string): DeviceSnapshot {
    if (!this.isConnected() || !this.snapshot) {
      throw new BuddyServiceError(503, "buddy_unavailable", "Buddy is disconnected or its status is stale.");
    }
    if (deviceId && deviceId !== this.snapshot.deviceId) {
      throw new BuddyServiceError(404, "buddy_device_not_found", "The requested Buddy device is not connected.");
    }
    return this.snapshot;
  }

  private async requestDevice(path: string, timeoutMs: number, body?: Record<string, unknown>, callerSignal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.settings.deviceUrl) throw new BuddyServiceError(503, "buddy_unconfigured", "BUDDY_DEVICE_URL is not configured.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.settings.deviceUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.settings.deviceToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const payload = await readResponse(response);
      if (!response.ok) throw new BuddyServiceError(503, "buddy_unavailable", "Buddy did not accept the request.");
      return payload;
    } catch (error) {
      if (error instanceof BuddyServiceError) throw error;
      const cancelled = callerSignal?.aborted === true;
      const code = cancelled ? "request_cancelled" : error instanceof Error && error.name === "AbortError" ? "buddy_timeout" : "buddy_unavailable";
      throw new BuddyServiceError(cancelled ? 499 : 503, code, "Buddy did not respond to the request.");
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): BuddyServerSettings {
  const host = env.BUDDY_HOST?.trim() || "127.0.0.1";
  const deviceUrl = env.BUDDY_DEVICE_URL?.trim().replace(/\/$/, "") ?? "";
  const settings: BuddyServerSettings = {
    host,
    port: integerEnv(env.BUDDY_PORT, 8765),
    serviceToken: env.BUDDY_SERVICE_TOKEN?.trim() ?? "",
    adminToken: env.BUDDY_ADMIN_TOKEN?.trim() ?? "",
    deviceUrl,
    deviceToken: env.BUDDY_DEVICE_TOKEN?.trim() ?? "",
    pollIntervalMs: Math.max(250, integerEnv(env.BUDDY_POLL_INTERVAL_MS, 2_000)),
    freshnessMs: Math.max(500, integerEnv(env.BUDDY_FRESHNESS_MS, 8_000)),
    requestTimeoutMs: Math.max(100, integerEnv(env.BUDDY_REQUEST_TIMEOUT_MS, 4_000)),
    invokeTimeoutMs: Math.max(1_000, integerEnv(env.BUDDY_INVOKE_TIMEOUT_MS, 30_000)),
    permissionsFile: env.BUDDY_PERMISSIONS_FILE?.trim() || join(process.cwd(), "data", "buddy", "permissions.json"),
  };
  validateServerSettings(settings);
  return settings;
}

function validateServerSettings(settings: BuddyServerSettings): void {
  if (!settings.adminToken) throw new Error("BUDDY_ADMIN_TOKEN is required.");
  if (!isLoopbackHost(settings.host) && !settings.serviceToken) {
    throw new Error("BUDDY_SERVICE_TOKEN is required when BUDDY_HOST is public.");
  }
  if (settings.deviceUrl && !settings.deviceToken) {
    throw new Error("BUDDY_DEVICE_TOKEN is required when BUDDY_DEVICE_URL is configured.");
  }
  const credentials = [settings.serviceToken, settings.adminToken, settings.deviceToken].filter(Boolean);
  if (new Set(credentials).size !== credentials.length) {
    throw new Error("BUDDY_SERVICE_TOKEN, BUDDY_ADMIN_TOKEN, and BUDDY_DEVICE_TOKEN must be distinct when supplied.");
  }
  if (settings.deviceUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(settings.deviceUrl);
    } catch {
      throw new Error("BUDDY_DEVICE_URL must be a valid HTTP URL.");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("BUDDY_DEVICE_URL must use HTTP or HTTPS.");
  }
}

export function createBuddyHttpServer(service: BuddyService, settings: BuddyServerSettings = service.settings): Server {
  return createServer(async (request, response) => {
    try {
      const parsed = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const path = normalizePath(parsed.pathname);
      if (request.method === "GET") {
        if (path !== "/healthz" && !authorized(request, credentialForBuddyRoute("GET", path, settings), settings.host)) {
          writeJson(response, 401, { error: "unauthorized" });
          return;
        }
        const [status, payload] = await service.handleGet(path, parsed.searchParams);
        writeJson(response, status, payload);
        return;
      }
      if (request.method === "POST") {
        const expectedToken = credentialForBuddyRoute("POST", path, settings);
        if (!authorized(request, expectedToken, settings.host)) {
          writeJson(response, 401, { error: "unauthorized" });
          return;
        }
        const body = await readJson(request);
        const controller = new AbortController();
        const abortIfClientDisconnects = () => {
          if (!response.writableEnded) controller.abort();
        };
        if (request.aborted || response.destroyed) controller.abort();
        response.on("close", abortIfClientDisconnects);
        let result: [number, Record<string, unknown>];
        try {
          result = await service.handlePost(path, body, controller.signal);
        } finally {
          response.off("close", abortIfClientDisconnects);
        }
        const [status, payload] = result;
        writeJson(response, status, payload);
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      if (!response.destroyed) writeError(response, error);
    }
  });
}

export function credentialForBuddyRoute(
  method: "GET" | "POST",
  path: string,
  settings: BuddyServerSettings,
): string {
  if ((method === "GET" && path === "/v1/buddy/observation")
    || (method === "POST" && (path === "/v1/buddy/permissions" || path === "/v1/buddy/manual" || path === "/v1/buddy/agent"))) return settings.adminToken;
  return settings.serviceToken;
}

export async function startBuddyService(settings: BuddyServerSettings = settingsFromEnv()): Promise<{ service: BuddyService; server: Server }> {
  const service = new BuddyService(settings);
  const server = createBuddyHttpServer(service, settings);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(settings.port, settings.host);
  });
  service.start();
  return { service, server };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new BuddyServiceError(413, "request_body_too_large", "Request body is too large.");
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BuddyServiceError(400, "invalid_json", "Request body is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new BuddyServiceError(400, "invalid_request", "Request body must be a JSON object.");
  return parsed;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new BuddyServiceError(502, "device_response_too_large", "Buddy returned a response that is too large.");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8")) as unknown;
  } catch {
    throw new BuddyServiceError(502, "invalid_device_response", "Buddy returned invalid JSON.");
  }
  if (!isRecord(payload)) throw new BuddyServiceError(502, "invalid_device_response", "Buddy returned an invalid response.");
  return payload;
}

function validateCapabilityArguments(capability: BuddyCapability, args: Record<string, unknown>): void {
  let validator: ReturnType<typeof capabilitySchemaValidator.compile>;
  try {
    validator = capabilitySchemaValidator.compile(capability.inputSchema);
  } catch {
    throw new BuddyServiceError(502, "invalid_capability_schema", "Buddy reported an invalid input schema for this capability.");
  }
  if (!validator(args)) {
    throw new BuddyServiceError(400, "invalid_capability_arguments", "The Buddy action arguments do not match the device capability schema.");
  }
}

function normalizeDeviceResult(result: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(result.image) || result.image.mimeType !== "application/x-rgb565") return result;
  try {
    return { ...result, image: convertRgb565Image(result.image) };
  } catch {
    throw new BuddyServiceError(502, "invalid_device_image", "Buddy returned a malformed RGB565 image.");
  }
}

function parseDeviceSnapshot(payload: Record<string, unknown>): DeviceSnapshot {
  if (typeof payload.deviceId !== "string" || !payload.deviceId.trim()) {
    throw new BuddyServiceError(502, "invalid_device_response", "Buddy status did not include a device ID.");
  }
  if (!Array.isArray(payload.capabilities)) {
    throw new BuddyServiceError(502, "invalid_device_response", "Buddy status did not include a capability list.");
  }
  const capabilities = payload.capabilities.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
      throw new BuddyServiceError(502, "invalid_device_response", "Buddy returned an invalid capability.");
    }
    const inputSchema = isRecord(entry.inputSchema) ? entry.inputSchema : { type: "object" };
    let requires: string[] | undefined;
    if ("requires" in entry) {
      if (!Array.isArray(entry.requires) || !entry.requires.every((dependency) => typeof dependency === "string" && dependency.trim())) {
        throw new BuddyServiceError(502, "invalid_device_response", "Buddy returned an invalid capability dependency list.");
      }
      requires = entry.requires.map((dependency) => (dependency as string).trim());
    }
    return {
      ...entry,
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : entry.name,
      inputSchema,
      ...(requires ? { requires } : {}),
    } as BuddyCapability;
  });
  return { deviceId: payload.deviceId.trim(), state: payload.state ?? null, capabilities };
}

function loadAuthorizationState(filePath: string): AuthorizationState {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(value)) return { agentEnabled: false, permissions: new Map() };
    if (value.schemaVersion === 2) {
      return {
        agentEnabled: value.agentEnabled === true,
        permissions: parsePermissionMap(value.permissions),
      };
    }
    return { agentEnabled: false, permissions: parsePermissionMap(value) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { agentEnabled: false, permissions: new Map() };
    throw new Error(`Buddy permissions file could not be read: ${filePath}`);
  }
}

function parsePermissionMap(value: unknown): Map<string, Map<string, boolean>> {
  if (!isRecord(value)) return new Map();
  const permissions = new Map<string, Map<string, boolean>>();
  for (const [deviceId, devicePermissions] of Object.entries(value)) {
      if (!isRecord(devicePermissions)) continue;
      permissions.set(deviceId, new Map(
        Object.entries(devicePermissions).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
      ));
  }
  return permissions;
}

function persistAuthorizationState(
  filePath: string | undefined,
  permissions: Map<string, Map<string, boolean>>,
  agentEnabled: boolean,
): void {
  if (!filePath) return;
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const serializedPermissions = Object.fromEntries(
      Array.from(permissions, ([deviceId, devicePermissions]) => [deviceId, Object.fromEntries(devicePermissions)]),
    );
    const state = { schemaVersion: 2, agentEnabled, permissions: serializedPermissions };
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } catch {
    throw new BuddyServiceError(500, "permissions_persistence_failed", "Buddy permissions could not be saved.");
  }
}

function replacePermissions(target: Map<string, Map<string, boolean>>, source: Map<string, Map<string, boolean>>): void {
  target.clear();
  for (const [deviceId, devicePermissions] of source) target.set(deviceId, devicePermissions);
}

function clonePermissions(source: Map<string, Map<string, boolean>>): Map<string, Map<string, boolean>> {
  return new Map(Array.from(source, ([deviceId, devicePermissions]) => [deviceId, new Map(devicePermissions)]));
}

function authorized(request: IncomingMessage, expected: string, host: string): boolean {
  if (!expected) return isLoopbackHost(host);
  const authorization = request.headers.authorization;
  return isBearerAuthorized(authorization, expected, host);
}

function isBearerAuthorized(authorization: string | string[] | undefined, expected: string, host: string): boolean {
  if (!expected) return isLoopbackHost(host);
  return typeof authorization === "string"
    && authorization.startsWith("Bearer ")
    && authorization.slice("Bearer ".length).trim() === expected;
}

function writeJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function writeError(response: ServerResponse, error: unknown): void {
  if (error instanceof BuddyServiceError) {
    writeJson(response, error.statusCode, { error: error.code, message: error.message });
    return;
  }
  writeJson(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new BuddyServiceError(400, "invalid_request", `${key} is required.`);
  return value.trim();
}

function integerEnv(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Expected an integer environment value, got ${value}.`);
  return parsed;
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
