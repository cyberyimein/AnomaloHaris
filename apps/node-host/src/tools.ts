import type { ToolCall, ToolDefinition, ToolResult } from "@anomalo/contracts";

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

function abortedResult(name: string): ToolResult {
  return {
    name,
    ok: false,
    content: "Tool execution cancelled.",
    data: { error_code: "cancelled" },
  };
}
