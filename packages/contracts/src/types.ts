import type { Static } from "@sinclair/typebox";

import type {
  AgentEventSchema,
  AgentEventTypeSchema,
  ConnectionMessageSchema,
  LlmRequestEventDataSchema,
  PresetModelDefinitionSchema,
  PresetModelRefSchema,
  PresetModelSummarySchema,
  ResponseFormatSchema,
  RunEventEnvelopeSchema,
  RunRequestSchema,
  ToolCallSchema,
  ToolDefinitionSchema,
  ToolResultSchema,
  WebSocketClientMessageTypeSchema,
  WebSocketControlMessageSchema,
  WebSocketControlMessageTypeSchema,
  WebSocketServerControlMessageTypeSchema,
  WebSocketMessageSchema,
} from "./schemas.js";

export type SessionId = string & { readonly __sessionId: unique symbol };
export type RunId = string & { readonly __runId: unique symbol };
export type ToolCallId = string & { readonly __toolCallId: unique symbol };
export type EntryId = string & { readonly __entryId: unique symbol };

export type AgentEventType = Static<typeof AgentEventTypeSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;
export type LlmRequestEventData = Static<typeof LlmRequestEventDataSchema>;
export type RunEventEnvelope = Static<typeof RunEventEnvelopeSchema>;
export type ConnectionMessage = Static<typeof ConnectionMessageSchema>;
export type WebSocketClientMessageType = Static<typeof WebSocketClientMessageTypeSchema>;
export type WebSocketControlMessage = Static<typeof WebSocketControlMessageSchema>;
export type WebSocketControlMessageType = Static<typeof WebSocketControlMessageTypeSchema>;
export type WebSocketServerControlMessageType = Static<
  typeof WebSocketServerControlMessageTypeSchema
>;
export type WebSocketMessage = Static<typeof WebSocketMessageSchema>;
export type ResponseFormat = Static<typeof ResponseFormatSchema>;
export type PresetModelRef = Static<typeof PresetModelRefSchema>;
export type PresetModelDefinition = Static<typeof PresetModelDefinitionSchema>;
export type PresetModelSummary = Static<typeof PresetModelSummarySchema>;
export type RunRequest = Static<typeof RunRequestSchema>;
export type ToolCall = Static<typeof ToolCallSchema>;
export type ToolDefinition = Static<typeof ToolDefinitionSchema>;
export type ToolResult = Static<typeof ToolResultSchema>;

export type ErrorCode =
  | "message_required"
  | "run_already_active"
  | "checkpoint_not_found"
  | "checkpoint_resume_required"
  | "response_format_mismatch"
  | "invalid_response_format"
  | "invalid_search_mode"
  | "run_timeout"
  | "max_tool_iterations"
  | "bootstrap_failed"
  | "model_failed"
  | "provider_unavailable"
  | "provider_protocol_error"
  | "preset_model_not_found"
  | "preset_model_unavailable"
  | "preset_model_override_forbidden"
  | "preset_model_default_cannot_retire"
  | "session_model_mismatch"
  | "tool_failed"
  | "tool_not_allowed"
  | "finalizer_failed"
  | "structured_output_invalid"
  | "plugin_failed";
