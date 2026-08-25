import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { legacyNamingAdapter } from "@anomaloharis/contracts";
import { FileResourceLoader } from "./resources.js";
import { builtinPluginCatalog } from "./plugin-catalog.js";
import { SqlitePresetModelRegistry, type LegacyPresetAgent } from "./preset-models.js";
import type { BootstrapToolRequest } from "./types.js";

const args = new Set(process.argv.slice(2));
const sourcePath = flagValue("--source");
const targetPath = flagValue("--target") ?? legacyNamingAdapter.readEnv(process.env, "ANOMALOHARIS_PRESET_MODEL_DB_PATH") ?? defaultTargetPath();

if (!sourcePath || !targetPath) {
  console.error("Usage: npm run migrate:preset-models -- --source <preset-agents.sqlite3> [--target <preset-models.sqlite3>] [--apply]");
  process.exitCode = 2;
} else {
  try {
    const agents = readLegacyAgents(sourcePath);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
    const resources = new FileResourceLoader({
      projectRoot: repoRoot,
      skillDirs: [join(repoRoot, "runtime-bundle", "skills")],
      mcpConfigPath: join(repoRoot, "runtime-bundle", "config", "mcp_servers.yaml"),
    });
    const registry = new SqlitePresetModelRegistry(targetPath, {
      catalog: builtinPluginCatalog(),
      resolvePrompt: (profile) => resources.promptText(profile),
    });
    try {
      const report = registry.migrateLegacyAgents(agents, {
        dryRun: !args.has("--apply"),
        publish: true,
      });
      process.stdout.write(`${JSON.stringify({ source: sourcePath, target: targetPath, ...report })}\n`);
      if (report.errors.length > 0) process.exitCode = 1;
    } finally {
      registry.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function readLegacyAgents(dbPath: string): LegacyPresetAgent[] {
  if (!existsSync(dbPath)) throw new Error(`Legacy Preset Agent database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preset_agents'").get();
    if (!table) throw new Error(`Legacy Preset Agent table not found: ${dbPath}`);
    const rows = db.prepare(`
      SELECT id, name, description, ghost, system_prompt, model, temperature,
        tool_names_json, tool_sources_json, bootstrap_tools_json, search_mode
      FROM preset_agents ORDER BY name ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const id = stringValue(row.id);
      const description = stringValue(row.description);
      const ghost = stringValue(row.ghost);
      const systemPrompt = stringValue(row.system_prompt);
      const model = stringValue(row.model);
      const temperature = typeof row.temperature === "number" ? row.temperature : undefined;
      const toolSources = recordValue(row.tool_sources_json);
      const bootstrapTools = bootstrapToolRequests(row.bootstrap_tools_json);
      const searchMode = stringValue(row.search_mode);
      return {
        name: stringValue(row.name) ?? "",
        ...(id === undefined ? {} : { id }),
        ...(description === undefined ? {} : { description }),
        ...(ghost === undefined ? {} : { ghost }),
        ...(systemPrompt === undefined ? {} : { system_prompt: systemPrompt }),
        ...(model === undefined ? {} : { model }),
        ...(temperature === undefined ? {} : { temperature }),
        tool_names: stringArray(row.tool_names_json),
        ...(toolSources === undefined ? {} : { tool_sources: toolSources }),
        ...(bootstrapTools.length === 0 ? {} : { bootstrap_tools: bootstrapTools }),
        ...(searchMode === undefined ? {} : { search_mode: searchMode }),
      } satisfies LegacyPresetAgent;
    });
  } finally {
    db.close();
  }
}

function flagValue(flag: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultTargetPath(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
  return join(repoRoot, "data", "preset-models.sqlite3");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function recordValue(value: unknown): Record<string, string> | undefined {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return Object.fromEntries(Object.entries(parsed).filter(([, item]) => typeof item === "string")) as Record<string, string>;
}

function bootstrapToolRequests(value: unknown): BootstrapToolRequest[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.name !== "string") return [];
    const record = item as Record<string, unknown>;
    const args = record.arguments;
    return [{
      name: item.name,
      ...(typeof record.resultKey === "string" ? { resultKey: record.resultKey } : {}),
      ...(args && typeof args === "object" && !Array.isArray(args) ? { arguments: args as Record<string, unknown> } : {}),
      ...(typeof record.required === "boolean" ? { required: record.required } : {}),
    }];
  });
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
