import type { ToolCall, ToolDefinition, ToolResult } from "@anomalo/contracts";

import type { PluginHost } from "./plugins.js";
import type { ToolContext } from "./types.js";

export interface ToolRuntime {
  list(context: ToolContext): Promise<ToolDefinition[]>;
  call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult>;
  status(context: ToolContext): Promise<Record<string, unknown>[]>;
}

export type ToolHandler = (
  arguments_: Record<string, unknown>,
  context: ToolContext,
  signal: AbortSignal,
) => ToolResult | Promise<ToolResult>;

export type ToolAdapter = {
  id: string;
  priority: number;
  list(context: ToolContext): Promise<ToolDefinition[]>;
  call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult>;
  status(context: ToolContext): Promise<Record<string, unknown>>;
};

export function asToolAdapter(id: string, priority: number, runtime: ToolRuntime): ToolAdapter {
  return {
    id,
    priority,
    list: (context) => runtime.list(context),
    call: (call, context, signal) => runtime.call(call, context, signal),
    status: async (context) => ({ provider: id, ...(await runtime.status(context)).reduce((value, item) => ({ ...value, ...item }), {}) }),
  };
}

export class DeterministicToolRuntime implements ToolRuntime {
  private readonly definitions: Map<string, ToolDefinition>;
  private readonly handlers: Map<string, ToolHandler>;
  readonly calls: Array<{ call: ToolCall; context: ToolContext }> = [];

  constructor(definitions: ToolDefinition[], handlers: Record<string, ToolHandler> = {}) {
    this.definitions = new Map(definitions.map((definition) => [definition.name, definition]));
    this.handlers = new Map(Object.entries(handlers));
    const duplicateCount = definitions.length - this.definitions.size;
    if (duplicateCount > 0) throw new Error("Duplicate tool names are not allowed.");
  }

  async list(_context: ToolContext): Promise<ToolDefinition[]> {
    return [...this.definitions.values()].map((definition) => structuredClone(definition));
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) return abortedResult(call.name);
    const definition = this.definitions.get(call.name);
    if (!definition) return { name: call.name, ok: false, content: `Tool not found: ${call.name}`, data: {} };
    this.calls.push({ call: structuredClone(call), context });
    const handler = this.handlers.get(call.name);
    if (!handler) return { name: call.name, ok: false, content: `No handler for ${call.name}.`, data: {} };
    try {
      const result = await handler(call.arguments, context, signal);
      return {
        name: result.name || call.name,
        ok: result.ok,
        content: result.content,
        data: result.data ?? {},
      };
    } catch (error) {
      return {
        name: call.name,
        ok: false,
        content: `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
        data: { error_type: error instanceof Error ? error.name : "Error" },
      };
    }
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return [{ provider: "DeterministicToolRuntime", tools: await this.list(context) }];
  }
}

/**
 * Merges the migrated adapters behind the ToolRuntime seam. Equal-priority
 * collisions are errors; a provider can only override another provider when
 * the configured priority says so explicitly.
 */
export class CompositeToolRuntime implements ToolRuntime {
  constructor(private readonly adapters: readonly ToolAdapter[]) {}

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    const selected = await this.resolve(context);
    return [...selected.values()].map(({ definition }) => structuredClone(definition));
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    const selected = await this.resolve(context);
    const owner = selected.get(call.name);
    if (!owner) return { name: call.name, ok: false, content: `Tool not found: ${call.name}`, data: { error_code: "tool_not_found" } };
    try {
      return await owner.adapter.call(call, context, signal);
    } catch (error) {
      return {
        name: call.name,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        data: { error_code: "tool_failed", adapter: owner.adapter.id },
      };
    }
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return Promise.all(this.adapters.map((adapter) => adapter.status(context)));
  }

  private async resolve(context: ToolContext): Promise<Map<string, { definition: ToolDefinition; adapter: ToolAdapter }>> {
    const selected = new Map<string, { definition: ToolDefinition; adapter: ToolAdapter }>();
    for (const adapter of this.adapters) {
      for (const definition of await adapter.list(context)) {
        const existing = selected.get(definition.name);
        if (existing && existing.adapter.priority === adapter.priority) {
          throw new Error(`Tool ${definition.name} is registered by ${existing.adapter.id} and ${adapter.id} at the same priority.`);
        }
        if (!existing || adapter.priority > existing.adapter.priority) {
          selected.set(definition.name, { definition, adapter });
        }
      }
    }
    return selected;
  }
}

export class CoreToolRuntime implements ToolRuntime {
  async list(_context: ToolContext): Promise<ToolDefinition[]> {
    return [{
      name: "time_now",
      description: "Return the current UTC time from the Node Host.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      source: "host-core",
    }];
  }

  async call(call: ToolCall, _context: ToolContext, _signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== "time_now") return { name: call.name, ok: false, content: `Tool not found: ${call.name}`, data: { error_code: "tool_not_found" } };
    const now = new Date().toISOString();
    return { name: call.name, ok: true, content: now, data: { timestamp: now } };
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return [{ provider: "host-core", available: true, tool_count: (await this.list(context)).length }];
  }
}

export class PluginToolAdapter implements ToolAdapter {
  readonly id = "pi-plugin-host";
  readonly priority = 20;

  constructor(private readonly plugins: PluginHost) {}

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    return this.plugins.tools({
      pluginId: "host",
      sessionId: context.sessionId,
      runId: context.runId,
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    });
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    return this.plugins.callTool(call, context, signal);
  }

  async status(_context: ToolContext): Promise<Record<string, unknown>> {
    return { provider: this.id, plugins: this.plugins.status() };
  }
}

function abortedResult(name: string): ToolResult {
  return {
    name,
    ok: false,
    content: "Tool execution cancelled.",
    data: { error_code: "cancelled" },
  };
}
