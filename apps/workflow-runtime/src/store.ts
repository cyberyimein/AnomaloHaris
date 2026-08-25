import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  WorkflowNodeRun,
  WorkflowNodeRunStatus,
} from "@anomaloharis/contracts";

import type { CompiledWorkflow } from "./compiler.js";

export type WorkflowRunSnapshot = {
  run_id: string;
  workflow_name: string;
  workflow_version: number;
  compiled_hash: string;
};

export type WorkflowNodeUpdate = {
  status: WorkflowNodeRunStatus;
  input?: unknown;
  output?: unknown;
  error?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  childRunId?: string;
  startedAt?: string;
  finishedAt?: string;
};

const WORKFLOW_RUN_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY REFERENCES execution_runs(run_id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  compiled_hash TEXT NOT NULL,
  compiled_json TEXT NOT NULL,
  FOREIGN KEY(workflow_name, workflow_version)
    REFERENCES workflow_versions(name, version)
);
CREATE TABLE IF NOT EXISTS workflow_node_runs (
  node_run_id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'running', 'succeeded', 'failed', 'skipped', 'stopped')),
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  usage_json TEXT,
  child_run_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(workflow_run_id, node_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_workflow
  ON workflow_node_runs(workflow_run_id, node_id, attempt);
`;

const NODE_TRANSITIONS: Record<WorkflowNodeRunStatus, readonly WorkflowNodeRunStatus[]> = {
  pending: ["ready", "skipped", "stopped"],
  ready: ["running", "skipped", "stopped"],
  running: ["succeeded", "failed", "stopped"],
  succeeded: [],
  failed: [],
  skipped: [],
  stopped: [],
};

export class WorkflowRunStore {
  private readonly now: () => string;
  private readonly nodeId: () => string;

  constructor(
    readonly db: DatabaseSync,
    options: { now?: () => string; nodeId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.nodeId = options.nodeId ?? (() => `node_run_${randomUUID().replaceAll("-", "")}`);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(WORKFLOW_RUN_SCHEMA);
    ensureSqliteColumn(this.db, "workflow_node_runs", "usage_json", "TEXT");
  }

  create(runId: string, compiled: CompiledWorkflow): void {
    this.db.prepare(`
      INSERT INTO workflow_runs(run_id, workflow_name, workflow_version, compiled_hash, compiled_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      runId,
      compiled.ref.split("@")[0]!,
      Number(compiled.ref.split("@")[1]),
      compiled.compiled_hash,
      JSON.stringify(compiled),
    );
    const statement = this.db.prepare(`
      INSERT INTO workflow_node_runs(node_run_id, workflow_run_id, node_id, attempt, status)
      VALUES (?, ?, ?, 1, 'pending')
    `);
    for (const node of compiled.nodes) statement.run(this.nodeId(), runId, node.id);
  }

  get(runId: string): WorkflowRunSnapshot | undefined {
    const row = this.db.prepare(`
      SELECT run_id, workflow_name, workflow_version, compiled_hash
      FROM workflow_runs WHERE run_id = ?
    `).get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      run_id: String(row.run_id),
      workflow_name: String(row.workflow_name),
      workflow_version: Number(row.workflow_version),
      compiled_hash: String(row.compiled_hash),
    };
  }

  listNodes(runId: string): WorkflowNodeRun[] {
    const rows = this.db.prepare(`
      SELECT node_run_id, workflow_run_id, node_id, attempt, status,
             input_json, output_json, error_json, usage_json, child_run_id, started_at, finished_at
      FROM workflow_node_runs
      WHERE workflow_run_id = ?
      ORDER BY node_id ASC, attempt ASC
    `).all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToNodeRun);
  }

  latestNode(runId: string, nodeId: string): WorkflowNodeRun | undefined {
    const row = this.db.prepare(`
      SELECT node_run_id, workflow_run_id, node_id, attempt, status,
             input_json, output_json, error_json, usage_json, child_run_id, started_at, finished_at
      FROM workflow_node_runs
      WHERE workflow_run_id = ? AND node_id = ?
      ORDER BY attempt DESC LIMIT 1
    `).get(runId, nodeId) as Record<string, unknown> | undefined;
    return row ? rowToNodeRun(row) : undefined;
  }

  createAttempt(runId: string, nodeId: string, attempt: number): string {
    const nodeRunId = this.nodeId();
    this.db.prepare(`
      INSERT INTO workflow_node_runs(node_run_id, workflow_run_id, node_id, attempt, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(nodeRunId, runId, nodeId, attempt);
    return nodeRunId;
  }

  update(nodeRunId: string, update: WorkflowNodeUpdate): WorkflowNodeRun {
    const current = this.db.prepare(`
      SELECT node_run_id, workflow_run_id, node_id, attempt, status,
             input_json, output_json, error_json, usage_json, child_run_id, started_at, finished_at
      FROM workflow_node_runs WHERE node_run_id = ?
    `).get(nodeRunId) as Record<string, unknown> | undefined;
    if (!current) throw new Error(`workflow_node_run_not_found:${nodeRunId}`);
    const from = String(current.status) as WorkflowNodeRunStatus;
    if (from !== update.status && !(NODE_TRANSITIONS[from] ?? []).includes(update.status)) {
      throw new Error(`workflow_node_state_invalid:${from}->${update.status}`);
    }
    const currentInput = current.input_json === null || current.input_json === undefined ? undefined : JSON.parse(String(current.input_json));
    const currentOutput = current.output_json === null || current.output_json === undefined ? undefined : JSON.parse(String(current.output_json));
    const currentError = current.error_json === null || current.error_json === undefined ? undefined : JSON.parse(String(current.error_json));
    const currentUsage = current.usage_json === null || current.usage_json === undefined ? undefined : JSON.parse(String(current.usage_json));
    this.db.prepare(`
      UPDATE workflow_node_runs SET
        status = ?,
        input_json = ?,
        output_json = ?,
        error_json = ?,
        usage_json = ?,
        child_run_id = ?,
        started_at = ?,
        finished_at = ?
      WHERE node_run_id = ?
    `).run(
      update.status,
      update.input === undefined ? (current.input_json === undefined ? null : current.input_json as string | null) : JSON.stringify(update.input),
      update.output === undefined ? (current.output_json === undefined ? null : current.output_json as string | null) : JSON.stringify(update.output),
      update.error === undefined ? (current.error_json === undefined ? null : current.error_json as string | null) : JSON.stringify(update.error),
      update.usage === undefined ? (current.usage_json === undefined ? null : current.usage_json as string | null) : JSON.stringify(update.usage),
      update.childRunId ?? (current.child_run_id === undefined ? null : current.child_run_id as string | null),
      update.startedAt ?? (current.started_at === undefined ? null : current.started_at as string | null) ?? (update.status === "running" ? this.now() : null),
      update.finishedAt ?? (current.finished_at === undefined ? null : current.finished_at as string | null) ?? (isTerminalNodeStatus(update.status) ? this.now() : null),
      nodeRunId,
    );
    return {
      node_run_id: String(current.node_run_id),
      workflow_run_id: String(current.workflow_run_id),
      node_id: String(current.node_id),
      attempt: Number(current.attempt),
      status: update.status,
      ...(update.input === undefined ? (currentInput === undefined ? {} : { input: currentInput }) : { input: structuredClone(update.input) }),
      ...(update.output === undefined ? (currentOutput === undefined ? {} : { output: currentOutput }) : { output: structuredClone(update.output) }),
      ...(update.error === undefined ? (currentError === undefined ? {} : { error: currentError }) : { error: structuredClone(update.error) }),
      ...(update.usage === undefined ? (currentUsage === undefined ? {} : { usage: currentUsage }) : { usage: structuredClone(update.usage) }),
      ...(update.childRunId ?? current.child_run_id ? { child_run_id: update.childRunId ?? String(current.child_run_id) } : {}),
      ...(update.startedAt ?? current.started_at ? { started_at: update.startedAt ?? String(current.started_at) } : {}),
      ...(update.finishedAt ?? current.finished_at ?? isTerminalNodeStatus(update.status) ? { finished_at: update.finishedAt ?? String(current.finished_at ?? this.now()) } : {}),
    };
  }
}

function isTerminalNodeStatus(status: WorkflowNodeRunStatus): boolean {
  return ["succeeded", "failed", "skipped", "stopped"].includes(status);
}

function rowToNodeRun(row: Record<string, unknown>): WorkflowNodeRun {
  const parsed = (value: unknown): unknown => value === null || value === undefined ? undefined : JSON.parse(String(value));
  return {
    node_run_id: String(row.node_run_id),
    workflow_run_id: String(row.workflow_run_id),
    node_id: String(row.node_id),
    attempt: Number(row.attempt),
    status: String(row.status) as WorkflowNodeRunStatus,
    ...(parsed(row.input_json) === undefined ? {} : { input: parsed(row.input_json) }),
    ...(parsed(row.output_json) === undefined ? {} : { output: parsed(row.output_json) }),
    ...(parsed(row.error_json) === undefined ? {} : { error: parsed(row.error_json) as Record<string, unknown> }),
    ...(parsed(row.usage_json) === undefined ? {} : { usage: parsed(row.usage_json) as Record<string, unknown> }),
    ...(row.child_run_id ? { child_run_id: String(row.child_run_id) } : {}),
    ...(row.started_at ? { started_at: String(row.started_at) } : {}),
    ...(row.finished_at ? { finished_at: String(row.finished_at) } : {}),
  };
}

function ensureSqliteColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  if (!columns.some((candidate) => candidate.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
