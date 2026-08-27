import { createHash } from "node:crypto";

import type { ToolCall, ToolDefinition, ToolResult } from "@anomaloharis/contracts";

import type { ToolContext } from "./types.js";
import type { ToolRuntime } from "./tools.js";

export const SKILL_ACTIVATE_TOOL_NAME = "skill_activate";
export const SKILL_SNAPSHOT_VERSION = 1 as const;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1_024;

export type RawSkillDocument = {
  content: string;
  path?: string | undefined;
};

export type ParsedSkillDocument = {
  name: string;
  description: string;
  body: string;
  contentHash: string;
  requiredPluginIds?: string[] | undefined;
};

export type SkillDescriptor = {
  name: string;
  description: string;
  requiredPluginIds?: string[] | undefined;
};

export type CompiledSkill = SkillDescriptor & {
  body: string;
  contentHash: string;
};

export type CompiledSkillSnapshot = {
  snapshotVersion: typeof SKILL_SNAPSHOT_VERSION;
  catalogHash: string;
  skills: CompiledSkill[];
};

export type ActivatedSkill = {
  name: string;
  description: string;
  body: string;
  contentHash: string;
  requiredPluginIds?: string[] | undefined;
  alreadyActive: boolean;
};

/**
 * The deep Skill Module. It owns the Agent Skills document contract, the
 * immutable compiled snapshot, catalog formatting, and activation lookup.
 * Callers do not need to know how frontmatter or hashes are represented.
 */
export class SkillRuntime {
  compile(documents: readonly RawSkillDocument[]): CompiledSkillSnapshot | undefined {
    if (documents.length === 0) return undefined;
    const compiled: CompiledSkill[] = [];
    const names = new Set<string>();
    for (const document of documents) {
      const parsed = parseSkillDocument(document.content);
      if (names.has(parsed.name)) throw new Error(`skill_duplicate_name:${parsed.name}`);
      names.add(parsed.name);
      compiled.push(parsed);
    }
    compiled.sort((left, right) => left.name.localeCompare(right.name));
    return {
      snapshotVersion: SKILL_SNAPSHOT_VERSION,
      catalogHash: catalogHash(compiled),
      skills: compiled,
    };
  }

  catalog(snapshot: CompiledSkillSnapshot | undefined): SkillDescriptor[] {
    return snapshot?.skills.map(({ name, description }) => ({ name, description })) ?? [];
  }

  catalogMessage(snapshot: CompiledSkillSnapshot | undefined): string | undefined {
    const entries = this.catalog(snapshot);
    if (entries.length === 0) return undefined;
    return [
      "Available Skill catalog:",
      "Select a matching Skill with the skill_activate tool before applying its instructions.",
      ...entries.map((skill) => `- ${skill.name}: ${skill.description}`),
    ].join("\n");
  }

  activate(
    snapshot: CompiledSkillSnapshot | undefined,
    name: string,
    activeNames: ReadonlySet<string> = new Set(),
  ): ActivatedSkill {
    const normalized = name.trim();
    const skill = snapshot?.skills.find((candidate) => candidate.name === normalized);
    if (!skill) throw new Error(`skill_not_found:${normalized || "unknown"}`);
    return {
      ...structuredClone(skill),
      alreadyActive: activeNames.has(skill.name),
    };
  }
}

/**
 * Production ToolRuntime Adapter for model-selected Skills. The adapter is
 * intentionally narrow: it can only address the immutable snapshot supplied
 * in ToolContext and never reads an arbitrary host filesystem path.
 */
export class SkillToolRuntime implements ToolRuntime {
  constructor(
    private readonly runtime: SkillRuntime,
    private readonly defaultSnapshot?: CompiledSkillSnapshot,
  ) {}

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    const snapshot = mergedSnapshot(
      this.runtime,
      context.presetModelRef ? undefined : filterSkillSnapshot(this.defaultSnapshot, context.allowedPluginIds),
      filterSkillSnapshot(context.skillSnapshot, context.allowedPluginIds),
    );
    const catalog = this.runtime.catalog(snapshot);
    if (catalog.length === 0) return [];
    return [{
      name: SKILL_ACTIVATE_TOOL_NAME,
      description: "Load the full instructions for one matching Agent Skill into the current run.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: catalog.map((skill) => skill.name),
            description: "The exact Skill name from the available Skill catalog.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      source: "agent-skill",
    }];
  }

  async call(call: ToolCall, context: ToolContext, _signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== SKILL_ACTIVATE_TOOL_NAME) {
      return { name: call.name, ok: false, content: `Tool not found: ${call.name}`, data: { error_code: "tool_not_found" } };
    }
    const snapshot = mergedSnapshot(
      this.runtime,
      context.presetModelRef ? undefined : filterSkillSnapshot(this.defaultSnapshot, context.allowedPluginIds),
      filterSkillSnapshot(context.skillSnapshot, context.allowedPluginIds),
    );
    const requestedName = typeof call.arguments.name === "string"
      ? call.arguments.name
      : typeof call.arguments.skill_name === "string"
        ? call.arguments.skill_name
        : "";
    try {
      const activated = this.runtime.activate(snapshot, requestedName, context.activeSkills);
      return {
        name: call.name,
        ok: true,
        content: `Skill ${activated.name} is active. Its instructions are now included in the next model context.`,
        data: {
          skill_action: "activate",
          skill_name: activated.name,
          skill_hash: activated.contentHash,
          already_active: activated.alreadyActive,
        },
      };
    } catch (error) {
      return {
        name: call.name,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        data: { error_code: error instanceof Error ? error.message.split(":", 1)[0] : "skill_activation_failed" },
      };
    }
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    const snapshot = mergedSnapshot(
      this.runtime,
      context.presetModelRef ? undefined : filterSkillSnapshot(this.defaultSnapshot, context.allowedPluginIds),
      filterSkillSnapshot(context.skillSnapshot, context.allowedPluginIds),
    );
    return [{
      provider: "agent-skill",
      available: Boolean(snapshot?.skills.length),
      skill_count: snapshot?.skills.length ?? 0,
      catalog_hash: snapshot?.catalogHash,
    }];
  }
}

export function parseSkillDocument(content: string): ParsedSkillDocument {
  const source = content.replace(/^\uFEFF/, "");
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("skill_frontmatter_required");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error("skill_frontmatter_unclosed");
  const frontmatter = parseFrontmatter(lines.slice(1, end));
  const name = frontmatter.name?.trim() ?? "";
  const description = frontmatter.description?.trim() ?? "";
  const requiredPluginIds = parseRequiredPluginIds(frontmatter.requires_plugins);
  validateSkillName(name);
  if (!description) throw new Error("skill_description_required");
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) throw new Error("skill_description_too_long");
  const body = lines.slice(end + 1).join("\n").replace(/^\n/, "").trim();
  return {
    name,
    description,
    body,
    contentHash: sha256(source),
    ...(requiredPluginIds ? { requiredPluginIds } : {}),
  };
}

export function validateSkillName(name: string): void {
  if (name.length === 0 || name.length > MAX_SKILL_NAME_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("skill_name_invalid");
  }
}

export function mergeSkillSnapshots(
  runtime: SkillRuntime,
  base: CompiledSkillSnapshot | undefined,
  overlay: CompiledSkillSnapshot | undefined,
): CompiledSkillSnapshot | undefined {
  if (!base && !overlay) return undefined;
  const byName = new Map<string, CompiledSkill>();
  for (const skill of base?.skills ?? []) byName.set(skill.name, structuredClone(skill));
  // A Preset Model's embedded Skill is the explicit model-scoped choice and
  // therefore wins over a same-named bundled Skill.
  for (const skill of overlay?.skills ?? []) byName.set(skill.name, structuredClone(skill));
  const skills = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    snapshotVersion: SKILL_SNAPSHOT_VERSION,
    catalogHash: catalogHash(skills),
    skills,
  };
}

export function filterSkillSnapshot(
  snapshot: CompiledSkillSnapshot | undefined,
  allowedPluginIds: ReadonlySet<string> | undefined,
): CompiledSkillSnapshot | undefined {
  if (!snapshot || !allowedPluginIds) return snapshot;
  const skills = snapshot.skills.filter((skill) => (skill.requiredPluginIds ?? []).every((pluginId) => allowedPluginIds.has(pluginId)));
  if (skills.length === 0) return undefined;
  if (skills.length === snapshot.skills.length) return snapshot;
  return {
    snapshotVersion: snapshot.snapshotVersion,
    catalogHash: catalogHash(skills),
    skills,
  };
}

export function parseSkillSnapshot(value: unknown): CompiledSkillSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.snapshotVersion !== SKILL_SNAPSHOT_VERSION || typeof candidate.catalogHash !== "string" || !Array.isArray(candidate.skills)) return undefined;
  const skills = candidate.skills.filter((skill): skill is CompiledSkill => {
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) return false;
    const value = skill as Record<string, unknown>;
    return typeof value.name === "string"
      && typeof value.description === "string"
      && typeof value.body === "string"
      && typeof value.contentHash === "string"
      && (value.requiredPluginIds === undefined || Array.isArray(value.requiredPluginIds));
  }).map((skill) => structuredClone(skill));
  if (skills.length !== candidate.skills.length) return undefined;
  try {
    let previousName = "";
    for (const skill of skills) {
      validateSkillName(skill.name);
      if (!skill.description.trim() || skill.description.length > MAX_SKILL_DESCRIPTION_LENGTH) return undefined;
      if (previousName && previousName.localeCompare(skill.name) >= 0) return undefined;
      if (!/^[0-9a-f]{64}$/.test(skill.contentHash)) return undefined;
      if (skill.requiredPluginIds !== undefined) {
        if (skill.requiredPluginIds.some((pluginId) => typeof pluginId !== "string" || !isPluginId(pluginId))) return undefined;
        if ([...new Set(skill.requiredPluginIds)].length !== skill.requiredPluginIds.length) return undefined;
        if ([...skill.requiredPluginIds].sort((left, right) => left.localeCompare(right)).join(",") !== skill.requiredPluginIds.join(",")) return undefined;
      }
      previousName = skill.name;
    }
  } catch {
    return undefined;
  }
  if (catalogHash(skills) !== candidate.catalogHash) return undefined;
  return { snapshotVersion: SKILL_SNAPSHOT_VERSION, catalogHash: candidate.catalogHash, skills };
}

function mergedSnapshot(
  runtime: SkillRuntime,
  base: CompiledSkillSnapshot | undefined,
  overlay: CompiledSkillSnapshot | undefined,
): CompiledSkillSnapshot | undefined {
  if (!overlay) return base;
  if (!base) return overlay;
  return mergeSkillSnapshots(runtime, base, overlay);
}

function parseFrontmatter(lines: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error("skill_frontmatter_invalid");
    const key = match[1]!.replaceAll("-", "_");
    if (values[key] !== undefined) throw new Error(`skill_frontmatter_duplicate:${key}`);
    let value = match[2] ?? "";
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const block: string[] = [];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (next.trim() && !/^\s+/.test(next)) {
          index -= 1;
          break;
        }
        block.push(next.replace(/^\s{2}/, ""));
        index += 1;
      }
      value = value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else {
      value = parseScalar(value);
    }
    values[key] = value;
  }
  return values;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function catalogHash(skills: readonly SkillDescriptor[]): string {
  return sha256(JSON.stringify(skills.map(({ name, description, requiredPluginIds }) => ({
    name,
    description,
    ...(requiredPluginIds?.length ? { required_plugin_ids: requiredPluginIds } : {}),
  }))));
}

function parseRequiredPluginIds(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const source = value.trim();
  let values: unknown;
  if (source.startsWith("[") && source.endsWith("]")) {
    try {
      values = JSON.parse(source);
    } catch {
      throw new Error("skill_required_plugins_invalid");
    }
  } else {
    values = source.split(",");
  }
  if (!Array.isArray(values)) throw new Error("skill_required_plugins_invalid");
  const pluginIds = [...new Set(values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  if (pluginIds.length !== values.length || pluginIds.some((pluginId) => !isPluginId(pluginId))) throw new Error("skill_required_plugins_invalid");
  return pluginIds;
}

function isPluginId(value: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
