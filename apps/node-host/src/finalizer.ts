import Ajv from "ajv";

import type { ResponseFormat } from "@anomaloharis/contracts";

import type { AgentRun } from "./agent-run.js";
import { ModelInterruptedError, type ModelAdapter, type ModelRequest, type ModelCallSettlement } from "./model.js";
import type { AgentEvent, ModelMessage } from "./types.js";

export type FinalAnswer = {
  text: string;
  output: unknown;
  format: string;
};

type FinalizationResult =
  | { kind: "success"; answer: FinalAnswer }
  | { kind: "failure"; error: string; errorCode: "structured_output_invalid" | "finalizer_failed" };

/** Format the research draft without tools; retry only output validation failures. */
export async function* finalizeAnswer(run: AgentRun, model: ModelAdapter,
  options: { beforeRequest?: (request: ModelRequest) => ModelCallSettlement | undefined } = {},
): AsyncGenerator<AgentEvent, FinalizationResult> {
  if (!run.structuredOutput) {
    return { kind: "success", answer: { text: run.state.assistantText, output: undefined, format: "text" } };
  }
  const responseFormat = run.input.responseFormat!;
  let validationError: string | undefined;
  // One initial attempt and one correction, preserving the existing output contract.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are a strict final-output formatter. Preserve facts and uncertainty in the research draft." },
      { role: "user", content: run.state.originalUserContent },
      { role: "assistant", content: run.state.assistantText || "No research draft was produced." },
      { role: "user", content: finalizerInstruction(responseFormat, validationError) },
    ];
    try {
      const request = run.modelRequest(messages, []);
      const settle = options.beforeRequest?.(request);
      yield run.modelRequestEvent({
        messages,
        tools: [],
        diagnostics: { segmentCounts: { finalizer: messages.length }, totalMessageCount: messages.length, toolCount: 0 },
      }, "finalizer", attempt + 1);
      let completion;
      try {
        if (run.signal.aborted) {
          settle?.({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
          throw new ModelInterruptedError("", []);
        }
        completion = await model.complete(request, run.signal);
      } catch (error) {
        if (!run.signal.aborted) settle?.(undefined);
        throw error;
      }
      settle?.(typeof completion === "string" ? undefined : completion.usage);
      let text: string;
      if (typeof completion === "string") {
        text = completion;
      } else {
        text = completion.text;
        if (completion.usage) run.addUsage(completion.usage);
      }
      if (run.signal.aborted) {
        validationError = "Finalizer was interrupted.";
        break;
      }
      const output = validateFinalOutput(text, responseFormat);
      return { kind: "success", answer: { text, output, format: responseFormat.type } };
    } catch (error) {
      if (error instanceof ModelInterruptedError || run.signal.aborted) {
        validationError = "Finalizer was interrupted.";
        break;
      }
      if (error instanceof StructuredOutputValidationError) {
        validationError = error.message;
        continue;
      }
      if (error instanceof Error) validationError = error.message;
      else validationError = String(error);
      break;
    }
  }
  // Keep existing error codes stable for transport consumers.
  let errorCode: "structured_output_invalid" | "finalizer_failed" = "finalizer_failed";
  if (validationError?.startsWith("Finalizer output")) errorCode = "structured_output_invalid";
  return { kind: "failure", error: validationError ?? "Finalizer failed.", errorCode };
}

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
  let outputRule = "Return only one valid JSON object.";
  if (responseFormat.type === "json_schema") {
    outputRule = "Return only one JSON value that conforms to the requested JSON Schema.";
  }
  let correction = "";
  if (validationError) {
    correction = ` The previous output failed validation: ${validationError.slice(0, 1000)} Generate a corrected output.`;
  }
  return `The tool-calling phase is complete. Use the research draft as the source of truth; do not redo research or invent facts. ${outputRule} Do not use Markdown fences or explanatory text.${correction}`;
}

export function validateFinalOutput(content: string, responseFormat: ResponseFormat): unknown {
  if (responseFormat.type === "text") return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    let message: string;
    if (error instanceof Error) message = error.message;
    else message = String(error);
    throw new StructuredOutputValidationError(
      `Finalizer returned invalid JSON: ${message}`,
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
