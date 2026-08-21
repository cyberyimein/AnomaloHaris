import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

import {
  ConnectionMessageSchema,
  RunEventEnvelopeSchema,
  RunRequestSchema,
  ToolDefinitionSchema,
  ToolResultSchema,
  WebSocketMessageSchema,
} from "./schemas.js";
import type {
  AgentEvent,
  ConnectionMessage,
  RunRequest,
  RunEventEnvelope,
  ToolDefinition,
  ToolResult,
  WebSocketMessage,
} from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: true });
const connectionMessageValidator = ajv.compile<ConnectionMessage>(ConnectionMessageSchema);

const validators = {
  agentEvent: ajv.compile<RunEventEnvelope>(RunEventEnvelopeSchema),
  connectionMessage: connectionMessageValidator,
  runRequest: ajv.compile<RunRequest>(RunRequestSchema),
  toolDefinition: ajv.compile<ToolDefinition>(ToolDefinitionSchema),
  toolResult: ajv.compile<ToolResult>(ToolResultSchema),
  webSocketControlMessage: connectionMessageValidator,
  webSocketMessage: ajv.compile<WebSocketMessage>(WebSocketMessageSchema),
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

export function validateWebSocketMessage(value: unknown): value is WebSocketMessage {
  return validators.webSocketMessage(value);
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
  if (!validateAgentEvent(value)) {
    throw new Error("Invalid agent event contract.");
  }
  return value as AgentEvent;
}

export function normalizeWebSocketMessage(value: unknown): WebSocketMessage {
  if (!validateWebSocketMessage(value)) {
    throw new Error("Invalid WebSocket message contract.");
  }
  return value;
}

export function assertValidContract(name: ContractName, value: unknown): void {
  const result = validateContract(name, value);
  if (!result.valid) {
    const details = result.errors?.map((error) => error.message).join(", ") || "invalid value";
    throw new Error(`Invalid ${name} contract: ${details}`);
  }
}
