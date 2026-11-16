import createBuddyBridge from "@anomaloharis/buddy-bridge";
import type { ToolCall, ToolDefinition, ToolResult } from "@anomaloharis/contracts";

import type { BuddyDashboardClient } from "./buddy-dashboard.js";
import type { ToolAdapter } from "./tools.js";
import type { ToolContext } from "./types.js";

type BuddyBridgeClient = ReturnType<typeof createBuddyBridge>;
type BuddyAccess = { agentEnabled: boolean; connected: boolean };

const buddyToolNames = new Set(["buddy_capabilities", "buddy_invoke"]);

/** Exposes discovery and invocation while enabled; the Buddy service enforces each dynamic capability grant. */
export class BuddyAgentToolAdapter implements ToolAdapter {
  readonly id = "buddy-runtime";
  readonly priority = 40;
  readonly alwaysAvailable = true;

  constructor(
    private readonly dashboard: Pick<BuddyDashboardClient, "status">,
    private readonly bridge: BuddyBridgeClient = createBuddyBridge({}),
  ) {}

  async list(_context: ToolContext): Promise<ToolDefinition[]> {
    const access = await this.readAccess();
    if (!access?.agentEnabled || !access.connected) return [];

    return this.bridge.tools
      .filter((tool) => buddyToolNames.has(tool.name))
      .map((tool) => ({ ...tool, source: this.id }));
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) {
      return failed(call.name, "Buddy tool call cancelled.", "cancelled");
    }
    if (!buddyToolNames.has(call.name)) {
      return failed(call.name, `Tool not found: ${call.name}`, "tool_not_found");
    }

    const access = await this.readAccess();
    if (!access) return failed(call.name, "Buddy service is unavailable.", "buddy_unavailable");
    if (!access.agentEnabled) return failed(call.name, "Buddy agent access is disabled.", "buddy_agent_disabled");
    if (!access.connected) return failed(call.name, "Buddy is disconnected.", "buddy_disconnected");

    try {
      return await this.bridge.callTool(call, context, signal);
    } catch (error) {
      return failed(
        call.name,
        error instanceof Error ? error.message : "Buddy tool failed.",
        "buddy_unavailable",
      );
    }
  }

  async status(_context: ToolContext): Promise<Record<string, unknown>> {
    const access = await this.readAccess();
    return {
      provider: this.id,
      agentEnabled: access?.agentEnabled ?? false,
      connected: access?.connected ?? false,
      available: access?.agentEnabled === true && access.connected,
    };
  }

  private async readAccess(): Promise<BuddyAccess | undefined> {
    try {
      const status = await this.dashboard.status();
      return {
        agentEnabled: status.agentEnabled === true,
        connected: status.connected === true,
      };
    } catch {
      return undefined;
    }
  }
}

function failed(name: string, content: string, errorCode: string): ToolResult {
  return { name, ok: false, content, data: { error_code: errorCode } };
}
