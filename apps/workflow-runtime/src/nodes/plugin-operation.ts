import type { CompiledWorkflowNode } from "../compiler.js";
import type { WorkflowNodeExecutionContext, WorkflowNodeExecutionResult, WorkflowNodeExecutor } from "../runner.js";

export function executePluginOperationNode(
  executor: WorkflowNodeExecutor,
  node: CompiledWorkflowNode,
  input: unknown,
  context: WorkflowNodeExecutionContext,
): Promise<WorkflowNodeExecutionResult> {
  return executor(node, input, context);
}
