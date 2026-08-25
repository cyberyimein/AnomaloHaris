import { Type, type Static } from "@sinclair/typebox";

import { PresetModelRefSchema, ResponseFormatSchema } from "./schemas.js";

export const OpenAIModelSchema = Type.Object({
  id: PresetModelRefSchema,
  object: Type.Literal("model"),
  created: Type.Integer({ minimum: 0 }),
  owned_by: Type.String({ minLength: 1 }),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const OpenAIModelListSchema = Type.Object({
  object: Type.Literal("list"),
  data: Type.Array(OpenAIModelSchema),
});

export const OpenAIChatMessageSchema = Type.Object({
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]),
  content: Type.Union([Type.String(), Type.Null()]),
  name: Type.Optional(Type.String({ minLength: 1 })),
  tool_call_id: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: true });

export const OpenAIChatCompletionRequestSchema = Type.Object({
  model: PresetModelRefSchema,
  messages: Type.Array(OpenAIChatMessageSchema, { minItems: 1 }),
  stream: Type.Optional(Type.Boolean()),
  response_format: Type.Optional(ResponseFormatSchema),
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // These fields remain in the schema so the route can return a stable,
  // explicit error instead of silently accepting caller-controlled tools.
  tools: Type.Optional(Type.Array(Type.Unknown())),
  tool_choice: Type.Optional(Type.Unknown()),
  provider: Type.Optional(Type.Unknown()),
  prompt: Type.Optional(Type.Unknown()),
  plugins: Type.Optional(Type.Unknown()),
}, { additionalProperties: true, $id: "https://anomaloharis.dev/schemas/openai-chat-completion-request.schema.json" });

export const OpenAIUsageSchema = Type.Object({
  prompt_tokens: Type.Integer({ minimum: 0 }),
  completion_tokens: Type.Integer({ minimum: 0 }),
  total_tokens: Type.Integer({ minimum: 0 }),
}, { additionalProperties: true, $id: "https://anomaloharis.dev/schemas/openai-usage.schema.json" });

export const OpenAIChatCompletionResponseSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  object: Type.Literal("chat.completion"),
  created: Type.Integer({ minimum: 0 }),
  model: PresetModelRefSchema,
  choices: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 0 }),
    message: Type.Object({ role: Type.Literal("assistant"), content: Type.Union([Type.String(), Type.Null()]) }),
    finish_reason: Type.Union([Type.Literal("stop"), Type.Null()]),
  }), { minItems: 1 }),
  usage: OpenAIUsageSchema,
});

export const OpenAIChatCompletionChunkSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  object: Type.Literal("chat.completion.chunk"),
  created: Type.Integer({ minimum: 0 }),
  model: PresetModelRefSchema,
  choices: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 0 }),
    delta: Type.Object({
      role: Type.Optional(Type.Literal("assistant")),
      content: Type.Optional(Type.String()),
    }),
    finish_reason: Type.Union([Type.Literal("stop"), Type.Null()]),
  }), { minItems: 1 }),
  usage: Type.Optional(OpenAIUsageSchema),
});

export type OpenAIModel = Static<typeof OpenAIModelSchema>;
export type OpenAIModelList = Static<typeof OpenAIModelListSchema>;
export type OpenAIChatMessage = Static<typeof OpenAIChatMessageSchema>;
export type OpenAIChatCompletionRequest = Static<typeof OpenAIChatCompletionRequestSchema>;
export type OpenAIUsage = Static<typeof OpenAIUsageSchema>;
export type OpenAIChatCompletionResponse = Static<typeof OpenAIChatCompletionResponseSchema>;
export type OpenAIChatCompletionChunk = Static<typeof OpenAIChatCompletionChunkSchema>;
