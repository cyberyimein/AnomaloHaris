import type { ExecutionRuntimeKind } from "@anomaloharis/contracts";

import type {
  ExecutionRuntimeAdapter,
  ResolvedExecutionTarget,
  RuntimeResolveOptions,
} from "./run-control.js";

/** Trusted runtime adapters are assembled by Host; arbitrary plugins cannot register a Run runtime. */
export class RuntimeCatalog {
  private readonly adapters = new Map<ExecutionRuntimeKind, ExecutionRuntimeAdapter>();

  register(adapter: ExecutionRuntimeAdapter): void {
    if (this.adapters.has(adapter.kind)) throw new Error(`duplicate_runtime_adapter:${adapter.kind}`);
    this.adapters.set(adapter.kind, adapter);
  }

  adapter(kind: ExecutionRuntimeKind): ExecutionRuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`runtime_unavailable:${kind}`);
    return adapter;
  }

  resolve(kind: ExecutionRuntimeKind, ref: string, options: RuntimeResolveOptions = {}): { adapter: ExecutionRuntimeAdapter; target: ResolvedExecutionTarget } {
    const adapter = this.adapter(kind);
    if (!adapter.isHealthy()) throw new Error(`runtime_unhealthy:${kind}`);
    return { adapter, target: adapter.resolve(ref, options) };
  }

  list(): Array<{ kind: ExecutionRuntimeKind; version: string; packageHash: string; capabilities: readonly string[]; healthy: boolean }> {
    return [...this.adapters.values()].map((adapter) => ({
      kind: adapter.kind,
      version: adapter.version,
      packageHash: adapter.packageHash,
      capabilities: [...adapter.capabilities],
      healthy: adapter.isHealthy(),
    }));
  }
}
