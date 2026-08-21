import type { Static } from "@sinclair/typebox";

import type {
  AgentEventSchema,
  AgentEventTypeSchema,
  ResponseFormatSchema,
  RunRequestSchema,
  ToolCallSchema,
  ToolDefinitionSchema,
  ToolResultSchema,
} from "./schemas.js";

export type SessionId = string & { readonly __sessionId: unique symbol };
export type RunId = string & { readonly __runId: unique symbol };
export type ToolCallId = string & { readonly __toolCallId: unique symbol };
export type EntryId = string & { readonly __entryId: unique symbol };

export type AgentEventType = Static<typeof AgentEventTypeSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;
export type ResponseFormat = Static<typeof ResponseFormatSchema>;
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
  | "tool_failed"
  | "finalizer_failed"
  | "structured_output_invalid"
  | "plugin_failed"
  | "worker_unavailable";

