import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";

import {
  BuddyConfigurationError,
  BuddyConnectionError,
  BuddyGateway,
  type BuddyEvent,
  type BuddyGatewayConfig,
  type BuddyGatewayStatus,
} from "./gateway.js";
import { HookRelay, type BuddyStatePort } from "./hook-relay.js";

export type BuddyServerSettings = {
  host: string;
  port: number;
  serviceToken: string;
  hookToken: string;
  approvalEnabled: boolean;
  approvalTimeoutSeconds: number;
  autoConnect: boolean;
  gateway: BuddyGatewayConfig;
};

const MAX_BODY_BYTES = 1_000_000;

export class BuddyService {
  readonly settings: BuddyServerSettings;
  readonly gateway: BuddyGateway;
  readonly relay: HookRelay;

  constructor(
    settings: BuddyServerSettings,
    options: { gateway?: BuddyGateway; relay?: HookRelay } = {},
  ) {
    this.settings = settings;
    this.gateway = options.gateway ?? new BuddyGateway(settings.gateway);
    this.relay = options.relay ?? new HookRelay(this.gateway, {
      approvalEnabled: settings.approvalEnabled,
      approvalTimeoutSeconds: settings.approvalTimeoutSeconds,
    });
  }

  health(): Record<string, unknown> {
    const status = this.gateway.status();
    return { ok: true, service: "buddy-service", runtime: "node", connected: status.connected };
  }

  async handleGet(path: string, query: URLSearchParams): Promise<[number, Record<string, unknown>]> {
    if (path === "/healthz") return [200, this.health()];
    if (path === "/v1/buddy/status") return [200, { status: sanitizeStatus(this.gateway.status()) }];
    if (path === "/v1/buddy/events") {
      const afterId = optionalNumber(query.get("after_id"));
      const limit = Math.max(1, Math.min(optionalNumber(query.get("limit")) ?? 50, 200));
      const events = this.gateway.getEvents({ afterId, limit }).filter((event) => {
        const eventType = query.get("event_type");
        return !eventType || event.type === eventType;
      });
      return [200, { events: events.map(sanitizeEvent) }];
    }
    if (path === "/v1/buddy/relay/sessions") return [200, { sessions: this.relay.snapshots() }];
    if (path.startsWith("/v1/buddy/relay/sessions/")) {
      const sessionId = decodeURIComponent(path.slice("/v1/buddy/relay/sessions/".length)).trim();
      const session = this.relay.snapshot(sessionId);
      return session ? [200, { session }] : [404, { error: "session_not_found" }];
    }
    return [404, { error: "not_found" }];
  }

  async handlePost(path: string, body: Record<string, unknown>): Promise<[number, Record<string, unknown>]> {
    if (path === "/v1/buddy/connect") {
      const status = await this.gateway.connect({
        ...(optionalString(body.port) ? { port: optionalString(body.port) } : {}),
        ...(optionalInteger(body.baud_rate) !== undefined ? { baudRate: optionalInteger(body.baud_rate) } : {}),
        ...(optionalString(body.transport) ? { transport: optionalString(body.transport) } : {}),
        ...(optionalString(body.tcp_host) ? { tcpHost: optionalString(body.tcp_host) } : {}),
        ...(optionalInteger(body.tcp_port) !== undefined ? { tcpPort: optionalInteger(body.tcp_port) } : {}),
        ...(optionalString(body.tcp_client_ip) ? { tcpClientIp: optionalString(body.tcp_client_ip) } : {}),
      });
      return [200, { status: sanitizeStatus(status) }];
    }
    if (path === "/v1/buddy/disconnect") return [200, { status: sanitizeStatus(await this.gateway.disconnect()) }];
    if (path === "/v1/buddy/state") {
      const state = requiredString(body, "state");
      return [200, { status: sanitizeStatus(this.gateway.setState(state, optionalString(body.text))) }];
    }
    if (path === "/v1/buddy/text") return [200, { status: sanitizeStatus(this.gateway.setText(requiredString(body, "text"))) }];
    if (path === "/v1/buddy/look") {
      return [200, { status: sanitizeStatus(this.gateway.look(requiredNumber(body, "yaw"), requiredNumber(body, "pitch"), optionalNumber(body.speed))) }];
    }
    if (path === "/v1/buddy/led") {
      return [200, { status: sanitizeStatus(this.gateway.setLed(requiredNumber(body, "r"), requiredNumber(body, "g"), requiredNumber(body, "b"), optionalNumber(body.ms))) }];
    }
    if (path === "/v1/buddy/approval") {
      const timeout = optionalNumber(body.timeout_seconds) ?? this.settings.approvalTimeoutSeconds;
      const approval = await this.gateway.requestApproval(requiredString(body, "request_id"), requiredString(body, "text"), timeout);
      return [200, { approval: sanitizeEvent(approval) }];
    }
    if (path === "/v1/agent/events") {
      const name = requiredString(body, "name");
      return [200, await this.relay.handleBody(name, body)];
    }
    const hookPrefix = path.startsWith("/api/copilot/hooks/") ? "/api/copilot/hooks/" : undefined;
    if (hookPrefix) {
      const eventName = path.slice(hookPrefix.length).trim();
      if (!eventName) return [400, { error: "event_name_required" }];
      const result = await this.relay.handleBody(eventName, body);
      return [200, result.effect];
    }
    return [404, { error: "not_found" }];
  }
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): BuddyServerSettings {
  const host = env.BUDDY_HOST?.trim() || "127.0.0.1";
  const settings: BuddyServerSettings = {
    host,
    port: integerEnv(env.BUDDY_PORT, 8765),
    serviceToken: env.BUDDY_SERVICE_TOKEN ?? "",
    hookToken: firstNonEmpty(
      env.BUDDY_HOOK_TOKEN,
      env.ANOMALO_COPILOT_HOOK_ADMIN_TOKEN,
      env.ANOMALO_ADMIN_TOKEN,
    ),
    approvalEnabled: booleanEnv(env.BUDDY_APPROVAL_ENABLED, false),
    approvalTimeoutSeconds: Math.max(0.1, floatEnv(env.BUDDY_APPROVAL_TIMEOUT_SECONDS, 30)),
    autoConnect: booleanEnv(env.BUDDY_AUTO_CONNECT, true),
    gateway: {
      transport: normalizeGatewayTransport(env.BUDDY_TRANSPORT),
      serialPort: env.BUDDY_SERIAL_PORT?.trim() || undefined,
      baudRate: integerEnv(env.BUDDY_BAUD_RATE, 115_200),
      tcpHost: env.BUDDY_TCP_HOST?.trim() || "127.0.0.1",
      tcpPort: integerEnv(env.BUDDY_TCP_PORT, 8766),
      tcpClientIp: env.BUDDY_TCP_CLIENT_IP?.trim() || undefined,
      hostName: env.BUDDY_HOST_NAME?.trim() || "",
      eventBufferSize: Math.max(1, integerEnv(env.BUDDY_EVENT_BUFFER_SIZE, 256)),
    },
  };
  if (!isLoopbackHost(host) && !settings.serviceToken) throw new Error("BUDDY_SERVICE_TOKEN is required when BUDDY_HOST is public.");
  if (!isLoopbackHost(host) && !settings.hookToken) throw new Error("BUDDY_HOOK_TOKEN is required when BUDDY_HOST is public.");
  const gatewayTransport = settings.gateway.transport === "auto"
    ? settings.gateway.serialPort ? "serial" : "tcp"
    : settings.gateway.transport;
  if (gatewayTransport === "tcp" && !isLoopbackHost(settings.gateway.tcpHost) && !settings.gateway.tcpClientIp) {
    throw new Error("BUDDY_TCP_CLIENT_IP is required when BUDDY_TCP_HOST is not loopback-only.");
  }
  return settings;
}

export function createBuddyHttpServer(service: BuddyService, settings: BuddyServerSettings = service.settings): Server {
  return createServer(async (request, response) => {
    try {
      const rawUrl = request.url ?? "/";
      const parsed = new URL(rawUrl, `http://${request.headers.host ?? "localhost"}`);
      const path = normalizePath(parsed.pathname);
      if (request.method === "GET") {
        if (path !== "/healthz" && !authorized(request, settings.serviceToken, settings.host)) {
          writeJson(response, 401, { error: "unauthorized" });
          return;
        }
        const [status, payload] = await service.handleGet(path, parsed.searchParams);
        writeJson(response, status, payload);
        return;
      }
      if (request.method === "POST") {
        const isHook = path.startsWith("/api/copilot/hooks/");
        if (!authorized(request, isHook ? settings.hookToken : settings.serviceToken, settings.host)) {
          writeJson(response, 401, { error: "unauthorized" });
          return;
        }
        const body = await readJson(request);
        const [status, payload] = await service.handlePost(path, body);
        writeJson(response, status, payload);
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      writeError(response, error);
    }
  });
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
  if (settings.autoConnect) {
    try {
      await service.gateway.connect();
    } catch (error) {
      console.warn("[buddy-service] Buddy gateway unavailable: " + errorMessage(error));
    }
  }
  return { service, server };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new RequestError(413, "request_body_too_large");
    chunks.push(buffer);
  }
  if (bytes === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "invalid_json");
  }
  if (!isRecord(parsed)) throw new RequestError(400, "request_body_must_be_object");
  return parsed;
}

function sanitizeEvent(event: BuddyEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    payload: event.payload,
    source: event.source,
    received_at: event.received_at,
  };
}

function sanitizeStatus(status: BuddyGatewayStatus & { command?: string }): Record<string, unknown> {
  const { last_event: lastEvent, ...rest } = status;
  return {
    ...rest,
    ...(lastEvent ? { last_event: sanitizeEvent(lastEvent) } : {}),
  };
}

function authorized(request: IncomingMessage, expected: string, host: string): boolean {
  if (!expected) return isLoopbackHost(host);
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ") && header.slice("Bearer ".length).trim() === expected) return true;
  const legacyHeader = request.headers["x-anomalo-admin-token"];
  return typeof legacyHeader === "string" && legacyHeader.trim() === expected;
}

function writeJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function writeError(response: ServerResponse, error: unknown): void {
  if (error instanceof RequestError) {
    writeJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof BuddyConfigurationError || error instanceof BuddyConnectionError) {
    writeJson(response, 503, { error: error.message, error_code: error.code });
    return;
  }
  if (error instanceof Error && ["state_required", "text_required", "request_id_required", "yaw_required", "pitch_required", "r_required", "g_required", "b_required", "integer_required", "number_required"].includes(error.message)) {
    writeJson(response, 400, { error: error.message });
    return;
  }
  writeJson(response, 500, { error: "internal_error" });
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body[key]);
  if (!value) throw new RequestError(400, `${key}_required`);
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "" || typeof value === "boolean") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RequestError(400, "number_required");
  return number;
}

function optionalInteger(value: unknown): number | undefined {
  const number = optionalNumber(value);
  if (number !== undefined && !Number.isInteger(number)) throw new RequestError(400, "integer_required");
  return number;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = optionalNumber(body[key]);
  if (value === undefined) throw new RequestError(400, `${key}_required`);
  return value;
}

function integerEnv(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function floatEnv(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeGatewayTransport(value: string | undefined): BuddyGatewayConfig["transport"] {
  const normalized = (value?.trim().toLowerCase() || "auto") as BuddyGatewayConfig["transport"];
  return ["auto", "tcp", "serial"].includes(normalized) ? normalized : "auto";
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || isIP(host) === 0 && host === "localhost";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
