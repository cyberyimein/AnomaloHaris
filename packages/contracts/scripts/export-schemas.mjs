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

const root = resolve(new URL("..", import.meta.url).pathname);
const schemas = [
  ["agent-event", AgentEventSchema],
  ["llm-request-event-data", LlmRequestEventDataSchema],
  ["preset-model-definition", PresetModelDefinitionSchema],
  ["preset-model-summary", PresetModelSummarySchema],
  ["run-request", RunRequestSchema],
  ["tool", ToolDefinitionSchema],
  ["websocket-control-message", WebSocketControlMessageSchema],
  ["websocket-message", WebSocketMessageSchema],
];

for (const [name, schema] of schemas) {
  const path = resolve(root, "schemas", `${name}.schema.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}
