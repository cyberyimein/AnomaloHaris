import type { ToolDefinition } from "@anomalo/contracts";

import type { ResourceLoader, ResourceSnapshot } from "./resources.js";
import type { ToolRuntime } from "./tools.js";
import type { BuiltContext, ContextDiagnostics, ModelMessage, ToolContext } from "./types.js";

export type ContextRequest = {
  baseMessages: ModelMessage[];
  loopMessages: ModelMessage[];
  bootstrapMessages?: ModelMessage[] | undefined;
  sessionMessages?: ModelMessage[] | undefined;
  currentUserMessage?: ModelMessage | undefined;
  toolContext: ToolContext;
  systemPrompt?: string | undefined;
  allowedToolNames?: ReadonlySet<string> | undefined;
  promptProfile: string;
  resourceSnapshot?: ResourceSnapshot | undefined;
};

export interface ContextBuilder {
  build(request: ContextRequest): Promise<BuiltContext>;
  prepare?(request: ContextRequest): Promise<ResourceSnapshot | undefined>;
}

export class ReplayContextBuilder implements ContextBuilder {
  constructor(private readonly tools: ToolRuntime) {}

  async build(request: ContextRequest): Promise<BuiltContext> {
    const listed = await this.tools.list(request.toolContext);
    const definitions = request.allowedToolNames
      ? listed.filter((tool) => request.allowedToolNames?.has(tool.name))
      : listed;
    const resourceMessages = request.resourceSnapshot
      ? activeResourceMessages(request.resourceSnapshot, request.toolContext, request.bootstrapMessages ?? [])
      : [];
    const baseMessages = request.sessionMessages
      ? [
        ...(!request.resourceSnapshot ? structuredClone(request.bootstrapMessages ?? []) : []),
        ...structuredClone(request.sessionMessages),
        ...(request.currentUserMessage ? [structuredClone(request.currentUserMessage)] : []),
      ]
      : structuredClone(request.baseMessages);
    const messages = [
      ...(request.resourceSnapshot ? staticResourceMessages(request.resourceSnapshot) : []),
      ...resourceMessages,
      ...(!request.resourceSnapshot && request.systemPrompt ? [{ role: "system" as const, content: request.systemPrompt }] : []),
      ...baseMessages,
      ...structuredClone(request.loopMessages),
    ];
    const diagnostics: ContextDiagnostics = {
      profile: request.promptProfile,
      model: request.toolContext.model,
      searchMode: request.toolContext.searchMode,
      segmentCounts: {
        resources: (request.resourceSnapshot?.messages.length ?? 0) + resourceMessages.length,
        base: baseMessages.length + (!request.resourceSnapshot && request.systemPrompt ? 1 : 0),
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

function staticResourceMessages(snapshot: ResourceSnapshot): ModelMessage[] {
  return structuredClone([
    ...snapshot.promptMessages,
    ...snapshot.searchMessages,
  ]);
}

function activeResourceMessages(
  snapshot: ResourceSnapshot,
  context: ToolContext,
  bootstrapMessages: ModelMessage[],
): ModelMessage[] {
  const activeSkillMessages: ModelMessage[] = [];
  for (const name of [...context.activeSkills].sort()) {
    const instructions = snapshot.skillInstructions[name];
    if (instructions) activeSkillMessages.push({ role: "system", content: `Active Skill: ${name}\n${instructions}` });
  }
  const activeMcpMessages: ModelMessage[] = [];
  for (const name of [...context.activeMcpServers].sort()) {
    const instructions = snapshot.mcpInstructions[name];
    if (instructions) activeMcpMessages.push({ role: "system", content: `Active MCP server: ${name}\n${instructions}` });
  }
  return structuredClone([
    ...bootstrapMessages,
    ...snapshot.memoryMessages,
    ...snapshot.skillCatalogMessages,
    ...activeSkillMessages,
    ...snapshot.mcpCatalogMessages,
    ...activeMcpMessages,
  ]);
}

/** Adds the L1 resource snapshot while keeping tool discovery dynamic per turn. */
export class ResourceContextBuilder extends ReplayContextBuilder {
  constructor(
    tools: ToolRuntime,
    private readonly resources: ResourceLoader,
  ) {
    super(tools);
  }

  async prepare(request: ContextRequest): Promise<ResourceSnapshot> {
    return this.resources.snapshot({
      promptProfile: request.promptProfile,
      searchMode: request.toolContext.searchMode,
      activeSkills: request.toolContext.activeSkills,
      activeMcpServers: request.toolContext.activeMcpServers,
      ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    });
  }
}

export function filterToolDefinitions(
  tools: ToolDefinition[],
  allowedToolNames?: ReadonlySet<string>,
): ToolDefinition[] {
  return allowedToolNames ? tools.filter((tool) => allowedToolNames.has(tool.name)) : tools;
}
