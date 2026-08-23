export type BuddyStatePort = {
  setState(state: string, text?: string): unknown | Promise<unknown>;
  setText(text: string): unknown | Promise<unknown>;
  showApproval(requestId: string, text: string): unknown | Promise<unknown>;
  requestApproval(requestId: string, text: string, timeoutSeconds: number): Promise<{ payload?: Record<string, unknown> }>;
};

export type HookEvent = {
  name: string;
  session_id: string | undefined;
  payload: Record<string, unknown>;
  sequence: number | undefined;
  timestamp: number | undefined;
  request_id: string | undefined;
  requires_user_action: boolean;
  text: string | undefined;
};

export type RelaySessionSnapshot = {
  session_id: string;
  state: string;
  buddy_state: string;
  last_sequence: number | undefined;
  last_timestamp: number | undefined;
  approval_request_count: number;
};

export type RelayResult = {
  session_id: string | undefined;
  state: string | undefined;
  buddy_state: string | undefined;
  applied: boolean;
  duplicate: boolean;
  effect: Record<string, string>;
  buddy_error?: string;
};

type RelayState = {
  session_id: string;
  state: string;
  last_sequence: number | undefined;
  last_timestamp: number | undefined;
  request_ids: Set<string>;
};

const EVENT_ALIASES: Record<string, string> = {
  sessionstart: "sessionStart",
  userpromptsubmit: "userPromptSubmitted",
  userpromptsubmitted: "userPromptSubmitted",
  pretooluse: "preToolUse",
  posttooluse: "postToolUse",
  permissionrequest: "permissionRequest",
  notification: "notification",
  stop: "agentStop",
  agentstop: "agentStop",
  sessionend: "sessionEnd",
  erroroccurred: "errorOccurred",
  error: "errorOccurred",
};

export class HookRelay {
  private readonly gateway: BuddyStatePort | undefined;
  private readonly approvalEnabled: boolean;
  private readonly approvalTimeoutSeconds: number;
  private readonly states = new Map<string, RelayState>();

  constructor(
    gateway: BuddyStatePort | undefined,
    options: { approvalEnabled?: boolean; approvalTimeoutSeconds?: number } = {},
  ) {
    this.gateway = gateway;
    this.approvalEnabled = options.approvalEnabled === true;
    this.approvalTimeoutSeconds = Math.max(0.1, options.approvalTimeoutSeconds ?? 30);
  }

  async handleBody(name: string, body: Record<string, unknown>): Promise<RelayResult> {
    return this.handle(parseHookEvent(name, body));
  }

  async handle(event: HookEvent): Promise<RelayResult> {
    if (!event.session_id) {
      return { session_id: undefined, state: undefined, buddy_state: undefined, applied: false, duplicate: false, effect: {} };
    }
    const state = this.states.get(event.session_id) ?? {
      session_id: event.session_id,
      state: "IDLE",
      last_sequence: undefined,
      last_timestamp: undefined,
      request_ids: new Set<string>(),
    } satisfies RelayState;
    this.states.set(event.session_id, state);

    if (this.isStale(state, event)) {
      return {
        session_id: event.session_id,
        state: state.state,
        buddy_state: buddyStateForInternal(state.state),
        applied: false,
        duplicate: true,
        effect: {},
      };
    }
    if (event.sequence !== undefined) state.last_sequence = event.sequence;
    if (event.timestamp !== undefined) state.last_timestamp = event.timestamp;
    const [internalState, buddyState] = transitionFor(event);
    state.state = internalState;
    const repeatedRequest = Boolean(event.request_id && state.request_ids.has(event.request_id));
    if (event.request_id && (event.name === "permissionRequest" || event.name === "notification")) {
      state.request_ids.add(event.request_id);
    }

    const hasApprovalRequest = (event.name === "permissionRequest" || event.name === "notification")
      && event.requires_user_action
      && Boolean(event.request_id);
    // The approval methods send the request-specific CODEX APPROVAL command.
    // Do not first send the generic approval state, or Buddy renders two cards.
    const buddyError = hasApprovalRequest ? undefined : await this.projectState(buddyState, event.text);
    let effect: Record<string, string> = {};
    let approvalError: string | undefined;
    if ((event.name === "permissionRequest" || event.name === "notification")
      && event.requires_user_action && !repeatedRequest) {
      const resolved = await this.resolveApproval(event, state);
      effect = resolved.effect;
      approvalError = resolved.error;
    }
    const relayError = buddyError ?? approvalError;
    return {
      session_id: event.session_id,
      state: state.state,
      buddy_state: buddyStateForInternal(state.state),
      applied: true,
      duplicate: repeatedRequest,
      effect,
      ...(relayError ? { buddy_error: relayError } : {}),
    };
  }

  snapshot(sessionId: string): RelaySessionSnapshot | undefined {
    const state = this.states.get(sessionId);
    if (!state) return undefined;
    return {
      session_id: state.session_id,
      state: state.state,
      buddy_state: buddyStateForInternal(state.state),
      last_sequence: state.last_sequence,
      last_timestamp: state.last_timestamp,
      approval_request_count: state.request_ids.size,
    };
  }

  snapshots(): RelaySessionSnapshot[] {
    return [...this.states.keys()].sort().flatMap((sessionId) => {
      const snapshot = this.snapshot(sessionId);
      return snapshot ? [snapshot] : [];
    });
  }

  private isStale(state: RelayState, event: HookEvent): boolean {
    if (event.sequence !== undefined && state.last_sequence !== undefined) return event.sequence <= state.last_sequence;
    if (event.sequence === undefined && event.timestamp !== undefined && state.last_timestamp !== undefined) {
      return event.timestamp <= state.last_timestamp;
    }
    return false;
  }

  private async projectState(buddyState: string, text: string | undefined): Promise<string | undefined> {
    if (!this.gateway) return undefined;
    try {
      await this.gateway.setState(buddyState, text);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private async resolveApproval(event: HookEvent, state: RelayState): Promise<{ effect: Record<string, string>; error: string | undefined }> {
    const requestId = event.request_id;
    if (!requestId || !this.gateway) return { effect: {}, error: undefined };
    const text = event.text ?? "Approval required";
    try {
      if (!this.approvalEnabled) {
        await this.gateway.showApproval(requestId, text);
        return { effect: {}, error: undefined };
      }
      const response = await this.gateway.requestApproval(requestId, text, this.approvalTimeoutSeconds);
      const choice = isRecord(response.payload) ? String(response.payload.choice ?? "").trim().toLowerCase() : "";
      if (["allow", "approve", "approved", "yes", "y", "ok"].includes(choice)) {
        state.state = "RUNNING";
        await this.projectState("coding", undefined);
        return { effect: { behavior: "allow" }, error: undefined };
      }
      if (["deny", "denied", "reject", "rejected", "no", "n", "cancel", "cancelled"].includes(choice)) {
        state.state = "CANCELLED";
        await this.projectState("idle", undefined);
        return { effect: { behavior: "deny", message: "Buddy denied the request." }, error: undefined };
      }
      return { effect: {}, error: undefined };
    } catch (error) {
      return { effect: {}, error: errorMessage(error) };
    }
  }
}

export function parseHookEvent(name: string, body: Record<string, unknown>): HookEvent {
  const nested = isRecord(body.payload) ? body.payload : {};
  const payload: Record<string, unknown> = { ...nested };
  for (const key of ["reason", "status", "notification_type", "notificationType"]) {
    if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
  }
  const first = (...keys: string[]): unknown => {
    for (const source of [body, nested]) {
      for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return undefined;
  };
  const canonicalName = normalizeEventName(name);
  const requires = first("requires_user_action", "requiresUserAction");
  return {
    name: canonicalName,
    session_id: stringValue(first("session_id", "sessionId", "thread_id", "threadId")),
    payload,
    sequence: numberValue(first("sequence", "seq")),
    timestamp: timestampValue(first("timestamp", "created_at", "createdAt")),
    request_id: stringValue(first("request_id", "requestId", "id")),
    requires_user_action: requires === undefined ? canonicalName === "permissionRequest" : boolValue(requires),
    text: compactText(first("text", "message", "description", "tool_name", "tool")),
  };
}

export function normalizeEventName(name: string): string {
  const normalized = [...name.trim()].filter((character) => /[A-Za-z0-9]/.test(character)).join("").toLowerCase();
  return EVENT_ALIASES[normalized] ?? (name.trim() || "unknown");
}

export function transitionFor(event: HookEvent): [string, string] {
  if (event.name === "sessionStart") return ["IDLE", "idle"];
  if (["userPromptSubmitted", "preToolUse", "postToolUse"].includes(event.name)) return ["RUNNING", "coding"];
  if (event.name === "permissionRequest") {
    return event.requires_user_action ? ["APPROVAL_REQUIRED", "approval"] : ["RUNNING", "coding"];
  }
  if (event.name === "notification" && event.requires_user_action) return ["APPROVAL_REQUIRED", "approval"];
  if (event.name === "notification") return ["WAITING_USER", "thinking"];
  if (event.name === "agentStop") {
    const reason = String(event.payload.reason ?? event.payload.status ?? "").toLowerCase();
    return [/(abort|cancel|exit|stop)/.test(reason) ? "CANCELLED" : "SUCCEEDED", /(abort|cancel|exit|stop)/.test(reason) ? "idle" : "done"];
  }
  if (event.name === "sessionEnd") {
    const reason = String(event.payload.reason ?? event.payload.status ?? "").toLowerCase();
    return [/(error|fail)/.test(reason) ? "FAILED" : "IDLE", /(error|fail)/.test(reason) ? "error" : "idle"];
  }
  if (event.name === "errorOccurred") return ["FAILED", "error"];
  return ["RUNNING", "coding"];
}

export function buddyStateForInternal(state: string): string {
  return ({ IDLE: "idle", RUNNING: "coding", WAITING_USER: "thinking", APPROVAL_REQUIRED: "approval", SUCCEEDED: "done", FAILED: "error", CANCELLED: "idle" } as Record<string, string>)[state] ?? "idle";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || typeof value === "boolean") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function timestampValue(value: unknown): number | undefined {
  const number = numberValue(value);
  if (number !== undefined) return number;
  const text = stringValue(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed / 1_000 : undefined;
}

function compactText(value: unknown): string | undefined {
  const text = stringValue(value);
  return text ? text.replace(/\s+/g, " ").slice(0, 240) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
