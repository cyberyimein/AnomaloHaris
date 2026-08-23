import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PluginCompatibility, PluginPermission, PluginSpec } from "./plugins.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * A catalog entry is the only executable plugin metadata that a Preset Model
 * compiler may bind. The catalog is intentionally explicit; the host never
 * scans a workspace or installs a package while serving a request.
 */
export type PluginManifest = {
  id: string;
  version: string;
  package: string;
  entry: string;
  compatibility: PluginCompatibility;
  permissions: readonly PluginPermission[];
  toolNames?: readonly string[];
  capabilities?: readonly string[];
  required?: boolean;
  /** Local source root used only to re-hash an installed development plugin. */
  packageRoot?: string;
  packageHash: string;
  manifestHash: string;
};

export type PluginLock = {
  id: string;
  version: string;
  package: string;
  entry: string;
  compatibility: PluginCompatibility;
  permissions: readonly PluginPermission[];
  capabilities?: readonly string[];
  packageHash: string;
  manifestHash: string;
};

export type CompiledPluginGraph = {
  locks: PluginLock[];
  pluginLockHash: string;
  toolNames: string[];
};

export class PluginCatalog {
  private readonly entries = new Map<string, PluginManifest>();

  constructor(manifests: readonly PluginManifest[] = []) {
    for (const manifest of manifests) this.register(manifest);
  }

  register(manifest: PluginManifest): void {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(manifest.id)) throw new Error(`invalid_plugin_id:${manifest.id}`);
    if (!manifest.version.trim()) throw new Error(`invalid_plugin_version:${manifest.id}`);
    if (this.entries.has(manifest.id)) throw new Error(`duplicate_plugin:${manifest.id}`);
    this.entries.set(manifest.id, structuredClone(manifest));
  }

  refreshRuntimeMetadata(id: string, toolNames: readonly string[], capabilities: readonly string[]): PluginManifest {
    const current = this.entries.get(id);
    if (!current) throw new Error(`plugin_not_allowlisted:${id}`);
    const refreshed = createPluginManifest({
      id: current.id,
      version: current.version,
      package: current.package,
      entry: current.entry,
      compatibility: current.compatibility,
      permissions: current.permissions,
      toolNames,
      capabilities,
      ...(current.required === undefined ? {} : { required: current.required }),
      ...(current.packageRoot ? { packageRoot: current.packageRoot } : {}),
    });
    this.entries.set(id, refreshed);
    return structuredClone(refreshed);
  }

  get(id: string): PluginManifest | undefined {
    const manifest = this.entries.get(id);
    return manifest ? structuredClone(manifest) : undefined;
  }

  list(): PluginManifest[] {
    return [...this.entries.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((manifest) => structuredClone(manifest));
  }

  compile(fixedPlugins: readonly string[]): CompiledPluginGraph {
    const locks: PluginLock[] = [];
    const toolNames = new Set<string>();
    for (const selector of fixedPlugins) {
      const { id, version } = parsePluginSelector(selector);
      const manifest = this.entries.get(id);
      if (!manifest) throw new Error(`plugin_not_allowlisted:${id}`);
      if (version !== undefined && version !== manifest.version) {
        throw new Error(`plugin_version_mismatch:${id}@${version}`);
      }
      const lock = toLock(manifest);
      locks.push(lock);
      for (const name of manifest.toolNames ?? []) {
        if (toolNames.has(name)) throw new Error(`duplicate_plugin_tool:${name}`);
        toolNames.add(name);
      }
    }
    return {
      locks,
      pluginLockHash: hash(locks),
      toolNames: [...toolNames].sort(),
    };
  }

  /** Verify that a compiled graph still points at the same installed bytes. */
  assertCurrent(locks: readonly PluginLock[]): void {
    for (const lock of locks) {
      const current = this.entries.get(lock.id);
      if (!current) throw new Error(`plugin_not_installed:${lock.id}`);
      const currentLock = toLock(current);
      if (canonicalJson(currentLock) !== canonicalJson(lock)) {
        throw new Error(`plugin_hash_mismatch:${lock.id}`);
      }
    }
  }

  /** Validate an extension allowlist before any child process is started. */
  assertSpecs(specs: readonly PluginSpec[], locks?: readonly PluginLock[]): void {
    const expected = locks ? new Map(locks.map((lock) => [lock.id, lock])) : undefined;
    for (const spec of specs) {
      const manifest = this.entries.get(spec.id);
      if (!manifest) throw new Error(`plugin_not_allowlisted:${spec.id}`);
      const currentLock = toLock(manifest);
      if (spec.version !== undefined && spec.version !== manifest.version) {
        throw new Error(`plugin_version_mismatch:${spec.id}@${spec.version}`);
      }
      if (spec.manifestHash !== undefined && spec.manifestHash !== currentLock.manifestHash) {
        throw new Error(`plugin_manifest_hash_mismatch:${spec.id}`);
      }
      if (spec.packageHash !== undefined && spec.packageHash !== currentLock.packageHash) {
        throw new Error(`plugin_hash_mismatch:${spec.id}`);
      }
      if (spec.capabilities !== undefined && canonicalJson([...spec.capabilities].sort()) !== canonicalJson([...(manifest.capabilities ?? [])].sort())) {
        throw new Error(`plugin_capabilities_mismatch:${spec.id}`);
      }
      const lock = expected?.get(spec.id);
      if (expected && !lock) throw new Error(`plugin_not_locked:${spec.id}`);
      if (lock && canonicalJson(currentLock) !== canonicalJson(lock)) {
        throw new Error(`plugin_hash_mismatch:${spec.id}`);
      }
    }
  }
}

export function createPluginManifest(input: {
  id: string;
  version: string;
  package: string;
  entry: string;
  compatibility: PluginCompatibility;
  permissions?: readonly PluginPermission[];
  toolNames?: readonly string[];
  capabilities?: readonly string[];
  required?: boolean;
  packageRoot?: string;
}): PluginManifest {
  const permissions = [...(input.permissions ?? [])].sort();
  const packageHash = hashPluginPackage(input.packageRoot ?? input.entry, input.package, input.entry);
  const manifestBody = {
    id: input.id,
    version: input.version,
    package: input.package,
    entry: input.entry,
    compatibility: input.compatibility,
    permissions,
    toolNames: [...(input.toolNames ?? [])].sort(),
    capabilities: [...(input.capabilities ?? [])].sort(),
    required: input.required === true,
    packageHash,
  };
  return {
    ...manifestBody,
    permissions,
    ...(manifestBody.toolNames.length > 0 ? { toolNames: manifestBody.toolNames } : {}),
    ...(manifestBody.capabilities.length > 0 ? { capabilities: manifestBody.capabilities } : {}),
    ...(manifestBody.required ? { required: true } : {}),
    ...(input.packageRoot ? { packageRoot: input.packageRoot } : {}),
    manifestHash: hash(manifestBody),
    packageHash,
  };
}

export function builtinPluginCatalog(): PluginCatalog {
  return new PluginCatalog([
    createPluginManifest({
      id: "host-core",
      version: "1.0.0",
      package: "@anomalo/node-host",
      entry: "builtin:host-core",
      compatibility: "L1",
      permissions: ["tools.register"],
      toolNames: ["time_now"],
    }),
    createPluginManifest({
      id: "web",
      version: "1.0.0",
      package: "@anomalo/node-host",
      entry: "builtin:web",
      compatibility: "L1",
      permissions: ["tools.register"],
      toolNames: ["web_fetch", "web_search"],
    }),
    createPluginManifest({
      id: "python-sandbox",
      version: "1.0.0",
      package: "@anomalo/node-host",
      entry: "builtin:python-sandbox",
      compatibility: "L1",
      permissions: ["tools.register"],
      toolNames: ["sandbox_python_run"],
    }),
    createPluginManifest({
      id: "browser-bridge",
      version: "1.0.0",
      package: "@anomalo/node-host",
      entry: "builtin:browser-bridge",
      compatibility: "L2",
      permissions: ["tools.register", "lifecycle.run"],
      toolNames: [
        "browser.click",
        "browser.fill",
        "browser.get_page_state",
        "browser.navigate",
        "browser.press_key",
        "browser.screenshot",
        "browser.select_option",
        "browser.type_text",
        "browser.wait_for",
      ],
    }),
    createPluginManifest({
      id: "pi-plugin-host",
      version: "1.0.0",
      package: "@anomalo/node-host",
      entry: "builtin:pi-plugin-host",
      compatibility: "L2",
      permissions: ["tools.register", "lifecycle.context", "lifecycle.run"],
    }),
    createPluginManifest({
      id: "buddy-bridge",
      version: "1.0.0",
      package: "@anomalo/buddy-bridge",
      entry: ".",
      // Hash the compiled package payload. Source checkouts and production
      // images intentionally contain different workspace metadata, while
      // this directory is copied byte-for-byte into the runtime image.
      packageRoot: resolve(REPOSITORY_ROOT, "apps/buddy-bridge/dist"),
      compatibility: "L2",
      permissions: ["tools.register", "lifecycle.run"],
      toolNames: [
        "buddy_status",
        "buddy_recent_events",
        "buddy_set_state",
        "buddy_set_text",
        "buddy_look",
        "buddy_set_led",
        "buddy_request_approval",
      ],
      capabilities: ["buddy"],
    }),
  ]);
}

export function pluginLockHash(locks: readonly PluginLock[]): string {
  return hash(locks);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toLock(manifest: PluginManifest): PluginLock {
  const packageHash = hashPluginPackage(manifest.packageRoot ?? manifest.entry, manifest.package, manifest.entry);
  const manifestBody = {
    id: manifest.id,
    version: manifest.version,
    package: manifest.package,
    entry: manifest.entry,
    compatibility: manifest.compatibility,
    permissions: [...manifest.permissions].sort(),
    toolNames: [...(manifest.toolNames ?? [])].sort(),
    capabilities: [...(manifest.capabilities ?? [])].sort(),
    required: manifest.required === true,
    packageHash,
  };
  return {
    id: manifest.id,
    version: manifest.version,
    package: manifest.package,
    entry: manifest.entry,
    compatibility: manifest.compatibility,
    permissions: [...manifest.permissions].sort(),
    ...(manifest.capabilities && manifest.capabilities.length > 0 ? { capabilities: [...manifest.capabilities].sort() } : {}),
    packageHash,
    manifestHash: hash(manifestBody),
  };
}

function parsePluginSelector(selector: string): { id: string; version?: string } {
  const value = selector.trim();
  const match = /^([a-z][a-z0-9._-]{0,63})(?:@([^@]+))?$/.exec(value);
  if (!match) throw new Error(`invalid_plugin_ref:${selector}`);
  return { id: match[1]!, ...(match[2] ? { version: match[2] } : {}) };
}

function hashPluginPackage(packagePath: string, packageName: string, entry: string): string {
  const candidate = isAbsolute(packagePath) ? packagePath : resolve(packagePath);
  if (!existsSync(candidate)) return hash({ package: packageName, entry });
  const stats = statSync(candidate);
  if (stats.isFile()) return createHash("sha256").update(readFileSync(candidate)).digest("hex");
  if (!stats.isDirectory()) return hash({ package: packageName, entry });
  const files = collectFiles(candidate);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.slice(candidate.length + 1));
    digest.update(readFileSync(file));
  }
  return digest.digest("hex");
}

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...collectFiles(path));
    else if (stats.isFile()) files.push(path);
  }
  return files.sort();
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
