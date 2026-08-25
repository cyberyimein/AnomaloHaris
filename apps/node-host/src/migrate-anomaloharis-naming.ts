import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalizePresetModelName,
  canonicalizePresetModelRef,
  legacyNamingAdapter,
} from "@anomaloharis/contracts";

import { FileResourceLoader } from "./resources.js";
import { builtinPluginCatalog, type PluginLock } from "./plugin-catalog.js";
import { SqlitePresetModelRegistry } from "./preset-models.js";

type MigrationTarget = {
  id: string;
  path: string;
};

type MigrationReport = {
  apply: boolean;
  backups: string[];
  databases: Array<{ id: string; path: string; changed: boolean; details: string[] }>;
};

const args = new Set(process.argv.slice(2));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const dataDir = resolve(
  flagValue("--data-dir")
    ?? legacyNamingAdapter.readEnv(process.env, "ANOMALOHARIS_DATA_DIR")
    ?? join(repoRoot, "data"),
);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const targets: MigrationTarget[] = [
  {
    id: "preset-models",
    path: resolve(configuredDatabasePath("--preset-model-db", "ANOMALOHARIS_PRESET_MODEL_DB_PATH", join(dataDir, "preset-models.sqlite3"))),
  },
  {
    id: "sessions",
    path: resolve(configuredDatabasePath("--session-db", "ANOMALOHARIS_SESSION_DB_PATH", join(dataDir, "sessions.sqlite3"))),
  },
  {
    id: "compute",
    path: resolve(configuredDatabasePath("--compute-db", "ANOMALOHARIS_COMPUTE_DB_PATH", join(dataDir, "compute.sqlite3"))),
  },
];

const report: MigrationReport = { apply: args.has("--apply"), backups: [], databases: [] };

try {
  for (const target of targets) {
    if (!existsSync(target.path)) {
      report.databases.push({ id: target.id, path: target.path, changed: false, details: ["missing"] });
      continue;
    }
    const result = migrateDatabase(target, report.apply);
    report.databases.push({ id: target.id, path: target.path, ...result });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.apply) process.stdout.write("Stage 0 naming migration applied.\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function migrateDatabase(target: MigrationTarget, apply: boolean): { changed: boolean; details: string[] } {
  const db = new DatabaseSync(target.path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  let transactionStarted = false;
  let foreignKeysDisabled = false;
  let originalJournalMode: "wal" | undefined;
  try {
    const details = target.id === "preset-models"
      ? presetModelDetails(db)
      : target.id === "sessions"
        ? sessionDetails(db)
        : computeDetails(db);
    const changed = details.length > 0;
    if (!changed || !apply) return { changed, details };

    const backup = `${target.path}.stage0-backup-${timestamp}`;
    originalJournalMode = prepareJournalModeForMigration(db);
    if (target.id === "preset-models") {
      db.exec("PRAGMA foreign_keys = OFF");
      foreignKeysDisabled = true;
    }
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    // The write lock is acquired before copying. This keeps the backup and the
    // subsequent rewrite on one consistent SQLite snapshot. WAL databases are
    // temporarily switched to rollback journaling so the backup is a single
    // file rather than an incomplete main file plus a separate WAL.
    copyFileSync(target.path, backup);
    report.backups.push(backup);
    if (target.id === "preset-models") {
      migratePresetModels(db);
      recompilePresetModels(db);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(`Preset Model migration foreign key violations: ${JSON.stringify(violations)}`);
      }
    } else if (target.id === "sessions") {
      migrateSessions(db);
    } else {
      migrateCompute(db);
    }
    db.exec("COMMIT");
    transactionStarted = false;
    if (foreignKeysDisabled) {
      db.exec("PRAGMA foreign_keys = ON");
      foreignKeysDisabled = false;
    }
    restoreJournalMode(db, originalJournalMode);
    originalJournalMode = undefined;
    return {
      changed: true,
      details: target.id === "preset-models" ? [...details, "recompiled snapshots and plugin locks"] : details,
    };
  } catch (error) {
    if (transactionStarted && db.isOpen) {
      try {
        db.exec("ROLLBACK");
      } finally {
        transactionStarted = false;
      }
    }
    if (foreignKeysDisabled) {
      db.exec("PRAGMA foreign_keys = ON");
      foreignKeysDisabled = false;
    }
    // Restore the original mode even when compilation or a data rewrite fails;
    // the transaction has already been rolled back, so the source is unchanged.
    restoreJournalMode(db, originalJournalMode);
    throw error;
  } finally {
    if (db.isOpen) db.close();
  }
}

function presetModelDetails(db: DatabaseSync): string[] {
  if (!hasTable(db, "preset_model_versions") || !hasTable(db, "preset_models")) return [];
  const oldVersions = count(db, "SELECT count(*) AS count FROM preset_model_versions WHERE name = 'anomalo'"); // naming-compat
  const oldParent = count(db, "SELECT count(*) AS count FROM preset_models WHERE name = 'anomalo'"); // naming-compat
  const staleDescriptions = legacyDescriptionCount(db, "preset_model_versions") + legacyDescriptionCount(db, "preset_models");
  const stalePluginLocks = stalePluginLockCount(db);
  if (oldVersions === 0 && oldParent === 0 && staleDescriptions === 0 && stalePluginLocks === 0) return [];
  const newVersions = count(db, "SELECT count(*) AS count FROM preset_model_versions WHERE name = 'anomaloharis'"); // naming-compat
  const duplicateIdentities = oldVersions > 0 && newVersions > 0;
  if (duplicateIdentities && !duplicatePresetModelsCompatible(db)) {
    throw new Error("Cannot migrate preset models: legacy and canonical identities contain different definitions.");
  }
  return [
    ...(oldVersions > 0 || oldParent > 0 ? [`preset model rows: ${oldVersions}`, `preset model parent rows: ${oldParent}`] : []),
    ...(duplicateIdentities ? ["consolidate duplicate preset model identities"] : []),
    ...(staleDescriptions > 0 ? [`canonicalize preset model descriptions: ${staleDescriptions}`] : []),
    ...(stalePluginLocks > 0 ? [`recompile stale plugin locks: ${stalePluginLocks}`] : []),
  ];
}

function migratePresetModels(db: DatabaseSync): void {
  const oldVersions = count(db, "SELECT count(*) AS count FROM preset_model_versions WHERE name = 'anomalo'"); // naming-compat
  const newVersions = count(db, "SELECT count(*) AS count FROM preset_model_versions WHERE name = 'anomaloharis'"); // naming-compat
  if (oldVersions > 0 && newVersions > 0) {
    db.prepare("DELETE FROM preset_model_plugin_locks WHERE name = 'anomalo'").run(); // naming-compat
    db.prepare("DELETE FROM preset_model_versions WHERE name = 'anomalo'").run(); // naming-compat
    db.prepare("DELETE FROM preset_models WHERE name = 'anomalo'").run(); // naming-compat
  }
  const rows = db.prepare(
    "SELECT version, definition_json, compiled_snapshot_json FROM preset_model_versions WHERE name IN ('anomalo', 'anomaloharis')", // naming-compat
  ).all() as Array<Record<string, unknown>>;
  db.prepare("UPDATE preset_model_plugin_locks SET name = 'anomaloharis', package_name = replace(package_name, '@anomalo/', '@anomaloharis/') WHERE name = 'anomalo'").run(); // naming-compat
  db.prepare("UPDATE preset_model_versions SET name = 'anomaloharis' WHERE name = 'anomalo'").run(); // naming-compat
  db.prepare("UPDATE preset_models SET name = 'anomaloharis' WHERE name = 'anomalo'").run(); // naming-compat
  rewriteLegacyDescriptionColumn(db, "preset_model_versions");
  rewriteLegacyDescriptionColumn(db, "preset_models");
  const update = db.prepare(`
    UPDATE preset_model_versions
    SET definition_json = ?, compiled_snapshot_json = ?
    WHERE name = 'anomaloharis' AND version = ?
  `);
  for (const row of rows) {
    update.run(
      rewriteJsonString(String(row.definition_json)),
      rewriteJsonString(String(row.compiled_snapshot_json)),
      Number(row.version),
    );
  }
}

function recompilePresetModels(db: DatabaseSync): void {
  const resources = new FileResourceLoader({
    projectRoot: repoRoot,
    skillDirs: [join(repoRoot, "runtime-bundle", "skills")],
    mcpConfigPath: join(repoRoot, "runtime-bundle", "config", "mcp_servers.yaml"),
  });
  const registry = new SqlitePresetModelRegistry(":memory:", {
    database: db,
    catalog: builtinPluginCatalog(),
    resolvePrompt: (profile) => resources.promptText(profile),
    allowLegacySnapshotRecompile: true,
  });
  try {
    registry.recompileAll({ transactionAlreadyOpen: true });
  } finally {
    registry.close();
  }
}

function sessionDetails(db: DatabaseSync): string[] {
  const details: string[] = [];
  for (const [table, column] of [
    ["agent_sessions", "metadata_json"],
    ["session_entries", "payload_json"],
    ["runs", "config_json"],
    ["run_checkpoints", "state_json"],
    ["web_traces", "payload_json"],
    ["sessions", "checkpoint_json"],
    ["sessions", "web_traces_json"],
  ] as const) {
    if (hasColumn(db, table, column) && countLike(db, table, column, "anomalo@")) details.push(`${table}.${column}`); // naming-compat
  }
  return details;
}

function migrateSessions(db: DatabaseSync): void {
  for (const [table, column] of [
    ["agent_sessions", "metadata_json"],
    ["session_entries", "payload_json"],
    ["runs", "config_json"],
    ["run_checkpoints", "state_json"],
    ["web_traces", "payload_json"],
    ["sessions", "checkpoint_json"],
    ["sessions", "web_traces_json"],
  ] as const) rewriteJsonColumn(db, table, column);
}

function computeDetails(db: DatabaseSync): string[] {
  const details: string[] = [];
  if (hasColumn(db, "usage_records", "model_ref") && countLike(db, "usage_records", "model_ref", "anomalo@")) details.push("usage_records.model_ref"); // naming-compat
  if (hasColumn(db, "native_runs", "model_ref") && countLike(db, "native_runs", "model_ref", "anomalo@")) details.push("native_runs.model_ref"); // naming-compat
  if (hasColumn(db, "native_run_events", "event_json") && countLike(db, "native_run_events", "event_json", "anomalo@")) details.push("native_run_events.event_json"); // naming-compat
  if (hasColumn(db, "idempotency_records", "response_json") && countLike(db, "idempotency_records", "response_json", "anomalo@")) details.push("idempotency_records.response_json"); // naming-compat
  return details;
}

function migrateCompute(db: DatabaseSync): void {
  migratePresetModelRefColumn(db, "usage_records", "model_ref");
  migratePresetModelRefColumn(db, "native_runs", "model_ref");
  rewriteJsonColumn(db, "native_run_events", "event_json");
  rewriteJsonColumn(db, "idempotency_records", "response_json");
}

function prepareJournalModeForMigration(db: DatabaseSync): "wal" | undefined {
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
  if (String(row?.journal_mode ?? "").toLowerCase() !== "wal") return undefined;
  const switched = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: string } | undefined;
  if (String(switched?.journal_mode ?? "").toLowerCase() !== "delete") {
    throw new Error("Cannot create a consistent Stage 0 backup: failed to switch SQLite out of WAL mode.");
  }
  return "wal";
}

function restoreJournalMode(db: DatabaseSync, originalMode: "wal" | undefined): void {
  if (!originalMode) return;
  const restored = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined;
  if (String(restored?.journal_mode ?? "").toLowerCase() !== originalMode) {
    throw new Error(`Failed to restore SQLite journal mode ${originalMode}.`);
  }
}

function migratePresetModelRefColumn(db: DatabaseSync, table: string, column: string): void {
  if (!hasColumn(db, table, column)) return;
  const rows = db.prepare(`SELECT rowid AS row_id, ${column} AS value FROM ${table} WHERE ${column} LIKE '%anomalo@%'`).all() as Array<{ row_id: number; value: string }>; // naming-compat
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  for (const row of rows) {
    const rewritten = canonicalizePresetModelRef(row.value);
    if (rewritten !== row.value) update.run(rewritten, row.row_id);
  }
}

function rewriteJsonColumn(db: DatabaseSync, table: string, column: string): void {
  if (!hasColumn(db, table, column)) return;
  const rows = db.prepare(`SELECT rowid AS row_id, ${column} AS value FROM ${table} WHERE ${column} LIKE '%anomalo@%'`).all() as Array<{ row_id: number; value: string }>; // naming-compat
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  for (const row of rows) {
    const rewritten = rewriteJsonString(row.value);
    if (rewritten !== row.value) update.run(rewritten, row.row_id);
  }
}

function rewriteJsonString(value: string): string {
  try {
    return JSON.stringify(rewriteJsonValue(JSON.parse(value), ""));
  } catch {
    return value.replace(/\banomalo@([1-9][0-9]*)\b/g, "anomaloharis@$1"); // naming-compat
  }
}

function rewriteJsonValue(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if (key === "name" || key === "ref" || key.endsWith("_ref") || key.endsWith("Ref")) return canonicalizePresetModelRef(canonicalizePresetModelName(value));
    if (key === "description") return value.replace(/\bAnomalo\b/g, "AnomaloHaris").replace(/\banomalo\b/g, "anomaloharis");
    if (value === "anomalo") return "anomaloharis"; // naming-compat
    if (value.startsWith("@anomalo/")) return `@anomaloharis/${value.slice("@anomalo/".length)}`; // naming-compat
    return canonicalizePresetModelRef(value);
  }
  if (Array.isArray(value)) return value.map((item) => rewriteJsonValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, rewriteJsonValue(childValue, childKey)]));
  }
  return value;
}

function legacyDescriptionCount(db: DatabaseSync, table: string): number {
  if (!hasColumn(db, table, "description")) return 0;
  const rows = db.prepare(`SELECT description FROM ${table}`).all() as Array<{ description: string }>;
  return rows.filter((row) => /\bAnomalo\b/.test(row.description)).length;
}

function rewriteLegacyDescriptionColumn(db: DatabaseSync, table: string): void {
  if (!hasColumn(db, table, "description")) return;
  const rows = db.prepare(`SELECT rowid AS row_id, description FROM ${table}`).all() as Array<{ row_id: number; description: string }>;
  const update = db.prepare(`UPDATE ${table} SET description = ? WHERE rowid = ?`);
  for (const row of rows) {
    const rewritten = row.description.replace(/\bAnomalo\b/g, "AnomaloHaris");
    if (rewritten !== row.description) update.run(rewritten, row.row_id);
  }
}

function stalePluginLockCount(db: DatabaseSync): number {
  if (!hasTable(db, "preset_model_versions")) return 0;
  const catalog = builtinPluginCatalog();
  const rows = db.prepare("SELECT compiled_snapshot_json FROM preset_model_versions").all() as Array<{ compiled_snapshot_json: string }>;
  let count = 0;
  for (const row of rows) {
    let snapshot: { pluginLocks?: unknown };
    try {
      snapshot = JSON.parse(row.compiled_snapshot_json) as { pluginLocks?: unknown };
    } catch {
      count += 1;
      continue;
    }
    if (!Array.isArray(snapshot.pluginLocks)) continue;
    try {
      catalog.assertCurrent(snapshot.pluginLocks as PluginLock[]);
    } catch {
      count += 1;
    }
  }
  return count;
}

function duplicatePresetModelsCompatible(db: DatabaseSync): boolean {
  const oldParent = db.prepare("SELECT description FROM preset_models WHERE name = 'anomalo'").get() as { description?: string } | undefined; // naming-compat
  const newParent = db.prepare("SELECT description FROM preset_models WHERE name = 'anomaloharis'").get() as { description?: string } | undefined; // naming-compat
  if (!oldParent || !newParent) return false;
  if (normalizeDescription(oldParent.description) !== normalizeDescription(newParent.description)) return false;

  const oldRows = db.prepare("SELECT version, status, description, definition_json FROM preset_model_versions WHERE name = 'anomalo' ORDER BY version").all() as Array<Record<string, unknown>>; // naming-compat
  const newRows = db.prepare("SELECT version, status, description, definition_json FROM preset_model_versions WHERE name = 'anomaloharis' ORDER BY version").all() as Array<Record<string, unknown>>; // naming-compat
  if (oldRows.length !== newRows.length) return false;
  return oldRows.every((oldRow, index) => {
    const newRow = newRows[index];
    return Number(oldRow.version) === Number(newRow?.version)
      && String(oldRow.status) === String(newRow?.status)
      && normalizeDescription(String(oldRow.description)) === normalizeDescription(String(newRow?.description))
      && normalizeJson(rewriteJsonString(String(oldRow.definition_json))) === normalizeJson(String(newRow?.definition_json));
  });
}

function normalizeDescription(value: string | undefined): string {
  return String(value ?? "").replace(/\bAnomalo\b/g, "AnomaloHaris");
}

function normalizeJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return hasTable(db, table) && (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

function count(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { count: number }).count);
}

function countLike(db: DatabaseSync, table: string, column: string, value: string): number {
  return Number((db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} LIKE ?`).get(`%${value}%`) as { count: number }).count);
}

function configuredDatabasePath(flag: string, envName: string, fallback: string): string {
  return flagValue(flag) || legacyNamingAdapter.readEnv(process.env, envName) || fallback;
}

function flagValue(flag: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
