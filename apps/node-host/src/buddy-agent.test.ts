import type { ToolCall, ToolDefinition, ToolResult } from "@anomaloharis/contracts";
import { describe, expect, it, vi } from "vitest";

import type { BuddyDashboardClient } from "./buddy-dashboard.js";
import { BuddyAgentToolAdapter } from "./buddy-agent.js";
import type { ToolContext } from "./types.js";

const context: ToolContext = {
  sessionId: "buddy-session",
  runId: "buddy-run",
  searchMode: "diy",
  model: "fixture-model",
  activeSkills: new Set(),
  activeMcpServers: new Set(),
};

const definitions: ToolDefinition[] = [
  {
    name: "buddy_capabilities",
    description: "Read robot capabilities and permissions.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    source: "buddy-bridge",
  },
  {
    name: "buddy_invoke",
    description: "Invoke a permitted robot capability.",
    parameters: { type: "object", properties: { capability: { type: "string" }, args: { type: "object" } } },
    source: "buddy-bridge",
  },
];

function dashboard(status: () => Promise<Record<string, unknown>>) {
  return { status: vi.fn(status) } as unknown as BuddyDashboardClient;
}

function bridge(result?: ToolResult) {
  return {
    tools: definitions,
    callTool: vi.fn(async (call: ToolCall): Promise<ToolResult> => ({
      ...(result ?? {}),
      name: call.name,
      ok: result?.ok ?? true,
      content: result?.content ?? "Buddy invocation complete.",
      data: result?.data ?? { capability: call.arguments.capability },
    })),
  };
}

describe("BuddyAgentToolAdapter", () => {
  it("lists the bridge tools across presets without filtering by per-capability grants", async () => {
    const status = async () => ({
      agentEnabled: true,
      connected: true,
      capabilities: [
        { name: "camera.capture", allowed: false },
        { name: "led.express", allowed: false, effectiveAllowed: false },
        { name: "led.resume", allowed: false, effectiveAllowed: false },
      ],
    });
    const adapter = new BuddyAgentToolAdapter(dashboard(status), bridge() as never);

    const firstPreset = await adapter.list({ ...context, allowedPluginIds: new Set(["example-plugin"]) });
    const secondPreset = await adapter.list({ ...context, allowedPluginIds: new Set(["another-plugin"]) });

    expect(firstPreset.map((tool) => tool.name)).toEqual(["buddy_capabilities", "buddy_invoke"]);
    expect(firstPreset.map((tool) => tool.source)).toEqual(["buddy-runtime", "buddy-runtime"]);
    expect(secondPreset).toEqual(firstPreset);
    expect(adapter.id).toBe("buddy-runtime");
    expect(adapter.alwaysAvailable).toBe(true);
  });

  it("exposes dynamic LED capabilities for discovery while relaying server permission denials", async () => {
    const call: ToolCall = {
      id: "express-call",
      name: "buddy_invoke",
      arguments: { capability: "led.express", args: { emotion: "thinking", intensity: 0.5, durationMs: 8000 } },
    };
    const buddyBridge = bridge({
      name: "buddy_invoke",
      ok: false,
      content: "permission denied",
      data: { status: 403, error_code: "permission_denied" },
    });
    const adapter = new BuddyAgentToolAdapter(
      dashboard(async () => ({
        agentEnabled: true,
        connected: true,
        capabilities: [
          { name: "led.express", allowed: false, effectiveAllowed: false },
          { name: "led.resume", allowed: false, effectiveAllowed: false },
        ],
      })),
      buddyBridge as never,
    );

    await expect(adapter.list(context)).resolves.toHaveLength(2);
    await expect(adapter.call(call, context, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      content: "permission denied",
      data: { error_code: "permission_denied" },
    });
    expect(buddyBridge.callTool).toHaveBeenCalledWith(call, context, expect.any(AbortSignal));
  });

  it("denies a direct invocation after the Buddy agent has been disabled", async () => {
    const buddyBridge = bridge();
    const adapter = new BuddyAgentToolAdapter(
      dashboard(async () => ({ agentEnabled: false, connected: true })),
      buddyBridge as never,
    );

    const result = await adapter.call(
      { id: "forged-call", name: "buddy_invoke", arguments: { capability: "camera.capture", args: {} } },
      context,
      new AbortController().signal,
    );

    expect(result).toMatchObject({ ok: false, data: { error_code: "buddy_agent_disabled" } });
    expect(buddyBridge.callTool).not.toHaveBeenCalled();
  });

  it("fails closed when status is unavailable without throwing into chat", async () => {
    const buddyBridge = bridge();
    const client = dashboard(async () => { throw new Error("service token rejected"); });
    const adapter = new BuddyAgentToolAdapter(client, buddyBridge as never);

    await expect(adapter.list(context)).resolves.toEqual([]);
    await expect(adapter.status(context)).resolves.toMatchObject({
      agentEnabled: false,
      connected: false,
      available: false,
    });
    await expect(adapter.call(
      { id: "offline-call", name: "buddy_capabilities", arguments: {} },
      context,
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, data: { error_code: "buddy_unavailable" } });
    expect(buddyBridge.callTool).not.toHaveBeenCalled();
  });

  it("delegates an enabled call to the bridge with its run context and abort signal", async () => {
    const buddyBridge = bridge();
    const client = dashboard(async () => ({ agentEnabled: true, connected: true }));
    const adapter = new BuddyAgentToolAdapter(client, buddyBridge as never);
    const signal = new AbortController().signal;
    const call: ToolCall = {
      id: "invoke-call",
      name: "buddy_invoke",
      arguments: { capability: "camera.capture", args: {} },
    };

    await expect(adapter.call(call, context, signal)).resolves.toMatchObject({ ok: true });
    expect(buddyBridge.callTool).toHaveBeenCalledWith(call, context, signal);
    expect(client.status).toHaveBeenCalledTimes(1);
  });
});
