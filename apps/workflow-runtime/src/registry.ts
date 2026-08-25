import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  WorkflowDefinition,
  WorkflowRef,
  WorkflowSummary,
  WorkflowValidationReport,
} from "@anomaloharis/contracts";

import type { CompiledWorkflow, WorkflowDependencyLock } from "./compiler.js";
import { WorkflowRuntimeError } from "./errors.js";

export type StoredWorkflow = WorkflowSummary & {
  definition: WorkflowDefinition;
  compiled: CompiledWorkflow;
  dependency_locks: WorkflowDependencyLock[];
  validation: WorkflowValidationReport;
};

export type WorkflowListOptions = {
  includeDraft?: boolean;
  includeRetired?: boolean;
};

export type WorkflowResolveOptions = {
  allowDraft?: boolean;
  allowRetired?: boolean;
};

type WorkflowRow = {
  name: string;
  version: number;
  status: "draft" | "published" | "retired";
  description: string;
  definition_json: string;
  definition_hash: string;
  compiled_json: string;
  compiled_hash: string;
  capability_manifest_hash: string;
  validation_json: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  retired_at: string | null;
};

const REGISTRY_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS workflows (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_versions (
  name TEXT NOT NULL REFERENCES workflows(name) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'retired')),
  description TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  compiled_json TEXT NOT NULL,
  compiled_hash TEXT NOT NULL,
  capability_manifest_hash TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  retired_at TEXT,
  PRIMARY KEY(name, version)
);
CREATE INDEX IF NOT EXISTS idx_workflow_versions_status
  ON workflow_versions(name, status, version DESC);
CREATE TABLE IF NOT EXISTS workflow_dependency_locks (
  workflow_name TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL,
  dependency_ref TEXT NOT NULL,
  dependency_hash TEXT NOT NULL,
  PRIMARY KEY(workflow_name, workflow_version, node_id, dependency_kind),
  FOREIGN KEY(workflow_name, workflow_version)
    REFERENCES workflow_versions(name, version) ON DELETE CASCADE
);
`;

export class SqliteWorkflowRegistry {
  readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;
  private readonly now: () => string;

  constructor(dbPath: string, options: { database?: DatabaseSync; now?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.database) {
      this.db = options.database;
      this.ownsDatabase = false;
    } else {
      if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.ownsDatabase = true;
    }
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(REGISTRY_SCHEMA);
  }

  list(options: WorkflowListOptions = {}): StoredWorkflow[] {
    const includeDraft = options.includeDraft !== false;
    const includeRetired = options.includeRetired !== false;
    const statuses = ["published", ...(includeDraft ? ["draft"] : []), ...(includeRetired ? ["retired"] : [])];
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT name, version, status, description, definition_json, definition_hash,
             compiled_json, compiled_hash, capability_manifest_hash, validation_json,
             created_at, updated_at, published_at, retired_at
      FROM workflow_versions
      WHERE status IN (${placeholders})
      ORDER BY name ASC, version DESC
    `).all(...statuses) as unknown as WorkflowRow[];
    return rows.map((row) => this.toStored(row));
  }

  get(ref: string, options: WorkflowResolveOptions = {}): StoredWorkflow {
    const parsed = parseRef(ref);
    const row = this.db.prepare(`
      SELECT name, version, status, description, definition_json, definition_hash,
             compiled_json, compiled_hash, capability_manifest_hash, validation_json,
             created_at, updated_at, published_at, retired_at
      FROM workflow_versions WHERE name = ? AND version = ?
    `).get(parsed.name, parsed.version) as unknown as WorkflowRow | undefined;
    if (!row) throw new WorkflowRuntimeError("workflow_not_found", `Workflow ${ref} was not found.`, 404);
    if (row.status === "draft" && !options.allowDraft) throw new WorkflowRuntimeError("workflow_not_found", `Workflow ${ref} is not published.`, 404);
    if (row.status === "retired" && !options.allowRetired) throw new WorkflowRuntimeError("workflow_not_found", `Workflow ${ref} is retired.`, 404);
    return this.toStored(row);
  }

  insertDraft(input: { definition: WorkflowDefinition; report: WorkflowValidationReport; compiled: CompiledWorkflow }): { workflow: StoredWorkflow; idempotent: boolean } {
    const ref = `${input.definition.metadata.name}@${input.definition.metadata.version}`;
    const parsed = parseRef(ref);
    const existing = this.find(parsed.name, parsed.version);
    if (existing) {
      if (existing.definition_hash === input.report.definition_hash && existing.status === "draft") return { workflow: existing, idempotent: true };
      throw new WorkflowRuntimeError("workflow_version_conflict", `Workflow ${ref} already exists with a different lifecycle or definition.`, 409);
    }
    const createdAt = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO workflows(name, description, created_at, updated_at) VALUES (?, ?, ?, ?)").run(parsed.name, input.definition.metadata.description, createdAt, createdAt);
      this.db.prepare("UPDATE workflows SET description = ?, updated_at = ? WHERE name = ?").run(input.definition.metadata.description, createdAt, parsed.name);
      this.insertVersion(input, "draft", createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { workflow: this.get(ref, { allowDraft: true }), idempotent: false };
  }

  updatePublished(input: { ref: string; report: WorkflowValidationReport; compiled: CompiledWorkflow }): StoredWorkflow {
    const current = this.get(input.ref, { allowDraft: true, allowRetired: true });
    const timestamp = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.updateCompiled(input, timestamp);
      this.db.prepare("UPDATE workflow_versions SET status = 'published', published_at = ?, retired_at = NULL, updated_at = ? WHERE name = ? AND version = ?")
        .run(timestamp, timestamp, current.name, current.version);
      this.db.prepare("UPDATE workflows SET updated_at = ? WHERE name = ?").run(timestamp, current.name);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(input.ref, { allowDraft: true, allowRetired: true });
  }

  retire(ref: string): StoredWorkflow {
    const current = this.get(ref, { allowDraft: true, allowRetired: true });
    if (current.status !== "published") throw new WorkflowRuntimeError("workflow_lifecycle_invalid", "Only a published Workflow can be retired.", 409);
    const timestamp = this.now();
    this.db.prepare("UPDATE workflow_versions SET status = 'retired', retired_at = ?, updated_at = ? WHERE name = ? AND version = ?")
      .run(timestamp, timestamp, current.name, current.version);
    this.db.prepare("UPDATE workflows SET updated_at = ? WHERE name = ?").run(timestamp, current.name);
    return this.get(ref, { allowRetired: true });
  }

  deleteDraft(ref: string): void {
    const current = this.get(ref, { allowDraft: true, allowRetired: true });
    if (current.status !== "draft") throw new WorkflowRuntimeError("workflow_lifecycle_invalid", "Only a draft Workflow can be deleted.", 409);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM workflow_versions WHERE name = ? AND version = ?").run(current.name, current.version);
      const remaining = this.db.prepare("SELECT 1 FROM workflow_versions WHERE name = ? LIMIT 1").get(current.name);
      if (!remaining) this.db.prepare("DELETE FROM workflows WHERE name = ?").run(current.name);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }

  private insertVersion(input: { definition: WorkflowDefinition; report: WorkflowValidationReport; compiled: CompiledWorkflow }, status: "draft" | "published", timestamp: string): void {
    const definition = input.definition;
    this.db.prepare(`
      INSERT INTO workflow_versions(
        name, version, status, description, definition_json, definition_hash,
        compiled_json, compiled_hash, capability_manifest_hash, validation_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      definition.metadata.name,
      definition.metadata.version,
      status,
      definition.metadata.description,
      JSON.stringify(definition),
      input.report.definition_hash,
      JSON.stringify(input.compiled),
      input.compiled.compiled_hash,
      input.report.capability_manifest_hash,
      JSON.stringify(input.report),
      timestamp,
      timestamp,
    );
    this.persistLocks(definition.metadata.name, definition.metadata.version, input.compiled.dependency_locks);
  }

  private updateCompiled(input: { ref: string; report: WorkflowValidationReport; compiled: CompiledWorkflow }, timestamp: string): void {
    const parsed = parseRef(input.ref);
    this.db.prepare(`
      UPDATE workflow_versions
      SET compiled_json = ?, compiled_hash = ?, capability_manifest_hash = ?, validation_json = ?, updated_at = ?
      WHERE name = ? AND version = ?
    `).run(JSON.stringify(input.compiled), input.compiled.compiled_hash, input.report.capability_manifest_hash, JSON.stringify(input.report), timestamp, parsed.name, parsed.version);
    this.db.prepare("DELETE FROM workflow_dependency_locks WHERE workflow_name = ? AND workflow_version = ?").run(parsed.name, parsed.version);
    this.persistLocks(parsed.name, parsed.version, input.compiled.dependency_locks);
  }

  private persistLocks(name: string, version: number, locks: readonly WorkflowDependencyLock[]): void {
    const statement = this.db.prepare(`
      INSERT INTO workflow_dependency_locks(workflow_name, workflow_version, node_id, dependency_kind, dependency_ref, dependency_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const lock of locks) statement.run(name, version, lock.node_id, lock.dependency_kind, lock.dependency_ref, lock.dependency_hash);
  }

  private find(name: string, version: number): StoredWorkflow | undefined {
    const row = this.db.prepare(`
      SELECT name, version, status, description, definition_json, definition_hash,
             compiled_json, compiled_hash, capability_manifest_hash, validation_json,
             created_at, updated_at, published_at, retired_at
      FROM workflow_versions WHERE name = ? AND version = ?
    `).get(name, version) as unknown as WorkflowRow | undefined;
    return row ? this.toStored(row) : undefined;
  }

  private toStored(row: WorkflowRow): StoredWorkflow {
    const locks = this.db.prepare(`
      SELECT node_id, dependency_kind, dependency_ref, dependency_hash
      FROM workflow_dependency_locks WHERE workflow_name = ? AND workflow_version = ?
      ORDER BY node_id, dependency_kind, dependency_ref
    `).all(row.name, row.version) as unknown as WorkflowDependencyLock[];
    const definition = JSON.parse(row.definition_json) as WorkflowDefinition;
    const compiled = JSON.parse(row.compiled_json) as CompiledWorkflow;
    const validation = JSON.parse(row.validation_json) as WorkflowValidationReport;
    return {
      ref: `${row.name}@${row.version}` as WorkflowRef,
      name: row.name as WorkflowSummary["name"],
      version: row.version,
      description: row.description,
      status: row.status,
      definition_hash: row.definition_hash,
      compiled_hash: row.compiled_hash,
      capability_manifest_hash: row.capability_manifest_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...(row.published_at ? { published_at: row.published_at } : {}),
      ...(row.retired_at ? { retired_at: row.retired_at } : {}),
      definition,
      compiled,
      dependency_locks: locks,
      validation,
    };
  }
}

function parseRef(ref: string): { name: string; version: number } {
  const match = /^([a-z][a-z0-9-]{0,63})@([1-9][0-9]{0,8})$/.exec(ref);
  if (!match) throw new WorkflowRuntimeError("workflow_ref_invalid", `Invalid Workflow Ref: ${ref}.`, 400);
  return { name: match[1]!, version: Number(match[2]) };
}
