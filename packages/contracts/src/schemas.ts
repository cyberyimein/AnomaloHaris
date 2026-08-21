import { Type } from "@sinclair/typebox";

export const AgentEventTypeSchema = Type.Union([
  Type.Literal("run.started"),
  Type.Literal("llm.request"),
  Type.Literal("message.delta"),
  Type.Literal("message.done"),
  Type.Literal("tool.started"),
  Type.Literal("tool.finished"),
  Type.Literal("tool.error"),
  Type.Literal("run.finished"),
  Type.Literal("run.stopped"),
  Type.Literal("run.error"),
  Type.Literal("session.state"),
  Type.Literal("client.ready"),
  Type.Literal("client.error"),
  Type.Literal("browser.tool.call"),
  Type.Literal("browser.tool.result"),
  Type.Literal("pong"),
]);

export const AgentEventSchema = Type.Object(
  {
    schema_version: Type.Optional(Type.Literal(1)),
    type: AgentEventTypeSchema,
    session_id: Type.String({ minLength: 1 }),
    run_id: Type.String({ minLength: 1 }),
    data: Type.Record(Type.String(), Type.Unknown()),
    timestamp: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true, $id: "https://anomalo.dev/schemas/agent-event.schema.json" },
);

export const ResponseFormatSchema = Type.Union([
  Type.Object({ type: Type.Literal("text") }),
  Type.Object({ type: Type.Literal("json_object") }),
  Type.Object({
    type: Type.Literal("json_schema"),
    json_schema: Type.Object({
      name: Type.String({ minLength: 1 }),
      strict: Type.Optional(Type.Boolean()),
      schema: Type.Record(Type.String(), Type.Unknown()),
    }),
  }),
]);

export const RunRequestSchema = Type.Object(
  {
    message: Type.Union([Type.String(), Type.Null()]),
    session_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    resume: Type.Optional(Type.Boolean()),
    prompt_profile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    search_mode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    response_format: Type.Optional(Type.Union([ResponseFormatSchema, Type.Null()])),
  },
  { additionalProperties: true, $id: "https://anomalo.dev/schemas/run-request.schema.json" },
);

export const ToolDefinitionSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
    description: Type.String(),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    source: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true, $id: "https://anomalo.dev/schemas/tool.schema.json" },
);

export const ToolCallSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
  arguments: Type.Record(Type.String(), Type.Unknown()),
});

export const ToolResultSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  ok: Type.Boolean(),
  content: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
});

