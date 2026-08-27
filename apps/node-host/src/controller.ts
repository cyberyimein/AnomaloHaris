import type { AgentEvent, RunId, SessionId } from "@anomaloharis/contracts";

import { randomIds, type IdFactory } from "./ids.js";
import type { AgentCore } from "./core.js";
import type { AgentRunInput } from "./types.js";

export type StartRunRequest = Omit<AgentRunInput, "runId"> & {
  runId?: RunId;
  /** Internal Host authorization for a Session already bound to a retired model version. */
  allowRetiredPresetModel?: boolean;
};

export type StopResult = {
  stopped: boolean;
  runId?: RunId;
  reason: "user_stop" | "disconnect" | "no_active_run";
};

export class RunController {
  private readonly active = new Map<SessionId, { runId: RunId; abort: AbortController }>();

  constructor(private readonly core: AgentCore, private readonly ids: IdFactory = randomIds) {}

  async *start(request: StartRunRequest, parentSignal?: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.active.has(request.sessionId)) {
      yield errorEvent(request.sessionId, request.runId ?? this.ids.runId(), "run_already_active", "A run is already active for this session.");
      return;
    }
    const runId = request.runId ?? this.ids.runId();
    const abort = new AbortController();
    const onParentAbort = () => abort.abort(parentSignal?.reason);
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    this.active.set(request.sessionId, { runId, abort });
    try {
      yield* this.core.execute({ ...request, runId }, abort.signal);
    } finally {
      parentSignal?.removeEventListener("abort", onParentAbort);
      const current = this.active.get(request.sessionId);
      if (current?.runId === runId) this.active.delete(request.sessionId);
    }
  }

  async stop(sessionId: SessionId, reason: "user_stop" | "disconnect"): Promise<StopResult> {
    const active = this.active.get(sessionId);
    if (!active) return { stopped: false, reason: "no_active_run" };
    active.abort.abort(reason);
    return { stopped: true, runId: active.runId, reason };
  }

  status(sessionId: SessionId): { active: boolean; runId?: RunId } {
    const active = this.active.get(sessionId);
    return active ? { active: true, runId: active.runId } : { active: false };
  }

  hasActiveRun(sessionId: SessionId): boolean {
    return this.active.has(sessionId);
  }
}

function errorEvent(sessionId: SessionId, runId: RunId, errorCode: string, error: string): AgentEvent {
  return {
    schema_version: 1,
    type: "run.error",
    session_id: sessionId,
    run_id: runId,
    data: { error, error_code: errorCode },
    timestamp: new Date().toISOString(),
  };
}
