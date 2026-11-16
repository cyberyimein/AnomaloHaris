export type BuddyDashboardClientOptions = {
  baseUrl: string;
  token?: string;
  adminToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class BuddyDashboardError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "BuddyDashboardError";
  }
}

/**
 * Small, allowlisted proxy client for the independent Buddy service.
 *
 * This is deliberately a control-plane client for the UI. It is not a
 * ToolRuntime and is never added to AgentCore's model-visible tool graph.
 */
export class BuddyDashboardClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly adminToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BuddyDashboardClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token?.trim() ?? "";
    this.adminToken = options.adminToken?.trim() ?? "";
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 29_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async status(): Promise<Record<string, unknown>> {
    return this.request("/v1/buddy/status");
  }

  async observation(): Promise<Record<string, unknown>> {
    return this.request("/v1/buddy/observation", "GET", undefined, this.adminToken);
  }

  async invoke(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/v1/buddy/manual", "POST", body, this.adminToken);
  }

  async setAgentEnabled(enabled: boolean): Promise<Record<string, unknown>> {
    return this.request("/v1/buddy/agent", "POST", { enabled }, this.adminToken);
  }

  async setPermission(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/v1/buddy/permissions", "POST", body, this.adminToken);
  }

  private async request(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, unknown>,
    token = this.token,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        const message = typeof payload.error === "string" ? payload.error : `Buddy service returned HTTP ${response.status}.`;
        throw new BuddyDashboardError(503, "buddy_unavailable", message);
      }
      return payload;
    } catch (error) {
      if (error instanceof BuddyDashboardError) throw error;
      const message = error instanceof Error && error.name === "AbortError"
        ? `Buddy service request timed out after ${this.timeoutMs} ms.`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new BuddyDashboardError(503, "buddy_unavailable", `Buddy service unavailable: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const payload = JSON.parse(text) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : { value: payload };
  } catch {
    return { error: text.slice(0, 500) };
  }
}
