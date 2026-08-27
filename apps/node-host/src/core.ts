import type { ToolCall, ToolDefinition, ToolResult } from "@anomaloharis/contracts";

import { systemClock, type Clock } from "./clock.js";
import { ReplayContextBuilder, type ContextBuilder } from "./context.js";
import { finalizerInstruction, StructuredOutputValidationError, validateFinalOutput } from "./finalizer.js";
import { randomIds, type IdFactory } from "./ids.js";
import { ModelInterruptedError, ModelProtocolError, ProviderUnavailableError, type ModelAdapter, type ModelRequest, type ModelUsage } from "./model.js";
import type { PluginContext, PluginEvent, PluginHost } from "./plugins.js";
import type { SessionRepository } from "./session.js";
import type { ToolRuntime } from "./tools.js";
import type {
  AgentEvent,
  AgentPolicy,
  AgentRunInput,
  BuiltContext,
  EntryId,
  ModelMessage,
  SessionCheckpoint,
  SessionId,
  ToolContext,
} from "./types.js";

export class AgentCore {
  constructor(
    private readonly dependencies: {
      model: ModelAdapter;
      tools: ToolRuntime;
      sessions: SessionRepository;
      context?: ContextBuilder;
      ids?: IdFactory;
      clock?: Clock;
      policy?: AgentPolicy;
      plugins?: PluginHost;
    },
  ) {}

  async *execute(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const ids = this.dependencies.ids ?? randomIds;
    const clock = this.dependencies.clock ?? systemClock;
    const fallbackPolicy = this.dependencies.policy ?? defaultPolicy;
    const contextBuilder: ContextBuilder = this.dependencies.context ?? new ReplayContextBuilder(this.dependencies.tools);
    const session = await this.dependencies.sessions.open(input.sessionId);
    const initialActiveSkills = new Set(session.activeSkills);
    const initialActiveMcpServers = new Set(session.activeMcpServers);
    const contextSessionMessages = session.messages.length > 0
      ? session.messages
      : (input.historyMessages ?? []);
    let checkpoint: SessionCheckpoint | undefined;
    let resumedRunId: AgentRunInput["runId"] | undefined;

    if (input.resume) {
      try {
        const resumable = await this.dependencies.sessions.resume(input.sessionId);
        checkpoint = resumable.checkpoint;
        resumedRunId = resumable.runId;
      } catch {
        yield makeEvent("run.error", input, clock, {
          error: "No paused run is available for this session.",
          error_code: "checkpoint_not_found",
          can_resume: false,
        });
        return;
      }
    } else if (session.checkpoint) {
      yield makeEvent("run.error", input, clock, {
        error: "A paused run exists for this session. Resume it before sending a new message.",
        error_code: "checkpoint_resume_required",
        can_resume: true,
      });
      return;
    }

    if (!input.resume && !input.message?.trim()) {
      yield makeEvent("run.error", input, clock, {
        error: "Message content is required.",
        error_code: "message_required",
      });
      return;
    }

    if (input.resume && JSON.stringify(input.responseFormat) !== JSON.stringify(checkpoint?.state.responseFormat)) {
      if (input.responseFormat !== undefined) {
        yield makeEvent("run.error", input, clock, {
          error: "The requested response_format does not match the paused run.",
          error_code: "response_format_mismatch",
          can_resume: true,
        });
        return;
      }
    }
    const effectiveResponseFormat = checkpoint?.state.responseFormat ?? input.responseFormat ?? input.policy?.responseFormat;
    const effectiveTemperature = checkpoint?.state.temperature ?? input.temperature ?? input.policy?.temperature;
    const effectiveAllowedToolNames = checkpoint?.state.allowedToolNames !== undefined
      ? new Set(checkpoint.state.allowedToolNames)
      : input.allowedToolNames;
    const effectiveAllowedPluginIds = checkpoint?.state.allowedPluginIds !== undefined
      ? new Set(checkpoint.state.allowedPluginIds)
      : input.allowedPluginIds;
    const effectiveAllowedPluginLocks = checkpoint?.state.allowedPluginLocks ?? input.allowedPluginLocks;
    const effectiveSkillSnapshot = checkpoint?.state.skillSnapshot ?? input.skillSnapshot;
    const effectivePolicy = checkpoint?.state.policy ?? input.policy ?? fallbackPolicy;
    const effectiveSystemPrompt = checkpoint?.state.systemPrompt ?? input.systemPrompt;
    const runInput: AgentRunInput = {
      ...input,
      runId: resumedRunId ?? input.runId,
      model: checkpoint?.state.model ?? input.model,
      ...(checkpoint?.state.presetModelRef ?? input.presetModelRef
        ? { presetModelRef: checkpoint?.state.presetModelRef ?? input.presetModelRef }
        : {}),
      ...(checkpoint?.state.compiledHash ?? input.compiledHash
        ? { compiledHash: checkpoint?.state.compiledHash ?? input.compiledHash }
        : {}),
      ...(checkpoint?.state.toolProtocol ?? input.toolProtocol
        ? { toolProtocol: checkpoint?.state.toolProtocol ?? input.toolProtocol }
        : {}),
      promptProfile: checkpoint?.state.promptProfile ?? input.promptProfile,
      ...(effectiveSystemPrompt === undefined
        ? {}
        : { systemPrompt: effectiveSystemPrompt }),
      searchMode: checkpoint?.state.searchMode ?? input.searchMode,
      policy: structuredClone(effectivePolicy),
      ...(effectiveTemperature === undefined ? {} : { temperature: effectiveTemperature }),
      ...(effectiveResponseFormat ? { responseFormat: effectiveResponseFormat } : {}),
      ...(effectiveAllowedToolNames === undefined ? {} : { allowedToolNames: effectiveAllowedToolNames }),
      ...(effectiveAllowedPluginIds === undefined ? {} : { allowedPluginIds: effectiveAllowedPluginIds }),
      ...(effectiveAllowedPluginLocks === undefined ? {} : { allowedPluginLocks: structuredClone(effectiveAllowedPluginLocks) }),
      ...(effectiveSkillSnapshot === undefined ? {} : { skillSnapshot: structuredClone(effectiveSkillSnapshot) }),
    };
    const policy = runInput.policy ?? fallbackPolicy;
    const runSignal = AbortSignal.any([signal, AbortSignal.timeout(policy.runTimeoutMs)]);
    const originalUserContent = checkpoint?.state.originalUserContent ?? input.message ?? "";
    const currentUserMessage: ModelMessage = checkpoint?.state.currentUserMessage ?? {
      role: "user",
      content: input.resume
        ? "Continue the interrupted task from the saved context."
        : originalUserContent,
    };
    const loopMessages = dropPersistedLoopMessages(
      session.messages,
      structuredClone(checkpoint?.state.loopMessages ?? []),
    );
    const bootstrapContext = structuredClone(checkpoint?.state.bootstrapContext ?? []);
    let currentAssistantText = checkpoint?.state.assistantText ?? "";
    let runUsage: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let iteration = checkpoint?.iteration ?? 0;
    let lastEntryId = session.activeLeafEntryId;

    await this.dependencies.sessions.beginRun({
      runId: runInput.runId,
      sessionId: input.sessionId,
      status: "active",
      ...(lastEntryId ? { lastEntryId } : {}),
      config: {
        model: runInput.model,
        ...(runInput.presetModelRef ? { model_ref: runInput.presetModelRef } : {}),
        ...(runInput.compiledHash ? { compiled_hash: runInput.compiledHash } : {}),
        ...(runInput.temperature === undefined ? {} : { temperature: runInput.temperature }),
        policy: policyForRecord(policy),
        ...(runInput.allowedPluginIds ? { plugin_ids: [...runInput.allowedPluginIds].sort() } : {}),
        searchMode: runInput.searchMode,
        promptProfile: runInput.promptProfile,
      },
      startedAt: clock.now(),
    });

    if (!checkpoint) {
      const entryId = ids.entryId();
      await this.dependencies.sessions.append([{
        entryId,
        sessionId: runInput.sessionId,
        ...(lastEntryId ? { parentEntryId: lastEntryId } : {}),
        runId: runInput.runId,
        kind: "message",
        role: "user",
        payload: { content: currentUserMessage.content },
        createdAt: clock.now(),
      }]);
      lastEntryId = entryId;
    }

    yield makeEvent("run.started", runInput, clock, {
      resumed: Boolean(checkpoint),
      search_mode: runInput.searchMode,
      model: runInput.model,
      ...(runInput.presetModelRef ? { model_ref: runInput.presetModelRef } : {}),
    });
    const pluginContext = makePluginContext(runInput);
    const pluginScope = runInput.allowedPluginIds
      ? {
        modelRef: runInput.presetModelRef,
        compiledHash: runInput.compiledHash,
        pluginIds: runInput.allowedPluginIds,
        ...(runInput.allowedPluginLocks ? { locks: runInput.allowedPluginLocks } : {}),
      }
      : undefined;
    const dispatchPlugin = (event: PluginEvent) => this.dependencies.plugins?.dispatch(event, pluginScope);
    const notifyAgentEnd = async (eventType: "run.finished" | "run.stopped" | "run.error"): Promise<void> => {
      await dispatchPlugin({ type: "agent_end", context: pluginContext, eventType });
    };
    if (session.messages.length === 0 && !session.checkpoint) {
      await dispatchPlugin({ type: "session_start", context: pluginContext });
    }
    const beforeAgentStart = await dispatchPlugin({
      type: "before_agent_start",
      context: pluginContext,
      messages: [...contextSessionMessages, ...bootstrapMessages(bootstrapContext), currentUserMessage],
    });
    const resourceSnapshot = contextBuilder.prepare
      ? await contextBuilder.prepare({
        baseMessages: [],
        loopMessages: [],
        toolContext: toolContext(runInput, undefined, initialActiveSkills, initialActiveMcpServers),
        ...(runInput.systemPrompt ? { systemPrompt: runInput.systemPrompt } : {}),
        promptProfile: runInput.promptProfile,
      })
      : undefined;

    try {
      if (!checkpoint && input.bootstrapTools?.length) {
        for (const [index, definition] of input.bootstrapTools.entries()) {
          yield makeEvent("tool.started", runInput, clock, {
            phase: "bootstrap",
            tool_call_id: `bootstrap-${runInput.runId}-${index + 1}`,
            tool: definition.name,
            result_key: definition.resultKey ?? definition.name,
            arguments: definition.arguments ?? {},
          });
        }
        const bootstrap = await this.runBootstrapTools(
          runInput,
          input.bootstrapTools,
          runSignal,
          policy,
          initialActiveSkills,
          initialActiveMcpServers,
        );
        for (const result of bootstrap.results) {
          yield makeEvent(result.result.ok ? "tool.finished" : "tool.error", runInput, clock, {
            phase: "bootstrap",
            tool_call_id: result.callId,
            tool: result.name,
            result_key: result.resultKey,
            ok: result.result.ok,
            content: result.result.content,
            data: result.result.data,
          });
        }
        bootstrapContext.push(...bootstrap.context);
        if (bootstrap.requiredFailure) {
          await this.dependencies.sessions.failRun({
            runId: runInput.runId,
            sessionId: input.sessionId,
            errorCode: "bootstrap_failed",
            ...(lastEntryId ? { lastEntryId } : {}),
            endedAt: clock.now(),
          });
          yield makeEvent("run.error", runInput, clock, {
            error: bootstrap.requiredFailure,
            error_code: "bootstrap_failed",
            can_resume: false,
          });
          await notifyAgentEnd("run.error");
          return;
        }
      }

      while (iteration < policy.maxToolIterations) {
        iteration += 1;
        const liveResources = await this.dependencies.sessions.open(input.sessionId);
        const activeSkills = new Set(liveResources.activeSkills);
        const activeMcpServers = new Set(liveResources.activeMcpServers);
        const context = await contextBuilder.build({
          baseMessages: beforeAgentStart?.messages ?? [],
          ...(beforeAgentStart?.messages
            ? {}
            : {
              bootstrapMessages: bootstrapMessages(bootstrapContext),
              sessionMessages: contextSessionMessages,
              currentUserMessage,
            }),
          loopMessages,
          toolContext: toolContext(runInput, undefined, activeSkills, activeMcpServers),
          ...(runInput.systemPrompt ? { systemPrompt: runInput.systemPrompt } : {}),
          ...(runInput.allowedToolNames ? { allowedToolNames: runInput.allowedToolNames } : {}),
          promptProfile: runInput.promptProfile,
          ...(resourceSnapshot ? { resourceSnapshot } : {}),
        });
        if (runInput.compiledHash) context.diagnostics.compiledHash = runInput.compiledHash;
        const contextHook = await dispatchPlugin({
          type: "context",
          context: pluginContext,
          messages: context.messages,
          tools: context.tools,
        });
        if (contextHook?.messages) context.messages = contextHook.messages;
        if (contextHook?.tools) context.tools = contextHook.tools;
        if (runInput.toolProtocol === "none") context.tools = [];
        const request = toModelRequest(runInput, context);
        yield makeEvent("llm.request", runInput, clock, {
          ...llmRequestEventData(runInput, context.diagnostics, iteration, "agent", context.messages.length, context.tools.length),
        });

        const toolCalls: ToolCall[] = [];
        let completed = false;
        try {
          for await (const modelEvent of this.dependencies.model.stream(request, runSignal)) {
            if (modelEvent.type === "text.delta") {
              currentAssistantText += modelEvent.text;
              if (!isStructured(runInput)) {
                yield makeEvent("message.delta", runInput, clock, { content: modelEvent.text });
              }
            } else if (modelEvent.type === "tool.calls") {
              toolCalls.push(...modelEvent.calls);
              break;
            } else if (modelEvent.type === "usage") {
              runUsage = addUsage(runUsage, modelEvent.usage);
            } else if (modelEvent.type === "done") {
              completed = true;
              break;
            }
          }
        } catch (error) {
          if (error instanceof ModelInterruptedError || runSignal.aborted) {
            await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, error instanceof ModelInterruptedError ? error.toolCalls : [], loopMessages, bootstrapContext, iteration, clock);
            const terminalType = runSignalTimeout(runSignal) ? "run.error" : "run.stopped";
            await notifyAgentEnd(terminalType);
            yield terminalType === "run.error"
              ? makeEvent("run.error", runInput, clock, { error: "Agent run timed out.", error_code: "run_timeout", checkpointed: true, can_resume: true })
              : makeEvent("run.stopped", runInput, clock, { reason: runSignal.reason === "disconnect" ? "disconnect" : "user_stop", checkpointed: true, can_resume: true });
            return;
          }
          throw error;
        }

        if (completed || toolCalls.length === 0) {
          let finalText = currentAssistantText;
          let finalOutput: unknown;
          let outputFormat = "text";
          if (isStructured(runInput)) {
            let validationError: string | undefined;
            let finalizerSucceeded = false;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const finalizerMessages: ModelMessage[] = [
                { role: "system", content: "You are a strict final-output formatter. Preserve facts and uncertainty in the research draft." },
                { role: "user", content: originalUserContent },
                { role: "assistant", content: currentAssistantText || "No research draft was produced." },
                { role: "user", content: finalizerInstruction(runInput.responseFormat!, validationError) },
              ];
              yield makeEvent("llm.request", runInput, clock, {
                ...llmRequestEventData(
                  runInput,
                  { segmentCounts: { finalizer: finalizerMessages.length }, totalMessageCount: finalizerMessages.length, toolCount: 0 },
                  iteration,
                  "finalizer",
                  finalizerMessages.length,
                  0,
                ),
                attempt: attempt + 1,
              });
              try {
                const finalizerRequest: ModelRequest = {
                  model: runInput.model,
                  ...(runInput.presetModelRef ? { presetModelRef: runInput.presetModelRef } : {}),
                  ...(runInput.toolProtocol ? { toolProtocol: runInput.toolProtocol } : {}),
                  messages: finalizerMessages,
                  tools: [],
                  ...(runInput.temperature === undefined ? {} : { temperature: runInput.temperature }),
                  responseFormat: runInput.responseFormat,
                };
                const completion = await this.dependencies.model.complete(finalizerRequest, runSignal);
                if (typeof completion === "string") {
                  finalText = completion;
                } else {
                  finalText = completion.text;
                  if (completion.usage) runUsage = addUsage(runUsage, completion.usage);
                }
                if (runSignal.aborted) {
                  validationError = "Finalizer was interrupted.";
                  break;
                }
                finalOutput = validateFinalOutput(finalText, runInput.responseFormat!);
                outputFormat = runInput.responseFormat!.type;
                finalizerSucceeded = true;
                break;
              } catch (error) {
                if (error instanceof ModelInterruptedError || runSignal.aborted) {
                  validationError = "Finalizer was interrupted.";
                  break;
                }
                if (error instanceof StructuredOutputValidationError) {
                  validationError = error.message;
                  continue;
                }
                validationError = error instanceof Error ? error.message : String(error);
                break;
              }
            }
            if (!finalizerSucceeded) {
              if (runSignal.aborted) {
                await this.saveCheckpoint(
                  runInput,
                  currentUserMessage,
                  originalUserContent,
                  currentAssistantText,
                  [],
                  loopMessages,
                  bootstrapContext,
                  iteration,
                  clock,
                  runSignalTimeout(runSignal) ? "run_timeout" : "stopped",
                );
                const terminalType = runSignalTimeout(runSignal) ? "run.error" : "run.stopped";
                await notifyAgentEnd(terminalType);
                yield terminalType === "run.error"
                  ? makeEvent("run.error", runInput, clock, { error: "Agent run timed out.", error_code: "run_timeout", checkpointed: true, can_resume: true })
                  : makeEvent("run.stopped", runInput, clock, { reason: runSignal.reason === "disconnect" ? "disconnect" : "user_stop", checkpointed: true, can_resume: true });
                return;
              }
              await this.saveCheckpoint(
                runInput,
                currentUserMessage,
                originalUserContent,
                currentAssistantText,
                [],
                loopMessages,
                bootstrapContext,
                iteration,
                clock,
                runSignalTimeout(runSignal) ? "run_timeout" : "finalizer_error",
              );
              const errorCode = runSignalTimeout(runSignal)
                ? "run_timeout"
                : validationError?.startsWith("Finalizer output") ? "structured_output_invalid" : "finalizer_failed";
              await this.dependencies.sessions.failRun({ runId: runInput.runId, sessionId: runInput.sessionId, errorCode, ...(lastEntryId ? { lastEntryId } : {}), endedAt: clock.now() });
              await notifyAgentEnd("run.error");
              yield makeEvent("run.error", runInput, clock, { error: validationError ?? "Finalizer failed.", error_code: errorCode, can_resume: true });
              return;
            }
          }

          lastEntryId = await appendLoopMessages(this.dependencies.sessions, runInput, loopMessages, lastEntryId, ids, clock);
          lastEntryId = await appendAssistant(this.dependencies.sessions, runInput, finalText, lastEntryId, ids, clock);
          await this.dependencies.sessions.finishRun({ runId: runInput.runId, sessionId: runInput.sessionId, ...(lastEntryId ? { lastEntryId } : {}), endedAt: clock.now() });
          if (isStructured(runInput)) yield makeEvent("message.delta", runInput, clock, { content: finalText });
          yield makeEvent("message.done", runInput, clock, {});
          await notifyAgentEnd("run.finished");
          yield makeEvent("run.finished", runInput, clock, {
            final_text: finalText,
            output: finalOutput,
            output_format: outputFormat,
            usage: runUsage,
          });
          return;
        }

        loopMessages.push({ role: "assistant", content: currentAssistantText, tool_calls: toolCalls });
        for (const call of toolCalls) {
          const contextForTool = toolContext(runInput, call.id, activeSkills, activeMcpServers);
          const toolHook = await dispatchPlugin({ type: "tool_call", context: pluginContext, call });
          const effectiveCall = toolHook?.call ?? call;
          yield makeEvent("tool.started", runInput, clock, { tool_call_id: effectiveCall.id, tool: effectiveCall.name, arguments: effectiveCall.arguments });
          let result: ToolResult;
          if (toolHook?.allow === false) {
            result = { name: effectiveCall.name, ok: false, content: "Plugin policy denied this tool call.", data: { error_code: "plugin_failed" } };
          } else if (runInput.allowedToolNames && !runInput.allowedToolNames.has(effectiveCall.name)) {
            result = {
              name: effectiveCall.name,
              ok: false,
              content: `Tool is not enabled for this run: ${effectiveCall.name}`,
              data: { error_code: "tool_not_allowed" },
            };
          } else {
            try {
              const toolSignal = AbortSignal.any([
                runSignal,
                AbortSignal.timeout(timeoutForTool(policy.toolTimeoutMs, context.tools, effectiveCall.name)),
              ]);
              result = await this.dependencies.tools.call(effectiveCall, contextForTool, toolSignal);
            } catch (error) {
              result = { name: effectiveCall.name, ok: false, content: error instanceof Error ? error.message : String(error), data: { error_type: "ToolError" } };
            }
          }
          const resultHook = await dispatchPlugin({ type: "tool_result", context: pluginContext, call: effectiveCall, result });
          if (resultHook?.result) result = resultHook.result;
          await applyResourceAction(this.dependencies.sessions, input.sessionId, result);
          loopMessages.push({ role: "tool", tool_call_id: effectiveCall.id, name: effectiveCall.name, content: result.content });
          yield makeEvent(result.ok ? "tool.finished" : "tool.error", runInput, clock, { tool_call_id: effectiveCall.id, tool: effectiveCall.name, ok: result.ok, content: result.content, data: result.data });
          if (runSignal.aborted) {
            await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, [effectiveCall], loopMessages, bootstrapContext, iteration, clock);
            const terminalType = runSignalTimeout(runSignal) ? "run.error" : "run.stopped";
            await notifyAgentEnd(terminalType);
            yield terminalType === "run.error"
              ? makeEvent("run.error", runInput, clock, { error: "Agent run timed out.", error_code: "run_timeout", checkpointed: true, can_resume: true })
              : makeEvent("run.stopped", runInput, clock, { reason: runSignal.reason === "disconnect" ? "disconnect" : "user_stop", checkpointed: true, can_resume: true });
            return;
          }
        }
        await dispatchPlugin({ type: "turn_end", context: pluginContext, iteration });
        currentAssistantText = "";
      }

      lastEntryId = await appendLoopMessages(this.dependencies.sessions, runInput, loopMessages, lastEntryId, ids, clock);
      await this.dependencies.sessions.failRun({ runId: runInput.runId, sessionId: runInput.sessionId, errorCode: "max_tool_iterations", ...(lastEntryId ? { lastEntryId } : {}), endedAt: clock.now() });
      await notifyAgentEnd("run.error");
      yield makeEvent("run.error", runInput, clock, { error: "Maximum tool iterations reached.", error_code: "max_tool_iterations", can_resume: false });
    } catch (error) {
      if (runSignal.aborted) {
        await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, [], loopMessages, bootstrapContext, iteration, clock);
        const terminalType = runSignalTimeout(runSignal) ? "run.error" : "run.stopped";
        await notifyAgentEnd(terminalType);
        yield terminalType === "run.error"
          ? makeEvent("run.error", runInput, clock, { error: "Agent run timed out.", error_code: "run_timeout", checkpointed: true, can_resume: true })
          : makeEvent("run.stopped", runInput, clock, { reason: runSignal.reason === "disconnect" ? "disconnect" : "user_stop", checkpointed: true, can_resume: true });
        return;
      }
      const errorCode = error instanceof ModelProtocolError || error instanceof ProviderUnavailableError
        ? error.errorCode
        : "model_failed";
      await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, [], loopMessages, bootstrapContext, iteration, clock, errorCode);
      await this.dependencies.sessions.failRun({ runId: runInput.runId, sessionId: runInput.sessionId, errorCode, ...(lastEntryId ? { lastEntryId } : {}), endedAt: clock.now() });
      await notifyAgentEnd("run.error");
      yield makeEvent("run.error", runInput, clock, { error: error instanceof Error ? error.message : String(error), error_code: errorCode, can_resume: true });
    }
  }

  private async runBootstrapTools(
    input: AgentRunInput,
    definitions: NonNullable<AgentRunInput["bootstrapTools"]>,
    signal: AbortSignal,
    policy: AgentPolicy,
    activeSkills: ReadonlySet<string>,
    activeMcpServers: ReadonlySet<string>,
  ): Promise<{
    results: Array<{ callId: string; name: string; resultKey: string; result: ToolResult }>;
    context: Record<string, unknown>[];
    requiredFailure?: string;
  }> {
    const calls = definitions.map((definition, index) => ({
      callId: `bootstrap-${input.runId}-${index + 1}`,
      name: definition.name,
      resultKey: definition.resultKey ?? definition.name,
      arguments: definition.arguments ?? {},
      required: definition.required ?? true,
    }));
    const results = await Promise.all(calls.map(async (call) => {
      const child = new AbortController();
      const onAbort = () => child.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => child.abort("bootstrap_timeout"), policy.bootstrapToolTimeoutMs);
      let result: ToolResult;
      try {
        result = await this.dependencies.tools.call(
          { id: call.callId, name: call.name, arguments: call.arguments },
          toolContext(input, call.callId, activeSkills, activeMcpServers),
          child.signal,
        );
      } catch (error) {
        result = { name: call.name, ok: false, content: error instanceof Error ? error.message : String(error), data: { error_type: "BootstrapToolError" } };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
      return { ...call, result };
    }));
    const context: Record<string, unknown>[] = [];
    const failures: string[] = [];
    for (const result of results) {
      if (result.result.ok) context.push({ key: result.resultKey, tool: result.name, arguments: result.arguments, result: result.result.content });
      else if (result.required) failures.push(`${result.name} (${result.resultKey}): ${result.result.content}`);
    }
    return { results, context, ...(failures.length ? { requiredFailure: `Required bootstrap tool failed: ${failures.join("; ")}` } : {}) };
  }

  private async saveCheckpoint(
    input: AgentRunInput,
    currentUserMessage: ModelMessage,
    originalUserContent: string,
    assistantText: string,
    pendingToolCalls: ToolCall[],
    loopMessages: ModelMessage[],
    bootstrapContext: Record<string, unknown>[],
    iteration: number,
    clock: Clock,
    reason = "stopped",
  ): Promise<void> {
    await this.dependencies.sessions.checkpoint({
      runId: input.runId,
      sessionId: input.sessionId,
      reason,
      iteration,
      state: {
        promptProfile: input.promptProfile,
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
        originalUserContent,
        currentUserMessage,
        assistantText,
        pendingToolCalls,
        completedToolCallIds: [],
        loopMessages,
        bootstrapContext,
        ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
        ...(input.allowedToolNames === undefined ? {} : { allowedToolNames: [...input.allowedToolNames].sort() }),
        model: input.model,
        ...(input.presetModelRef ? { presetModelRef: input.presetModelRef } : {}),
        ...(input.compiledHash ? { compiledHash: input.compiledHash } : {}),
        ...(input.skillSnapshot === undefined ? {} : { skillSnapshot: structuredClone(input.skillSnapshot) }),
        ...(input.toolProtocol ? { toolProtocol: input.toolProtocol } : {}),
        ...(input.policy ? { policy: structuredClone(input.policy) } : {}),
        ...(input.allowedPluginIds ? { allowedPluginIds: [...input.allowedPluginIds].sort() } : {}),
        ...(input.allowedPluginLocks ? { allowedPluginLocks: structuredClone(input.allowedPluginLocks) } : {}),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        searchMode: input.searchMode,
      },
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
  }
}

export const defaultPolicy: AgentPolicy = {
  maxToolIterations: 50,
  runTimeoutMs: 600_000,
  bootstrapToolTimeoutMs: 2_000,
  toolTimeoutMs: 30_000,
  structuredOutputRetryCount: 1,
  toolExecution: "sequential",
};

function toolContext(
  input: AgentRunInput,
  toolCallId?: string,
  activeSkills: ReadonlySet<string> = new Set(),
  activeMcpServers: ReadonlySet<string> = new Set(),
): ToolContext {
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    ...(toolCallId ? { toolCallId } : {}),
    searchMode: input.searchMode,
    model: input.model,
    ...(input.presetModelRef ? { presetModelRef: input.presetModelRef } : {}),
    ...(input.skillSnapshot === undefined ? {} : { skillSnapshot: structuredClone(input.skillSnapshot) }),
    activeSkills,
    activeMcpServers,
    ...(input.allowedPluginIds ? { allowedPluginIds: input.allowedPluginIds } : {}),
    ...(input.allowedPluginLocks ? { allowedPluginLocks: input.allowedPluginLocks } : {}),
  };
}

function policyForRecord(policy: AgentPolicy): Record<string, unknown> {
  return {
    max_tool_iterations: policy.maxToolIterations,
    run_timeout_ms: policy.runTimeoutMs,
    bootstrap_tool_timeout_ms: policy.bootstrapToolTimeoutMs,
    tool_timeout_ms: policy.toolTimeoutMs,
    tool_execution: policy.toolExecution,
    ...(policy.temperature === undefined ? {} : { temperature: policy.temperature }),
    ...(policy.responseFormat === undefined ? {} : { response_format: policy.responseFormat }),
    ...(policy.searchMode === undefined ? {} : { search_mode: policy.searchMode }),
  };
}

function makePluginContext(input: AgentRunInput): PluginContext {
  return {
    pluginId: "host",
    sessionId: input.sessionId,
    runId: input.runId,
  };
}

async function applyResourceAction(
  sessions: SessionRepository,
  sessionId: SessionId,
  result: ToolResult,
): Promise<void> {
  if (!result.ok || !sessions.setResources || !result.data || typeof result.data !== "object") return;
  const data = result.data as Record<string, unknown>;
  const current = await sessions.open(sessionId);
  const activeSkills = new Set(current.activeSkills);
  const activeMcpServers = new Set(current.activeMcpServers);
  let changed = false;
  if (data.skill_action === "activate" || data.skill_action === "deactivate") {
    const name = typeof data.skill_name === "string" ? data.skill_name : "";
    if (name) {
      changed = true;
      if (data.skill_action === "activate") activeSkills.add(name);
      else activeSkills.delete(name);
    }
  }
  if (data.mcp_action === "activate" || data.mcp_action === "deactivate") {
    const name = typeof data.server_name === "string" ? data.server_name : "";
    if (name) {
      changed = true;
      if (data.mcp_action === "activate") activeMcpServers.add(name);
      else activeMcpServers.delete(name);
    }
  }
  if (changed) await sessions.setResources(sessionId, [...activeSkills], [...activeMcpServers]);
}

function toModelRequest(input: AgentRunInput, context: BuiltContext): ModelRequest {
  return {
    model: input.model,
    ...(input.presetModelRef ? { presetModelRef: input.presetModelRef } : {}),
    ...(input.toolProtocol ? { toolProtocol: input.toolProtocol } : {}),
    messages: context.messages,
    tools: input.toolProtocol === "none" ? [] : context.tools,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
  };
}

function timeoutForTool(policyTimeoutMs: number, definitions: ToolDefinition[], name: string): number {
  const declaredTimeoutMs = definitions.find((definition) => definition.name === name)?.timeout_ms;
  if (typeof declaredTimeoutMs !== "number" || !Number.isFinite(declaredTimeoutMs)) return policyTimeoutMs;
  return Math.max(policyTimeoutMs, Math.trunc(declaredTimeoutMs));
}

function llmRequestEventData(
  input: AgentRunInput,
  diagnostics: Pick<BuiltContext["diagnostics"], "segmentCounts" | "totalMessageCount" | "toolCount"> & { compiledHash?: string | undefined },
  iteration: number,
  phase: string,
  messageCount: number,
  toolCount: number,
): Record<string, unknown> {
  return {
    model_ref: input.presetModelRef ?? input.model,
    provider_model: input.model,
    iteration,
    phase,
    profile: input.promptProfile,
    request: {
      message_count: messageCount,
      tool_count: toolCount,
      response_format: input.responseFormat?.type ?? "text",
    },
    context: {
      segment_counts: diagnostics.segmentCounts,
      total_message_count: diagnostics.totalMessageCount,
      tool_count: diagnostics.toolCount,
      compiled_hash: diagnostics.compiledHash ?? "uncompiled",
      profile: input.promptProfile,
    },
  };
}

function makeEvent(
  type: AgentEvent["type"],
  input: AgentRunInput,
  clock: Clock,
  data: Record<string, unknown>,
): AgentEvent {
  return {
    schema_version: 1,
    type,
    session_id: input.sessionId,
    run_id: input.runId,
    data,
    timestamp: clock.now(),
  };
}

async function appendLoopMessages(
  sessions: SessionRepository,
  input: AgentRunInput,
  messages: ModelMessage[],
  parentEntryId: EntryId | undefined,
  ids: IdFactory,
  clock: Clock,
): Promise<EntryId | undefined> {
  let lastEntryId = parentEntryId;
  for (const message of messages) {
    const entryId = ids.entryId();
    await sessions.append([{
      entryId,
      sessionId: input.sessionId,
      ...(lastEntryId ? { parentEntryId: lastEntryId } : {}),
      runId: input.runId,
      kind: "message",
      role: message.role,
      payload: { ...message },
      createdAt: clock.now(),
    }]);
    lastEntryId = entryId;
  }
  return lastEntryId;
}

async function appendAssistant(
  sessions: SessionRepository,
  input: AgentRunInput,
  text: string,
  parentEntryId: EntryId | undefined,
  ids: IdFactory,
  clock: Clock,
): Promise<EntryId> {
  const entryId = ids.entryId();
  await sessions.append([{
    entryId,
    sessionId: input.sessionId,
    ...(parentEntryId ? { parentEntryId } : {}),
    runId: input.runId,
    kind: "message",
    role: "assistant",
    payload: { content: text },
    createdAt: clock.now(),
  }]);
  return entryId;
}

function bootstrapMessages(context: Record<string, unknown>[]): ModelMessage[] {
  if (context.length === 0) return [];
  return [{
    role: "system",
    content: `Authoritative runtime context captured at the start of this run. Use these values directly; do not call a tool to rediscover them:\n${JSON.stringify(context)}`,
  }];
}

function dropPersistedLoopMessages(
  persistedMessages: ModelMessage[],
  loopMessages: ModelMessage[],
): ModelMessage[] {
  if (loopMessages.length === 0 || persistedMessages.length < loopMessages.length) return loopMessages;
  const offset = persistedMessages.length - loopMessages.length;
  const alreadyPersisted = loopMessages.every((message, index) => (
    JSON.stringify(persistedMessages[offset + index]) === JSON.stringify(message)
  ));
  return alreadyPersisted ? [] : loopMessages;
}

function isStructured(input: AgentRunInput): boolean {
  return input.responseFormat?.type === "json_object" || input.responseFormat?.type === "json_schema";
}

function runSignalTimeout(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return reason === "run_timeout" || (
    typeof DOMException !== "undefined" &&
    reason instanceof DOMException &&
    reason.name === "TimeoutError"
  );
}

function addUsage(current: ModelUsage, next: ModelUsage): ModelUsage {
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    ...(current.cachedTokens !== undefined || next.cachedTokens !== undefined
      ? { cachedTokens: (current.cachedTokens ?? 0) + (next.cachedTokens ?? 0) }
      : {}),
    ...(next.providerRequestId ? { providerRequestId: next.providerRequestId } : current.providerRequestId ? { providerRequestId: current.providerRequestId } : {}),
  };
}
