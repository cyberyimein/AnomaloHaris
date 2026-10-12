import type { CompiledWorkflow, CompiledWorkflowNode } from "./compiler.js";

export type NodeState = "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped" | "stopped";

type IncomingEdge = { from: string; fromPort: string; toPort: string };
type OutgoingEdge = { fromPort: string; to: string; toPort: string };

/** Run-local DAG state: readiness, routed outputs, and disabled condition branches. */
export class WorkflowRunGraph {
  private readonly states = new Map<string, NodeState>();
  private readonly outputs = new Map<string, unknown>();
  private readonly disabledEdges = new Set<string>();
  private readonly incoming = new Map<string, IncomingEdge[]>();
  private readonly outgoing = new Map<string, OutgoingEdge[]>();
  private readonly nodes: Map<string, CompiledWorkflowNode>;

  constructor(private readonly compiled: CompiledWorkflow, private readonly input: unknown) {
    this.nodes = new Map(compiled.nodes.map((node) => [node.id, node]));
    for (const node of compiled.nodes) this.states.set(node.id, "pending");
    for (const edge of compiled.edges) {
      const incoming = this.incoming.get(edge.to.node) ?? [];
      incoming.push({ from: edge.from.node, fromPort: edge.from.port, toPort: edge.to.port });
      this.incoming.set(edge.to.node, incoming);
      const outgoing = this.outgoing.get(edge.from.node) ?? [];
      outgoing.push({ fromPort: edge.from.port, to: edge.to.node, toPort: edge.to.port });
      this.outgoing.set(edge.from.node, outgoing);
    }
  }

  node(nodeId: string): CompiledWorkflowNode {
    // Compilation guarantees that topology entries and edges reference existing nodes.
    return this.nodes.get(nodeId)!;
  }

  entries(): IterableIterator<[string, NodeState]> {
    return this.states.entries();
  }

  setState(nodeId: string, state: NodeState): void {
    this.states.set(nodeId, state);
  }

  markRootsReady(): void {
    for (const nodeId of this.compiled.topology_order) {
      if ((this.incoming.get(nodeId)?.length ?? 0) === 0) this.markReady(nodeId);
    }
  }

  /** Compiled topology order is the tie-breaker when several nodes are ready. */
  nextReady(): string | undefined {
    return this.compiled.topology_order.find((nodeId) => this.states.get(nodeId) === "ready");
  }

  hasReady(): boolean {
    return this.compiled.topology_order.some((nodeId) => this.states.get(nodeId) === "ready");
  }

  hasFailed(): boolean {
    return [...this.states.values()].some((state) => state === "failed");
  }

  /** Joins receive an array of active inputs; skipped branches contribute no value. */
  inputFor(nodeId: string): unknown {
    if (nodeId === this.compiled.topology_order[0]) return this.input;
    const incoming = this.incoming.get(nodeId) ?? [];
    const values = incoming
      .filter((edge) => !this.disabledEdges.has(edgeKey(edge.from, edge.fromPort, nodeId, edge.toPort)))
      .filter((edge) => {
        const state = this.states.get(edge.from) ?? "pending";
        return state !== "skipped" && state !== "stopped";
      })
      .map((edge) => this.outputs.get(`${edge.from}:${edge.fromPort}`));
    if (incoming.length > 1 || this.node(nodeId).type === "join") return values;
    return values[0];
  }

  succeed(nodeId: string, output: unknown): void {
    this.setState(nodeId, "succeeded");
    if (output === undefined) return;
    const node = this.node(nodeId);
    const outgoing = this.outgoing.get(nodeId) ?? [];
    if (node.type === "condition" && output && typeof output === "object" && !Array.isArray(output)) {
      const result = output as { branch?: unknown; value?: unknown };
      for (const edge of outgoing) {
        if (edge.fromPort === result.branch) {
          this.outputs.set(`${nodeId}:${edge.fromPort}`, result.value);
        } else {
          this.disabledEdges.add(edgeKey(nodeId, edge.fromPort, edge.to, edge.toPort));
        }
      }
      return;
    }
    // One output port may fan out to multiple edges. Store its value once.
    for (const port of new Set(outgoing.map((edge) => edge.fromPort))) {
      this.outputs.set(`${nodeId}:${port}`, output);
    }
  }

  releaseDependents(nodeId: string): void {
    for (const edge of this.outgoing.get(nodeId) ?? []) {
      if (this.states.get(edge.to) !== "pending") continue;
      const dependencies = this.incoming.get(edge.to) ?? [];
      const allSettled = dependencies.every((dependency) => isSettled(this.states.get(dependency.from) ?? "pending"));
      if (allSettled) this.markReady(edge.to);
    }
  }

  /** Skip only when every incoming edge was disabled by a condition. */
  shouldSkip(nodeId: string): boolean {
    const incoming = this.incoming.get(nodeId) ?? [];
    if (incoming.length === 0) return false;
    return incoming.every((edge) => this.disabledEdges.has(edgeKey(edge.from, edge.fromPort, nodeId, edge.toPort)));
  }

  private markReady(nodeId: string): void {
    if (this.states.get(nodeId) === "pending") this.states.set(nodeId, "ready");
  }
}

function isSettled(state: NodeState): boolean {
  return state === "succeeded" || state === "failed" || state === "skipped" || state === "stopped";
}

function edgeKey(from: string, fromPort: string, to: string, toPort: string): string {
  return `${from}:${fromPort}->${to}:${toPort}`;
}
