import Ajv from "ajv";

import type { ResponseFormat } from "@anomaloharis/contracts";

export class StructuredOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputValidationError";
  }
}

export function finalizerInstruction(
  responseFormat: ResponseFormat,
  validationError?: string,
): string {
  const outputRule = responseFormat.type === "json_schema"
    ? "Return only one JSON value that conforms to the requested JSON Schema."
    : "Return only one valid JSON object.";
  const correction = validationError
    ? ` The previous output failed validation: ${validationError.slice(0, 1000)} Generate a corrected output.`
    : "";
  return `The tool-calling phase is complete. Use the research draft as the source of truth; do not redo research or invent facts. ${outputRule} Do not use Markdown fences or explanatory text.${correction}`;
}

export function validateFinalOutput(content: string, responseFormat: ResponseFormat): unknown {
  if (responseFormat.type === "text") return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new StructuredOutputValidationError(
      `Finalizer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (responseFormat.type === "json_object") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StructuredOutputValidationError("Finalizer JSON output must be an object.");
    }
    return parsed;
  }
  const validator = new Ajv({ allErrors: true }).compile(responseFormat.json_schema.schema);
  if (!validator(parsed)) {
    const details = (validator.errors ?? []).slice(0, 3).map((error) => error.message).join("; ");
    throw new StructuredOutputValidationError(
      `Finalizer output does not match JSON Schema: ${details}`,
    );
  }
  return parsed;
}
