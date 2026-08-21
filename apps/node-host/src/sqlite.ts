import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { EntryId, RunId, SessionId } from "@anomalo/contracts";

import { systemClock, type Clock } from "./clock.js";
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
import type { SessionRepository } from "./session.js";

export const SESSION_V2_SCHEMA_VERSION = 2;

const SESSION_V2_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
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
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  active_skills_json TEXT NOT NULL DEFAULT '[]',
  active_mcp_servers_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS session_web_traces (
  trace_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
  run_id TEXT,
  tool_call_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_runs (
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
  ON session_runs(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_checkpoints_session
  ON run_checkpoints(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_web_traces_session_created
  ON session_web_traces(session_id, created_at DESC);
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
      INSERT INTO session_runs(
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
        "UPDATE session_runs SET status = 'paused', last_entry_id = COALESCE(last_entry_id, ?) WHERE run_id = ?",
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
        UPDATE session_runs
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
      UPDATE session_runs
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
    }));
  }

  async setResources(sessionId: SessionId, activeSkills: string[], activeMcpServers: string[]): Promise<void> {
    this.ensureSession(sessionId);
    this.db.prepare(`
      INSERT INTO session_resources(session_id, active_skills_json, active_mcp_servers_json)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        active_skills_json = excluded.active_skills_json,
        active_mcp_servers_json = excluded.active_mcp_servers_json
    `).run(sessionId, JSON.stringify([...new Set(activeSkills)].sort()), JSON.stringify([...new Set(activeMcpServers)].sort()));
  }

  async appendWebTrace(sessionId: SessionId, trace: Record<string, unknown>): Promise<void> {
    this.ensureSession(sessionId);
    const traceId = typeof trace.id === "string" && trace.id ? trace.id : this.ids.entryId();
    this.db.prepare(`
      INSERT OR REPLACE INTO session_web_traces(
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
    if (legacyTableExists(this.db)) migrateLegacySession(this.db, sessionId, this.clock);
    const migrated = this.db.prepare(
      "SELECT session_id FROM agent_sessions WHERE session_id = ?",
    ).get(sessionId);
    if (!migrated) {
      const now = this.clock.now();
      this.db.prepare(`
        INSERT INTO agent_sessions(session_id, created_at, updated_at) VALUES (?, ?, ?)
      `).run(sessionId, now, now);
    }
    this.ensureResources(sessionId);
  }

  private ensureResources(sessionId: SessionId): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO session_resources(session_id) VALUES (?)",
    ).run(sessionId);
  }

  private sessionLeaf(sessionId: SessionId): string | null {
    const row = this.db.prepare(
      "SELECT active_leaf_entry_id FROM agent_sessions WHERE session_id = ?",
    ).get(sessionId) as Row | undefined;
    return (row?.active_leaf_entry_id as string | null | undefined) ?? null;
  }

  private readSnapshot(sessionId: SessionId): SessionSnapshot {
    const session = this.db.prepare(`
      SELECT session_id, title, search_mode, metadata_json, active_leaf_entry_id
      FROM agent_sessions WHERE session_id = ?
    `).get(sessionId) as Row;
    const resources = this.db.prepare(`
      SELECT active_skills_json, active_mcp_servers_json
      FROM session_resources WHERE session_id = ?
    `).get(sessionId) as Row | undefined;
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
      activeSkills: parseStringArray(resources?.active_skills_json),
      activeMcpServers: parseStringArray(resources?.active_mcp_servers_json),
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
      SELECT payload_json FROM session_web_traces
      WHERE session_id = ? ORDER BY created_at ASC, trace_id ASC
    `).all(sessionId) as Row[]).map((row) => parseObject(row.payload_json));
  }
}

export type MigrationError = { sessionId: string; error: string };
export type SessionMigrationReport = {
  dryRun: boolean;
  legacySessions: number;
  migratedSessions: number;
  skippedSessions: number;
  errors: MigrationError[];
  sourceHash: string;
};

export function migrateLegacyDatabase(
  dbPath: string,
  options: { dryRun?: boolean; clock?: Clock } = {},
): SessionMigrationReport {
  const dryRun = options.dryRun ?? false;
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    return { dryRun, legacySessions: 0, migratedSessions: 0, skippedSessions: 0, errors: [], sourceHash: hashJson([]) };
  }
  const db = new DatabaseSync(dbPath);
  const clock = options.clock ?? systemClock;
  try {
    if (!legacyTableExists(db)) {
      return { dryRun, legacySessions: 0, migratedSessions: 0, skippedSessions: 0, errors: [], sourceHash: hashJson([]) };
    }
    const rows = db.prepare("SELECT * FROM sessions ORDER BY session_id").all() as Row[];
    const report: SessionMigrationReport = {
      dryRun,
      legacySessions: rows.length,
      migratedSessions: 0,
      skippedSessions: 0,
      errors: [],
      sourceHash: hashJson(rows),
    };
    if (dryRun) return report;
    initializeSessionV2Database(db, clock);
    for (const row of rows) {
      const sessionId = String(row.session_id);
      try {
        if (db.prepare("SELECT 1 FROM agent_sessions WHERE session_id = ?").get(sessionId)) {
          report.skippedSessions += 1;
          continue;
        }
        migrateLegacyRow(db, row, clock);
        report.migratedSessions += 1;
      } catch (error) {
        report.errors.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  } finally {
    db.close();
  }
}

function migrateLegacySession(db: DatabaseSync, sessionId: SessionId, clock: Clock): void {
  const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Row | undefined;
  if (!row) return;
  if (db.prepare("SELECT 1 FROM agent_sessions WHERE session_id = ?").get(sessionId)) return;
  migrateLegacyRow(db, row, clock);
}

function migrateLegacyRow(db: DatabaseSync, row: Row, clock: Clock): void {
  const sessionId = String(row.session_id);
  const now = String(row.updated_at || clock.now());
  const messages = parseArray(row.messages_json);
  const checkpoint = parseNullableObject(row.checkpoint_json);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO agent_sessions(session_id, title, search_mode, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?)
    `).run(sessionId, String(row.title || firstTitle(messages)), String(row.search_mode || "diy"), now, now);
    db.prepare("INSERT INTO session_resources(session_id, active_skills_json, active_mcp_servers_json) VALUES (?, ?, ?)").run(
      sessionId,
      JSON.stringify(parseArray(row.active_skills_json)),
      JSON.stringify(parseArray(row.active_mcp_servers_json)),
    );
    let parent: string | null = null;
    for (const [index, message] of messages.entries()) {
      if (!message || typeof message !== "object") continue;
      const payload = message as Record<string, unknown>;
      const entryId = `legacy-${hashJson({ sessionId, index, payload }).slice(0, 24)}`;
      db.prepare(`
        INSERT INTO session_entries(entry_id, session_id, parent_entry_id, kind, role, payload_json, created_at)
        VALUES (?, ?, ?, 'message', ?, ?, ?)
      `).run(entryId, sessionId, parent, typeof payload.role === "string" ? payload.role : null, JSON.stringify(payload), now);
      parent = entryId;
    }
    db.prepare("UPDATE agent_sessions SET active_leaf_entry_id = ? WHERE session_id = ?").run(parent, sessionId);
    if (checkpoint) {
      const runId = String(checkpoint.run_id || `legacy-run-${sessionId}`);
      const checkpointMessages = parseArray(checkpoint.messages);
      db.prepare(`
        INSERT INTO session_runs(run_id, session_id, status, last_entry_id, config_json, started_at)
        VALUES (?, ?, 'paused', ?, '{}', ?)
      `).run(runId, sessionId, parent, now);
      db.prepare(`
        INSERT INTO run_checkpoints(run_id, session_id, reason, iteration, state_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        sessionId,
        String(checkpoint.reason || "stopped"),
        Number(checkpoint.iteration || 0),
        JSON.stringify({
          promptProfile: String(checkpoint.prompt_profile || "agent"),
          originalUserContent: String(checkpoint.user_content || ""),
          currentUserMessage: { role: "user", content: "Continue the interrupted task from the saved context." },
          assistantText: "",
          pendingToolCalls: [],
          completedToolCallIds: [],
          loopMessages: checkpointMessages,
          bootstrapContext: parseArray(checkpoint.bootstrap_context),
          ...(checkpoint.response_format ? { responseFormat: checkpoint.response_format } : {}),
          model: "legacy",
          searchMode: String(row.search_mode || "diy"),
        }),
        now,
        now,
      );
    }
    for (const trace of parseArray(row.web_traces_json)) {
      if (!trace || typeof trace !== "object") continue;
      const payload = trace as Record<string, unknown>;
      const traceId = typeof payload.id === "string" ? payload.id : `legacy-trace-${hashJson(payload).slice(0, 24)}`;
      db.prepare(`
        INSERT OR IGNORE INTO session_web_traces(trace_id, session_id, run_id, tool_call_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(traceId, sessionId, stringOrNull(payload.run_id), stringOrNull(payload.tool_call_id), JSON.stringify(payload), String(payload.timestamp || now));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function checkpointFromRow(row: Row): SessionCheckpoint {
  return {
    runId: row.run_id as RunId,
    sessionId: row.session_id as SessionId,
    reason: String(row.reason),
    iteration: Number(row.iteration),
    state: parseObject(row.state_json) as SessionCheckpoint["state"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function legacyTableExists(db: DatabaseSync): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
  ).get());
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

function parseNullableObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = parseObject(value);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: unknown): string[] {
  return parseArray(value).filter((item): item is string => typeof item === "string");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstTitle(messages: unknown[]): string {
  const message = messages.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).role === "user" && typeof (item as Record<string, unknown>).content === "string");
  const content = message && typeof message === "object" ? String((message as Record<string, unknown>).content || "").trim() : "";
  return content.slice(0, 120) || "Untitled conversation";
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
