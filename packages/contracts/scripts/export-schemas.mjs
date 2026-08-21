import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  AgentEventSchema,
  RunRequestSchema,
  ToolDefinitionSchema,
  WebSocketControlMessageSchema,
} from "../dist/schemas.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const schemas = [
  ["agent-event", AgentEventSchema],
  ["run-request", RunRequestSchema],
  ["tool", ToolDefinitionSchema],
  ["websocket-control-message", WebSocketControlMessageSchema],
];

for (const [name, schema] of schemas) {
  const path = resolve(root, "schemas", `${name}.schema.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}
