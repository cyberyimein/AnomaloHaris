import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  ExecutionRun,
  ExecutionRunEvent,
  ExecutionRunStatus,
  ExecutionRuntimeKind,
  ExecutionTarget,
  StopReason,
  WorkflowRunRequest,
} from "@anomaloharis/contracts";

import { randomIds, type IdFactory } from "./ids.js";
import { RuntimeCatalog } from "./runtime-catalog.js";

export type RuntimeEvent = {
  type: string;
  data?: Record<string, unknown>;
  terminal?: "succeeded" | "failed" | "stopped";
};

export type ResolvedExecutionTarget = {
  kind: ExecutionRuntimeKind;
  ref: string;
  hash: string;
  /** Internal authorization carried from the validated bound-session request. */
  allowRetired?: boolean;
};

export type RuntimeResolveOptions = {
  allowRetired?: boolean;
};

export type RunContext = {
  runId: string;
  parentRunId?: string;
  clientId: string;
  target: ResolvedExecutionTarget;
  metadata: Record<string, unknown>;
  permissions?: ReadonlySet<string>;
  signal: AbortSignal;
};

export type RunRequest = WorkflowRunRequest & {
  clientId: string;
  parentRunId?: string;
  permissions?: readonly string[];
};

export type StopResult = {
  stopped: boolean;
  runId: string;
  status: ExecutionRunStatus;
};

export type RecoveryResult = {
  runId: string;
  action: "requeued" | "failed" | "noop";
};

export interface ExecutionRuntimeAdapter {
  readonly kind: ExecutionRuntimeKind;
  readonly version: string;
  readonly packageHash: string;
  readonly capabilities: readonly string[];
  readonly consumesHostSlot: boolean;
  isHealthy(): boolean;
  resolve(ref: string, options?: RuntimeResolveOptions): ResolvedExecutionTarget;
  /** Called while the top-level execution row is in the same transaction. */
  prepareRun?(context: { runId: string; target: ResolvedExecutionTarget; request: RunRequest }): void;
  start(context: RunContext, input: unknown): AsyncIterable<RuntimeEvent>;
  stop(runId: string, reason: StopReason): Promise<void> | void;
  recover?(runId: string, errorCode: "WORKFLOW_HOST_RESTARTED"): Promise<void> | void;
}

export type ChildRunRequest = {
  input: unknown;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  permissions?: readonly string[];
  expectedTargetHash?: string;
};

export type RunHandle = AsyncIterable<ExecutionRunEvent> & {
  runId: string;
  existing: boolean;
};

export type RunStartOptions = {
  allowRetiredTarget?: boolean;
};

const RUN_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS execution_runs (
  run_id TEXT PRIMARY KEY,
  parent_run_id TEXT REFERENCES execution_runs(run_id),
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('preset_model', 'workflow')),
  target_ref TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  target_allow_retired INTEGER NOT NULL DEFAULT 0,
  runtime_adapter_version TEXT NOT NULL,
  runtime_adapter_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'stopping', 'stopped')),
  input_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  output_json TEXT,
  error_json TEXT,
  idempotency_key TEXT,
  request_hash TEXT NOT NULL,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  stopped_at TEXT,
  UNIQUE(client_id, runtime_kind, target_ref, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_execution_runs_parent ON execution_runs(parent_run_id);
CREATE TABLE IF NOT EXISTS execution_run_events (
  run_id TEXT NOT NULL REFERENCES execution_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, sequence)
);
`;

const RUN_TRANSITIONS: Record<ExecutionRunStatus, readonly ExecutionRunStatus[]> = {
  queued: ["running", "stopping", "failed"],
  running: ["succeeded", "failed", "stopping"],
  succeeded: [],
  failed: [],
  stopping: ["stopped", "failed"],
  stopped: [],
};

export class RunControlError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorCode: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RunControlError";
  }
}

export function assertLegalRunTransition(from: ExecutionRunStatus, to: ExecutionRunStatus): void {
  if (from !== to && !(RUN_TRANSITIONS[from] ?? []).includes(to)) {
    throw new RunControlError(409, "run_state_invalid", `Illegal Run transition ${from} -> ${to}.`);
  }
}

/**
 * The only owner of top-level execution identity, event sequence, idempotency,
 * stop propagation and restart recovery.
 */
export class RunControl {
  private readonly now: () => string;
  private readonly ids: IdFactory;
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly capacity: ExecutionCapacity;

  constructor(
    readonly db: DatabaseSync,
    readonly runtimes: RuntimeCatalog,
    options: { now?: () => string; ids?: IdFactory; maxConcurrency?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.ids = options.ids ?? randomIds;
    this.capacity = new ExecutionCapacity(options.maxConcurrency ?? Number.MAX_SAFE_INTEGER);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(RUN_SCHEMA);
    ensureSqliteColumn(this.db, "execution_runs", "permissions_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureSqliteColumn(this.db, "execution_runs", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureSqliteColumn(this.db, "execution_runs", "target_allow_retired", "INTEGER NOT NULL DEFAULT 0");
    ensureSqliteColumn(this.db, "execution_runs", "runtime_adapter_version", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureSqliteColumn(this.db, "execution_runs", "runtime_adapter_hash", "TEXT NOT NULL DEFAULT 'unknown'");
  }

  start(target: ExecutionTarget, request: RunRequest, options: RunStartOptions = {}): RunHandle {
    const allowRetiredTarget = options.allowRetiredTarget === true;
    const resolved = this.runtimes.resolve(target.kind, target.ref, allowRetiredTarget ? { allowRetired: true } : {});
    const permissions = normalizePermissions(request.permissions);
    const requestHash = hashJson({
      target,
      target_hash: resolved.target.hash,
      runtime_adapter_version: resolved.adapter.version,
      runtime_adapter_hash: resolved.adapter.packageHash,
      input: request.input,
      metadata: request.metadata ?? {},
      parent_run_id: request.parentRunId ?? null,
      permissions,
    });
    const existing = request.idempotency_key
      ? this.findByIdempotency(request.clientId, target, request.idempotency_key)
      : undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new RunControlError(409, "idempotency_key_reused", "The idempotency key was already used with a different run request.");
      }
      if (existing.status === "queued" && !this.active.has(existing.run_id)) this.launch(existing.run_id, resolved.adapter, resolved.target, request);
      return this.handle(existing.run_id, true);
    }

    const runId = this.ids.runId();
    const createdAt = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO execution_runs(
          run_id, parent_run_id, runtime_kind, target_ref, target_hash, target_allow_retired,
          runtime_adapter_version, runtime_adapter_hash, client_id,
          status, input_json, metadata_json, permissions_json, idempotency_key, request_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        request.parentRunId ?? null,
        resolved.target.kind,
        resolved.target.ref,
        resolved.target.hash,
        allowRetiredTarget ? 1 : 0,
        resolved.adapter.version,
        resolved.adapter.packageHash,
        request.clientId,
        JSON.stringify(request.input),
        JSON.stringify(request.metadata ?? {}),
        JSON.stringify(permissions),
        request.idempotency_key ?? null,
        requestHash,
        createdAt,
      );
      resolved.adapter.prepareRun?.({ runId, target: resolved.target, request });
      this.appendEventTx(runId, resolved.target, request.parentRunId, "run.queued", { status: "queued" }, createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (isUniqueConstraint(error)) {
        const duplicate = request.idempotency_key ? this.findByIdempotency(request.clientId, target, request.idempotency_key) : undefined;
        if (duplicate) {
          if (duplicate.request_hash !== requestHash) {
            throw new RunControlError(409, "idempotency_key_reused", "The idempotency key was already used with a different run request.");
          }
          if (duplicate.status === "queued" && !this.active.has(duplicate.run_id)) this.launch(duplicate.run_id, resolved.adapter, resolved.target, request);
          return this.handle(duplicate.run_id, true);
        }
      }
      throw error;
    }
    this.notify(runId);
    this.launch(runId, resolved.adapter, resolved.target, request);
    return this.handle(runId, false);
  }

  get(runId: string): ExecutionRun {
    const row = this.db.prepare(`SELECT * FROM execution_runs WHERE run_id = ?`).get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new RunControlError(404, "run_not_found", `Run ${runId} was not found.`);
    return rowToRun(row);
  }

  async *events(runId: string, afterSequence = 0): AsyncIterable<ExecutionRunEvent> {
    let sequence = Math.max(0, afterSequence);
    for (;;) {
      const rows = this.db.prepare(`
        SELECT event_json FROM execution_run_events
        WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC
      `).all(runId, sequence) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const event = JSON.parse(String(row.event_json)) as ExecutionRunEvent;
        sequence = event.sequence;
        yield event;
      }
      const run = this.get(runId);
      if (isTerminal(run.status)) {
        const tailRows = this.db.prepare(`
          SELECT event_json FROM execution_run_events
          WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC
        `).all(runId, sequence) as Array<Record<string, unknown>>;
        for (const row of tailRows) {
          const event = JSON.parse(String(row.event_json)) as ExecutionRunEvent;
          sequence = event.sequence;
          yield event;
        }
        return;
      }
      await this.waitForChange(runId);
    }
  }

  eventsSnapshot(runId: string, afterSequence = 0): ExecutionRunEvent[] {
    this.get(runId);
    const rows = this.db.prepare(`
      SELECT event_json FROM execution_run_events
      WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(runId, Math.max(0, afterSequence)) as Array<Record<string, unknown>>;
    return rows.map((row) => JSON.parse(String(row.event_json)) as ExecutionRunEvent);
  }

  activeAgentRunForSession(sessionId: string): string | undefined {
    const rows = this.db.prepare(`
      SELECT run_id, input_json FROM execution_runs
      WHERE runtime_kind = 'preset_model' AND status IN ('queued', 'running', 'stopping')
      ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const input = parseObject(row.input_json);
      const agentInput = input.agent_input && typeof input.agent_input === "object" && !Array.isArray(input.agent_input)
        ? input.agent_input as Record<string, unknown>
        : input;
      const candidate = typeof input.session_id === "string"
        ? input.session_id
        : typeof agentInput.sessionId === "string"
          ? agentInput.sessionId
          : typeof agentInput.session_id === "string"
            ? agentInput.session_id
            : `run_${String(row.run_id)}`;
      if (candidate === sessionId) return String(row.run_id);
    }
    return undefined;
  }

  async stop(runId: string, reason: StopReason): Promise<StopResult> {
    const run = this.get(runId);
    if (isTerminal(run.status)) return { stopped: false, runId, status: run.status };
    const adapter = this.runtimes.adapter(run.runtime_kind);
    if (run.status !== "stopping") this.transition(runId, "stopping", "run.stopping", { reason });
    this.controllers.get(runId)?.abort(reason);
    const execution = this.active.get(runId);
    const [adapterStop, executionStop] = await Promise.allSettled([
      Promise.resolve(adapter.stop(runId, reason)),
      execution ?? Promise.resolve(),
    ]);
    if (adapterStop.status === "rejected") throw adapterStop.reason;
    if (executionStop.status === "rejected") throw executionStop.reason;
    const current = this.get(runId);
    if (current.status === "stopping") this.transition(runId, "stopped", "run.stopped", { reason, status: "stopped" });
    return { stopped: true, runId, status: this.get(runId).status };
  }

  async recover(): Promise<RecoveryResult[]> {
    const rows = this.db.prepare(`SELECT run_id, parent_run_id, status, runtime_kind, target_ref, target_hash, target_allow_retired, runtime_adapter_version, runtime_adapter_hash, client_id, input_json, metadata_json, permissions_json, idempotency_key FROM execution_runs WHERE status IN ('queued', 'running', 'stopping')`).all() as Array<Record<string, unknown>>;
    const result: RecoveryResult[] = [];
    for (const row of rows) {
      const runId = String(row.run_id);
      const status = String(row.status) as ExecutionRunStatus;
      if (status === "queued") {
        try {
          const allowRetiredTarget = Number(row.target_allow_retired) === 1;
          const resolved = this.runtimes.resolve(
            String(row.runtime_kind) as ExecutionRuntimeKind,
            String(row.target_ref),
            allowRetiredTarget ? { allowRetired: true } : {},
          );
          if (resolved.target.hash !== String(row.target_hash)
            || resolved.adapter.version !== String(row.runtime_adapter_version)
            || resolved.adapter.packageHash !== String(row.runtime_adapter_hash)) {
            this.transition(runId, "failed", "run.failed", { error_code: "RUNTIME_TARGET_CHANGED", error: "The persisted runtime target hash is no longer available." });
            result.push({ runId, action: "failed" });
            continue;
          }
          this.launch(runId, resolved.adapter, resolved.target, {
            clientId: String(row.client_id),
            input: JSON.parse(String(row.input_json)),
            metadata: parseObject(row.metadata_json),
            permissions: parsePermissions(row.permissions_json),
            ...(row.parent_run_id ? { parentRunId: String(row.parent_run_id) } : {}),
            ...(row.idempotency_key ? { idempotency_key: String(row.idempotency_key) } : {}),
          });
          result.push({ runId, action: "requeued" });
        } catch (error) {
          this.transition(runId, "failed", "run.failed", { error_code: "RUNTIME_TARGET_UNAVAILABLE", error: error instanceof Error ? error.message : String(error) });
          result.push({ runId, action: "failed" });
        }
      } else {
        const adapter = this.runtimes.adapter(String(row.runtime_kind) as ExecutionRuntimeKind);
        await adapter.recover?.(runId, "WORKFLOW_HOST_RESTARTED");
        this.transition(runId, "failed", "run.failed", { error_code: "WORKFLOW_HOST_RESTARTED", error: "The Host restarted before this run completed." });
        result.push({ runId, action: "failed" });
      }
    }
    return result;
  }

  startAgentChild(parentRunId: string, target: { kind: "preset_model"; ref: string }, request: ChildRunRequest): RunHandle {
    const parent = this.get(parentRunId);
    if (parent.runtime_kind !== "workflow" || parent.status !== "running") {
      throw new RunControlError(409, "child_run_parent_invalid", "Child Agent Runs require an active Workflow parent Run.");
    }
    const row = this.db.prepare("SELECT permissions_json FROM execution_runs WHERE run_id = ?").get(parentRunId) as Record<string, unknown>;
    const parentPermissions = parsePermissions(row.permissions_json);
    const requestedPermissions = request.permissions === undefined ? parentPermissions : normalizePermissions(request.permissions);
    if (requestedPermissions.some((permission) => !hasPermission(parentPermissions, permission))) {
      throw new RunControlError(403, "child_run_permission_escalation", "A child Agent Run cannot widen its parent Run permissions.");
    }
    // Workflow dependency locks are the authorization to keep using a retired
    // Preset Model version. Without the lock, child creation must still obey
    // the normal published-only target policy.
    const allowRetiredTarget = request.expectedTargetHash !== undefined;
    const resolved = this.runtimes.resolve(
      target.kind,
      target.ref,
      allowRetiredTarget ? { allowRetired: true } : {},
    );
    if (request.expectedTargetHash && request.expectedTargetHash !== resolved.target.hash) {
      throw new RunControlError(503, "workflow_dependency_hash_mismatch", "The locked Preset Model hash is no longer available.", true);
    }
    return this.start(target, {
      clientId: parent.client_id,
      input: request.input,
      ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      permissions: requestedPermissions,
      parentRunId,
    }, { allowRetiredTarget });
  }

  stopChildren(parentRunId: string, reason: StopReason): Promise<void> {
    const rows = this.db.prepare("SELECT run_id FROM execution_runs WHERE parent_run_id = ? AND status IN ('queued', 'running', 'stopping')").all(parentRunId) as Array<Record<string, unknown>>;
    return Promise.all(rows.map((row) => this.stop(String(row.run_id), reason).then(() => undefined))).then(() => undefined);
  }

  acquireHostSlot(signal: AbortSignal): Promise<() => void> {
    return this.capacity.acquire(signal);
  }

  private launch(runId: string, adapter: ExecutionRuntimeAdapter, target: ResolvedExecutionTarget, request: RunRequest): void {
    if (this.active.has(runId)) return;
    const task = this.execute(runId, adapter, target, request).finally(() => {
      this.active.delete(runId);
      this.notify(runId);
    });
    this.active.set(runId, task);
  }

  private async execute(runId: string, adapter: ExecutionRuntimeAdapter, target: ResolvedExecutionTarget, request: RunRequest): Promise<void> {
    const run = this.get(runId);
    if (isTerminal(run.status)) return;
    const abort = new AbortController();
    this.controllers.set(runId, abort);
    let releaseCapacity: (() => void) | undefined;
    let usage: Record<string, unknown> | undefined;
    try {
      if (adapter.consumesHostSlot) releaseCapacity = await this.capacity.acquire(abort.signal);
      if (abort.signal.aborted || this.get(runId).status === "stopping") {
        const current = this.get(runId);
        if (current.status === "stopping") this.transition(runId, "stopped", "run.stopped", { reason: String(abort.signal.reason ?? "user_stop"), status: "stopped" });
        return;
      }
      this.transition(runId, "running", "run.started", { status: "running" });
      let terminal: RuntimeEvent["terminal"];
      let output: unknown;
      let terminalData: Record<string, unknown> = {};
      for await (const event of adapter.start({
        runId,
        ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
        clientId: request.clientId,
        target,
        metadata: request.metadata ?? {},
        permissions: new Set(normalizePermissions(request.permissions)),
        signal: abort.signal,
      }, request.input)) {
        const eventData = event.data ?? {};
        if (event.terminal) terminal = event.terminal;
        if (event.terminal) terminalData = eventData;
        if (eventData.output !== undefined) output = eventData.output;
        if (eventData.usage && typeof eventData.usage === "object" && !Array.isArray(eventData.usage)) usage = aggregateUsage(usage, eventData.usage as Record<string, unknown>);
        this.appendEvent(runId, target, request.parentRunId, event.type, eventData);
        this.notify(runId);
      }
      const current = this.get(runId);
      if (isTerminal(current.status)) return;
      if (current.status === "stopping" || terminal === "stopped") {
        if (current.status !== "stopping") this.transition(runId, "stopping", "run.stopping", { reason: terminalData.reason ?? "runtime_stop" });
        this.transition(runId, "stopped", "run.stopped", { ...terminalData, status: "stopped" }, usage);
      } else if (terminal === "failed") {
        this.transition(runId, "failed", "run.failed", { ...terminalData, error_code: terminalData.error_code ?? "RUNTIME_FAILED", status: "failed" }, usage);
      } else {
        this.finish(runId, "succeeded", output, usage);
      }
    } catch (error) {
      const current = this.get(runId);
      if (current.status === "stopping" || abort.signal.aborted) {
        if (current.status === "stopping") this.transition(runId, "stopped", "run.stopped", { status: "stopped" });
      } else {
        this.transition(runId, "failed", "run.failed", { error_code: "RUNTIME_FAILED", error: error instanceof Error ? error.message : String(error) }, usage);
      }
    } finally {
      releaseCapacity?.();
      this.controllers.delete(runId);
    }
  }

  private handle(runId: string, existing: boolean): RunHandle {
    const stream = this.events(runId);
    return Object.assign(stream, { runId, existing }) as RunHandle;
  }

  private findByIdempotency(clientId: string, target: ExecutionTarget, key: string): ExecutionRun & { request_hash: string } | undefined {
    const row = this.db.prepare(`
      SELECT *, request_hash FROM execution_runs
      WHERE client_id = ? AND runtime_kind = ? AND target_ref = ? AND idempotency_key = ?
    `).get(clientId, target.kind, target.ref, key) as Record<string, unknown> | undefined;
    return row ? Object.assign(rowToRun(row), { request_hash: String(row.request_hash) }) : undefined;
  }

  private transition(runId: string, next: ExecutionRunStatus, type: string, data: Record<string, unknown>, usage?: Record<string, unknown>): void {
    const current = this.get(runId);
    assertLegalRunTransition(current.status, next);
    const timestamp = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE execution_runs SET status = ?,
          error_json = CASE WHEN ? = 1 THEN ? ELSE error_json END,
          usage_json = CASE WHEN ? IS NULL THEN usage_json ELSE ? END,
          started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
          finished_at = CASE WHEN ? IN ('succeeded', 'failed', 'stopped') THEN ? ELSE finished_at END,
          stopped_at = CASE WHEN ? = 'stopped' THEN ? ELSE stopped_at END
        WHERE run_id = ?
      `).run(next, next === "failed" || (next === "stopped" && data.error_code !== undefined) ? 1 : 0, JSON.stringify(data), usage === undefined ? null : JSON.stringify(usage), usage === undefined ? null : JSON.stringify(usage), next, timestamp, next, timestamp, next, timestamp, runId);
      this.appendEventTx(runId, { kind: current.runtime_kind, ref: current.target_ref, hash: current.target_hash }, current.parent_run_id, type, data, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.notify(runId);
  }

  private finish(runId: string, status: "succeeded" | "failed", output?: unknown, usage?: Record<string, unknown>): void {
    const current = this.get(runId);
    assertLegalRunTransition(current.status, status);
    const timestamp = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE execution_runs SET status = ?, output_json = ?, usage_json = ?, finished_at = ? WHERE run_id = ?")
        .run(status, output === undefined ? null : JSON.stringify(output), usage === undefined ? null : JSON.stringify(usage), timestamp, runId);
      this.appendEventTx(runId, { kind: current.runtime_kind, ref: current.target_ref, hash: current.target_hash }, current.parent_run_id, status === "succeeded" ? "run.succeeded" : "run.failed", status === "succeeded" ? { output, status, ...(usage ? { usage } : {}) } : { status, error_code: "RUNTIME_FAILED", ...(usage ? { usage } : {}) }, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.notify(runId);
  }

  private appendEvent(runId: string, target: ResolvedExecutionTarget, parentRunId: string | undefined, type: string, data: Record<string, unknown>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.appendEventTx(runId, target, parentRunId, type, data, this.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendEventTx(runId: string, target: ResolvedExecutionTarget, parentRunId: string | undefined, type: string, data: Record<string, unknown>, timestamp: string): void {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM execution_run_events WHERE run_id = ?").get(runId) as { sequence?: number } | undefined;
    const sequence = Number(row?.sequence ?? 0) + 1;
    const event: ExecutionRunEvent = {
      schema_version: 1,
      run_id: runId,
      ...(parentRunId ? { parent_run_id: parentRunId } : {}),
      runtime_kind: target.kind,
      target_ref: target.ref,
      sequence,
      timestamp,
      type,
      data,
    };
    this.db.prepare("INSERT INTO execution_run_events(run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)").run(runId, sequence, JSON.stringify(event), timestamp);
  }

  private waitForChange(runId: string): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(runId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.waiters.set(runId, waiters);
      setTimeout(() => {
        if (!waiters.delete(resolve)) return;
        if (waiters.size === 0) this.waiters.delete(runId);
        resolve();
      }, 250);
    });
  }

  private notify(runId: string): void {
    const waiters = this.waiters.get(runId);
    if (!waiters) return;
    this.waiters.delete(runId);
    for (const resolve of waiters) resolve();
  }
}

function rowToRun(row: Record<string, unknown>): ExecutionRun {
  const parsed = (value: unknown): unknown => value === null || value === undefined ? undefined : JSON.parse(String(value));
  return {
    run_id: String(row.run_id),
    ...(row.parent_run_id ? { parent_run_id: String(row.parent_run_id) } : {}),
    runtime_kind: String(row.runtime_kind) as ExecutionRuntimeKind,
    target_ref: String(row.target_ref),
    target_hash: String(row.target_hash),
    runtime_adapter_version: String(row.runtime_adapter_version),
    runtime_adapter_hash: String(row.runtime_adapter_hash),
    client_id: String(row.client_id),
    status: String(row.status) as ExecutionRunStatus,
    input: parsed(row.input_json),
    ...(parsed(row.output_json) === undefined ? {} : { output: parsed(row.output_json) }),
    ...(parsed(row.error_json) === undefined ? {} : { error: parsed(row.error_json) as Record<string, unknown> }),
    ...(row.idempotency_key ? { idempotency_key: String(row.idempotency_key) } : {}),
    ...(parsed(row.usage_json) === undefined ? {} : { usage: parsed(row.usage_json) as Record<string, unknown> }),
    created_at: String(row.created_at),
    ...(row.started_at ? { started_at: String(row.started_at) } : {}),
    ...(row.finished_at ? { finished_at: String(row.finished_at) } : {}),
    ...(row.stopped_at ? { stopped_at: String(row.stopped_at) } : {}),
  };
}

function isTerminal(status: ExecutionRunStatus): boolean {
  return ["succeeded", "failed", "stopped"].includes(status);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /unique|constraint/i.test(error.message);
}

function ensureSqliteColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  if (!columns.some((candidate) => candidate.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function normalizePermissions(value: readonly string[] | undefined): string[] {
  return [...new Set((value ?? []).filter((permission): permission is string => typeof permission === "string" && permission.length > 0))].sort();
}

function parsePermissions(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizePermissions(parsed) : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hasPermission(permissions: readonly string[], requested: string): boolean {
  return permissions.includes("*") || permissions.includes(requested);
}

function aggregateUsage(current: Record<string, unknown> | undefined, next: Record<string, unknown>): Record<string, unknown> {
  const result = current ? structuredClone(current) : {};
  for (const [key, value] of Object.entries(next)) {
    const existing = result[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = (typeof existing === "number" && Number.isFinite(existing) ? existing : 0) + value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = aggregateUsage(
        existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : undefined,
        value as Record<string, unknown>,
      );
    } else if (existing === undefined) {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

class ExecutionCapacity {
  private active = 0;
  private readonly waiters: Array<{
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    onAbort: () => void;
  }> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Number.MAX_SAFE_INTEGER;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) return Promise.resolve(this.reserve());
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private reserve(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError());
        continue;
      }
      waiter.resolve(this.reserve());
    }
  }
}

function abortError(): Error {
  const error = new Error("Execution capacity acquisition stopped.");
  error.name = "AbortError";
  return error;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
