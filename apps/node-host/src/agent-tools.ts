import { isDashboardBuddyTool } from "./buddy-tool-policy.js";
import type { ToolCall, ToolDefinition, ToolResult } from "@anomaloharis/contracts";

import type { ActiveResources, AgentRun } from "./agent-run.js";
import type { ToolRuntime } from "./tools.js";
import type { AgentEvent, BootstrapToolRequest } from "./types.js";

/** Startup tools run concurrently and complete before the first model request. */
export async function* runBootstrapTools(
  run: AgentRun,
  tools: ToolRuntime,
  definitions: BootstrapToolRequest[],
): AsyncGenerator<AgentEvent, string | undefined> {
  const calls = definitions.map((definition, index) => ({
    id: `bootstrap-${run.input.runId}-${index + 1}`,
    name: definition.name,
    resultKey: definition.resultKey ?? definition.name,
    arguments: definition.arguments ?? {},
    required: definition.required ?? true,
  }));
  for (const call of calls) {
    yield run.event("tool.started", {
      phase: "bootstrap", tool_call_id: call.id, tool: call.name,
      result_key: call.resultKey, arguments: call.arguments,
    });
  }
  const results = await Promise.all(calls.map(async (call) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(run.signal.reason);
    run.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort("bootstrap_timeout"), run.policy.bootstrapToolTimeoutMs);
    let result: ToolResult;
    try {
      result = await tools.call(
        { id: call.id, name: call.name, arguments: call.arguments },
        run.toolContext(run.initialResources, call.id),
        controller.signal,
      );
    } catch (error) {
      result = {
        name: call.name, ok: false, content: errorMessage(error),
        data: { error_type: "BootstrapToolError" },
      };
    } finally {
      clearTimeout(timer);
      run.signal.removeEventListener("abort", onAbort);
    }
    return { call, result };
  }));

  for (const { call, result } of results) {
    yield run.event(toolResultEventType(result), {
      phase: "bootstrap", tool_call_id: call.id, tool: call.name,
      result_key: call.resultKey, ok: result.ok, content: result.content, data: result.data,
    });
  }
  const failures: string[] = [];
  for (const { call, result } of results) {
    if (result.ok) {
      run.state.bootstrapContext.push({
        key: call.resultKey, tool: call.name, arguments: call.arguments, result: result.content,
      });
    } else if (call.required) {
      failures.push(`${call.name} (${call.resultKey}): ${result.content}`);
    }
  }
  if (failures.length > 0) return `Required bootstrap tool failed: ${failures.join("; ")}`;
  return undefined;
}

/** Model-selected tools run sequentially; return the interrupted call for checkpointing. */
export async function* executeToolCalls(
  run: AgentRun,
  tools: ToolRuntime,
  calls: ToolCall[],
  definitions: ToolDefinition[],
  resources: ActiveResources,
): AsyncGenerator<AgentEvent, ToolCall | undefined> {
  run.state.loopMessages.push({ role: "assistant", content: run.state.assistantText, tool_calls: calls });
  for (const call of calls) {
    const context = run.toolContext(resources, call.id);
    const hook = await run.toolCallHook(call);
    const effectiveCall = hook?.call ?? call;
    yield run.event("tool.started", {
      tool_call_id: effectiveCall.id, tool: effectiveCall.name, arguments: effectiveCall.arguments,
    });

    let result: ToolResult;
    if (hook?.allow === false) {
      result = {
        name: effectiveCall.name, ok: false, content: "Plugin policy denied this tool call.",
        data: { error_code: "plugin_failed" },
      };
    } else if (run.input.allowedToolNames && !run.input.allowedToolNames.has(effectiveCall.name)
      && !definitions.some(tool => tool.name === effectiveCall.name && isDashboardBuddyTool(tool))) {
      result = {
        name: effectiveCall.name, ok: false,
        content: `Tool is not enabled for this run: ${effectiveCall.name}`,
        data: { error_code: "tool_not_allowed" },
      };
    } else {
      try {
        const signal = AbortSignal.any([
          run.signal,
          AbortSignal.timeout(timeoutForTool(run.policy.toolTimeoutMs, definitions, effectiveCall.name)),
        ]);
        result = await tools.call(effectiveCall, context, signal);
      } catch (error) {
        // Tool failures are model input; they do not terminate the agent loop.
        result = { name: effectiveCall.name, ok: false, content: errorMessage(error), data: { error_type: "ToolError" } };
      }
    }
    const resultHook = await run.toolResultHook(effectiveCall, result);
    if (resultHook?.result) result = resultHook.result;
    await run.applyResourceAction(result);
    if (result.ok && result.image) run.attachToolImage(effectiveCall.id, result.image);
    run.state.loopMessages.push({
      role: "tool", tool_call_id: effectiveCall.id, name: effectiveCall.name, content: result.content,
    });
    yield run.event(toolResultEventType(result), {
      tool_call_id: effectiveCall.id, tool: effectiveCall.name,
      ok: result.ok, content: result.content, data: result.data,
    });
    // Keep the tool result before saving a stop checkpoint, as in normal execution.
    if (run.signal.aborted) return effectiveCall;
  }
  return undefined;
}

function toolResultEventType(result: ToolResult): "tool.finished" | "tool.error" {
  if (result.ok) return "tool.finished";
  return "tool.error";
}

/** A declared tool timeout may extend, but never shorten, the policy timeout. */
function timeoutForTool(policyTimeoutMs: number, definitions: ToolDefinition[], name: string): number {
  const declared = definitions.find((definition) => definition.name === name)?.timeout_ms;
  if (typeof declared !== "number" || !Number.isFinite(declared)) return policyTimeoutMs;
  return Math.max(policyTimeoutMs, Math.trunc(declared));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
