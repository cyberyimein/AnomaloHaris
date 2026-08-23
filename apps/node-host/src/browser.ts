import type { ToolCall, ToolDefinition, ToolResult } from "@anomalo/contracts";

import type { ToolRuntime } from "./tools.js";
import type { ToolContext } from "./types.js";

export type BrowserMessageSender = (message: Record<string, unknown>) => void | Promise<void>;
export type BrowserRegistration = { sessionId: string; token: symbol };

type PendingCall = {
  call: ToolCall;
  context: ToolContext;
  resolve: (result: ToolResult) => void;
  timer: NodeJS.Timeout;
};

export const BROWSER_TOOL_NAMES = [
  "browser.get_page_state",
  "browser.navigate",
  "browser.click",
  "browser.fill",
  "browser.type_text",
  "browser.press_key",
  "browser.select_option",
  "browser.wait_for",
  "browser.screenshot",
] as const;

/** Host-side bridge for the existing browser.tool.call/result WebSocket protocol. */
export class BrowserToolBridge {
  private readonly senders = new Map<string, { sender: BrowserMessageSender; token: symbol }>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 60_000) {
    this.timeoutMs = Math.max(1_000, timeoutMs);
  }

  register(sessionId: string, sender: BrowserMessageSender): BrowserRegistration {
    const token = Symbol(sessionId);
    this.senders.set(sessionId, { sender, token });
    return { sessionId, token };
  }

  unregister(registration: BrowserRegistration, reason = "browser_client_disconnected"): void {
    const current = this.senders.get(registration.sessionId);
    if (!current || current.token !== registration.token) return;
    this.senders.delete(registration.sessionId);
    for (const [key, pending] of this.pending) {
      if (pending.context.sessionId !== registration.sessionId) continue;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.resolve(browserError(pending.call.name, `The browser bridge was disconnected: ${reason}.`, "BROWSER_UNAVAILABLE"));
    }
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) return browserError(call.name, "The browser tool call was cancelled.", "CANCELLED");
    const senderEntry = this.senders.get(context.sessionId);
    if (!senderEntry) return browserError(call.name, "The browser bridge is not connected.", "BROWSER_UNAVAILABLE");
    const key = `${context.sessionId}:${context.runId}:${call.id}`;
    if (this.pending.has(key)) return browserError(call.name, "This browser tool call is already pending.", "DUPLICATE_CALL");
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        void this.sendCancel(senderEntry.sender, call, context, "browser_tool_timeout");
        resolve(browserError(call.name, "The browser tool call exceeded its deadline.", "DEADLINE_EXCEEDED"));
      }, this.timeoutMs);
      this.pending.set(key, { call, context, resolve, timer });
      const onAbort = () => {
        if (!this.pending.delete(key)) return;
        clearTimeout(timer);
        void this.sendCancel(senderEntry.sender, call, context, "run_cancelled");
        resolve(browserError(call.name, "The browser tool call was cancelled.", "CANCELLED"));
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve(senderEntry.sender({
        type: "browser.tool.call",
        session_id: context.sessionId,
        run_id: context.runId,
        data: {
          tool_call_id: call.id,
          tool: call.name,
          arguments: call.arguments,
          timeout_ms: this.timeoutMs,
        },
      })).catch((error: unknown) => {
        if (!this.pending.delete(key)) return;
        clearTimeout(timer);
        resolve(browserError(call.name, `Could not send browser tool call: ${error instanceof Error ? error.message : String(error)}`, "BROWSER_UNAVAILABLE"));
      });
    });
  }

  complete(message: Record<string, any>): boolean {
    const sessionId = typeof message.session_id === "string" ? message.session_id : "";
    const runId = typeof message.run_id === "string" ? message.run_id : "";
    const data = isRecord(message.data) ? message.data : {};
    const toolCallId = typeof data.tool_call_id === "string" ? data.tool_call_id : "";
    const key = `${sessionId}:${runId}:${toolCallId}`;
    const pending = this.pending.get(key);
    if (!pending || (data.status !== "ok" && data.status !== "error")) return false;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (data.status === "ok") {
      const result = isRecord(data.result) ? data.result : {};
      pending.resolve({ name: pending.call.name, ok: true, content: JSON.stringify(result), data: result });
    } else {
      const error = isRecord(data.error) ? data.error : {};
      const content = typeof error.message === "string" ? error.message : "The browser extension reported an error.";
      pending.resolve({ name: pending.call.name, ok: false, content, data: { error } });
    }
    return true;
  }

  hasRegistration(sessionId: string): boolean {
    return this.senders.has(sessionId);
  }

  private async sendCancel(sender: BrowserMessageSender, call: ToolCall, context: ToolContext, reason: string): Promise<void> {
    try {
      await sender({ type: "browser.tool.cancel", session_id: context.sessionId, run_id: context.runId, data: { tool_call_id: call.id, reason } });
    } catch {
      // The connection is already unavailable; the pending call has a terminal result.
    }
  }
}

export class BrowserToolRuntime implements ToolRuntime {
  constructor(private readonly bridge: BrowserToolBridge) {}

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    if (!this.bridge.hasRegistration(context.sessionId)) return [];
    return BROWSER_TOOL_NAMES.map((name) => ({
      name,
      description: browserDescription(name),
      parameters: browserParameters(name),
      source: "browser_bridge",
    }));
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    if (!(BROWSER_TOOL_NAMES as readonly string[]).includes(call.name)) return browserError(call.name, `Unknown browser tool: ${call.name}`, "TOOL_NOT_FOUND");
    if (!context.toolCallId || context.toolCallId !== call.id) return browserError(call.name, "Browser tool call identifiers are invalid.", "INVALID_CONTEXT");
    return this.bridge.call(call, context, signal);
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return [{ provider: "browser_bridge", available: this.bridge.hasRegistration(context.sessionId), tool_count: BROWSER_TOOL_NAMES.length }];
  }
}

function browserDescription(name: string): string {
  const descriptions: Record<string, string> = {
    "browser.get_page_state": "Inspect the connected control tab and return its current page state.",
    "browser.navigate": "Navigate the connected control tab to an HTTP(S) URL.",
    "browser.click": "Click a current browser target reference.",
    "browser.fill": "Fill a non-sensitive browser input.",
    "browser.type_text": "Type bounded text through the browser control bridge.",
    "browser.press_key": "Press a supported key in the browser control tab.",
    "browser.select_option": "Select an option in a native browser select.",
    "browser.wait_for": "Wait for a browser page condition.",
    "browser.screenshot": "Capture the connected browser tab when visual inspection is needed.",
  };
  return descriptions[name] ?? "Call the connected browser control bridge.";
}

function browserParameters(name: string): Record<string, unknown> {
  const target = {
    type: "object",
    required: ["target_ref", "expected_document_epoch"],
    properties: {
      tab_id: { type: "integer" },
      target_ref: { type: "string" },
      expected_document_epoch: { type: "string" },
    },
    additionalProperties: false,
  };
  switch (name) {
    case "browser.get_page_state":
      return {
        type: "object",
        properties: {
          tab_id: { type: "integer" },
          max_text_chars: { type: "integer", minimum: 0, maximum: 60_000 },
          max_targets: { type: "integer", minimum: 0, maximum: 200 },
        },
        additionalProperties: false,
      };
    case "browser.navigate":
      return {
        type: "object",
        required: ["url"],
        properties: {
          tab_id: { type: "integer" },
          url: { type: "string", format: "uri" },
        },
        additionalProperties: false,
      };
    case "browser.click":
      return target;
    case "browser.fill":
    case "browser.type_text":
      return {
        ...target,
        required: ["target_ref", "expected_document_epoch", "text"],
        properties: {
          ...target.properties,
          text: { type: "string", maxLength: 20_000 },
        },
      };
    case "browser.press_key":
      return {
        type: "object",
        required: ["key"],
        properties: {
          tab_id: { type: "integer" },
          target_ref: { type: "string" },
          expected_document_epoch: { type: "string", description: "Required when target_ref is provided." },
          key: { type: "string", enum: ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"] },
          modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] } },
        },
        allOf: [
          { if: { required: ["target_ref"] }, then: { required: ["expected_document_epoch"] } },
          { if: { required: ["expected_document_epoch"] }, then: { required: ["target_ref"] } },
        ],
        additionalProperties: false,
      };
    case "browser.select_option":
      return {
        ...target,
        properties: {
          ...target.properties,
          value: { type: "string" },
          label: { type: "string" },
        },
      };
    case "browser.wait_for":
      return {
        type: "object",
        required: ["condition"],
        properties: {
          tab_id: { type: "integer" },
          condition: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["url_matches", "text_visible", "target_visible", "dom_quiet"] },
              pattern: { type: "string", minLength: 1, description: "A URL substring, or a full-URL glob using * and ?." },
              text: { type: "string" },
              target_ref: { type: "string" },
              expected_document_epoch: { type: "string" },
              quiet_ms: { type: "integer", minimum: 0, maximum: 30_000 },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      };
    case "browser.screenshot":
      return {
        type: "object",
        properties: {
          tab_id: { type: "integer" },
          format: { type: "string", enum: ["png", "jpeg"] },
          quality: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      };
    default:
      return { type: "object", properties: {}, additionalProperties: false };
  }
}

function browserError(name: string, content: string, code: string): ToolResult {
  return { name, ok: false, content, data: { error: { code, message: content, retryable: code !== "INVALID_CONTEXT" } } };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
