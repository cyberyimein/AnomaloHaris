import type { ToolCall, ToolDefinition, ToolResult } from "@anomaloharis/contracts";

import { WebResearchSubagent } from "./subagent.js";
import type { ToolRuntime } from "./tools.js";
import type { ToolContext } from "./types.js";
import { DEFAULT_SEARCH_MODE, DEFAULT_SUBAGENT_MODEL, isSearchMode, type RetrievalSearchMode } from "./search-mode.js";

export { DEFAULT_SEARCH_MODE, DEFAULT_SUBAGENT_MODEL, isSearchMode, SEARCH_MODES } from "./search-mode.js";

const SEARCH_TOOL_NAME = "web_search";
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 90_000;
const MIN_SUBAGENT_TIMEOUT_MS = 180_000;

export type ResponsesSearchRuntimeOptions = {
  apiKey?: string;
  baseUrl?: string;
  subagentModel?: string;
  timeoutMs?: number;
  subagentTimeoutMs?: number;
  resolveProvider?: (context: ToolContext) => ResponsesSearchProvider | undefined;
  fetchImpl?: typeof fetch;
};

export type ResponsesSearchProvider = {
  baseUrl: string;
  apiKey?: string;
};

export class ResponsesSearchRuntime implements ToolRuntime {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly subagentModel: string;
  private readonly timeoutMs: number;
  private readonly subagentTimeoutMs: number;
  private readonly resolveProvider: ((context: ToolContext) => ResponsesSearchProvider | undefined) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly subagent: WebResearchSubagent;

  constructor(options: ResponsesSearchRuntimeOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.baseUrl = options.baseUrl?.trim().replace(/\/+$/, "") ?? "";
    this.subagentModel = options.subagentModel?.trim() || DEFAULT_SUBAGENT_MODEL;
    this.timeoutMs = clampInteger(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 100, 300_000);
    this.subagentTimeoutMs = clampInteger(
      options.subagentTimeoutMs,
      Math.max(this.timeoutMs * 2, MIN_SUBAGENT_TIMEOUT_MS),
      100,
      600_000,
    );
    this.resolveProvider = options.resolveProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.subagent = new WebResearchSubagent({
      model: this.subagentModel,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      webSearch: this,
      timeoutMs: this.subagentTimeoutMs,
      toolTimeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    const mode = normalizeSearchMode(context.searchMode);
    if (mode === "diy") return [];
    const isNative = mode === "native";
    return [{
      name: SEARCH_TOOL_NAME,
      description: isNative
        ? "Use the active model to execute the Provider's native web retrieval capability."
        : `Delegate research to an isolated ${this.subagentModel} subagent with web_search as its only capability.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "Search query or research request." },
          count: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Maximum number of source results to use." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      source: isNative ? "model_native_search" : "responses_api_subagent",
      timeout_ms: isNative ? this.timeoutMs : this.subagentTimeoutMs,
    }];
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== SEARCH_TOOL_NAME) {
      return { name: call.name, ok: false, content: `Unknown retrieval tool: ${call.name}`, data: { error_code: "tool_not_found" } };
    }
    const mode = normalizeSearchMode(context.searchMode);
    if (mode === "diy") {
      return { name: call.name, ok: false, content: "Responses search mode is not active.", data: { error_code: "invalid_search_mode" } };
    }
    if (mode === "subagent") return this.subagent.run(call, context, signal);
    return this.searchDirect(call, context, signal);
  }

  private async searchDirect(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    const query = String(call.arguments.query ?? "").trim();
    if (!query) {
      return { name: call.name, ok: false, content: "Search query is required.", data: { error_code: "message_required" } };
    }
    const count = clampInteger(call.arguments.count, 5, 1, 10);
    const model = context.model;
    const providerConfig = this.resolveProvider?.(context);
    const apiKey = providerConfig ? providerConfig.apiKey?.trim() ?? "" : this.apiKey;
    const baseUrl = providerConfig ? providerConfig.baseUrl.trim().replace(/\/+$/, "") : this.baseUrl;
    const provider = "model_native_responses";
    const searchTool = responsesSearchTool(baseUrl, count);
    const baseData = {
      trace_kind: "web_search",
      provider,
      search_mode: "native",
      model,
      query,
      results: [],
      search_tool_type: searchTool.type,
    };

    if (!apiKey) {
      return {
        name: call.name,
        ok: false,
        content: "Provider-native web retrieval is unavailable because OPENROUTER_API_KEY is not configured. Switch to another retrieval mode or configure the key.",
        data: { ...baseData, capability_status: "unavailable", error_code: "missing_api_key" },
      };
    }
    if (!baseUrl) {
      return {
        name: call.name,
        ok: false,
        content: "Responses search is unavailable because OPENAI_BASE_URL is not configured.",
        data: { ...baseData, capability_status: "unavailable", error_code: "missing_base_url" },
      };
    }

    try {
      const response = await this.request(model, query, count, signal, { apiKey, baseUrl });
      const result = parseResponsesSearchResponse(response);
      const content = result.text
        ? `${result.text}${result.citations.length ? `\n\nSources:\n${result.citations.map((citation) => `- [${citation.title}](${citation.url})`).join("\n")}` : ""}`
        : "";
      if (!content) {
        return {
          name: call.name,
          ok: false,
          content: `${provider} returned no usable search content for model ${model}. Switch retrieval modes and try again.`,
          data: {
            ...baseData,
            results: result.citations,
            search_calls: result.searchCalls,
            response_id: result.responseId,
            capability_status: "no_content",
          },
        };
      }
      return {
        name: call.name,
        ok: true,
        content,
        data: {
          ...baseData,
          results: result.citations,
          citations: result.citations,
          search_calls: result.searchCalls,
          response_id: result.responseId,
          capability_status: "available",
        },
      };
    } catch (error) {
      const failure = error instanceof ResponsesSearchError
        ? error
        : new ResponsesSearchError(error instanceof Error ? error.message : String(error), "transport_error");
      const modeLabel = `Provider-native web retrieval is unavailable for ${model}`;
      return {
        name: call.name,
        ok: false,
        content: `${modeLabel}. Responses API returned: ${failure.message} Switch to another retrieval mode and try again.`,
        data: {
          ...baseData,
          capability_status: "unavailable",
          error_code: failure.code,
          ...(failure.statusCode === undefined ? {} : { http_status: failure.statusCode }),
        },
      };
    }
  }

  async status(_context: ToolContext): Promise<Record<string, unknown>[]> {
    return [{
      provider: "responses_api",
      available: Boolean(this.apiKey && this.baseUrl),
      base_url_configured: Boolean(this.baseUrl),
      api_key_configured: Boolean(this.apiKey),
      subagent_model: this.subagentModel,
      timeout_ms: this.timeoutMs,
      subagent_timeout_ms: this.subagentTimeoutMs,
    }];
  }

  private async request(
    model: string,
    query: string,
    count: number,
    signal: AbortSignal,
    provider: ResponsesSearchProvider,
  ): Promise<Record<string, unknown>> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const searchTool = responsesSearchTool(provider.baseUrl, count);
    let response: Response;
    try {
      response = await this.fetchImpl(`${provider.baseUrl.replace(/\/+$/, "")}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: query,
          tools: [searchTool],
          max_tool_calls: 1,
          max_output_tokens: 2_400,
        }),
        signal: requestSignal,
      });
    } catch (error) {
      throw new ResponsesSearchError(error instanceof Error ? error.message : String(error), "transport_error");
    }
    const text = await boundedResponseText(response, MAX_RESPONSE_BYTES);
    const payload = parseJsonObject(text);
    if (!response.ok || payload.error) {
      const error = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : {};
      throw new ResponsesSearchError(
        String(error.message || `HTTP ${response.status}`),
        String(error.code || "responses_api_error"),
        response.status,
      );
    }
    if (!payload || Object.keys(payload).length === 0) {
      throw new ResponsesSearchError(`Responses API returned invalid JSON (HTTP ${response.status}).`, "invalid_response", response.status);
    }
    return payload;
  }
}

export class ResponsesSearchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ResponsesSearchError";
  }
}

type ResponsesSearchTool =
  | { type: "openrouter:web_search"; parameters: { engine: "auto"; max_results: number; max_uses: 1; max_total_results: number } }
  | { type: "web_search_preview" };

function responsesSearchTool(baseUrl: string, count: number): ResponsesSearchTool {
  if (isOpenRouterBaseUrl(baseUrl)) {
    return {
      type: "openrouter:web_search",
      parameters: {
        engine: "auto",
        max_results: count,
        max_uses: 1,
        max_total_results: count,
      },
    };
  }
  return { type: "web_search_preview" };
}

function isOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

type ResponsesSearchResult = {
  text: string;
  citations: Array<{ title: string; url: string; snippet?: string }>;
  searchCalls: Array<Record<string, unknown>>;
  responseId?: string;
};

function parseResponsesSearchResponse(payload: Record<string, unknown>): ResponsesSearchResult {
  const textParts: string[] = [];
  const citations: Array<{ title: string; url: string; snippet?: string }> = [];
  const searchCalls: Array<Record<string, unknown>> = [];
  const seenUrls = new Set<string>();
  const output = Array.isArray(payload.output) ? payload.output : [];

  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    const itemType = String(item.type ?? "");
    if (itemType === "web_search_call") {
      const action = item.action && typeof item.action === "object" && !Array.isArray(item.action)
        ? item.action as Record<string, unknown>
        : {};
      searchCalls.push({
        type: itemType,
        status: item.status,
        ...(action.query === undefined ? {} : { query: action.query }),
        ...(action.queries === undefined ? {} : { queries: action.queries }),
      });
    }
    if (["output_text", "text"].includes(itemType) && item.text) textParts.push(String(item.text));
    const contents = Array.isArray(item.content) ? item.content : [];
    for (const rawContent of contents) {
      if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) continue;
      const content = rawContent as Record<string, unknown>;
      const contentType = String(content.type ?? "");
      if (["output_text", "text"].includes(contentType) && content.text) textParts.push(String(content.text));
      const annotations = Array.isArray(content.annotations) ? content.annotations : [];
      for (const annotation of annotations) {
        const citation = citationFromAnnotation(annotation);
        if (citation && !seenUrls.has(citation.url)) {
          seenUrls.add(citation.url);
          citations.push(citation);
        }
      }
    }
  }
  if (textParts.length === 0 && typeof payload.output_text === "string") textParts.push(payload.output_text);
  return {
    text: textParts.map((part) => part.trim()).filter(Boolean).join("\n").trim(),
    citations,
    searchCalls,
    ...(typeof payload.id === "string" && payload.id ? { responseId: payload.id } : {}),
  };
}

function citationFromAnnotation(value: unknown): { title: string; url: string; snippet?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const annotation = value as Record<string, unknown>;
  const nested = annotation.url_citation && typeof annotation.url_citation === "object" && !Array.isArray(annotation.url_citation)
    ? annotation.url_citation as Record<string, unknown>
    : {};
  const url = String(annotation.url ?? nested.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return undefined;
  const title = String(annotation.title ?? nested.title ?? "").trim() || new URL(url).hostname;
  const snippet = String(annotation.content ?? nested.content ?? "").trim();
  return { title, url, ...(snippet ? { snippet } : {}) };
}

function normalizeSearchMode(value: string): RetrievalSearchMode {
  return isSearchMode(value) ? value : DEFAULT_SEARCH_MODE;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, numberValue));
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new ResponsesSearchError("Responses API response is too large.", "response_too_large", response.status);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new ResponsesSearchError("Responses API response is too large.", "response_too_large", response.status);
  return text;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
