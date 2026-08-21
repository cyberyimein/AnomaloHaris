import type { ToolCall, ToolResult } from "@anomalo/contracts";

import { systemClock, type Clock } from "./clock.js";
import { ReplayContextBuilder, type ContextBuilder } from "./context.js";
import { finalizerInstruction, StructuredOutputValidationError, validateFinalOutput } from "./finalizer.js";
import { randomIds, type IdFactory } from "./ids.js";
import { ModelInterruptedError, type ModelAdapter, type ModelRequest } from "./model.js";
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
    },
  ) {}

  async *execute(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const ids = this.dependencies.ids ?? randomIds;
    const clock = this.dependencies.clock ?? systemClock;
    const policy = this.dependencies.policy ?? defaultPolicy;
    const contextBuilder = this.dependencies.context ?? new ReplayContextBuilder(this.dependencies.tools);
    const session = await this.dependencies.sessions.open(input.sessionId);
    let checkpoint: SessionCheckpoint | undefined;

    if (input.resume) {
      try {
        checkpoint = (await this.dependencies.sessions.resume(input.sessionId)).checkpoint;
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

    const effectiveResponseFormat = input.responseFormat ?? checkpoint?.state.responseFormat;
    const runInput: AgentRunInput = { ...input, ...(effectiveResponseFormat ? { responseFormat: effectiveResponseFormat } : {}) };
    const originalUserContent = checkpoint?.state.originalUserContent ?? input.message ?? "";
    const currentUserMessage: ModelMessage = checkpoint?.state.currentUserMessage ?? {
      role: "user",
      content: input.resume
        ? "Continue the interrupted task from the saved context."
        : originalUserContent,
    };
    const loopMessages = structuredClone(checkpoint?.state.loopMessages ?? []);
    const bootstrapContext = structuredClone(checkpoint?.state.bootstrapContext ?? []);
    let currentAssistantText = checkpoint?.state.assistantText ?? "";
    let iteration = checkpoint?.iteration ?? 0;
    let lastEntryId = session.activeLeafEntryId;

    await this.dependencies.sessions.beginRun({
      runId: input.runId,
      sessionId: input.sessionId,
      status: "active",
      ...(lastEntryId ? { lastEntryId } : {}),
      config: {
        model: input.model,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        searchMode: input.searchMode,
        promptProfile: input.promptProfile,
      },
      startedAt: clock.now(),
    });

    if (!checkpoint) {
      const entryId = ids.entryId();
      await this.dependencies.sessions.append([{
        entryId,
        sessionId: input.sessionId,
        ...(lastEntryId ? { parentEntryId: lastEntryId } : {}),
        runId: input.runId,
        kind: "message",
        role: "user",
        payload: { content: currentUserMessage.content },
        createdAt: clock.now(),
      }]);
      lastEntryId = entryId;
    }

    yield makeEvent("run.started", runInput, clock, {
      resumed: Boolean(checkpoint),
      search_mode: input.searchMode,
      model: input.model,
    });

    try {
      if (!checkpoint && input.bootstrapTools?.length) {
        for (const [index, definition] of input.bootstrapTools.entries()) {
          yield makeEvent("tool.started", runInput, clock, {
            phase: "bootstrap",
            tool_call_id: `bootstrap-${input.runId}-${index + 1}`,
            tool: definition.name,
            result_key: definition.resultKey ?? definition.name,
            arguments: definition.arguments ?? {},
          });
        }
        const bootstrap = await this.runBootstrapTools(runInput, input.bootstrapTools, signal, policy);
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
            runId: input.runId,
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
          return;
        }
      }

      while (iteration < policy.maxToolIterations) {
        iteration += 1;
        const context = await contextBuilder.build({
          baseMessages: [
            ...session.messages,
            ...bootstrapMessages(bootstrapContext),
            currentUserMessage,
          ],
          loopMessages,
          toolContext: toolContext(runInput),
          ...(input.allowedToolNames ? { allowedToolNames: input.allowedToolNames } : {}),
          promptProfile: input.promptProfile,
        });
        const request = toModelRequest(runInput, context);
        yield makeEvent("llm.request", runInput, clock, {
          profile: input.promptProfile,
          iteration,
          phase: "agent",
          context: context.diagnostics,
        });

        const toolCalls: ToolCall[] = [];
        let completed = false;
        try {
          for await (const modelEvent of this.dependencies.model.stream(request, signal)) {
            if (modelEvent.type === "text.delta") {
              currentAssistantText += modelEvent.text;
              if (!isStructured(runInput)) {
                yield makeEvent("message.delta", runInput, clock, { content: modelEvent.text });
              }
            } else if (modelEvent.type === "tool.calls") {
              toolCalls.push(...modelEvent.calls);
              break;
            } else if (modelEvent.type === "done") {
              completed = true;
              break;
            }
          }
        } catch (error) {
          if (error instanceof ModelInterruptedError || signal.aborted) {
            await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, error instanceof ModelInterruptedError ? error.toolCalls : [], loopMessages, bootstrapContext, iteration, clock);
            yield makeEvent("run.stopped", runInput, clock, {
              reason: signal.reason === "disconnect" ? "disconnect" : "user_stop",
              checkpointed: true,
              can_resume: true,
            });
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
                profile: input.promptProfile,
                iteration,
                phase: "finalizer",
                attempt: attempt + 1,
                context: { phase: "finalizer", totalMessageCount: finalizerMessages.length, toolCount: 0 },
              });
              try {
                const finalizerRequest: ModelRequest = {
                  model: input.model,
                  messages: finalizerMessages,
                  tools: [],
                  ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
                  responseFormat: runInput.responseFormat,
                };
                finalText = await this.dependencies.model.complete(finalizerRequest, signal);
                finalOutput = validateFinalOutput(finalText, runInput.responseFormat!);
                outputFormat = runInput.responseFormat!.type;
                finalizerSucceeded = true;
                break;
              } catch (error) {
                if (error instanceof ModelInterruptedError || signal.aborted) {
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
              await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, [], loopMessages, bootstrapContext, iteration, clock, "finalizer_error");
              const errorCode = validationError?.startsWith("Finalizer output") ? "structured_output_invalid" : "finalizer_failed";
              await this.dependencies.sessions.failRun({ runId: input.runId, sessionId: input.sessionId, errorCode, ...(lastEntryId ? { lastEntryId } : {}), endedAt: clock.now() });
              yield makeEvent("run.error", runInput, clock, { error: validationError ?? "Finalizer failed.", error_code: errorCode, can_resume: true });
              return;
            }
          }

          lastEntryId = await appendLoopMessages(this.dependencies.sessions, runInput, loopMessages, lastEntryId, ids, clock);
          lastEntryId = await appendAssistant(this.dependencies.sessions, runInput, finalText, lastEntryId, ids, clock);
          await this.dependencies.sessions.finishRun({ runId: input.runId, sessionId: input.sessionId, ...(lastEntryId ? { lastEntryId } : {}), endedAt: clock.now() });
          if (isStructured(runInput)) yield makeEvent("message.delta", runInput, clock, { content: finalText });
          yield makeEvent("message.done", runInput, clock, {});
          yield makeEvent("run.finished", runInput, clock, { final_text: finalText, output: finalOutput, output_format: outputFormat });
          return;
        }

        loopMessages.push({ role: "assistant", content: currentAssistantText, tool_calls: toolCalls });
        for (const call of toolCalls) {
          const contextForTool = toolContext(runInput, call.id);
          yield makeEvent("tool.started", runInput, clock, { tool_call_id: call.id, tool: call.name, arguments: call.arguments });
          let result: ToolResult;
          try {
            result = await this.dependencies.tools.call(call, contextForTool, signal);
          } catch (error) {
            result = { name: call.name, ok: false, content: error instanceof Error ? error.message : String(error), data: { error_type: "ToolError" } };
          }
          loopMessages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: result.content });
          yield makeEvent(result.ok ? "tool.finished" : "tool.error", runInput, clock, { tool_call_id: call.id, tool: call.name, ok: result.ok, content: result.content, data: result.data });
          if (signal.aborted) {
            await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, [call], loopMessages, bootstrapContext, iteration, clock);
            yield makeEvent("run.stopped", runInput, clock, { reason: signal.reason === "disconnect" ? "disconnect" : "user_stop", checkpointed: true, can_resume: true });
            return;
          }
        }
        currentAssistantText = "";
      }

      lastEntryId = await appendLoopMessages(this.dependencies.sessions, runInput, loopMessages, lastEntryId, ids, clock);
      await this.dependencies.sessions.failRun({ runId: input.runId, sessionId: input.sessionId, errorCode: "max_tool_iterations", ...(lastEntryId ? { lastEntryId } : {}), endedAt: clock.now() });
      yield makeEvent("run.error", runInput, clock, { error: "Maximum tool iterations reached.", error_code: "max_tool_iterations", can_resume: false });
    } catch (error) {
      if (signal.aborted) {
        await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, [], loopMessages, bootstrapContext, iteration, clock);
        yield makeEvent("run.stopped", runInput, clock, { reason: signal.reason === "disconnect" ? "disconnect" : "user_stop", checkpointed: true, can_resume: true });
        return;
      }
      await this.saveCheckpoint(runInput, currentUserMessage, originalUserContent, currentAssistantText, [], loopMessages, bootstrapContext, iteration, clock, "model_failed");
      await this.dependencies.sessions.failRun({ runId: input.runId, sessionId: input.sessionId, errorCode: "model_failed", ...(lastEntryId ? { lastEntryId } : {}), endedAt: clock.now() });
      yield makeEvent("run.error", runInput, clock, { error: error instanceof Error ? error.message : String(error), error_code: "model_failed", can_resume: true });
    }
  }

  private async runBootstrapTools(
    input: AgentRunInput,
    definitions: NonNullable<AgentRunInput["bootstrapTools"]>,
    signal: AbortSignal,
    policy: AgentPolicy,
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
        result = await this.dependencies.tools.call({ id: call.callId, name: call.name, arguments: call.arguments }, toolContext(input, call.callId), child.signal);
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
        originalUserContent,
        currentUserMessage,
        assistantText,
        pendingToolCalls,
        completedToolCallIds: [],
        loopMessages,
        bootstrapContext,
        ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
        model: input.model,
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
  structuredOutputRetryCount: 1,
  toolExecution: "sequential",
};

function toolContext(input: AgentRunInput, toolCallId?: string): ToolContext {
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    ...(toolCallId ? { toolCallId } : {}),
    searchMode: input.searchMode,
    model: input.model,
    activeSkills: new Set(),
    activeMcpServers: new Set(),
  };
}

function toModelRequest(input: AgentRunInput, context: BuiltContext): ModelRequest {
  return {
    model: input.model,
    messages: context.messages,
    tools: context.tools,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
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

function isStructured(input: AgentRunInput): boolean {
  return input.responseFormat?.type === "json_object" || input.responseFormat?.type === "json_schema";
}
