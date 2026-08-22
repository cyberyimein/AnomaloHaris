import { spawn, type ChildProcess } from "node:child_process";
import { URL } from "node:url";

import type { ToolCall, ToolDefinition, ToolResult } from "@anomalo/contracts";

import type { ToolRuntime } from "./tools.js";
import type { ToolContext } from "./types.js";

export type PythonWorkerClientOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type WorkerCapabilities = {
  tools?: boolean;
  audio?: boolean;
  vision?: boolean;
  buddy?: boolean;
  [key: string]: unknown;
};

export type WorkerTranscription = {
  text: string;
  language?: string | null;
  provider?: string;
  duration_seconds?: number | null;
  metadata?: Record<string, unknown>;
};

export type WorkerSynthesis = {
  audio_base64: string;
  format: string;
  mime_type: string;
  provider: string;
  language?: string | null;
  voice?: string | null;
  sample_rate_hz?: number | null;
  metadata?: Record<string, unknown>;
};

export class PythonWorkerClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PythonWorkerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/internal/health", { method: "GET" }, signal);
  }

  async capabilities(signal?: AbortSignal): Promise<WorkerCapabilities> {
    return this.request("/internal/capabilities", { method: "GET" }, signal) as Promise<WorkerCapabilities>;
  }

  async listTools(context: ToolContext, signal?: AbortSignal): Promise<ToolDefinition[]> {
    const result = await this.request("/internal/tools/list", {
      method: "POST",
      body: JSON.stringify({ context: serializeToolContext(context) }),
    }, signal);
    return Array.isArray((result as { tools?: unknown }).tools) ? (result as { tools: ToolDefinition[] }).tools : [];
  }

  async callTool(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    try {
      const result = await this.request("/internal/tools/call", {
        method: "POST",
        body: JSON.stringify({
          request_id: `${context.runId}:${call.id}`,
          session_id: context.sessionId,
          run_id: context.runId,
          tool_call_id: call.id,
          tool: call.name,
          arguments: call.arguments,
          context: serializeToolContext(context),
        }),
      }, signal);
      return normalizeWorkerResult((result as { result?: ToolResult }).result ?? result, call.name);
    } catch (error) {
      return {
        name: call.name,
        ok: false,
        content: `Python Worker unavailable: ${error instanceof Error ? error.message : String(error)}`,
        data: { error_code: "worker_unavailable", worker_url: this.baseUrl },
      };
    }
  }

  async toolStatus(context: ToolContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const [capabilities, tools] = await Promise.all([
        this.capabilities(signal),
        this.listTools(context, signal),
      ]);
      return { provider: "python-worker", available: true, capabilities, tool_count: tools.length };
    } catch (error) {
      return {
        provider: "python-worker",
        available: false,
        error_code: "worker_unavailable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async transcribe(
    audioBytes: Uint8Array,
    options: { filename?: string; contentType?: string; language?: string; prompt?: string; vadFilter?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<WorkerTranscription> {
    return this.request("/internal/audio/transcribe", {
      method: "POST",
      body: JSON.stringify({
        audio_base64: Buffer.from(audioBytes).toString("base64"),
        ...(options.filename ? { filename: options.filename } : {}),
        ...(options.contentType ? { content_type: options.contentType } : {}),
        ...(options.language ? { language: options.language } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.vadFilter === undefined ? {} : { vad_filter: options.vadFilter }),
      }),
    }, signal) as Promise<WorkerTranscription>;
  }

  async synthesize(text: string, options: { language?: string; voice?: string } = {}, signal?: AbortSignal): Promise<WorkerSynthesis> {
    return this.request("/internal/audio/synthesize", {
      method: "POST",
      body: JSON.stringify({ text, ...(options.language ? { language: options.language } : {}), ...(options.voice ? { voice: options.voice } : {}) }),
    }, signal) as Promise<WorkerSynthesis>;
  }

  async analyzeVision(imageBytes: Uint8Array, options: { applyBuddyAction?: boolean; minConfidence?: number } = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/internal/vision/analyze", {
      method: "POST",
      body: JSON.stringify({
        image_base64: Buffer.from(imageBytes).toString("base64"),
        apply_buddy_action: options.applyBuddyAction ?? false,
        ...(options.minConfidence === undefined ? {} : { min_confidence: options.minConfidence }),
      }),
    }, signal);
  }

  async buddyAction(action: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("/internal/buddy/action", { method: "POST", body: JSON.stringify(action) }, signal);
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new Error("Python Worker request cancelled.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("worker_timeout"), this.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers = new Headers(init.headers);
      headers.set("content-type", "application/json");
      if (this.token) headers.set("x-anomalo-worker-token", this.token);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const payload = await response.json() as unknown;
      if (!response.ok) throw new Error(`Worker request failed (${response.status}): ${JSON.stringify(payload)}`);
      if (!isRecord(payload)) throw new Error("Worker response must be a JSON object.");
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export class PythonWorkerToolRuntime implements ToolRuntime {
  constructor(private readonly client: PythonWorkerClient) {}

  async list(context: ToolContext): Promise<ToolDefinition[]> {
    try {
      return await this.client.listTools(context);
    } catch {
      return [];
    }
  }

  async call(call: ToolCall, context: ToolContext, signal: AbortSignal): Promise<ToolResult> {
    return this.client.callTool(call, context, signal);
  }

  async status(context: ToolContext): Promise<Record<string, unknown>[]> {
    return [await this.client.toolStatus(context)];
  }
}

export type PythonWorkerProcessOptions = {
  client: PythonWorkerClient;
  command: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
};

export class PythonWorkerProcess {
  private child: ChildProcess | undefined;
  private readonly startupTimeoutMs: number;
  private readonly restartBaseDelayMs: number;
  private readonly restartMaxDelayMs: number;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartAttempt = 0;
  private stopping = true;

  constructor(private readonly options: PythonWorkerProcessOptions) {
    this.startupTimeoutMs = Math.max(100, options.startupTimeoutMs ?? 15_000);
    this.restartBaseDelayMs = Math.max(100, options.restartBaseDelayMs ?? 250);
    this.restartMaxDelayMs = Math.max(this.restartBaseDelayMs, options.restartMaxDelayMs ?? 30_000);
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const [executable, ...args] = this.options.command;
    if (!executable) throw new Error("Python Worker command is empty.");
    const child = spawn(executable, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[python-worker] ${chunk}`));
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.stopping) this.scheduleRestart();
    });
    const startedAt = Date.now();
    let lastError = "health check has not completed";
    while (Date.now() - startedAt < this.startupTimeoutMs) {
      if (!this.running) throw new Error(`Python Worker exited before health check: ${lastError}`);
      try {
        await this.options.client.health();
        this.restartAttempt = 0;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await delay(100);
      }
    }
    await this.stop();
    throw new Error(`Python Worker did not become healthy: ${lastError}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || this.running) return;
    const delayMs = Math.min(
      this.restartMaxDelayMs,
      this.restartBaseDelayMs * (2 ** Math.min(this.restartAttempt, 8)),
    );
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch((error: unknown) => {
        process.stderr.write(`[python-worker] restart failed: ${error instanceof Error ? error.message : String(error)}\n`);
        this.scheduleRestart();
      });
    }, delayMs);
  }
}

export function workerClientFromEnvironment(env: NodeJS.ProcessEnv = process.env): PythonWorkerClient {
  return new PythonWorkerClient({
    baseUrl: env.ANOMALO_PYTHON_WORKER_URL ?? "http://127.0.0.1:8849",
    ...(env.ANOMALO_PYTHON_WORKER_TOKEN ? { token: env.ANOMALO_PYTHON_WORKER_TOKEN } : {}),
    timeoutMs: Number(env.ANOMALO_PYTHON_WORKER_TIMEOUT_MS ?? "2000"),
  });
}

export function workerCommandFromEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.ANOMALO_PYTHON_WORKER_COMMAND?.trim();
  if (configured) return configured.split(/\s+/);
  const port = new URL(env.ANOMALO_PYTHON_WORKER_URL ?? "http://127.0.0.1:8849").port || "8849";
  return [env.PYTHON_EXECUTABLE ?? "python", "-m", "uvicorn", "app.worker:app", "--host", "127.0.0.1", "--port", port];
}

function serializeToolContext(context: ToolContext): Record<string, unknown> {
  return {
    session_id: context.sessionId,
    run_id: context.runId,
    tool_call_id: context.toolCallId,
    search_mode: context.searchMode,
    model: context.model,
    active_skills: [...context.activeSkills],
    active_mcp_servers: [...context.activeMcpServers],
  };
}

function normalizeWorkerResult(value: unknown, name: string): ToolResult {
  if (!isRecord(value)) return { name, ok: false, content: "Invalid Python Worker tool result.", data: { error_code: "worker_unavailable" } };
  return {
    name,
    ok: value.ok === true,
    content: typeof value.content === "string" ? value.content : String(value.content ?? ""),
    data: isRecord(value.data) ? value.data : {},
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
