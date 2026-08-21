import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

import {
  AgentEventSchema,
  RunRequestSchema,
  ToolDefinitionSchema,
  ToolResultSchema,
  WebSocketControlMessageSchema,
} from "./schemas.js";
import type {
  AgentEvent,
  RunRequest,
  ToolDefinition,
  ToolResult,
  WebSocketControlMessage,
} from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: true });

const validators = {
  agentEvent: ajv.compile<AgentEvent>(AgentEventSchema),
  runRequest: ajv.compile<RunRequest>(RunRequestSchema),
  toolDefinition: ajv.compile<ToolDefinition>(ToolDefinitionSchema),
  toolResult: ajv.compile<ToolResult>(ToolResultSchema),
  webSocketControlMessage: ajv.compile<WebSocketControlMessage>(WebSocketControlMessageSchema),
};

export type ContractName = keyof typeof validators;

export type ContractValidation = {
  valid: boolean;
  errors: ErrorObject[] | null;
};

export function validateContract(name: ContractName, value: unknown): ContractValidation {
  const validator = validators[name] as ValidateFunction<unknown>;
  const valid = validator(value);
  return { valid, errors: valid ? null : (validator.errors ?? null) };
}

export function validateAgentEvent(value: unknown): value is AgentEvent {
  return validators.agentEvent(value);
}

export function normalizeAgentEvent(value: unknown): AgentEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent event must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type !== "string" || !candidate.type) {
    throw new Error("Agent event type is required.");
  }
  if (candidate.schema_version !== undefined && candidate.schema_version !== 1) {
    throw new Error("Unsupported agent event schema version.");
  }
  return value as AgentEvent;
}

export function assertValidContract(name: ContractName, value: unknown): void {
  const result = validateContract(name, value);
  if (!result.valid) {
    const details = result.errors?.map((error) => error.message).join(", ") || "invalid value";
    throw new Error(`Invalid ${name} contract: ${details}`);
  }
}
