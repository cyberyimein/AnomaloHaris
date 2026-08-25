import type { WorkflowValidationReport } from "@anomaloharis/contracts";

export class WorkflowRuntimeError extends Error {
  override readonly name = "WorkflowRuntimeError";

  constructor(
    readonly errorCode: string,
    message: string,
    readonly statusCode = 500,
    readonly validation?: WorkflowValidationReport,
  ) {
    super(message);
  }
}

export function workflowErrorCode(error: unknown): string {
  if (error instanceof WorkflowRuntimeError) return error.errorCode;
  if (error instanceof Error && error.message === "workflow_not_found") return "workflow_not_found";
  return "workflow_runtime_error";
}

export function workflowErrorStatus(error: unknown): number {
  if (error instanceof WorkflowRuntimeError) return error.statusCode;
  if (workflowErrorCode(error) === "workflow_not_found") return 404;
  return 500;
}
