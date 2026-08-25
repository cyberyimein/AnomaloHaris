/** Join preserves the compiled edge order so replay is deterministic. */
export function executeJoinNode(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [input];
}
