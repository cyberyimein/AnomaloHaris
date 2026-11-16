import { legacyNamingAdapter, type ToolCall, type ToolDefinition, type ToolResult } from "@anomaloharis/contracts";

const tools: ToolDefinition[] = [
  {
    name: "buddy_capabilities",
    description: "Read the robot connection, deviceId, current device state including state.lighting, dynamically installed capability schemas, and dashboard grants. Before acting, require allowed=true and effectiveAllowed=true, including declared dependencies.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    source: "buddy-bridge",
  },
  {
    name: "buddy_invoke",
    description: "Invoke a discovered capability only when buddy_capabilities reports allowed=true and effectiveAllowed=true; never retry or bypass a permission denial, and tell the user which Buddy-page grant is missing. When led.express is available and granted, inspect state.lighting and use the light bar sparingly as a preferred body-feedback channel for meaningful listening, thinking, speaking, happy, curious, concerned, or calm cues. Preserve an existing manual override unless the user requests a change. Use led.resume only when separately granted to restore automatic lifecycle lighting after your own temporary cue; otherwise let the expression expire. Keep Buddy body feedback independent; do not automatically mirror generic Agent or Codex execution hooks. A camera observation returns a fresh image.",
    parameters: {
      type: "object",
      properties: { deviceId: { type: "string" }, capability: { type: "string" }, args: { type: "object" } },
      required: ["capability", "args"],
      additionalProperties: false,
    },
    source: "buddy-bridge",
    timeout_ms: 30000,
  },
];

function setting(name: string) {
  return legacyNamingAdapter.readEnv(process.env, name);
}

export default function createBuddyBridge(_api: unknown) {
  const baseUrl = (setting("ANOMALOHARIS_BUDDY_SERVICE_URL") || "http://127.0.0.1:8765").replace(/\/$/, "");
  const token = setting("ANOMALOHARIS_BUDDY_SERVICE_TOKEN");
  const configuredTimeout = Number(setting("ANOMALOHARIS_BUDDY_REQUEST_TIMEOUT_MS"));
  const timeout = configuredTimeout > 0 ? Math.min(30000, configuredTimeout) : 29000;
  return {
    capabilities: [{ id: "buddy", kind: "service", description: "Independent LAN robot." }],
    tools,
    hooks: {},
    async callTool(call: ToolCall, _context: unknown, signal: AbortSignal): Promise<ToolResult> {
      try {
        const invoke = call.name === "buddy_invoke";
        if (!invoke && call.name !== "buddy_capabilities") throw new Error("Unknown Buddy tool.");
        const response = await fetch(baseUrl + (invoke ? "/v1/buddy/invoke" : "/v1/buddy/status"), {
          method: invoke ? "POST" : "GET",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(invoke ? { body: JSON.stringify(call.arguments) } : {}),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        });
        const payload = await response.json();
        if (!response.ok) {
          const detail = payload?.message ?? payload?.error;
          return {
            name: call.name,
            ok: false,
            content: typeof detail === "string" ? detail : `Buddy returned HTTP ${response.status}.`,
            data: { status: response.status, error_code: payload?.error ?? "buddy_unavailable" },
          };
        }
        if (!payload || typeof payload !== "object" || (invoke && !payload.result)) throw new Error("Invalid Buddy response.");
        const image = payload.result?.image;
        if (image !== undefined) {
          if (!["image/png", "image/jpeg"].includes(image?.mimeType) || typeof image.data !== "string" || !image.data.length ||
              image.data.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("Invalid Buddy image.");
          const { data: bytes, ...metadata } = image;
          payload.result.image = metadata;
          return {
            name: call.name, ok: true, content: JSON.stringify(payload), data: payload,
            image: { mimeType: image.mimeType, data: bytes },
          };
        }
        return { name: call.name, ok: true, content: JSON.stringify(payload), data: payload };
      } catch (error) {
        return { name: call.name, ok: false, content: error instanceof Error ? error.message : "Buddy unavailable.", data: {} };
      }
    },
  };
}
