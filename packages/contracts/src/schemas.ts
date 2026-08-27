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
]);

export const WebSocketClientMessageTypeSchema = Type.Union([
  Type.Literal("client.hello"),
  Type.Literal("user.message"),
  Type.Literal("run.stop"),
  Type.Literal("run.resume"),
  Type.Literal("browser.tool.result"),
  Type.Literal("ping"),
]);

export const WebSocketServerControlMessageTypeSchema = Type.Union([
  Type.Literal("session.state"),
  Type.Literal("client.ready"),
  Type.Literal("client.error"),
  Type.Literal("browser.tool.call"),
  Type.Literal("browser.tool.cancel"),
  Type.Literal("pong"),
]);

export const WebSocketControlMessageTypeSchema = Type.Union([
  WebSocketClientMessageTypeSchema,
  WebSocketServerControlMessageTypeSchema,
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
  { additionalProperties: true, $id: "https://anomaloharis.dev/schemas/agent-event.schema.json" },
);

export const RunEventEnvelopeSchema = AgentEventSchema;

export const WebSocketControlMessageSchema = Type.Object(
  {
    schema_version: Type.Optional(Type.Literal(1)),
    type: WebSocketControlMessageTypeSchema,
    session_id: Type.Optional(Type.String({ minLength: 1 })),
    run_id: Type.Optional(Type.String({ minLength: 1 })),
    content: Type.Optional(Type.String()),
    search_mode: Type.Optional(Type.String({ minLength: 1 })),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    error: Type.Optional(Type.String()),
  },
  {
    additionalProperties: true,
    $id: "https://anomaloharis.dev/schemas/websocket-control-message.schema.json",
  },
);

export const ConnectionMessageSchema = WebSocketControlMessageSchema;

export const WebSocketMessageSchema = Type.Union(
  [RunEventEnvelopeSchema, ConnectionMessageSchema],
  { $id: "https://anomaloharis.dev/schemas/websocket-message.schema.json" },
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

export const LlmRequestEventDataSchema = Type.Object(
  {
    model_ref: Type.String({ minLength: 1 }),
    provider_model: Type.String({ minLength: 1 }),
    iteration: Type.Integer({ minimum: 0 }),
    request: Type.Object({
      message_count: Type.Integer({ minimum: 0 }),
      tool_count: Type.Integer({ minimum: 0 }),
      response_format: Type.String({ minLength: 1 }),
    }),
    context: Type.Object({
      segment_counts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
      total_message_count: Type.Integer({ minimum: 0 }),
      tool_count: Type.Integer({ minimum: 0 }),
      compiled_hash: Type.String({ minLength: 1 }),
    }, { additionalProperties: true }),
  },
  { additionalProperties: true, $id: "https://anomaloharis.dev/schemas/llm-request-event-data.schema.json" },
);

export const PresetModelRefSchema = Type.String({
  pattern: "^[a-z][a-z0-9._-]{0,63}@[1-9][0-9]{0,8}$",
  minLength: 3,
});

const PresetModelSkillFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 256 }),
    content: Type.String({ maxLength: 262_144 }),
  },
  { additionalProperties: false },
);

// One uploaded Markdown document represents one independent Agent Skill. The
// server derives its identity from the SKILL.md frontmatter, so callers cannot
// accidentally maintain a second, conflicting name/description field.
const PresetModelSkillSchema = Type.Object(
  {
    content: Type.String({ maxLength: 262_144 }),
  },
  { additionalProperties: false },
);

export const PresetModelDefinitionSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9._-]{0,63}$", minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    description: Type.String(),
    provider: Type.Object({
      adapter: Type.String({ minLength: 1 }),
      model: Type.String({ minLength: 1 }),
      credential_ref: Type.Optional(Type.String({ minLength: 1 })),
      tool_protocol: Type.Optional(Type.Union([
        Type.Literal("openai"),
        Type.Literal("dsml"),
        Type.Literal("auto"),
        Type.Literal("none"),
      ])),
      capabilities: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    prompt: Type.Optional(Type.Object({
      profile: Type.Optional(Type.String({ minLength: 1 })),
      system: Type.Optional(Type.String()),
      skills: Type.Optional(Type.Array(PresetModelSkillSchema, { maxItems: 8 })),
      skill_files: Type.Optional(Type.Array(PresetModelSkillFileSchema, { maxItems: 8 })),
      // Kept for definitions created before skill_files was introduced.
      skill_markdown: Type.Optional(Type.String({ maxLength: 262_144 })),
    })),
    plugins: Type.Optional(Type.Object({
      fixed: Type.Array(Type.String({ minLength: 1 })),
      allowed_tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      bootstrap_tools: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
    })),
    policy: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: true, $id: "https://anomaloharis.dev/schemas/preset-model-definition.schema.json" },
);

export const PresetModelSummarySchema = Type.Object({
  ref: PresetModelRefSchema,
  name: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
  description: Type.String(),
  status: Type.Union([Type.Literal("draft"), Type.Literal("published"), Type.Literal("retired")]),
  provider_model: Type.String({ minLength: 1 }),
  compiled_hash: Type.String({ minLength: 1 }),
});

export const RunRequestSchema = Type.Object(
  {
    message: Type.Union([Type.String(), Type.Null()]),
    session_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    resume: Type.Optional(Type.Boolean()),
    prompt_profile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    search_mode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    preset_model: Type.Optional(Type.Union([PresetModelRefSchema, Type.Null()])),
    response_format: Type.Optional(Type.Union([ResponseFormatSchema, Type.Null()])),
  },
  { additionalProperties: true, $id: "https://anomaloharis.dev/schemas/run-request.schema.json" },
);

export const ToolDefinitionSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
    description: Type.String(),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    source: Type.String({ minLength: 1 }),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 600_000 })),
  },
  { additionalProperties: true, $id: "https://anomaloharis.dev/schemas/tool.schema.json" },
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
