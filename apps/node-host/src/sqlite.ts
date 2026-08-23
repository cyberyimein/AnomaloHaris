import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { EntryId, RunId, SessionId } from "@anomalo/contracts";

import { systemClock, type Clock } from "./clock.js";
import { randomIds, type IdFactory } from "./ids.js";
import type {
  AgentPolicy,
  FailedRunRecord,
  FinishedRunRecord,
  ModelMessage,
  NewRunRecord,
  NewSessionEntry,
  ResumableRun,
  ResponseFormat,
  SessionCheckpoint,
  SessionListQuery,
  SessionSnapshot,
  SessionSummary,
  ToolCall,
} from "./types.js";
import type { SessionRepository } from "./session.js";
import type { PluginLock } from "./plugin-catalog.js";

export const SESSION_V2_SCHEMA_VERSION = 2;

const SESSION_V2_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  title TEXT NOT NULL DEFAULT 'Untitled conversation',
  search_mode TEXT NOT NULL DEFAULT 'diy',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  active_leaf_entry_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_entries (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  parent_entry_id TEXT REFERENCES session_entries(entry_id) ON DELETE SET NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'compaction', 'system', 'event')),
  role TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_resources (
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY(session_id, resource_type, resource_name)
);
CREATE TABLE IF NOT EXISTS web_traces (
  trace_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  run_id TEXT,
  tool_call_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished', 'error', 'stopped')),
  start_entry_id TEXT,
  last_entry_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS run_checkpoints (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_entries_session_created
  ON session_entries(session_id, created_at, entry_id);
CREATE INDEX IF NOT EXISTS idx_session_entries_parent
  ON session_entries(parent_entry_id);
CREATE INDEX IF NOT EXISTS idx_session_runs_session_started
  ON runs(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status
  ON runs(status);
CREATE INDEX IF NOT EXISTS idx_run_checkpoints_session
  ON run_checkpoints(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_traces_session_created
  ON web_traces(session_id, created_at DESC);
`;

type Row = Record<string, unknown>;

export function initializeSessionV2Database(db: DatabaseSync, clock: Clock = systemClock): void {
  db.exec(SESSION_V2_SCHEMA);
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
  ).run(SESSION_V2_SCHEMA_VERSION, clock.now());
}

export class SqliteSessionAdapter implements SessionRepository {
  readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly ownsDatabase: boolean;

  constructor(
    dbPath: string,
    options: { clock?: Clock; ids?: IdFactory; database?: DatabaseSync } = {},
  ) {
    if (options.database) {
      this.db = options.database;
      this.ownsDatabase = false;
    } else {
      if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.ownsDatabase = true;
    }
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIds;
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = DELETE;");
    initializeSessionV2Database(this.db, this.clock);
  }

  async open(sessionId: SessionId): Promise<SessionSnapshot> {
    this.ensureSession(sessionId);
    return this.readSnapshot(sessionId);
  }

  async append(entries: NewSessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        this.ensureSession(entry.sessionId);
        this.db.prepare(`
          INSERT INTO session_entries(
            entry_id, session_id, parent_entry_id, run_id, kind, role, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entry.entryId,
          entry.sessionId,
          entry.parentEntryId ?? null,
          entry.runId ?? null,
          entry.kind,
          entry.role ?? null,
          JSON.stringify(entry.payload),
          entry.createdAt,
        );
        this.db.prepare(`
          UPDATE agent_sessions
          SET active_leaf_entry_id = ?, updated_at = ?,
              title = CASE
                WHEN title = 'Untitled conversation' AND ? = 'user'
                  AND length(trim(json_extract(?, '$.content'))) > 0
                THEN substr(trim(json_extract(?, '$.content')), 1, 120)
                ELSE title
              END
          WHERE session_id = ?
        `).run(
          entry.entryId,
          entry.createdAt,
          entry.role ?? null,
          JSON.stringify(entry.payload),
          JSON.stringify(entry.payload),
          entry.sessionId,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async setActiveLeaf(sessionId: SessionId, entryId: EntryId): Promise<void> {
    this.ensureSession(sessionId);
    this.db.prepare(
      "UPDATE agent_sessions SET active_leaf_entry_id = ?, updated_at = ? WHERE session_id = ?",
    ).run(entryId, this.clock.now(), sessionId);
  }

  async beginRun(record: NewRunRecord): Promise<void> {
    this.ensureSession(record.sessionId);
    this.db.prepare(`
      INSERT INTO runs(
        run_id, session_id, status, start_entry_id, last_entry_id,
        config_json, started_at, ended_at, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        start_entry_id = excluded.start_entry_id,
        last_entry_id = excluded.last_entry_id,
        config_json = excluded.config_json,
        started_at = excluded.started_at,
        ended_at = NULL,
        error_code = NULL
    `).run(
      record.runId,
      record.sessionId,
      record.status,
      record.startEntryId ?? null,
      record.lastEntryId ?? null,
      JSON.stringify(record.config),
      record.startedAt,
    );
  }

  async checkpoint(record: SessionCheckpoint): Promise<void> {
    this.ensureSession(record.sessionId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO run_checkpoints(
          run_id, session_id, reason, iteration, state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          session_id = excluded.session_id,
          reason = excluded.reason,
          iteration = excluded.iteration,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).run(
        record.runId,
        record.sessionId,
        record.reason,
        record.iteration,
        JSON.stringify(record.state),
        record.createdAt,
        record.updatedAt,
      );
      this.db.prepare(
        "UPDATE runs SET status = 'paused', last_entry_id = COALESCE(last_entry_id, ?) WHERE run_id = ?",
      ).run(this.sessionLeaf(record.sessionId), record.runId);
      this.db.prepare(
        "UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?",
      ).run(record.updatedAt, record.sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async finishRun(record: FinishedRunRecord): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE runs
        SET status = 'finished', last_entry_id = ?, ended_at = ?, error_code = NULL
        WHERE run_id = ? AND session_id = ?
      `).run(record.lastEntryId ?? null, record.endedAt, record.runId, record.sessionId);
      this.db.prepare(
        "DELETE FROM run_checkpoints WHERE run_id = ? AND session_id = ?",
      ).run(record.runId, record.sessionId);
      this.db.prepare(
        "UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?",
      ).run(record.endedAt, record.sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async failRun(record: FailedRunRecord): Promise<void> {
    const status = record.errorCode === "run_stopped" ? "stopped" : "error";
    this.db.prepare(`
      UPDATE runs
      SET status = ?, last_entry_id = ?, ended_at = ?, error_code = ?
      WHERE run_id = ? AND session_id = ?
    `).run(status, record.lastEntryId ?? null, record.endedAt, record.errorCode, record.runId, record.sessionId);
    this.db.prepare(
      "UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?",
    ).run(record.endedAt, record.sessionId);
  }

  async resume(sessionId: SessionId): Promise<ResumableRun> {
    this.ensureSession(sessionId);
    const row = this.db.prepare(`
      SELECT run_id, session_id, reason, iteration, state_json, created_at, updated_at
      FROM run_checkpoints
      WHERE session_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(sessionId) as Row | undefined;
    if (!row) throw new Error("checkpoint_not_found");
    return { runId: row.run_id as RunId, sessionId, checkpoint: checkpointFromRow(row) };
  }

  async list(query: SessionListQuery = {}): Promise<SessionSummary[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    const rows = this.db.prepare(`
      SELECT s.session_id, s.title, s.updated_at,
        json_extract(s.metadata_json, '$.preset_model_ref') AS preset_model_ref,
        EXISTS(SELECT 1 FROM run_checkpoints c WHERE c.session_id = s.session_id) AS can_resume,
        (
          SELECT count(*) FROM session_entries e
          WHERE e.session_id = s.session_id
            AND e.kind = 'message'
            AND e.role IN ('user', 'assistant')
            AND length(trim(COALESCE(json_extract(e.payload_json, '$.content'), ''))) > 0
        ) AS message_count
      FROM agent_sessions s
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(limit) as Row[];
    return rows.map((row) => ({
      sessionId: row.session_id as SessionId,
      title: String(row.title || "Untitled conversation"),
      messageCount: Number(row.message_count ?? 0),
      updatedAt: String(row.updated_at),
      canResume: Boolean(row.can_resume),
      ...(typeof row.preset_model_ref === "string" ? { presetModelRef: row.preset_model_ref } : {}),
    }));
  }

  async setResources(sessionId: SessionId, activeSkills: string[], activeMcpServers: string[]): Promise<void> {
    this.ensureSession(sessionId);
    this.db.prepare("DELETE FROM session_resources WHERE session_id = ?").run(sessionId);
    const insert = this.db.prepare(
      "INSERT INTO session_resources(session_id, resource_type, resource_name, active) VALUES (?, ?, ?, 1)",
    );
    for (const name of [...new Set(activeSkills)].sort()) insert.run(sessionId, "skill", name);
    for (const name of [...new Set(activeMcpServers)].sort()) insert.run(sessionId, "mcp", name);
  }

  async setSearchMode(sessionId: SessionId, searchMode: string): Promise<void> {
    this.ensureSession(sessionId);
    this.db.prepare(
      "UPDATE agent_sessions SET search_mode = ?, updated_at = ? WHERE session_id = ?",
    ).run(searchMode, this.clock.now(), sessionId);
  }

  async setPresetModel(sessionId: SessionId, modelRef: string): Promise<void> {
    this.ensureSession(sessionId);
    const current = this.readSnapshot(sessionId);
    const metadata = { ...current.metadata, preset_model_ref: modelRef };
    this.db.prepare(
      "UPDATE agent_sessions SET metadata_json = ?, updated_at = ? WHERE session_id = ?",
    ).run(JSON.stringify(metadata), this.clock.now(), sessionId);
  }

  async appendWebTrace(sessionId: SessionId, trace: Record<string, unknown>): Promise<void> {
    this.ensureSession(sessionId);
    const traceId = typeof trace.id === "string" && trace.id ? trace.id : this.ids.entryId();
    this.db.prepare(`
      INSERT OR REPLACE INTO web_traces(
        trace_id, session_id, run_id, tool_call_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      traceId,
      sessionId,
      stringOrNull(trace.run_id),
      stringOrNull(trace.tool_call_id),
      JSON.stringify({ ...trace, timestamp: trace.timestamp ?? this.clock.now() }),
      String(trace.timestamp ?? this.clock.now()),
    );
  }

  async getCheckpoint(sessionId: SessionId): Promise<SessionCheckpoint | undefined> {
    try {
      return (await this.resume(sessionId)).checkpoint;
    } catch (error) {
      if (error instanceof Error && error.message === "checkpoint_not_found") return undefined;
      throw error;
    }
  }

  close(): void {
    if (this.ownsDatabase && this.db.isOpen) this.db.close();
  }

  private ensureSession(sessionId: SessionId): void {
    const existing = this.db.prepare(
      "SELECT session_id FROM agent_sessions WHERE session_id = ?",
    ).get(sessionId);
    if (existing) {
      this.ensureResources(sessionId);
      return;
    }
    const now = this.clock.now();
    this.db.prepare(`
      INSERT INTO agent_sessions(session_id, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run(sessionId, SESSION_V2_SCHEMA_VERSION, now, now);
  }

  private ensureResources(sessionId: SessionId): void {
    void sessionId;
  }

  private sessionLeaf(sessionId: SessionId): string | null {
    const row = this.db.prepare(
      "SELECT active_leaf_entry_id FROM agent_sessions WHERE session_id = ?",
    ).get(sessionId) as Row | undefined;
    return (row?.active_leaf_entry_id as string | null | undefined) ?? null;
  }

  private readSnapshot(sessionId: SessionId): SessionSnapshot {
    const session = this.db.prepare(`
      SELECT session_id, schema_version, title, search_mode, metadata_json, active_leaf_entry_id
      FROM agent_sessions WHERE session_id = ?
    `).get(sessionId) as Row;
    const resources = this.db.prepare(`
      SELECT resource_type, resource_name
      FROM session_resources WHERE session_id = ? AND active = 1
      ORDER BY resource_type, resource_name
    `).all(sessionId) as Row[];
    const updated = this.db.prepare(
      "SELECT updated_at FROM agent_sessions WHERE session_id = ?",
    ).get(sessionId) as Row;
    const checkpointRow = this.db.prepare(`
      SELECT run_id, session_id, reason, iteration, state_json, created_at, updated_at
      FROM run_checkpoints WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId) as Row | undefined;
    return {
      sessionId,
      schemaVersion: SESSION_V2_SCHEMA_VERSION,
      title: String(session.title || "Untitled conversation"),
      ...(session.active_leaf_entry_id ? { activeLeafEntryId: session.active_leaf_entry_id as EntryId } : {}),
      searchMode: String(session.search_mode || "diy"),
      metadata: parseObject(session.metadata_json),
      messages: this.readMessageChain(sessionId, session.active_leaf_entry_id as string | null | undefined),
      activeSkills: resources.filter((row) => row.resource_type === "skill").map((row) => String(row.resource_name)),
      activeMcpServers: resources.filter((row) => row.resource_type === "mcp").map((row) => String(row.resource_name)),
      webTraces: this.readWebTraces(sessionId),
      ...(checkpointRow ? { checkpoint: checkpointFromRow(checkpointRow) } : {}),
      updatedAt: String(updated.updated_at),
    } as SessionSnapshot & { updatedAt: string };
  }

  private readMessageChain(sessionId: SessionId, leaf: string | null | undefined): Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; [key: string]: unknown }> {
    const rows = this.db.prepare(`
      SELECT entry_id, parent_entry_id, kind, role, payload_json
      FROM session_entries WHERE session_id = ?
    `).all(sessionId) as Row[];
    const byId = new Map(rows.map((row) => [String(row.entry_id), row]));
    let current = leaf ?? (rows.at(-1)?.entry_id as string | undefined);
    const chain: Row[] = [];
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const row = byId.get(current);
      if (!row) break;
      chain.push(row);
      current = row.parent_entry_id as string | undefined;
    }
    chain.reverse();
    return chain.flatMap((row) => {
      if (row.kind !== "message" || typeof row.role !== "string") return [];
      const payload = parseObject(row.payload_json);
      if (typeof payload.content !== "string") return [];
      return [{ role: row.role as "system" | "user" | "assistant" | "tool", content: payload.content, ...payload }];
    });
  }

  private readWebTraces(sessionId: SessionId): Record<string, unknown>[] {
    return (this.db.prepare(`
      SELECT payload_json FROM web_traces
      WHERE session_id = ? ORDER BY created_at ASC, trace_id ASC
    `).all(sessionId) as Row[]).map((row) => parseObject(row.payload_json));
  }
}

function checkpointFromRow(row: Row): SessionCheckpoint {
  const raw = parseObject(row.state_json);
  const responseFormat = parseResponseFormat(raw.responseFormat);
  const model = stringValue(raw.model);
  const systemPrompt = stringValue(raw.systemPrompt);
  const presetModelRef = stringValue(raw.presetModelRef);
  const allowedToolNames = parseStringArray(raw.allowedToolNames);
  const allowedPluginIds = parseStringArray(raw.allowedPluginIds);
  const allowedPluginLocks = parsePluginLocks(raw.allowedPluginLocks);
  const policy = parseAgentPolicy(raw.policy);
  const toolProtocol = stringValue(raw.toolProtocol);
  return {
    runId: row.run_id as RunId,
    sessionId: row.session_id as SessionId,
    reason: String(row.reason),
    iteration: Number(row.iteration),
    state: {
      promptProfile: stringValue(raw.promptProfile) ?? "agent",
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      originalUserContent: stringValue(raw.originalUserContent) ?? "",
      currentUserMessage: parseCurrentUserMessage(raw.currentUserMessage),
      assistantText: stringValue(raw.assistantText) ?? "",
      pendingToolCalls: parseToolCalls(raw.pendingToolCalls),
      completedToolCallIds: parseStringArray(raw.completedToolCallIds),
      loopMessages: parseModelMessages(raw.loopMessages),
      bootstrapContext: parseRecordArray(raw.bootstrapContext),
      ...(responseFormat === undefined ? {} : { responseFormat }),
      ...(allowedToolNames.length === 0 && raw.allowedToolNames === undefined
        ? {}
        : { allowedToolNames }),
      ...(model === undefined ? {} : { model }),
      ...(presetModelRef === undefined ? {} : { presetModelRef: presetModelRef as SessionCheckpoint["state"]["presetModelRef"] }),
      ...(toolProtocol === undefined ? {} : { toolProtocol: toolProtocol as SessionCheckpoint["state"]["toolProtocol"] }),
      ...(policy === undefined ? {} : { policy }),
      ...(allowedPluginIds.length === 0 && raw.allowedPluginIds === undefined
        ? {}
        : { allowedPluginIds }),
      ...(allowedPluginLocks.length === 0 ? {} : { allowedPluginLocks }),
      ...(typeof raw.temperature === "number" ? { temperature: raw.temperature } : {}),
      searchMode: stringValue(raw.searchMode) ?? "diy",
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseCurrentUserMessage(value: unknown): ModelMessage {
  const messages = parseModelMessages([value]);
  return messages[0] ?? { role: "user", content: "Continue the interrupted task from the saved context." };
}

function parseModelMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const role = item.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return [];
    return [{
      ...item,
      role,
      content: typeof item.content === "string" ? item.content : "",
    } as ModelMessage];
  });
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return [];
    const argumentsValue = isRecord(item.arguments) ? item.arguments : {};
    return [{ id: item.id, name: item.name, arguments: argumentsValue } as ToolCall];
  });
}

function parseRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseResponseFormat(value: unknown): ResponseFormat | undefined {
  return isRecord(value) && typeof value.type === "string" ? value as ResponseFormat : undefined;
}

function parseAgentPolicy(value: unknown): AgentPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const maxToolIterations = policyInteger(value, "maxToolIterations", 1, 1_000);
  const runTimeoutMs = policyInteger(value, "runTimeoutMs", 1_000, 3_600_000);
  const bootstrapToolTimeoutMs = policyInteger(value, "bootstrapToolTimeoutMs", 1, 120_000);
  const toolTimeoutMs = policyInteger(value, "toolTimeoutMs", 1, 600_000);
  const toolExecution = value.toolExecution ?? "sequential";
  if (maxToolIterations === undefined || runTimeoutMs === undefined || bootstrapToolTimeoutMs === undefined || toolTimeoutMs === undefined) return undefined;
  if (toolExecution !== "sequential") return undefined;
  const temperature = typeof value.temperature === "number" && Number.isFinite(value.temperature) ? value.temperature : undefined;
  const responseFormat = parseResponseFormat(value.responseFormat);
  const searchMode = typeof value.searchMode === "string"
    ? value.searchMode
    : undefined;
  return {
    maxToolIterations,
    runTimeoutMs,
    bootstrapToolTimeoutMs,
    toolTimeoutMs,
    structuredOutputRetryCount: 1,
    toolExecution: "sequential",
    ...(temperature === undefined ? {} : { temperature }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(searchMode === undefined ? {} : { searchMode: searchMode as AgentPolicy["searchMode"] }),
  };
}

function policyInteger(value: Record<string, unknown>, key: string, minimum: number, maximum: number): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum
    ? candidate
    : undefined;
}

function parsePluginLocks(value: unknown): PluginLock[] {
  return parseArray(value).flatMap((item) => {
    if (!isRecord(item)) return [];
    if (typeof item.id !== "string" || typeof item.version !== "string" || typeof item.package !== "string" || typeof item.entry !== "string") return [];
    if (typeof item.compatibility !== "string" || typeof item.packageHash !== "string" || typeof item.manifestHash !== "string") return [];
    const permissions = Array.isArray(item.permissions)
      ? item.permissions.filter((permission): permission is PluginLock["permissions"][number] => typeof permission === "string")
      : [];
    return [{
      id: item.id,
      version: item.version,
      package: item.package,
      entry: item.entry,
      compatibility: item.compatibility as PluginLock["compatibility"],
      permissions,
      ...(Array.isArray(item.capabilities) ? { capabilities: item.capabilities.filter((capability): capability is string => typeof capability === "string") } : {}),
      packageHash: item.packageHash,
      manifestHash: item.manifestHash,
    }];
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseStringArray(value: unknown): string[] {
  return parseArray(value).filter((item): item is string => typeof item === "string");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
