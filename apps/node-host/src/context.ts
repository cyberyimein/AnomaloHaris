import type { ToolDefinition } from "@anomalo/contracts";

import type { ToolRuntime } from "./tools.js";
import type { BuiltContext, ContextDiagnostics, ModelMessage, ToolContext } from "./types.js";

export type ContextRequest = {
  baseMessages: ModelMessage[];
  loopMessages: ModelMessage[];
  toolContext: ToolContext;
  allowedToolNames?: ReadonlySet<string> | undefined;
  promptProfile: string;
};

export interface ContextBuilder {
  build(request: ContextRequest): Promise<BuiltContext>;
}

export class ReplayContextBuilder implements ContextBuilder {
  constructor(private readonly tools: ToolRuntime) {}

  async build(request: ContextRequest): Promise<BuiltContext> {
    const listed = await this.tools.list(request.toolContext);
    const definitions = request.allowedToolNames
      ? listed.filter((tool) => request.allowedToolNames?.has(tool.name))
      : listed;
    const messages = [
      ...structuredClone(request.baseMessages),
      ...structuredClone(request.loopMessages),
    ];
    const diagnostics: ContextDiagnostics = {
      profile: request.promptProfile,
      model: request.toolContext.model,
      searchMode: request.toolContext.searchMode,
      segmentCounts: {
        base: request.baseMessages.length,
        toolLoop: request.loopMessages.length,
      },
      totalMessageCount: messages.length,
      toolCount: definitions.length,
    };
    return {
      messages,
      tools: structuredClone(definitions),
      diagnostics,
    };
  }
}

export function filterToolDefinitions(
  tools: ToolDefinition[],
  allowedToolNames?: ReadonlySet<string>,
): ToolDefinition[] {
  return allowedToolNames ? tools.filter((tool) => allowedToolNames.has(tool.name)) : tools;
}
