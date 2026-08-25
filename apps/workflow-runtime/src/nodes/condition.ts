export function executeConditionNode(expression: unknown, input: unknown): { branch: "true" | "false"; value: unknown } {
  return { branch: evaluateWorkflowExpression(expression, input) ? "true" : "false", value: input };
}

export function evaluateWorkflowExpression(expression: unknown, input: unknown): boolean {
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) return false;
  const value = expression as Record<string, unknown>;
  if (typeof value.path === "string") return resolvePath(input, value.path) !== undefined;
  if (Object.prototype.hasOwnProperty.call(value, "literal")) return Boolean(value.literal);
  const op = value.op;
  if (op === "exists") return evaluateWorkflowExpression(value.value ?? value.left, input);
  if (op === "not") return !evaluateWorkflowExpression(value.value ?? value.left, input);
  if (op === "and") return Array.isArray(value.values) && value.values.every((child) => evaluateWorkflowExpression(child, input));
  if (op === "or") return Array.isArray(value.values) && value.values.some((child) => evaluateWorkflowExpression(child, input));
  if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(String(op))) {
    const left = expressionValue(value.left, input);
    const right = expressionValue(value.right, input);
    if (op === "eq") return left === right;
    if (op === "neq") return left !== right;
    if (op === "gt") return (left as any) > (right as any);
    if (op === "gte") return (left as any) >= (right as any);
    if (op === "lt") return (left as any) < (right as any);
    return (left as any) <= (right as any);
  }
  return false;
}

function expressionValue(value: unknown, input: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") return resolvePath(input, record.path);
    if (Object.prototype.hasOwnProperty.call(record, "literal")) return record.literal;
  }
  return undefined;
}

function resolvePath(input: unknown, path: string): unknown {
  if (!path.startsWith("$.")) return undefined;
  return path.slice(2).split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, input);
}
