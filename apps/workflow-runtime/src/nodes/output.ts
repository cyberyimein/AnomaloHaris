/** Output node is intentionally transparent; schema validation is owned by Runner. */
export function executeOutputNode(input: unknown): unknown {
  return input;
}
