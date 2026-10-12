import type { ToolCall, ToolResult } from "@anomaloharis/contracts";

import type { Clock } from "./clock.js";
import type { ContextBuilder, ContextRequest } from "./context.js";
import type { IdFactory } from "./ids.js";
import type { ModelRequest, ModelUsage } from "./model.js";
import type { PluginContext, PluginEvent, PluginExecutionScope, PluginHost } from "./plugins.js";
import type { ResourceSnapshot } from "./resources.js";
import type { SessionRepository } from "./session.js";
import type {
  AgentEvent,
  AgentPolicy,
  AgentRunInput,
  BuiltContext,
  EntryId,
  FinishedRunRecord,
  ModelMessage,
  NewRunRecord,
  NewSessionEntry,
  RunId,
  SessionCheckpoint,
  SessionSnapshot,
  ToolContext,
} from "./types.js";

type RunDependencies = {
  sessions: SessionRepository;
  ids: IdFactory;
  clock: Clock;
  plugins?: PluginHost | undefined;
};

/** Mutable execution state belongs to one invocation, never to the shared AgentCore. */
type RunState = {
  originalUserContent: string;
  currentUserMessage: ModelMessage;
  /** Assistant and tool messages buffered until completion or the iteration limit. */
  loopMessages: ModelMessage[];
  bootstrapContext: Record<string, unknown>[];
  /** Current model draft; reset after a completed tool turn. */
  assistantText: string;
  /** Usage for this invocation; checkpoints do not persist usage counters. */
  usage: ModelUsage;
  iteration: number;
  lastEntryId: EntryId | undefined;
};

type PreparationResult =
  | { kind: "ready"; run: AgentRun }
  | { kind: "rejected"; event: AgentEvent };

export type ActiveResources = {
  activeSkills: ReadonlySet<string>;
  activeMcpServers: ReadonlySet<string>;
};

type ContextSeed = {
  messages: ModelMessage[] | undefined;
  resourceSnapshot: ResourceSnapshot | undefined;
};

/** Owns run-local configuration, context assembly, and the session journal. */
export class AgentRun {
  readonly state: RunState;
  readonly signal: AbortSignal;
  readonly policy: AgentPolicy;
  readonly initialResources: ActiveResources;
  private readonly historyMessages: ModelMessage[];
  private readonly resumedFromRunId: RunId | undefined;
  private readonly pluginContext: PluginContext;
  private readonly pluginScope: PluginExecutionScope | undefined;

  private constructor(
    readonly input: AgentRunInput,
    readonly resumed: boolean,
    private readonly session: SessionSnapshot,
    checkpoint: SessionCheckpoint | undefined,
    parentSignal: AbortSignal,
    policy: AgentPolicy,
    private readonly dependencies: RunDependencies,
  ) {
    this.resumedFromRunId = checkpoint?.runId;
    this.policy = policy;
    this.signal = AbortSignal.any([parentSignal, AbortSignal.timeout(policy.runTimeoutMs)]);
    this.initialResources = {
      activeSkills: new Set(session.activeSkills),
      activeMcpServers: new Set(session.activeMcpServers),
    };
    this.historyMessages = session.messages;
    if (this.historyMessages.length === 0) this.historyMessages = input.historyMessages ?? [];

    const originalUserContent = checkpoint?.state.originalUserContent ?? input.message ?? "";
    let currentUserMessage = checkpoint?.state.currentUserMessage;
    if (!currentUserMessage) {
      let content = originalUserContent;
      if (input.resume) content = "Continue the interrupted task from the saved context.";
      currentUserMessage = { role: "user", content };
    }
    this.state = {
      originalUserContent,
      currentUserMessage,
      loopMessages: unpersistedLoopMessages(session.messages, structuredClone(checkpoint?.state.loopMessages ?? [])),
      bootstrapContext: structuredClone(checkpoint?.state.bootstrapContext ?? []),
      assistantText: checkpoint?.state.assistantText ?? "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      iteration: checkpoint?.iteration ?? 0,
      lastEntryId: session.activeLeafEntryId,
    };
    this.pluginContext = {
      pluginId: "host",
      sessionId: input.sessionId,
      runId: input.runId,
    };
    if (input.allowedPluginIds) {
      this.pluginScope = {
        modelRef: input.presetModelRef,
        compiledHash: input.compiledHash,
        pluginIds: input.allowedPluginIds,
      };
      if (input.allowedPluginLocks) this.pluginScope = { ...this.pluginScope, locks: input.allowedPluginLocks };
    }
  }

  /** Reject invalid starts before writing a run record or emitting run.started. */
  static async prepare(
    input: AgentRunInput,
    signal: AbortSignal,
    fallbackPolicy: AgentPolicy,
    dependencies: RunDependencies,
  ): Promise<PreparationResult> {
    const session = await dependencies.sessions.open(input.sessionId);
    let checkpoint: SessionCheckpoint | undefined;
    const reject = (data: Record<string, unknown>): PreparationResult => ({
      kind: "rejected",
      event: createEvent("run.error", input, dependencies.clock, data),
    });

    if (input.resume) {
      try {
        const saved = await dependencies.sessions.resume(input.sessionId);
        checkpoint = saved.checkpoint;
      } catch {
        return reject({
          error: "No paused run is available for this session.",
          error_code: "checkpoint_not_found",
          can_resume: false,
        });
      }
    } else if (session.checkpoint) {
      return reject({
        error: "A paused run exists for this session. Resume it before sending a new message.",
        error_code: "checkpoint_resume_required",
        can_resume: true,
      });
    }
    if (!input.resume && !input.message?.trim()) {
      return reject({ error: "Message content is required.", error_code: "message_required" });
    }
    if (input.resume && input.responseFormat !== undefined
      && JSON.stringify(input.responseFormat) !== JSON.stringify(checkpoint?.state.responseFormat)) {
      return reject({
        error: "The requested response_format does not match the paused run.",
        error_code: "response_format_mismatch",
        can_resume: true,
      });
    }
    const config = resolveRunInput(input, checkpoint, fallbackPolicy);
    const policy = config.policy ?? fallbackPolicy;
    return {
      kind: "ready",
      run: new AgentRun(config, Boolean(checkpoint), session, checkpoint, signal, policy, dependencies),
    };
  }

  event(type: AgentEvent["type"], data: Record<string, unknown>): AgentEvent {
    return createEvent(type, this.input, this.dependencies.clock, data);
  }

  async *start(): AsyncGenerator<AgentEvent, void> {
    const { input, state, dependencies } = this;
    const config: Record<string, unknown> = {
      model: input.model,
      policy: policyForRecord(this.policy),
      searchMode: input.searchMode,
      promptProfile: input.promptProfile,
    };
    if (input.presetModelRef) config.model_ref = input.presetModelRef;
    if (input.compiledHash) config.compiled_hash = input.compiledHash;
    if (input.temperature !== undefined) config.temperature = input.temperature;
    if (input.allowedPluginIds) config.plugin_ids = [...input.allowedPluginIds].sort();
    const record: NewRunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      status: "active",
      config,
      startedAt: dependencies.clock.now(),
    };
    if (this.resumedFromRunId) {
      record.resumedFromRunId = this.resumedFromRunId;
      config.resumed_from_run_id = this.resumedFromRunId;
    }
    if (state.lastEntryId) record.lastEntryId = state.lastEntryId;
    await dependencies.sessions.beginRun(record);
    // A resumed run already has its user message in the journal.
    if (!this.resumed) {
      state.lastEntryId = await this.appendMessage(state.currentUserMessage, { content: state.currentUserMessage.content });
    }
    const data: Record<string, unknown> = {
      resumed: this.resumed,
      search_mode: input.searchMode,
      model: input.model,
    };
    if (this.resumedFromRunId) data.resumed_from_run_id = this.resumedFromRunId;
    if (input.presetModelRef) data.model_ref = input.presetModelRef;
    yield this.event("run.started", data);
  }

  async prepareContext(builder: ContextBuilder): Promise<ContextSeed> {
    if (this.session.messages.length === 0 && !this.session.checkpoint) {
      await this.dispatchPlugin({ type: "session_start", context: this.pluginContext });
    }
    const hook = await this.dispatchPlugin({
      type: "before_agent_start",
      context: this.pluginContext,
      messages: [...this.historyMessages, ...bootstrapMessages(this.state.bootstrapContext), this.state.currentUserMessage],
    });
    let resourceSnapshot: ResourceSnapshot | undefined;
    if (builder.prepare) {
      const request: ContextRequest = {
        baseMessages: [],
        loopMessages: [],
        promptProfile: this.input.promptProfile,
        toolContext: this.toolContext(this.initialResources),
      };
      if (this.input.systemPrompt) request.systemPrompt = this.input.systemPrompt;
      resourceSnapshot = await builder.prepare(request);
    }
    return { messages: hook?.messages, resourceSnapshot };
  }

  /** Refresh active resources each turn; static prompt resources stay frozen for this run. */
  async buildContext(
    builder: ContextBuilder,
    seed: ContextSeed,
  ): Promise<{ context: BuiltContext; resources: ActiveResources }> {
    // Bot runs journal completed tool batches before every request. Stable Entry IDs
    // let compaction project a durable boundary without guessing by message text.
    if (this.input.botSession && this.state.loopMessages.length) {
      await this.flushLoopMessages();
      this.state.loopMessages = [];
    }
    const session = await this.dependencies.sessions.open(this.input.sessionId);
    const resources: ActiveResources = {
      activeSkills: new Set(session.activeSkills),
      activeMcpServers: new Set(session.activeMcpServers),
    };
    const request: ContextRequest = {
      baseMessages: seed.messages ?? [],
      loopMessages: this.state.loopMessages,
      toolContext: this.toolContext(resources),
      promptProfile: this.input.promptProfile,
    };
    // Hook-supplied messages replace the default history segments, including an empty override.
    if (!seed.messages) {
      request.bootstrapMessages = bootstrapMessages(this.state.bootstrapContext);
      request.sessionMessages = this.input.botSession ? await this.dependencies.sessions.journal?.(this.input.sessionId) ?? session.messages : this.historyMessages;
      if (!this.input.botSession) request.currentUserMessage = this.state.currentUserMessage;
    }
    if (this.input.systemPrompt) request.systemPrompt = this.input.systemPrompt;
    if (this.input.allowedToolNames) request.allowedToolNames = this.input.allowedToolNames;
    if (seed.resourceSnapshot) request.resourceSnapshot = seed.resourceSnapshot;
    const context = await builder.build(request);
    if (this.input.compiledHash) context.diagnostics.compiledHash = this.input.compiledHash;
    const hook = await this.dispatchPlugin({
      type: "context",
      context: this.pluginContext,
      messages: context.messages,
      tools: context.tools,
    });
    if (hook?.messages) context.messages = hook.messages;
    if (hook?.tools) context.tools = hook.tools;
    if (this.input.toolProtocol === "none") context.tools = [];
    return { context, resources };
  }

  modelRequest(messages: ModelMessage[], tools: BuiltContext["tools"]): ModelRequest {
    const request: ModelRequest = { model: this.input.model, messages, tools };
    if (this.input.presetModelRef) request.presetModelRef = this.input.presetModelRef;
    if (this.input.toolProtocol) request.toolProtocol = this.input.toolProtocol;
    if (this.input.temperature !== undefined) request.temperature = this.input.temperature;
    if (this.input.responseFormat !== undefined) request.responseFormat = this.input.responseFormat;
    return request;
  }

  modelRequestEvent(context: {
    messages: ModelMessage[];
    tools: BuiltContext["tools"];
    diagnostics: Pick<BuiltContext["diagnostics"], "segmentCounts" | "totalMessageCount" | "toolCount" | "compiledHash">;
  }, phase = "agent", attempt?: number): AgentEvent {
    const data: Record<string, unknown> = {
      model_ref: this.input.presetModelRef ?? this.input.model,
      provider_model: this.input.model,
      iteration: this.state.iteration,
      phase,
      profile: this.input.promptProfile,
      request: {
        message_count: context.messages.length,
        tool_count: context.tools.length,
        response_format: this.input.responseFormat?.type ?? "text",
      },
      context: {
        segment_counts: context.diagnostics.segmentCounts,
        total_message_count: context.diagnostics.totalMessageCount,
        tool_count: context.diagnostics.toolCount,
        compiled_hash: context.diagnostics.compiledHash ?? "uncompiled",
        profile: this.input.promptProfile,
      },
    };
    if (attempt !== undefined) data.attempt = attempt;
    return this.event("llm.request", data);
  }

  toolContext(resources: ActiveResources, toolCallId?: string): ToolContext {
    const context: ToolContext = {
      sessionId: this.input.sessionId,
      runId: this.input.runId,
      searchMode: this.input.searchMode,
      model: this.input.model,
      ...resources,
    };
    if (toolCallId) context.toolCallId = toolCallId;
    if (this.input.presetModelRef) context.presetModelRef = this.input.presetModelRef;
    if (this.input.skillSnapshot !== undefined) context.skillSnapshot = structuredClone(this.input.skillSnapshot);
    if (this.input.allowedPluginIds) context.allowedPluginIds = this.input.allowedPluginIds;
    if (this.input.allowedPluginLocks) context.allowedPluginLocks = this.input.allowedPluginLocks;
    return context;
  }

  dispatchPlugin(event: PluginEvent) {
    return this.dependencies.plugins?.dispatch(event, this.pluginScope);
  }

  toolCallHook(call: ToolCall) {
    return this.dispatchPlugin({ type: "tool_call", context: this.pluginContext, call });
  }

  toolResultHook(call: ToolCall, result: ToolResult) {
    return this.dispatchPlugin({ type: "tool_result", context: this.pluginContext, call, result });
  }

  async endTurn(): Promise<void> {
    await this.dispatchPlugin({ type: "turn_end", context: this.pluginContext, iteration: this.state.iteration });
    this.state.assistantText = "";
  }

  async notifyEnd(eventType: "run.finished" | "run.stopped" | "run.error"): Promise<void> {
    await this.dispatchPlugin({ type: "agent_end", context: this.pluginContext, eventType });
  }

  addUsage(next: ModelUsage): void {
    const current = this.state.usage;
    current.promptTokens += next.promptTokens;
    current.completionTokens += next.completionTokens;
    current.totalTokens += next.totalTokens;
    if (current.cachedTokens !== undefined || next.cachedTokens !== undefined) {
      current.cachedTokens = (current.cachedTokens ?? 0) + (next.cachedTokens ?? 0);
    }
    if (next.providerRequestId) current.providerRequestId = next.providerRequestId;
  }

  get structuredOutput(): boolean {
    return this.input.responseFormat?.type === "json_object" || this.input.responseFormat?.type === "json_schema";
  }

  get timedOut(): boolean {
    const reason = this.signal.reason;
    if (reason === "run_timeout") return true;
    return typeof DOMException !== "undefined" && reason instanceof DOMException && reason.name === "TimeoutError";
  }

  /** Serialize the recovery contract explicitly; optional values retain their presence semantics. */
  async checkpoint(options: { pendingToolCalls?: ToolCall[]; reason?: string } = {}): Promise<void> {
    const { input, state } = this;
    const saved: SessionCheckpoint["state"] = {
      promptProfile: input.promptProfile,
      originalUserContent: state.originalUserContent,
      currentUserMessage: state.currentUserMessage,
      assistantText: state.assistantText,
      pendingToolCalls: options.pendingToolCalls ?? [],
      completedToolCallIds: [],
      loopMessages: state.loopMessages,
      bootstrapContext: state.bootstrapContext,
      model: input.model,
      searchMode: input.searchMode,
    };
    if (input.systemPrompt !== undefined) saved.systemPrompt = input.systemPrompt;
    if (input.responseFormat !== undefined) saved.responseFormat = input.responseFormat;
    if (input.allowedToolNames !== undefined) saved.allowedToolNames = [...input.allowedToolNames].sort();
    if (input.presetModelRef) saved.presetModelRef = input.presetModelRef;
    if (input.compiledHash) saved.compiledHash = input.compiledHash;
    if (input.skillSnapshot !== undefined) saved.skillSnapshot = structuredClone(input.skillSnapshot);
    if (input.toolProtocol) saved.toolProtocol = input.toolProtocol;
    if (input.policy) saved.policy = structuredClone(input.policy);
    if (input.allowedPluginIds) saved.allowedPluginIds = [...input.allowedPluginIds].sort();
    if (input.allowedPluginLocks) saved.allowedPluginLocks = structuredClone(input.allowedPluginLocks);
    if (input.temperature !== undefined) saved.temperature = input.temperature;
    await this.dependencies.sessions.checkpoint({
      runId: input.runId,
      sessionId: input.sessionId,
      reason: options.reason ?? "stopped",
      iteration: state.iteration,
      state: saved,
      createdAt: this.dependencies.clock.now(),
      updatedAt: this.dependencies.clock.now(),
    });
  }

  /** Persist recovery state before notifying plugins or publishing a terminal event. */
  async *stop(options: { pendingToolCalls?: ToolCall[]; reason?: string } = {}): AsyncGenerator<AgentEvent, void> {
    await this.checkpoint(options);
    if (this.timedOut) {
      await this.notifyEnd("run.error");
      yield this.event("run.error", { error: "Agent run timed out.", error_code: "run_timeout", checkpointed: true, can_resume: true });
      return;
    }
    let reason = "user_stop";
    if (this.signal.reason === "disconnect") reason = "disconnect";
    await this.notifyEnd("run.stopped");
    yield this.event("run.stopped", { reason, checkpointed: true, can_resume: true });
  }

  async fail(errorCode: string): Promise<void> {
    await this.dependencies.sessions.failRun({ ...this.finishedRecord(), errorCode });
  }

  async flushLoopMessages(): Promise<void> {
    let lastEntryId = this.state.lastEntryId;
    for (const message of this.state.loopMessages) {
      lastEntryId = await this.appendMessage(message, { ...message }, lastEntryId);
    }
    // Advance the run's parent pointer only after the entire flush succeeds.
    this.state.lastEntryId = lastEntryId;
  }

  async complete(text: string): Promise<void> {
    await this.flushLoopMessages();
    this.state.lastEntryId = await this.appendMessage({ role: "assistant", content: text }, { content: text });
    await this.dependencies.sessions.finishRun(this.finishedRecord());
  }

  /** Tool resource actions become visible when the next turn rebuilds its context. */
  async applyResourceAction(result: ToolResult): Promise<void> {
    const sessions = this.dependencies.sessions;
    if (!result.ok || !sessions.setResources || !result.data || typeof result.data !== "object") return;
    const data = result.data as Record<string, unknown>;
    const current = await sessions.open(this.input.sessionId);
    const skills = new Set(current.activeSkills);
    const servers = new Set(current.activeMcpServers);
    let changed = false;
    if ((data.skill_action === "activate" || data.skill_action === "deactivate")
      && typeof data.skill_name === "string" && data.skill_name) {
      changed = true;
      if (data.skill_action === "activate") skills.add(data.skill_name);
      else skills.delete(data.skill_name);
    }
    if ((data.mcp_action === "activate" || data.mcp_action === "deactivate") && typeof data.server_name === "string" && data.server_name) {
      changed = true;
      if (data.mcp_action === "activate") servers.add(data.server_name);
      else servers.delete(data.server_name);
    }
    if (changed) await sessions.setResources(this.input.sessionId, [...skills], [...servers]);
  }

  private finishedRecord(): FinishedRunRecord {
    const record: FinishedRunRecord = {
      runId: this.input.runId,
      sessionId: this.input.sessionId,
      endedAt: this.dependencies.clock.now(),
    };
    if (this.state.lastEntryId) record.lastEntryId = this.state.lastEntryId;
    return record;
  }

  private async appendMessage(
    message: ModelMessage,
    payload: Record<string, unknown>,
    parentEntryId = this.state.lastEntryId,
  ): Promise<EntryId> {
    const entry: NewSessionEntry = {
      entryId: this.dependencies.ids.entryId(),
      sessionId: this.input.sessionId,
      runId: this.input.runId,
      kind: "message",
      role: message.role,
      payload,
      createdAt: this.dependencies.clock.now(),
    };
    if (parentEntryId) entry.parentEntryId = parentEntryId;
    await this.dependencies.sessions.append([entry]);
    return entry.entryId;
  }
}

/** Saved values take precedence; missing legacy checkpoint fields fall back to the invocation. */
function resolveRunInput(
  input: AgentRunInput,
  checkpoint: SessionCheckpoint | undefined,
  fallbackPolicy: AgentPolicy,
): AgentRunInput {
  const saved = checkpoint?.state;
  const config: AgentRunInput = {
    ...input,
    model: saved?.model ?? input.model,
    promptProfile: saved?.promptProfile ?? input.promptProfile,
    searchMode: saved?.searchMode ?? input.searchMode,
    policy: structuredClone(saved?.policy ?? input.policy ?? fallbackPolicy),
  };
  // Test presence explicitly: zero temperature and empty allowlists are valid values.
  const temperature = saved?.temperature ?? input.temperature ?? input.policy?.temperature;
  if (temperature !== undefined) config.temperature = temperature;
  const responseFormat = saved?.responseFormat ?? input.responseFormat ?? input.policy?.responseFormat;
  if (responseFormat) config.responseFormat = responseFormat;
  const systemPrompt = saved?.systemPrompt ?? input.systemPrompt;
  if (systemPrompt !== undefined) config.systemPrompt = systemPrompt;
  const modelRef = saved?.presetModelRef ?? input.presetModelRef;
  if (modelRef) config.presetModelRef = modelRef;
  const compiledHash = saved?.compiledHash ?? input.compiledHash;
  if (compiledHash) config.compiledHash = compiledHash;
  const toolProtocol = saved?.toolProtocol ?? input.toolProtocol;
  if (toolProtocol) config.toolProtocol = toolProtocol;
  if (saved?.allowedToolNames !== undefined) config.allowedToolNames = new Set(saved.allowedToolNames);
  if (saved?.allowedPluginIds !== undefined) config.allowedPluginIds = new Set(saved.allowedPluginIds);
  const locks = saved?.allowedPluginLocks ?? input.allowedPluginLocks;
  if (locks !== undefined) config.allowedPluginLocks = structuredClone(locks);
  const skills = saved?.skillSnapshot ?? input.skillSnapshot;
  if (skills !== undefined) config.skillSnapshot = structuredClone(skills);
  return config;
}

function createEvent(type: AgentEvent["type"], input: AgentRunInput, clock: Clock, data: Record<string, unknown>): AgentEvent {
  return {
    schema_version: 1,
    type,
    session_id: input.sessionId,
    run_id: input.runId,
    data,
    timestamp: clock.now(),
  };
}

function policyForRecord(policy: AgentPolicy): Record<string, unknown> {
  const record: Record<string, unknown> = {
    max_tool_iterations: policy.maxToolIterations,
    run_timeout_ms: policy.runTimeoutMs,
    bootstrap_tool_timeout_ms: policy.bootstrapToolTimeoutMs,
    tool_timeout_ms: policy.toolTimeoutMs,
    tool_execution: policy.toolExecution,
  };
  if (policy.temperature !== undefined) record.temperature = policy.temperature;
  if (policy.responseFormat !== undefined) record.response_format = policy.responseFormat;
  if (policy.searchMode !== undefined) record.search_mode = policy.searchMode;
  return record;
}

function bootstrapMessages(context: Record<string, unknown>[]): ModelMessage[] {
  if (context.length === 0) return [];
  return [{
    role: "system",
    content: `Authoritative runtime context captured at the start of this run. Use these values directly; do not call a tool to rediscover them:\n${JSON.stringify(context)}`,
  }];
}

/** Error recovery may encounter a loop suffix already flushed to the journal. */
function unpersistedLoopMessages(persisted: ModelMessage[], loop: ModelMessage[]): ModelMessage[] {
  if (loop.length === 0 || persisted.length < loop.length) return loop;
  const offset = persisted.length - loop.length;
  const alreadyPersisted = loop.every((message, index) => JSON.stringify(persisted[offset + index]) === JSON.stringify(message));
  if (alreadyPersisted) return [];
  return loop;
}
