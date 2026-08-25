import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  AgentEventSchema,
  LlmRequestEventDataSchema,
  PresetModelDefinitionSchema,
  PresetModelSummarySchema,
  RunRequestSchema,
  ToolDefinitionSchema,
  WebSocketControlMessageSchema,
  WebSocketMessageSchema,
} from "../dist/schemas.js";
import {
  WorkflowCapabilityManifestSchema,
  WorkflowDefinitionSchema,
  WorkflowImportResultSchema,
  WorkflowSummarySchema,
  WorkflowValidationReportSchema,
} from "../dist/workflows.js";
import {
  ExecutionRunEventSchema,
  ExecutionRunSchema,
  ExecutionTargetSchema,
  WorkflowNodeRunSchema,
  WorkflowRunRequestSchema,
} from "../dist/workflow-runs.js";
import {
  OpenAIChatCompletionRequestSchema,
  OpenAIChatCompletionChunkSchema,
  OpenAIChatCompletionResponseSchema,
  OpenAIModelListSchema,
  OpenAIUsageSchema,
} from "../dist/openai.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const schemas = [
  ["agent-event", AgentEventSchema],
  ["llm-request-event-data", LlmRequestEventDataSchema],
  ["openai-chat-completion-request", OpenAIChatCompletionRequestSchema],
  ["openai-chat-completion-chunk", OpenAIChatCompletionChunkSchema],
  ["openai-chat-completion-response", OpenAIChatCompletionResponseSchema],
  ["openai-model-list", OpenAIModelListSchema],
  ["openai-usage", OpenAIUsageSchema],
  ["preset-model-definition", PresetModelDefinitionSchema],
  ["preset-model-summary", PresetModelSummarySchema],
  ["run-request", RunRequestSchema],
  ["tool", ToolDefinitionSchema],
  ["websocket-control-message", WebSocketControlMessageSchema],
  ["websocket-message", WebSocketMessageSchema],
  ["workflow-capability-manifest", WorkflowCapabilityManifestSchema],
  ["workflow-definition", WorkflowDefinitionSchema],
  ["workflow-import-result", WorkflowImportResultSchema],
  ["workflow-summary", WorkflowSummarySchema],
  ["workflow-validation-report", WorkflowValidationReportSchema],
  ["execution-run-event", ExecutionRunEventSchema],
  ["execution-run", ExecutionRunSchema],
  ["execution-target", ExecutionTargetSchema],
  ["workflow-node-run", WorkflowNodeRunSchema],
  ["workflow-run-request", WorkflowRunRequestSchema],
];

for (const [name, schema] of schemas) {
  const path = resolve(root, "schemas", `${name}.schema.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}
