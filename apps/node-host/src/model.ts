import type { ToolCall } from "@anomalo/contracts";

import { DsmlProtocolError, DsmlToolCallParser } from "./dsml.js";
import type { ModelMessage, ResponseFormat, ToolDefinition } from "./types.js";

export type ModelRequest = {
  model: string;
  temperature?: number | undefined;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  responseFormat?: ResponseFormat | undefined;
};

export type ModelStreamEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.calls"; calls: ToolCall[] }
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

export interface ModelAdapter {
  readonly model: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<string>;
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

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string> {
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
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...requestPayload(request), stream: true }),
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
            const calls = [...parseToolCalls(pendingCalls), ...parsed.calls];
            yield calls.length > 0 ? { type: "tool.calls", calls } : { type: "done" };
            return;
          }
          const payload = JSON.parse(data) as Record<string, any>;
          const delta = payload.choices?.[0]?.delta;
          if (typeof delta?.content === "string") {
            const parsed = dsmlParser?.feed(delta.content) ?? { text: delta.content, calls: [] };
            if (parsed.text) {
              emittedText += parsed.text;
              yield { type: "text.delta", text: parsed.text };
            }
            if (parsed.calls.length > 0) {
              yield {
                type: "tool.calls",
                calls: [...parseToolCalls(pendingCalls), ...parsed.calls],
              };
              return;
            }
          }
          for (const toolDelta of delta?.tool_calls ?? []) {
            const index = Number(toolDelta.index ?? 0);
            const pending = pendingCalls.get(index) ?? { id: "", name: "", arguments: "" };
            pending.id += String(toolDelta.id ?? "");
            pending.name += String(toolDelta.function?.name ?? "");
            pending.arguments += String(toolDelta.function?.arguments ?? "");
            pendingCalls.set(index, pending);
          }
          if (["stop", "length", "content_filter"].includes(payload.choices?.[0]?.finish_reason)) {
            const parsed = finishDsml(dsmlParser);
            if (parsed.text) {
              emittedText += parsed.text;
              yield { type: "text.delta", text: parsed.text };
            }
            const calls = [...parseToolCalls(pendingCalls), ...parsed.calls];
            yield calls.length > 0 ? { type: "tool.calls", calls } : { type: "done" };
            return;
          }
        }
        if (chunk.done) break;
      }
      const parsed = finishDsml(dsmlParser);
      if (parsed.text) {
        emittedText += parsed.text;
        yield { type: "text.delta", text: parsed.text };
      }
      const calls = [...parseToolCalls(pendingCalls), ...parsed.calls];
      yield calls.length > 0 ? { type: "tool.calls", calls } : { type: "done" };
    } catch (error) {
      if (signal.aborted) throw new ModelInterruptedError(emittedText, parseToolCalls(pendingCalls));
      if (error instanceof DsmlProtocolError) throw new ModelProtocolError(error.message);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload(request)),
      signal,
    });
    if (!response.ok) throw new Error(`Model request failed (${response.status}).`);
    const payload = (await response.json()) as Record<string, any>;
    const content = String(payload.choices?.[0]?.message?.content ?? "");
    if (this.toolProtocol === "openai" || this.toolProtocol === "none") return content;
    try {
      const parsed = new DsmlToolCallParser();
      const first = parsed.feed(content);
      const last = parsed.finish();
      const calls = [...first.calls, ...last.calls];
      if (calls.length > 0) throw new ModelProtocolError("Non-streaming provider response contained tool calls.");
      return first.text + last.text;
    } catch (error) {
      if (error instanceof ModelProtocolError) throw error;
      if (error instanceof DsmlProtocolError) throw new ModelProtocolError(error.message);
      throw error;
    }
  }
}

function finishDsml(parser: DsmlToolCallParser | undefined): { text: string; calls: ToolCall[] } {
  return parser?.finish() ?? { text: "", calls: [] };
}

function requestPayload(request: ModelRequest): Record<string, unknown> {
  return {
    model: request.model,
    temperature: request.temperature,
    messages: request.messages,
    tools: request.tools.length > 0 ? request.tools : undefined,
    tool_choice: request.tools.length > 0 ? "auto" : undefined,
    response_format: request.responseFormat,
  };
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
