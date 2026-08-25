/** Parallel is a scheduling marker and does not mutate the value. */
export function executeParallelNode(input: unknown): unknown {
  return input;
}
