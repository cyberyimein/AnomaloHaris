import * as http from "node:http";
import { lookup } from "node:dns/promises";
import * as https from "node:https";
import { isIP } from "node:net";

import type { ToolCall, ToolDefinition, ToolResult } from "@anomaloharis/contracts";

import type { ToolRuntime } from "./tools.js";
import type { ToolContext } from "./types.js";

export type WebToolRuntimeOptions = {
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  searchUrl?: string;
  maxChars?: number;
  timeoutMs?: number;
  lookupImpl?: (hostname: string) => Promise<readonly string[]>;
};

export class WebToolRuntime implements ToolRuntime {
  private readonly enabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly searchUrl: string;
  private readonly maxChars: number;
  private readonly timeoutMs: number;
  private readonly lookupImpl: (hostname: string) => Promise<readonly string[]>;
  private readonly pinDnsAddress: boolean;

  constructor(options: WebToolRuntimeOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.searchUrl = options.searchUrl ?? "https://html.duckduckgo.com/html/";
    this.maxChars = Math.max(1_000, options.maxChars ?? 30_000);
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 30_000);
    this.lookupImpl = options.lookupImpl ?? (async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address));
    this.pinDnsAddress = options.fetchImpl === undefined;
  }

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    if (!this.enabled || context.searchMode !== "diy") return [];
    return [
      {
        name: "web_search",
        description: "Search the public web and return titles, URLs, and snippets.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 },
            count: { type: "integer", minimum: 1, maximum: 10, default: 5 },
          },
          required: ["query"],
          additionalProperties: false,
        },
        source: "web",
      },
      {
        name: "web_fetch",
        description: "Fetch a public HTTP(S) page and return bounded readable text.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", minLength: 1 },
            max_chars: { type: "integer", minimum: 1_000, maximum: this.maxChars },
            start_char: { type: "integer", minimum: 0 },
          },
          required: ["url"],
          additionalProperties: false,
        },
        source: "web",
      },
    ];
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    if (!this.enabled || context.searchMode !== "diy") {
      return { name: call.name, ok: false, content: "DIY web tools are disabled for this run.", data: { error_code: "invalid_search_mode" } };
    }
    if (call.name === "web_search") return this.search(call, signal);
    if (call.name === "web_fetch") return this.fetchPage(call, signal);
    return { name: call.name, ok: false, content: `Unknown web tool: ${call.name}`, data: { error_code: "tool_not_found" } };
  }

  async status(_context: ToolContext): Promise<Record<string, unknown>[]> {
    return [{ provider: "web", available: this.enabled, transport: "node-fetch" }];
  }

  private async search(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const query = String(call.arguments.query ?? "").trim();
    if (!query) return { name: call.name, ok: false, content: "Search query is required.", data: { error_code: "message_required" } };
    const count = clampInteger(call.arguments.count, 5, 1, 10);
    try {
      const searchTarget = new URL(this.searchUrl);
      searchTarget.searchParams.set("q", query);
      const response = await this.request(searchTarget.href, {
        method: "GET",
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "AnomaloHaris/0.1 Node Host" },
      }, signal);
      if (!response.ok) {
        return {
          name: call.name,
          ok: false,
          content: `HTTP ${response.status} while searching ${searchTarget.origin}`,
          data: { error_code: "tool_failed", query, status: response.status },
        };
      }
      const html = await response.text();
      const results = parseSearchResults(html).slice(0, count);
      return {
        name: call.name,
        ok: results.length > 0,
        content: results.length > 0 ? results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`).join("\n\n") : "No web results found.",
        data: { query, results },
      };
    } catch (error) {
      return { name: call.name, ok: false, content: `Web search failed: ${error instanceof Error ? error.message : String(error)}`, data: { error_code: "tool_failed", query } };
    }
  }

  private async fetchPage(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const url = String(call.arguments.url ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only HTTP(S) URLs are supported.");
      await this.validatePublicUrl(parsed);
    } catch (error) {
      return { name: call.name, ok: false, content: error instanceof Error ? error.message : String(error), data: { error_code: "tool_failed" } };
    }
    const maxChars = clampInteger(call.arguments.max_chars, this.maxChars, 1_000, this.maxChars);
    const startChar = clampInteger(call.arguments.start_char, 0, 0, Number.MAX_SAFE_INTEGER);
    try {
      const response = await this.requestPublic(parsed.href, { headers: { "user-agent": "AnomaloHaris/0.1 Node Host" } }, signal);
      if (!response.ok) return { name: call.name, ok: false, content: `HTTP ${response.status} while fetching ${parsed.href}`, data: { error_code: "tool_failed", status: response.status } };
      const contentType = response.headers.get("content-type") ?? "";
      if (!/(text\/|application\/(xhtml\+xml|json|xml))/.test(contentType)) return { name: call.name, ok: false, content: `Unsupported response content type: ${contentType}`, data: { error_code: "tool_failed" } };
      const text = stripHtml(await response.text());
      const content = text.slice(startChar, startChar + maxChars);
      return { name: call.name, ok: true, content, data: { url: parsed.href, content_type: contentType, start_char: startChar, truncated: startChar + maxChars < text.length } };
    } catch (error) {
      return { name: call.name, ok: false, content: `Web fetch failed: ${error instanceof Error ? error.message : String(error)}`, data: { error_code: "tool_failed", url: parsed.href } };
    }
  }

  private async request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return this.fetchImpl(url, { ...init, signal: AbortSignal.any([signal, timeout]) });
  }

  private async requestPublic(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let currentUrl = url;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const parsed = new URL(currentUrl);
      const address = await this.resolvePublicAddress(parsed);
      const response = this.pinDnsAddress
        ? await this.requestPinned(currentUrl, init, signal, address)
        : await this.request(currentUrl, { ...init, redirect: "manual" }, signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirect === 5) throw new Error("Too many redirects while fetching the public URL.");
      currentUrl = new URL(location, parsed).href;
    }
    throw new Error("Too many redirects while fetching the public URL.");
  }

  private async validatePublicUrl(url: URL): Promise<void> {
    await this.resolvePublicAddress(url);
  }

  private async resolvePublicAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
    if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
      throw new Error("URL resolves to a non-public address.");
    }
    const addresses = isIP(hostname) ? [hostname] : await this.lookupImpl(hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error("URL resolves to a non-public address.");
    const address = addresses[0];
    const family = isIP(address ?? "");
    if (!address || (family !== 4 && family !== 6)) throw new Error("URL resolves to an invalid address.");
    return { address, family };
  }

  private async requestPinned(url: string, init: RequestInit, signal: AbortSignal, resolved: { address: string; family: 4 | 6 }): Promise<Response> {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const headers = new Headers(init.headers);
    const nodeHeaders: Record<string, string> = {};
    headers.forEach((value, key) => { nodeHeaders[key] = value; });
    return new Promise<Response>((resolveResponse, reject) => {
      const request = transport.request(parsed, {
        method: init.method ?? "GET",
        headers: nodeHeaders,
        signal: requestSignal,
        lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolveResponse(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 500,
            headers: responseHeaders,
          }));
        });
      });
      request.once("error", reject);
      if (typeof init.body === "string") request.write(init.body);
      request.end();
    });
  }
}

function parseSearchResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const pattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/)/gi;
  for (const match of html.matchAll(pattern)) {
    const url = decodeHtml(match[1] ?? "");
    const title = stripHtml(match[2] ?? "");
    const snippet = stripHtml(match[3] ?? "");
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const [first = -1, second = -1] = octets;
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19 || second === 51))
      || (first === 203 && second === 0);
  }
  if (isIP(normalized) !== 6) return true;
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4) return isPrivateAddress(mappedIpv4);
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) return true;
  return false;
}

function mappedIpv4Address(address: string): string | undefined {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const parts = address.split("::");
  if (parts.length > 2) return undefined;
  const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const right = parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const expanded = parts.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : [...left];
  if (expanded.length !== 8 || expanded.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const isMapped = expanded.slice(0, 5).every((part) => part === "0") && expanded[5] === "ffff";
  const isCompatible = expanded.slice(0, 6).every((part) => part === "0");
  if (!isMapped && !isCompatible) return undefined;
  const first = Number.parseInt(expanded[6] ?? "0", 16);
  const second = Number.parseInt(expanded[7] ?? "0", 16);
  return `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
}
