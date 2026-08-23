import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { ToolCall, ToolDefinition, ToolResult } from "@anomalo/contracts";

import type { ToolRuntime } from "./tools.js";
import type { ToolContext } from "./types.js";

export const PYTHON_SANDBOX_TOOL_NAME = "sandbox_python_run";
export const FRUITSPY_PYTHON_API_PATH = "/api/v1/tools/python";
const ARTIFACT_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_ARTIFACTS = 4;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const INLINE_ARTIFACT_MEDIA_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type PythonSandboxRuntimeOptions = {
  enabled?: boolean;
  baseUrl?: string;
  apiPath?: string;
  token?: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  statusTimeoutMs?: number;
  artifactsDir?: string;
  artifactAccessSecret?: string;
  fetchImpl?: typeof fetch;
};

type HttpJsonResponse = {
  status: number;
  headers: Headers;
  payload: Record<string, unknown>;
  text: string;
};

export type CachedPythonArtifact = {
  content: Buffer;
  mediaType: string;
};

export class PythonSandboxRuntime implements ToolRuntime {
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly apiPath: string;
  private readonly token: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly artifactsDir: string | undefined;
  private readonly artifactAccessSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly artifactMediaTypes = new Map<string, string>();

  constructor(options: PythonSandboxRuntimeOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.baseUrl = options.baseUrl?.trim().replace(/\/+$/, "") ?? "";
    this.apiPath = normalizeApiPath(options.apiPath ?? FRUITSPY_PYTHON_API_PATH);
    this.token = options.token?.trim() ?? "";
    this.defaultTimeoutMs = clampInteger(options.defaultTimeoutMs, 10_000, 1, 60_000);
    this.maxTimeoutMs = clampInteger(options.maxTimeoutMs, 60_000, this.defaultTimeoutMs, 60_000);
    this.statusTimeoutMs = clampInteger(options.statusTimeoutMs, 2_000, 100, 10_000);
    this.artifactsDir = options.artifactsDir?.trim() ? resolve(options.artifactsDir) : undefined;
    this.artifactAccessSecret = options.artifactAccessSecret?.trim() || randomUUID();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async list(_context: ToolContext): Promise<ToolDefinition[]> {
    if (!this.enabled || !this.baseUrl || !this.token) return [];
    const status = await this.fruitspyStatus();
    if (status.error || status.payload.ready !== true) return [];
    return [pythonSandboxDefinition()];
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== PYTHON_SANDBOX_TOOL_NAME) {
      return { name: call.name, ok: false, content: `Unknown sandbox tool: ${call.name}`, data: { error_code: "tool_not_found" } };
    }
    if (!this.enabled) return failedResult(call.name, "Python sandbox is disabled for this deployment.", { error_code: "sandbox_disabled" });
    if (!this.baseUrl) return failedResult(call.name, "FruitSpy Python tool base URL is not configured.", { error_code: "sandbox_unconfigured", backend: "fruitspy" });
    if (!this.token) return failedResult(call.name, "FruitSpy Python tool token is not configured.", { error_code: "sandbox_unconfigured", backend: "fruitspy" });

    const code = typeof call.arguments.code === "string" ? call.arguments.code : String(call.arguments.code ?? "");
    if (!code.trim()) return failedResult(call.name, "No Python code provided.", { error_code: "message_required" });

    const status = await this.fruitspyStatus(signal);
    if (status.error) {
      return failedResult(call.name, `FruitSpy Python tool status check failed: ${status.error}`, { backend: "fruitspy", error_code: "sandbox_unavailable" });
    }
    if (status.payload.ready !== true) {
      const state = String(status.payload.state ?? "unknown");
      const detail = status.payload.error ? ` error=${String(status.payload.error)}` : "";
      return failedResult(call.name, `FruitSpy Python tool is not ready. state=${state}${detail}`, { backend: "fruitspy", status: status.payload, error_code: "sandbox_unavailable" });
    }

    const timeoutMs = requestedTimeoutMs(call.arguments.timeout_ms, this.defaultTimeoutMs, this.maxTimeoutMs);
    const artifacts = requestedArtifacts(call.arguments.artifacts);
    const body: Record<string, unknown> = { code, timeout_ms: timeoutMs };
    if (artifacts.length > 0) body.artifacts = artifacts;
    const requestId = randomUUID();
    const headers = {
      Authorization: `Bearer ${this.token}`,
      "Idempotency-Key": requestId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response: HttpJsonResponse;
      try {
        response = await this.requestJson(
          "POST",
          this.fruitspyUrl("/executions"),
          headers,
          body,
          Math.min(timeoutMs + 2_000, 62_000),
          signal,
        );
      } catch (error) {
        return failedResult(call.name, `FruitSpy Python tool request failed: ${error instanceof Error ? error.message : String(error)}`, { backend: "fruitspy", request_id: requestId, error_code: "transport_error" });
      }

      if (response.status === 200) {
        const payload = await this.withCachedArtifacts(response.payload, context.sessionId, signal);
        return pythonExecutionResult(call.name, payload, requestId);
      }

      const error = fruitspyError(response);
      if (error.retryable === true && attempt < 3) {
        await waitForRetry(response.headers, attempt, signal);
        continue;
      }
      return failedResult(call.name, fruitspyErrorMessage(response), {
        backend: "fruitspy",
        request_id: requestId,
        http_status: response.status,
        error: error.value,
        error_code: String(error.value.code ?? "sandbox_failed"),
      });
    }

    return failedResult(call.name, "FruitSpy Python tool request failed after retries.", { backend: "fruitspy", request_id: requestId, error_code: "sandbox_failed" });
  }

  async status(_context: ToolContext): Promise<Record<string, unknown>[]> {
    if (!this.enabled) {
      return [{ provider: "fruitspy-python", enabled: false, available: false, base_url_configured: Boolean(this.baseUrl), token_configured: Boolean(this.token), tools: [] }];
    }
    if (!this.baseUrl) {
      return [{ provider: "fruitspy-python", enabled: true, available: false, base_url_configured: false, token_configured: Boolean(this.token), status_error: "base URL is not configured", tools: [] }];
    }
    const status = await this.fruitspyStatus();
    const ready = status.error === undefined && status.payload.ready === true;
    return [{
      provider: "fruitspy-python",
      enabled: true,
      available: ready && Boolean(this.token),
      base_url_configured: true,
      token_configured: Boolean(this.token),
      fruitspy_status: status.payload,
      ...(status.error === undefined ? {} : { fruitspy_status_error: status.error }),
      tools: ready && this.token ? [PYTHON_SANDBOX_TOOL_NAME] : [],
    }];
  }

  readArtifact(executionId: string, name: string, sessionId: string, accessToken: string): CachedPythonArtifact | undefined {
    if (
      !this.artifactsDir
      || !isSafeComponent(executionId)
      || !isSafeComponent(name)
      || !this.validArtifactAccessToken(executionId, name, sessionId, accessToken)
    ) return undefined;
    const path = join(this.artifactsDir, "python", executionId, name);
    try {
      if (!statSync(path).isFile()) return undefined;
      return {
        content: readFileSync(path),
        mediaType: this.artifactMediaTypes.get(`${executionId}/${name}`) ?? mediaTypeForName(name),
      };
    } catch {
      return undefined;
    }
  }

  private async fruitspyStatus(signal?: AbortSignal): Promise<{ payload: Record<string, unknown>; error?: string }> {
    if (!this.baseUrl) return { payload: {}, error: "base URL is not configured" };
    try {
      const response = await this.requestJson(
        "GET",
        this.fruitspyUrl(""),
        this.token ? { Authorization: `Bearer ${this.token}`, Accept: "application/json" } : { Accept: "application/json" },
        undefined,
        this.statusTimeoutMs,
        signal,
      );
      if (response.status !== 200) return { payload: response.payload, error: fruitspyErrorMessage(response) };
      return { payload: response.payload };
    } catch (error) {
      return { payload: {}, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async requestJson(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown> | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HttpJsonResponse> {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal,
    });
    const text = await boundedResponseText(response, MAX_RESPONSE_BYTES);
    return { status: response.status, headers: response.headers, payload: parseJsonObject(text), text };
  }

  private async withCachedArtifacts(payload: Record<string, unknown>, sessionId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const executionId = String(payload.execution_id ?? "");
    if (!isSafeComponent(executionId)) return { ...payload, artifacts: [] };
    const cachedArtifacts: Record<string, unknown>[] = [];
    const artifactErrors: Record<string, unknown>[] = Array.isArray(payload.artifact_errors)
      ? payload.artifact_errors.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
    const rawArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    for (const raw of rawArtifacts) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const artifact = raw as Record<string, unknown>;
      const name = String(artifact.name ?? "");
      const downloadUrl = String(artifact.download_url ?? "");
      if (!isSafeComponent(name) || !downloadUrl) continue;
      if (!this.artifactsDir) {
        artifactErrors.push({ path: name, reason: "artifact_cache_unconfigured" });
        continue;
      }
      try {
        const content = await this.downloadArtifact(downloadUrl, signal);
        const artifactDir = join(this.artifactsDir, "python", executionId);
        mkdirSync(artifactDir, { recursive: true });
        const target = join(artifactDir, name);
        const temporary = join(artifactDir, `.${name}.${randomUUID()}.part`);
        writeFileSync(temporary, content);
        renameSync(temporary, target);
        const mediaType = safeArtifactMediaType(String(artifact.media_type ?? "").trim(), name);
        this.artifactMediaTypes.set(`${executionId}/${name}`, mediaType);
        cachedArtifacts.push({
          ...withoutKey(artifact, "download_url"),
          media_type: mediaType,
          url: `/api/artifacts/python/${executionId}/${name}?session_id=${encodeURIComponent(sessionId)}&artifact_token=${encodeURIComponent(this.artifactAccessToken(executionId, name, sessionId))}`,
        });
      } catch (error) {
        artifactErrors.push({ path: name, reason: `download_failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return { ...payload, artifacts: cachedArtifacts, artifact_errors: artifactErrors };
  }

  private async downloadArtifact(downloadUrl: string, signal: AbortSignal): Promise<Buffer> {
    const parsed = new URL(downloadUrl, `${this.baseUrl}/`);
    const expectedPrefix = `${this.apiPath}/executions/`;
    const base = new URL(`${this.baseUrl}/`);
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith(expectedPrefix)) {
      throw new Error("FruitSpy returned an invalid artifact download URL");
    }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.defaultTimeoutMs + 2_000)]);
    const response = await this.fetchImpl(parsed.href, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "*/*" },
      signal: requestSignal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds the download limit");
    const content = Buffer.from(await response.arrayBuffer());
    if (content.byteLength > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds the download limit");
    return content;
  }

  private fruitspyUrl(suffix: string): string {
    return `${this.baseUrl}${this.apiPath}${suffix}`;
  }

  private artifactAccessToken(executionId: string, name: string, sessionId: string): string {
    return createHmac("sha256", this.artifactAccessSecret)
      .update(`${sessionId}\u0000${executionId}\u0000${name}`)
      .digest("base64url");
  }

  private validArtifactAccessToken(executionId: string, name: string, sessionId: string, accessToken: string): boolean {
    const expected = Buffer.from(this.artifactAccessToken(executionId, name, sessionId));
    const provided = Buffer.from(accessToken);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}

function pythonSandboxDefinition(): ToolDefinition {
  return {
    name: PYTHON_SANDBOX_TOOL_NAME,
    source: "sandbox",
    description: "Run short Python code in the locked-down external FruitSpy sandbox for math, data checks, or plotting. Print final answers to stdout.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1, description: "Python code to execute. Print final answers to stdout." },
        timeout_ms: { type: "integer", minimum: 1, maximum: 60_000, description: "Optional execution timeout in milliseconds." },
        artifacts: {
          type: "array",
          maxItems: MAX_ARTIFACTS,
          description: "Optional files written under /tmp to collect as artifacts.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,128}$", description: "Single filename under /tmp, such as plot.png." },
              media_type: { type: "string", maxLength: 128, description: "Artifact media type, such as image/png." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  };
}

function pythonExecutionResult(name: string, payload: Record<string, unknown>, requestId: string): ToolResult {
  const stdout = String(payload.stdout ?? "");
  const stderr = String(payload.stderr ?? "");
  const content = typeof payload.content === "string" && payload.content
    ? payload.content
    : limitOutput(stdout, stderr, 12_000);
  return {
    name,
    ok: payload.ok === true,
    content,
    data: {
      backend: "fruitspy",
      status: payload.status,
      exit_code: payload.exit_code,
      stdout,
      stderr,
      truncated: payload.truncated,
      image: payload.image,
      duration_ms: payload.duration_ms,
      execution_id: payload.execution_id,
      request_id: payload.request_id ?? requestId,
      artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
      artifact_errors: Array.isArray(payload.artifact_errors) ? payload.artifact_errors : [],
    },
  };
}

function failedResult(name: string, content: string, data: Record<string, unknown>): ToolResult {
  return { name, ok: false, content, data };
}

function requestedTimeoutMs(value: unknown, fallback: number, maximum: number): number {
  return clampInteger(value, fallback, 1, maximum);
}

function requestedArtifacts(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ARTIFACTS).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const path = String(raw.path ?? "").trim();
    if (!isSafeComponent(path)) return [];
    const mediaType = String(raw.media_type ?? "").trim();
    return [{ path, ...(mediaType && mediaType.length <= 128 ? { media_type: mediaType } : {}) }];
  });
}

function fruitspyError(response: HttpJsonResponse): { value: Record<string, unknown>; retryable: boolean } {
  const error = response.payload.error;
  const value = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : {};
  return { value, retryable: value.retryable === true || response.status === 429 || response.status === 503 };
}

function fruitspyErrorMessage(response: HttpJsonResponse): string {
  const error = fruitspyError(response).value;
  if (error.code || error.message) return `FruitSpy Python tool failed (${String(error.code ?? response.status)}): ${String(error.message ?? response.text)}`;
  const detail = response.payload.detail;
  if (detail) return `FruitSpy Python tool failed (${response.status}): ${String(detail)}`;
  const text = response.text.trim();
  return `FruitSpy Python tool failed (${response.status}): ${text.slice(0, 1_000) || "No response body."}`;
}

async function waitForRetry(headers: Headers, attempt: number, signal: AbortSignal): Promise<void> {
  const retryAfter = Number(headers.get("retry-after"));
  const delayMs = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter * 1_000, 0), 2_000) : Math.min(attempt * 250, 1_000);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Request cancelled."));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("FruitSpy response is too large.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("FruitSpy response is too large.");
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

function limitOutput(stdout: string, stderr: string, maxChars: number): string {
  const parts = [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""].filter(Boolean);
  const text = parts.join("\n\n") || "No output.";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... output truncated ...`;
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function normalizeApiPath(value: string): string {
  const normalized = `/${value.trim().replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? FRUITSPY_PYTHON_API_PATH : normalized;
}

function isSafeComponent(value: string): boolean {
  return ARTIFACT_COMPONENT_PATTERN.test(value);
}

function mediaTypeForName(name: string): string {
  const extension = name.toLowerCase().split(".").pop();
  return extension === "png"
    ? "image/png"
    : extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "gif"
        ? "image/gif"
        : extension === "webp"
          ? "image/webp"
          : extension === "avif"
            ? "image/avif"
            : extension === "json"
              ? "application/json"
              : "application/octet-stream";
}

function safeArtifactMediaType(value: string, name: string): string {
  const candidate = value.toLowerCase();
  if (INLINE_ARTIFACT_MEDIA_TYPES.has(candidate)) return candidate;
  const fallback = mediaTypeForName(name);
  return INLINE_ARTIFACT_MEDIA_TYPES.has(fallback) ? fallback : "application/octet-stream";
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, numberValue));
}
