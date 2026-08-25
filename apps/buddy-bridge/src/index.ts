import { legacyNamingAdapter, type ToolCall, type ToolDefinition, type ToolResult } from "@anomaloharis/contracts";

type PluginContext = {
  sessionId?: string;
  runId?: string;
  [key: string]: unknown;
};

type PluginEvent = {
  type: string;
  context: PluginContext;
  call?: ToolCall;
  result?: ToolResult;
  eventType?: string;
};

type PluginEventResult = { metadata?: Record<string, unknown> };

type PluginApi = {
  registerTool(definition: ToolDefinition, handler: (call: ToolCall, context: PluginContext, signal: AbortSignal) => Promise<ToolResult>): void;
  registerCapability(definition: { id: string; kind: "tool" | "service"; description?: string }): void;
  on(event: string, hook: (event: PluginEvent) => PluginEventResult | void | Promise<PluginEventResult | void>): void;
};

type BuddyExtension = {
  capabilities: Array<{ id: string; kind: "tool" | "service"; description: string }>;
  tools: ToolDefinition[];
  callTool(call: ToolCall, context: PluginContext, signal: AbortSignal): Promise<ToolResult>;
  hooks: Record<string, (event: PluginEvent) => PluginEventResult | void | Promise<PluginEventResult | void>>;
};

const SERVICE_URL_ENV = "ANOMALOHARIS_BUDDY_SERVICE_URL";
const SERVICE_TOKEN_ENV = "ANOMALOHARIS_BUDDY_SERVICE_TOKEN";
const REQUEST_TIMEOUT_ENV = "ANOMALOHARIS_BUDDY_REQUEST_TIMEOUT_MS";
const DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "buddy_status",
    description: "Read Buddy connection and device status from the independent Buddy backend.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    source: "buddy-bridge",
  },
  {
    name: "buddy_recent_events",
    description: "Read recent sanitized Buddy device events, optionally after an event id.",
    parameters: {
      type: "object",
      properties: {
        after_id: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        event_type: { type: "string" },
      },
      additionalProperties: false,
    },
    source: "buddy-bridge",
  },
  {
    name: "buddy_set_state",
    description: "Set Buddy's visual state and optional short status text.",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["idle", "listening", "thinking", "speaking", "stop", "error", "coding", "approval", "done"] },
        text: { type: "string", maxLength: 240 },
      },
      required: ["state"],
      additionalProperties: false,
    },
    source: "buddy-bridge",
  },
  {
    name: "buddy_set_text",
    description: "Set Buddy's short status text without changing its visual state.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", maxLength: 240 } },
      required: ["text"],
      additionalProperties: false,
    },
    source: "buddy-bridge",
  },
  {
    name: "buddy_look",
    description: "Move Buddy's head to a yaw/pitch target through the Buddy backend.",
    parameters: {
      type: "object",
      properties: {
        yaw: { type: "integer" },
        pitch: { type: "integer" },
        speed: { type: "integer", minimum: 0 },
      },
      required: ["yaw", "pitch"],
      additionalProperties: false,
    },
    source: "buddy-bridge",
  },
  {
    name: "buddy_set_led",
    description: "Set Buddy's LED color for an optional short duration.",
    parameters: {
      type: "object",
      properties: {
        r: { type: "integer", minimum: 0, maximum: 255 },
        g: { type: "integer", minimum: 0, maximum: 255 },
        b: { type: "integer", minimum: 0, maximum: 255 },
        ms: { type: "integer", minimum: 0, maximum: 60_000 },
      },
      required: ["r", "g", "b"],
      additionalProperties: false,
    },
    source: "buddy-bridge",
  },
  {
    name: "buddy_request_approval",
    description: "Show a Buddy approval prompt and wait for an explicit user decision.",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 160 },
        text: { type: "string", minLength: 1, maxLength: 240 },
        timeout_seconds: { type: "number", minimum: 0.1, maximum: 120 },
      },
      required: ["request_id", "text"],
      additionalProperties: false,
    },
    source: "buddy-bridge",
  },
];

export default function createBuddyBridge(_api: PluginApi): BuddyExtension {
  const client = new BuddyServiceClient();
  return {
    capabilities: [{ id: "buddy", kind: "service", description: "Optional Buddy device and approval service." }],
    tools: TOOL_DEFINITIONS,
    callTool: (call, context, signal) => client.callTool(call, context, signal),
    hooks: {
      before_agent_start: async (event) => { await client.notify("userPromptSubmitted", event.context); },
      tool_call: async (event) => { if (event.call) await client.notify("preToolUse", event.context, { tool_name: event.call.name }); },
      tool_result: async (event) => { if (event.call) await client.notify("postToolUse", event.context, { tool_name: event.call.name, ok: event.result?.ok }); },
      agent_end: async (event) => {
        const eventType = event.eventType ?? "run.finished";
        const name = eventType === "run.error" ? "sessionEnd" : "agentStop";
        await client.notify(name, event.context, { reason: eventType === "run.finished" ? "complete" : eventType.replace("run.", "") });
      },
    },
  };
}

export class BuddyServiceClient {
  private readonly baseUrl = (legacyNamingAdapter.readEnv(process.env, SERVICE_URL_ENV) || DEFAULT_SERVICE_URL).replace(/\/$/, "");
  private readonly token = legacyNamingAdapter.readEnv(process.env, SERVICE_TOKEN_ENV) || "";
  private readonly timeoutMs = boundedNumber(legacyNamingAdapter.readEnv(process.env, REQUEST_TIMEOUT_ENV), DEFAULT_REQUEST_TIMEOUT_MS, 100, 30_000);
  private readonly eventQueues = new Map<string, Promise<void>>();

  async callTool(call: ToolCall, context: PluginContext, signal: AbortSignal): Promise<ToolResult> {
    try {
      const request = routeForTool(call.name, call.arguments);
      const response = await this.request(request.route, context, signal, {
        ...(request.method ? { method: request.method } : {}),
        ...(request.body ? { body: request.body } : {}),
      });
      return {
        name: call.name,
        ok: true,
        content: toolSummary(call.name, response),
        data: response,
      };
    } catch (error) {
      return {
        name: call.name,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        data: { error_code: "buddy_unavailable" },
      };
    }
  }

  async notify(name: string, context: PluginContext, payload: Record<string, unknown> = {}): Promise<void> {
    const key = context.sessionId || "__buddy-no-session__";
    const previous = this.eventQueues.get(key) ?? Promise.resolve();
    let current!: Promise<void>;
    current = previous
      .catch(() => undefined)
      .then(async () => {
        await this.request(
          "/v1/agent/events",
          context,
          AbortSignal.timeout(Math.min(this.timeoutMs, 500)),
          { method: "POST", body: { name, session_id: context.sessionId, run_id: context.runId, payload } },
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.eventQueues.get(key) === current) this.eventQueues.delete(key);
      });
    this.eventQueues.set(key, current);
    await current;
  }

  private async request(
    route: string,
    context: PluginContext,
    signal: AbortSignal,
    options: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new Error("Buddy request cancelled.");
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const body = options.body
      ? JSON.stringify({ ...options.body, ...(context.sessionId ? { session_id: context.sessionId } : {}), ...(context.runId ? { run_id: context.runId } : {}) })
      : undefined;
    const response = await fetch(`${this.baseUrl}${route}`, {
      method: options.method ?? "GET",
      headers,
      ...(body ? { body } : {}),
      signal: requestSignal,
    });
    const raw = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      // The status code below is enough to produce a sanitized tool error.
    }
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : `Buddy backend returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    return payload;
  }
}

function routeForTool(name: string, arguments_: Record<string, unknown>): { route: string; method?: "GET" | "POST"; body?: Record<string, unknown> } {
  if (name === "buddy_status") return { route: "/v1/buddy/status" };
  if (name === "buddy_recent_events") {
    const query = new URLSearchParams();
    for (const key of ["after_id", "limit", "event_type"]) {
      const value = arguments_[key];
      if (value !== undefined && value !== null && String(value)) query.set(key, String(value));
    }
    return { route: `/v1/buddy/events${query.toString() ? `?${query}` : ""}` };
  }
  if (name === "buddy_set_state") return { route: "/v1/buddy/state", method: "POST", body: arguments_ };
  if (name === "buddy_set_text") return { route: "/v1/buddy/text", method: "POST", body: arguments_ };
  if (name === "buddy_look") return { route: "/v1/buddy/look", method: "POST", body: arguments_ };
  if (name === "buddy_set_led") return { route: "/v1/buddy/led", method: "POST", body: arguments_ };
  if (name === "buddy_request_approval") return { route: "/v1/buddy/approval", method: "POST", body: arguments_ };
  throw new Error(`Unknown Buddy tool: ${name}`);
}

function toolSummary(name: string, response: Record<string, unknown>): string {
  if (name === "buddy_status") return "Buddy status read.";
  if (name === "buddy_recent_events") return `Buddy events returned: ${Array.isArray(response.events) ? response.events.length : 0}.`;
  if (name === "buddy_request_approval") return "Buddy approval response received.";
  return "Buddy command completed.";
}

function boundedNumber(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
