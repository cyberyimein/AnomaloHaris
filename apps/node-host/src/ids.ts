import { randomUUID } from "node:crypto";

import type { EntryId, RunId, SessionId, ToolCall } from "@anomaloharis/contracts";

export interface IdFactory {
  sessionId(): SessionId;
  runId(): RunId;
  entryId(): EntryId;
  toolCallId(): string;
}

export const randomIds: IdFactory = {
  sessionId: () => `session_${randomUUID().replaceAll("-", "")}` as SessionId,
  runId: () => `run_${randomUUID().replaceAll("-", "")}` as RunId,
  entryId: () => `entry_${randomUUID().replaceAll("-", "")}` as EntryId,
  toolCallId: () => `call_${randomUUID().replaceAll("-", "")}`,
};

export function normalizeToolCallIds(calls: ToolCall[], ids: IdFactory = randomIds): ToolCall[] {
  return calls.map((call) => ({ ...call, id: call.id || ids.toolCallId() }));
}
