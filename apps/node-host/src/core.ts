import type { ToolCall } from "@anomaloharis/contracts";

import { AgentRun } from "./agent-run.js";
import { executeToolCalls, runBootstrapTools } from "./agent-tools.js";
import { systemClock, type Clock } from "./clock.js";
import { ReplayContextBuilder, type ContextBuilder } from "./context.js";
import { finalizeAnswer } from "./finalizer.js";
import { randomIds, type IdFactory } from "./ids.js";
import {
  ModelInterruptedError,
  ModelProtocolError,
  ProviderUnavailableError,
  type ModelAdapter,
} from "./model.js";
import type { PluginHost } from "./plugins.js";
import type { SessionRepository } from "./session.js";
import type { ToolRuntime } from "./tools.js";
import type { AgentEvent, AgentPolicy, AgentRunInput, BuiltContext } from "./types.js";

export type AgentCoreDependencies = {
  model: ModelAdapter;
  tools: ToolRuntime;
  sessions: SessionRepository;
  context?: ContextBuilder;
  ids?: IdFactory;
  clock?: Clock;
  policy?: AgentPolicy;
  plugins?: PluginHost;
  prepareModelContext?: (input: AgentRunInput, context: BuiltContext, signal: AbortSignal) => Promise<BuiltContext>;
  onUsage?: (input: AgentRunInput, usage: import("./model.js").ModelUsage) => void;
  beforeComplete?: (input: AgentRunInput, request: import("./model.js").ModelRequest) => import("./model.js").ModelCallSettlement | undefined;
};

type ModelTurnResult =
  | { kind: "answer" }
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "stopped" };

/** Coordinates one agent loop. All mutable state is allocated per execute() call. */
export class AgentCore {
  constructor(private readonly dependencies: AgentCoreDependencies) {}

  /** Stage generators stream public events; yield* also returns their internal outcome. */
  async *execute(input: AgentRunInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const contextBuilder = this.dependencies.context ?? new ReplayContextBuilder(this.dependencies.tools);
    const prepared = await AgentRun.prepare(input, signal, this.dependencies.policy ?? defaultPolicy, {
      sessions: this.dependencies.sessions,
      ids: this.dependencies.ids ?? randomIds,
      clock: this.dependencies.clock ?? systemClock,
      plugins: this.dependencies.plugins,
    });
    if (prepared.kind === "rejected") {
      yield prepared.event;
      return;
    }
    const run = prepared.run;
    yield* run.start();
    const contextSeed = await run.prepareContext(contextBuilder);

    try {
      // Startup tools provide authoritative context before the first model turn.
      if (!run.resumed && input.bootstrapTools?.length) {
        const failure = yield* runBootstrapTools(run, this.dependencies.tools, input.bootstrapTools);
        if (failure) {
          await run.fail("bootstrap_failed");
          yield run.event("run.error", { error: failure, error_code: "bootstrap_failed", can_resume: false });
          await run.notifyEnd("run.error");
          return;
        }
      }

      while (run.state.iteration < run.policy.maxToolIterations) {
        run.state.iteration += 1;
        const { context, resources } = await run.buildContext(contextBuilder, contextSeed);
        const readyContext = this.dependencies.prepareModelContext
          ? await this.dependencies.prepareModelContext(run.input, context, run.signal) : context;
        const turn = yield* this.requestModel(run, readyContext);
        if (turn.kind === "stopped") return;

        if (turn.kind === "tools") {
          const interruptedCall = yield* executeToolCalls(
            run, this.dependencies.tools, turn.calls, context.tools, resources,
          );
          if (interruptedCall) {
            yield* run.stop({ pendingToolCalls: [interruptedCall] });
            return;
          }
          await run.endTurn();
          continue;
        }

        // Structured output is validated before any final text is published.
        const finalization = yield* finalizeAnswer(run, this.dependencies.model, {
          beforeRequest: (request) => this.dependencies.beforeComplete?.(run.input, request),
        });
        if (finalization.kind === "failure") {
          if (run.signal.aborted) {
            let reason = "stopped";
            if (run.timedOut) reason = "run_timeout";
            yield* run.stop({ reason });
          } else {
            await run.checkpoint({ reason: "finalizer_error" });
            await run.fail(finalization.errorCode);
            await run.notifyEnd("run.error");
            yield run.event("run.error", {
              error: finalization.error,
              error_code: finalization.errorCode,
              can_resume: true,
            });
          }
          return;
        }
        const answer = finalization.answer;
        await run.complete(answer.text);
        if (run.structuredOutput) yield run.event("message.delta", { content: answer.text });
        yield run.event("message.done", {});
        await run.notifyEnd("run.finished");
        yield run.event("run.finished", {
          final_text: answer.text,
          output: answer.output,
          output_format: answer.format,
          usage: run.state.usage,
        });
        return;
      }

      await run.flushLoopMessages();
      await run.fail("max_tool_iterations");
      await run.notifyEnd("run.error");
      yield run.event("run.error", {
        error: "Maximum tool iterations reached.",
        error_code: "max_tool_iterations",
        can_resume: false,
      });
    } catch (error) {
      if (run.signal.aborted) {
        yield* run.stop();
        return;
      }
      let errorCode = "model_failed";
      if (error instanceof ModelProtocolError || error instanceof ProviderUnavailableError) {
        errorCode = error.errorCode;
      }
      await run.checkpoint({ reason: errorCode });
      await run.fail(errorCode);
      await run.notifyEnd("run.error");
      let message: string;
      if (error instanceof Error) message = error.message;
      else message = String(error);
      yield run.event("run.error", { error: message, error_code: errorCode, can_resume: true });
    }
  }

  /** Stream one model turn, then hand either tool calls or a completed draft to the loop. */
  private async *requestModel(run: AgentRun, context: BuiltContext): AsyncGenerator<AgentEvent, ModelTurnResult> {
    yield run.modelRequestEvent(context);
    const calls: ToolCall[] = [];
    try {
      const request = run.modelRequest(context.messages, context.tools);
      for await (const event of this.dependencies.model.stream(request, run.signal)) {
        switch (event.type) {
          case "text.delta":
            run.state.assistantText += event.text;
            if (!run.structuredOutput) yield run.event("message.delta", { content: event.text });
            break;
          case "usage":
            run.addUsage(event.usage);
            this.dependencies.onUsage?.(run.input, event.usage);
            break;
          case "tool.calls":
            calls.push(...event.calls);
            if (calls.length > 0) return { kind: "tools", calls };
            return { kind: "answer" };
          case "done":
            return { kind: "answer" };
        }
      }
    } catch (error) {
      if (error instanceof ModelInterruptedError || run.signal.aborted) {
        let pendingToolCalls: ToolCall[] = [];
        if (error instanceof ModelInterruptedError) pendingToolCalls = error.toolCalls;
        yield* run.stop({ pendingToolCalls });
        return { kind: "stopped" };
      }
      throw error;
    }
    // Some providers close the stream without an explicit done event.
    return { kind: "answer" };
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
