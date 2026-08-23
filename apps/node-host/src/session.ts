import type { EntryId, RunId, SessionId } from "@anomalo/contracts";

import type { Clock } from "./clock.js";
import { randomIds, type IdFactory } from "./ids.js";
import type {
  FailedRunRecord,
  FinishedRunRecord,
  NewRunRecord,
  NewSessionEntry,
  ResumableRun,
  SessionCheckpoint,
  SessionListQuery,
  SessionSnapshot,
  SessionSummary,
} from "./types.js";
import { systemClock } from "./clock.js";
import { DEFAULT_SEARCH_MODE, isSearchMode } from "./search-mode.js";

export interface SessionRepository {
  open(sessionId: SessionId): Promise<SessionSnapshot>;
  append(entries: NewSessionEntry[]): Promise<void>;
  setActiveLeaf(sessionId: SessionId, entryId: EntryId): Promise<void>;
  beginRun(record: NewRunRecord): Promise<void>;
  checkpoint(record: SessionCheckpoint): Promise<void>;
  finishRun(record: FinishedRunRecord): Promise<void>;
  failRun(record: FailedRunRecord): Promise<void>;
  setSearchMode?(sessionId: SessionId, searchMode: string): Promise<void>;
  setResources?(sessionId: SessionId, activeSkills: string[], activeMcpServers: string[]): Promise<void>;
  setPresetModel?(sessionId: SessionId, modelRef: string): Promise<void>;
  resume(sessionId: SessionId): Promise<ResumableRun>;
  list(query?: SessionListQuery): Promise<SessionSummary[]>;
}

type StoredSession = {
  snapshot: SessionSnapshot;
  entryParents: Map<EntryId, EntryId | undefined>;
  runs: Map<RunId, NewRunRecord>;
};

export class InMemorySessionAdapter implements SessionRepository {
  private readonly sessions = new Map<SessionId, StoredSession>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly ids: IdFactory = randomIds,
    private readonly defaultSearchMode: string = DEFAULT_SEARCH_MODE,
  ) {}

  async open(sessionId: SessionId): Promise<SessionSnapshot> {
    const existing = this.sessions.get(sessionId);
    if (existing) return structuredClone(existing.snapshot);
    const snapshot: SessionSnapshot = {
      sessionId,
      schemaVersion: 2,
      title: "Untitled conversation",
      searchMode: isSearchMode(this.defaultSearchMode) ? this.defaultSearchMode : DEFAULT_SEARCH_MODE,
      metadata: {},
      messages: [],
      activeSkills: [],
      activeMcpServers: [],
      webTraces: [],
    };
    this.sessions.set(sessionId, { snapshot, entryParents: new Map(), runs: new Map() });
    return structuredClone(snapshot);
  }

  async append(entries: NewSessionEntry[]): Promise<void> {
    for (const entry of entries) {
      const stored = await this.ensure(entry.sessionId);
      stored.entryParents.set(entry.entryId, entry.parentEntryId);
      if (entry.kind === "message" && entry.role && typeof entry.payload.content === "string") {
        stored.snapshot.messages.push({
          role: entry.role,
          content: entry.payload.content,
          ...structuredClone(entry.payload),
        });
        stored.snapshot.title = firstUserTitle(stored.snapshot.messages);
      }
      stored.snapshot.activeLeafEntryId = entry.entryId;
    }
  }

  async setActiveLeaf(sessionId: SessionId, entryId: EntryId): Promise<void> {
    const stored = await this.ensure(sessionId);
    stored.snapshot.activeLeafEntryId = entryId;
  }

  async beginRun(record: NewRunRecord): Promise<void> {
    const stored = await this.ensure(record.sessionId);
    stored.runs.set(record.runId, structuredClone(record));
  }

  async checkpoint(record: SessionCheckpoint): Promise<void> {
    const stored = await this.ensure(record.sessionId);
    stored.snapshot.checkpoint = structuredClone(record);
    const run = stored.runs.get(record.runId);
    if (run) run.status = "paused";
  }

  async finishRun(record: FinishedRunRecord): Promise<void> {
    const stored = await this.ensure(record.sessionId);
    const run = stored.runs.get(record.runId);
    if (run) {
      run.status = "finished";
      run.lastEntryId = record.lastEntryId;
    }
    delete stored.snapshot.checkpoint;
  }

  async failRun(record: FailedRunRecord): Promise<void> {
    const stored = await this.ensure(record.sessionId);
    const run = stored.runs.get(record.runId);
    if (run) {
      run.status = record.errorCode === "run_stopped" ? "stopped" : "error";
      run.lastEntryId = record.lastEntryId;
    }
  }

  async resume(sessionId: SessionId): Promise<ResumableRun> {
    const stored = await this.ensure(sessionId);
    if (!stored.snapshot.checkpoint) throw new Error("checkpoint_not_found");
    return {
      runId: stored.snapshot.checkpoint.runId,
      sessionId,
      checkpoint: structuredClone(stored.snapshot.checkpoint),
    };
  }

  async list(query: SessionListQuery = {}): Promise<SessionSummary[]> {
    const values = [...this.sessions.values()].map(({ snapshot }) => ({
      sessionId: snapshot.sessionId,
      title: snapshot.title,
      messageCount: snapshot.messages.filter((message) => message.role === "user" || message.role === "assistant").length,
      updatedAt: this.clock.now(),
      canResume: Boolean(snapshot.checkpoint),
      ...(typeof snapshot.metadata.preset_model_ref === "string" ? { presetModelRef: snapshot.metadata.preset_model_ref } : {}),
    }));
    return values.slice(0, query.limit ?? 100);
  }

  async setResources(sessionId: SessionId, activeSkills: string[], activeMcpServers: string[]): Promise<void> {
    const stored = await this.ensure(sessionId);
    stored.snapshot.activeSkills = [...new Set(activeSkills)].sort();
    stored.snapshot.activeMcpServers = [...new Set(activeMcpServers)].sort();
  }

  async setSearchMode(sessionId: SessionId, searchMode: string): Promise<void> {
    const stored = await this.ensure(sessionId);
    stored.snapshot.searchMode = searchMode;
  }

  async setPresetModel(sessionId: SessionId, modelRef: string): Promise<void> {
    const stored = await this.ensure(sessionId);
    stored.snapshot.metadata = { ...stored.snapshot.metadata, preset_model_ref: modelRef };
  }

  async appendWebTrace(sessionId: SessionId, trace: Record<string, unknown>): Promise<void> {
    const stored = await this.ensure(sessionId);
    stored.snapshot.webTraces.push({ ...structuredClone(trace), timestamp: trace.timestamp ?? this.clock.now() });
  }

  async getCheckpoint(sessionId: SessionId): Promise<SessionCheckpoint | undefined> {
    return (await this.ensure(sessionId)).snapshot.checkpoint
      ? structuredClone((await this.ensure(sessionId)).snapshot.checkpoint)
      : undefined;
  }

  private async ensure(sessionId: SessionId): Promise<StoredSession> {
    await this.open(sessionId);
    return this.sessions.get(sessionId)!;
  }
}

function firstUserTitle(messages: SessionSnapshot["messages"]): string {
  const user = messages.find((message) => message.role === "user" && message.content.trim());
  return user?.content.trim().slice(0, 120) || "Untitled conversation";
}
