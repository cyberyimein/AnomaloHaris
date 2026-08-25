import type { ToolCall } from "@anomaloharis/contracts";

import { DsmlProtocolError, DsmlToolCallParser } from "./dsml.js";
import type { ModelMessage, ResponseFormat, ToolDefinition } from "./types.js";

export type ModelRequest = {
  model: string;
  presetModelRef?: string | undefined;
  toolProtocol?: "openai" | "dsml" | "auto" | "none" | undefined;
  temperature?: number | undefined;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  responseFormat?: ResponseFormat | undefined;
};

export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number | undefined;
  providerRequestId?: string | undefined;
};

export type ModelCompletion = {
  text: string;
  usage?: ModelUsage | undefined;
};

export type ModelStreamEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.calls"; calls: ToolCall[] }
  | { type: "usage"; usage: ModelUsage }
  | { type: "done" };

export class ModelInterruptedError extends Error {
  readonly partialText: string;
  readonly toolCalls: ToolCall[];

  constructor(partialText: string, toolCalls: ToolCall[]) {
    super("Model stream interrupted");
    this.name = "ModelInterruptedError";
    this.partialText = partialText;
    this.toolCalls = toolCalls;
  }
}

export class ModelProtocolError extends Error {
  readonly errorCode = "provider_protocol_error";

  constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

export class ProviderUnavailableError extends Error {
  readonly errorCode = "provider_unavailable";

  constructor(message = "No model provider credential is configured.") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export interface ModelAdapter {
  readonly model: string;
  readonly lastUsage?: ModelUsage | undefined;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<string | ModelCompletion>;
}

export type ReplayStep = readonly ModelStreamEvent[];

export class ReplayModelAdapter implements ModelAdapter {
  readonly streamCalls: ModelRequest[] = [];
  readonly completeCalls: ModelRequest[] = [];
  private readonly steps: ModelStreamEvent[][];
  private readonly completions: string[];

  constructor(
    steps: Iterable<ReplayStep>,
    options: { completions?: Iterable<string>; model?: string } = {},
  ) {
    this.steps = [...steps].map((step) => [...step]);
    this.completions = [...(options.completions ?? [])];
    this.model = options.model ?? "replay-model";
  }

  readonly model: string;

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.streamCalls.push(cloneRequest(request));
    const step = this.steps.shift();
    if (!step) {
      throw new Error("ReplayModelAdapter has no streamed step left.");
    }
    let partialText = "";
    let toolCalls: ToolCall[] = [];
    try {
      for (const event of step) {
        if (signal.aborted) {
          throw new ModelInterruptedError(partialText, toolCalls);
        }
        if (event.type === "text.delta") partialText += event.text;
        if (event.type === "tool.calls") toolCalls = event.calls;
        yield event;
      }
    } catch (error) {
      if (error instanceof ModelInterruptedError) throw error;
      throw error;
    }
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string | ModelCompletion> {
    this.completeCalls.push(cloneRequest(request));
    if (signal.aborted) throw new ModelInterruptedError("", []);
    const completion = this.completions.shift();
    if (completion === undefined) {
      throw new Error("ReplayModelAdapter has no completion left.");
    }
    return completion;
  }
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly model: string;
  lastUsage: ModelUsage | undefined;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly toolProtocol: "auto" | "openai" | "dsml" | "none";

  constructor(options: {
    model: string;
    baseUrl: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
    toolProtocol?: "auto" | "openai" | "dsml" | "none";
  }) {
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.toolProtocol = options.toolProtocol ?? "auto";
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.lastUsage = undefined;
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...requestPayload(request, this.toolProtocol), stream: true }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Model request failed (${response.status}).`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
    const dsmlParser = this.toolProtocol === "openai" || this.toolProtocol === "none"
      ? undefined
      : new DsmlToolCallParser();
    let emittedText = "";
    let emittedUsage = false;
    const pendingDsmlCalls: ToolCall[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data) continue;
          if (data === "[DONE]") {
            const parsed = finishDsml(dsmlParser);
            if (parsed.text) {
              emittedText += parsed.text;
              yield { type: "text.delta", text: parsed.text };
            }
            const calls = this.toolProtocol === "none"
              ? []
              : [...parseToolCalls(pendingCalls), ...pendingDsmlCalls, ...parsed.calls];
            yield calls.length > 0 ? { type: "tool.calls", calls } : { type: "done" };
            return;
          }
          const payload = JSON.parse(data) as Record<string, any>;
          const usage = normalizeUsage(payload.usage, payload.id);
          if (usage && !emittedUsage) {
            emittedUsage = true;
            this.lastUsage = usage;
            yield { type: "usage", usage };
          }
          const delta = payload.choices?.[0]?.delta;
          if (typeof delta?.content === "string") {
            const parsed = dsmlParser?.feed(delta.content) ?? { text: delta.content, calls: [] };
            if (parsed.text) {
              emittedText += parsed.text;
              yield { type: "text.delta", text: parsed.text };
            }
            if (parsed.calls.length > 0) {
              pendingDsmlCalls.push(...parsed.calls);
            }
          }
          for (const toolDelta of this.toolProtocol === "none" ? [] : delta?.tool_calls ?? []) {
            const index = Number(toolDelta.index ?? 0);
            const pending = pendingCalls.get(index) ?? { id: "", name: "", arguments: "" };
            pending.id += String(toolDelta.id ?? "");
            pending.name += String(toolDelta.function?.name ?? "");
            pending.arguments += String(toolDelta.function?.arguments ?? "");
            pendingCalls.set(index, pending);
          }
        }
        if (chunk.done) break;
      }
      const parsed = finishDsml(dsmlParser);
      if (parsed.text) {
        emittedText += parsed.text;
        yield { type: "text.delta", text: parsed.text };
      }
      const calls = this.toolProtocol === "none"
        ? []
        : [...parseToolCalls(pendingCalls), ...pendingDsmlCalls, ...parsed.calls];
      yield calls.length > 0 ? { type: "tool.calls", calls } : { type: "done" };
    } catch (error) {
      if (signal.aborted) throw new ModelInterruptedError(emittedText, parseToolCalls(pendingCalls));
      if (error instanceof DsmlProtocolError) throw new ModelProtocolError(error.message);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string | ModelCompletion> {
    this.lastUsage = undefined;
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload(request, this.toolProtocol)),
      signal,
    });
    if (!response.ok) throw new Error(`Model request failed (${response.status}).`);
    const payload = (await response.json()) as Record<string, any>;
    const usage = normalizeUsage(payload.usage, payload.id);
    this.lastUsage = usage;
    const content = String(payload.choices?.[0]?.message?.content ?? "");
    if (this.toolProtocol === "openai" || this.toolProtocol === "none") {
      return { text: content, ...(usage ? { usage } : {}) };
    }
    try {
      const parsed = new DsmlToolCallParser();
      const first = parsed.feed(content);
      const last = parsed.finish();
      const calls = [...first.calls, ...last.calls];
      if (calls.length > 0) throw new ModelProtocolError("Non-streaming provider response contained tool calls.");
      return { text: first.text + last.text, ...(usage ? { usage } : {}) };
    } catch (error) {
      if (error instanceof ModelProtocolError) throw error;
      if (error instanceof DsmlProtocolError) throw new ModelProtocolError(error.message);
      throw error;
    }
  }
}

function normalizeUsage(value: unknown, requestId: unknown): ModelUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = integerValue(usage.prompt_tokens);
  const completionTokens = integerValue(usage.completion_tokens);
  const totalTokens = integerValue(usage.total_tokens);
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return undefined;
  const cachedTokens = integerValue(usage.cached_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(typeof requestId === "string" && requestId ? { providerRequestId: requestId } : {}),
  };
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function finishDsml(parser: DsmlToolCallParser | undefined): { text: string; calls: ToolCall[] } {
  return parser?.finish() ?? { text: "", calls: [] };
}

function requestPayload(request: ModelRequest, toolProtocol = request.toolProtocol): Record<string, unknown> {
  return {
    model: request.model,
    temperature: request.temperature,
    messages: request.messages.map(toProviderMessage),
    tools: request.toolProtocol === "none" ? undefined : request.tools.length > 0 ? request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })) : undefined,
    tool_choice: request.toolProtocol === "none" || request.tools.length === 0 ? undefined : "auto",
    response_format: request.responseFormat,
  };
}

function toProviderMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      ...(message.name ? { name: message.name } : {}),
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function parseToolCalls(
  pendingCalls: Map<number, { id: string; name: string; arguments: string }>,
): ToolCall[] {
  return [...pendingCalls.entries()].sort(([a], [b]) => a - b).map(([index, value]) => ({
    id: value.id || `call_${index}`,
    name: value.name,
    arguments: parseArguments(value.arguments),
  }));
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function cloneRequest(request: ModelRequest): ModelRequest {
  return structuredClone(request);
}
