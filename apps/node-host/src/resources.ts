import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ModelMessage } from "./types.js";

export type ResourceSnapshotRequest = {
  promptProfile: string;
  searchMode: string;
  activeSkills: ReadonlySet<string>;
  activeMcpServers: ReadonlySet<string>;
  systemPrompt?: string | undefined;
};

export type ResourceSnapshot = {
  messages: ModelMessage[];
  promptMessages: ModelMessage[];
  searchMessages: ModelMessage[];
  memoryMessages: ModelMessage[];
  skillCatalogMessages: ModelMessage[];
  mcpCatalogMessages: ModelMessage[];
  skillInstructions: Record<string, string>;
  mcpInstructions: Record<string, string>;
  activeSkillNames: string[];
  activeMcpServers: string[];
  diagnostics: {
    memoryFiles: number;
    skillCatalogEntries: number;
    activeSkillFiles: number;
    mcpCatalogEntries: number;
    activeMcpFiles: number;
  };
};

export interface ResourceLoader {
  snapshot(request: ResourceSnapshotRequest): Promise<ResourceSnapshot>;
}

export type FileResourceLoaderOptions = {
  projectRoot: string;
  skillDirs?: readonly string[];
  promptConfigPath?: string;
  mcpConfigPath?: string;
  maxFileBytes?: number;
};

/**
 * Loads trusted, local prompt resources without exposing the filesystem to a
 * plugin. The result is a run-level snapshot; callers must not rebuild it on
 * every model turn.
 */
export class FileResourceLoader implements ResourceLoader {
  private readonly projectRoot: string;
  private readonly skillDirs: readonly string[];
  private readonly promptConfigPath: string;
  private readonly mcpConfigPath: string;
  private readonly mcpInstructionDir: string;
  private readonly maxFileBytes: number;

  constructor(options: FileResourceLoaderOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.skillDirs = options.skillDirs ?? [join(this.projectRoot, "skills")];
    this.promptConfigPath = options.promptConfigPath ?? join(this.projectRoot, "agent-backend", "config", "prompts.yaml");
    this.mcpConfigPath = options.mcpConfigPath ?? join(this.projectRoot, "config", "mcp_servers.yaml");
    this.mcpInstructionDir = join(dirname(this.mcpConfigPath), "mcp");
    this.maxFileBytes = options.maxFileBytes ?? 256_000;
  }

  async snapshot(request: ResourceSnapshotRequest): Promise<ResourceSnapshot> {
    const promptMessages: ModelMessage[] = request.systemPrompt
      ? [{ role: "system", content: request.systemPrompt }]
      : [];
    const prompt = request.systemPrompt ? undefined : this.readPromptProfile(request.promptProfile);
    if (prompt) promptMessages.push({ role: "system", content: prompt });
    const searchMessages: ModelMessage[] = [{
      role: "system",
      content: `Search mode for this run: ${request.searchMode}. Use only the tools made available for this mode.`,
    }];
    const memoryMessages: ModelMessage[] = [];
    const memoryFiles = this.readMemoryFiles(memoryMessages);

    const skills = this.readSkills();
    const skillCatalogMessages: ModelMessage[] = [];
    if (skills.length > 0) {
      skillCatalogMessages.push({
        role: "system",
        content: `Available Skill catalog:\n${skills.map((skill) => `- ${skill.name}: ${skill.summary}`).join("\n")}`,
      });
    }
    const activeSkills = [...request.activeSkills].filter((name) => skills.some((skill) => skill.name === name));
    const mcp = this.readMcpCatalog();
    const mcpCatalogMessages: ModelMessage[] = [];
    if (mcp.names.length > 0) {
      mcpCatalogMessages.push({ role: "system", content: `Available MCP catalog:\n${mcp.names.map((name) => `- ${name}`).join("\n")}` });
    }
    const activeMcpServers = [...request.activeMcpServers].filter((name) => mcp.names.includes(name));
    const messages = [
      ...promptMessages,
      ...searchMessages,
      ...memoryMessages,
      ...skillCatalogMessages,
      ...mcpCatalogMessages,
    ];

    return {
      messages,
      promptMessages,
      searchMessages,
      memoryMessages,
      skillCatalogMessages,
      mcpCatalogMessages,
      skillInstructions: Object.fromEntries(skills.filter((skill) => skill.content).map((skill) => [skill.name, skill.content])),
      mcpInstructions: Object.fromEntries(mcp.instructions),
      activeSkillNames: activeSkills,
      activeMcpServers,
      diagnostics: {
        memoryFiles,
        skillCatalogEntries: skills.length,
        activeSkillFiles: activeSkills.filter((name) => skills.some((skill) => skill.name === name && skill.content)).length,
        mcpCatalogEntries: mcp.names.length,
        activeMcpFiles: activeMcpServers.filter((name) => mcp.instructions.has(name)).length,
      },
    };
  }

  private readMemoryFiles(messages: ModelMessage[]): number {
    const candidates = [
      join(this.projectRoot, "AGENTS.md"),
      join(this.projectRoot, "agent-backend", "config", "AGENTS.md"),
      join(this.projectRoot, "docs", "AGENTS.md"),
    ];
    let count = 0;
    for (const path of candidates) {
      const content = readBoundedFile(path, this.maxFileBytes);
      if (!content) continue;
      messages.push({ role: "system", content: `AGENTS.md memory (${path}):\n${content}` });
      count += 1;
    }
    return count;
  }

  private readPromptProfile(profile: string): string | undefined {
    const normalized = profile.trim();
    if (!normalized) return undefined;
    const candidates = [
      join(this.projectRoot, "prompts", `${normalized}.md`),
      join(this.projectRoot, "agent-backend", "prompts", `${normalized}.md`),
      join(this.projectRoot, "agent-backend", "config", "prompts", `${normalized}.md`),
    ];
    for (const path of candidates) {
      const content = readBoundedFile(path, this.maxFileBytes);
      if (content) return `Prompt profile: ${normalized}\n${content}`;
    }
    const yamlPaths = [this.promptConfigPath, join(this.projectRoot, "config", "prompts.yaml")];
    for (const yamlPath of [...new Set(yamlPaths)]) {
      const yamlContent = readPromptYamlProfile(yamlPath, normalized);
      if (yamlContent) return `Prompt profile: ${normalized}\n${yamlContent}`;
    }
    return undefined;
  }

  private readSkills(): Array<{ name: string; summary: string; content: string }> {
    const skills = new Map<string, { name: string; summary: string; content: string }>();
    for (const directory of this.skillDirs) {
      for (const path of findFiles(directory, "SKILL.md")) {
        const content = readBoundedFile(path, this.maxFileBytes) ?? "";
        const name = skillName(path);
        const summary = content.split("\n").find((line) => line.trim() && !line.trim().startsWith("#"))?.trim() ?? name;
        skills.set(name, { name, summary, content });
      }
    }
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private readMcpCatalog(): { names: string[]; instructions: Map<string, string> } {
    const content = readBoundedFile(this.mcpConfigPath, this.maxFileBytes);
    if (!content) return { names: [], instructions: new Map() };
    const names = new Set<string>();
    const instructions = new Map<string, string>();
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:[-]\s*)?([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (match?.[1] && !["servers", "mcp", "mcp_servers", "command", "args", "env", "url"].includes(match[1])) names.add(match[1]);
      const named = line.match(/^\s*-?\s*name:\s*['"]?([^'"#]+)['"]?\s*$/);
      if (named?.[1]) names.add(named[1].trim());
    }
    for (const name of names) {
      const instructionPath = join(this.mcpInstructionDir, `${name}.md`);
      const text = readBoundedFile(instructionPath, this.maxFileBytes);
      if (text) instructions.set(name, text);
    }
    return { names: [...names].sort(), instructions };
  }
}

function findFiles(directory: string, filename: string): string[] {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  const visit = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === filename) result.push(path);
    }
  };
  visit(directory);
  return result.sort();
}

function readBoundedFile(path: string, maxBytes: number): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    const content = readFileSync(path, "utf8");
    return Buffer.byteLength(content, "utf8") > maxBytes ? content.slice(0, maxBytes) : content;
  } catch {
    return undefined;
  }
}

function skillName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.at(-2) || "skill";
}

function readPromptYamlProfile(path: string, profile: string): string | undefined {
  const source = readBoundedFile(path, 2_000_000);
  if (!source) return undefined;
  const lines = source.split(/\r?\n/);
  const profileIndex = lines.findIndex((line) => line === `  ${profile}:`);
  if (profileIndex < 0) return undefined;
  const profileLines: string[] = [];
  for (let index = profileIndex + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index] ?? "")) break;
    profileLines.push(lines[index] ?? "");
  }
  const messages: string[] = [];
  for (let index = 0; index < profileLines.length; index += 1) {
    if (!/^\s+content:\s*[|>]?-?\s*$/.test(profileLines[index] ?? "")) continue;
    const contentLines: string[] = [];
    index += 1;
    while (index < profileLines.length) {
      const line = profileLines[index] ?? "";
      if (line.trim() && line.search(/\S/) < 10) {
        index -= 1;
        break;
      }
      contentLines.push(line.length >= 10 ? line.slice(10) : "");
      index += 1;
    }
    messages.push(contentLines.join("\n").trim());
  }
  return messages.filter(Boolean).join("\n\n") || undefined;
}
