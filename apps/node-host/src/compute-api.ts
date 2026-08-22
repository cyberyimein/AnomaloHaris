import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentEvent,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIModelList,
  OpenAIUsage,
  PresetModelRef,
  SessionId,
} from "@anomalo/contracts";
import { validateContract } from "@anomalo/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import { RunController, type StartRunRequest } from "./controller.js";
import { randomIds } from "./ids.js";
import type { CompiledPresetModel, SqlitePresetModelRegistry } from "./preset-models.js";
import type { ModelMessage } from "./types.js";
import type { SessionRepository } from "./session.js";

export type ServiceClientConfig = {
  id: string;
  token: string;
  scopes?: readonly string[];
};

type AuthenticatedClient = { id: string; scopes: ReadonlySet<string> };

export class ComputeRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorCode: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ComputeRequestError";
  }
}

export class ServiceAuth {
  private readonly clients: Map<string, { tokenHash: Buffer; scopes: ReadonlySet<string> }>;
  private readonly required: boolean;

  constructor(options: { clients?: readonly ServiceClientConfig[]; required?: boolean } = {}) {
    const clients = options.clients ?? [];
    this.required = options.required ?? clients.length > 0;
    this.clients = new Map();
    for (const client of clients) {
      if (!client.id.trim() || !client.token) throw new Error("invalid_service_client");
      if (this.clients.has(client.id)) throw new Error(`duplicate_service_client:${client.id}`);
      this.clients.set(client.id, {
        tokenHash: tokenHash(client.token),
        scopes: new Set(client.scopes ?? ["compute:models", "compute:invoke", "compute:read"]),
      });
    }
  }

  authenticate(headers: Record<string, unknown>, scope?: string): AuthenticatedClient {
    const raw = header(headers, "authorization");
    const token = raw?.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : header(headers, "x-anomalo-service-token");
    if (!token) {
      if (this.required) throw new ComputeRequestError(401, "unauthorized", "A service token is required.");
      return { id: "local", scopes: new Set(["compute:models", "compute:invoke", "compute:read"]) };
    }
    const candidateHash = tokenHash(token);
    for (const [id, client] of this.clients) {
      if (client.tokenHash.length !== candidateHash.length || !timingSafeEqual(client.tokenHash, candidateHash)) continue;
      if (scope && !client.scopes.has(scope)) {
        throw new ComputeRequestError(403, "forbidden", `Service client ${id} is missing scope ${scope}.`);
      }
      return { id, scopes: client.scopes };
    }
    throw new ComputeRequestError(401, "unauthorized", "The service token is invalid.");
  }
}

export type UsageRecord = {
  requestId: string;
  runId: string;
  clientId: string;
  modelRef: string;
  providerModel: string;
  status: "running" | "completed" | "error" | "stopped";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number | undefined;
  estimatedCost?: number | undefined;
  currency?: string | undefined;
  providerRequestId?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  latencyMs?: number | undefined;
  errorCode?: string | undefined;
};

export interface UsageRepository {
  begin(record: UsageRecord): Promise<void>;
  finish(record: UsageRecord): Promise<void>;
  list(options?: { clientId?: string; modelRef?: string; limit?: number }): Promise<UsageRecord[]>;
}

export class InMemoryUsageRepository implements UsageRepository {
  private readonly records = new Map<string, UsageRecord>();

  async begin(record: UsageRecord): Promise<void> {
    this.records.set(record.requestId, structuredClone(record));
  }

  async finish(record: UsageRecord): Promise<void> {
    this.records.set(record.requestId, structuredClone(record));
  }

  async list(options: { clientId?: string; modelRef?: string; limit?: number } = {}): Promise<UsageRecord[]> {
    return [...this.records.values()]
      .filter((record) => !options.clientId || record.clientId === options.clientId)
      .filter((record) => !options.modelRef || record.modelRef === options.modelRef)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, options.limit ?? 100)
      .map((record) => structuredClone(record));
  }
}

export type IdempotencyRecord = {
  clientId: string;
  key: string;
  requestHash: string;
  response: Record<string, unknown>;
  createdAt: string;
};

export interface IdempotencyRepository {
  get(clientId: string, key: string): Promise<IdempotencyRecord | undefined>;
  put(record: IdempotencyRecord): Promise<IdempotencyRecord>;
}

export class InMemoryIdempotencyRepository implements IdempotencyRepository {
  private readonly records = new Map<string, IdempotencyRecord>();

  async get(clientId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.records.get(`${clientId}:${key}`);
    return record ? structuredClone(record) : undefined;
  }

  async put(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    const mapKey = `${record.clientId}:${record.key}`;
    const existing = this.records.get(mapKey);
    if (existing) return structuredClone(existing);
    this.records.set(mapKey, structuredClone(record));
    return structuredClone(record);
  }
}

/** Durable usage and idempotency store for the local compute center. */
export class SqliteComputeStore implements UsageRepository, IdempotencyRepository {
  readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;

  constructor(dbPath: string, options: { database?: DatabaseSync } = {}) {
    if (options.database) {
      this.db = options.database;
      this.ownsDatabase = false;
    } else {
      if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.ownsDatabase = true;
    }
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS usage_records (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        model_ref TEXT NOT NULL,
        provider_model TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cached_tokens INTEGER,
        estimated_cost REAL,
        currency TEXT,
        provider_request_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        latency_ms INTEGER,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_usage_records_started ON usage_records(started_at DESC);
      CREATE TABLE IF NOT EXISTS idempotency_records (
        client_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(client_id, idempotency_key)
      );
    `);
  }

  async begin(record: UsageRecord): Promise<void> {
    this.writeUsage(record);
  }

  async finish(record: UsageRecord): Promise<void> {
    this.writeUsage(record);
  }

  async list(options: { clientId?: string; modelRef?: string; limit?: number } = {}): Promise<UsageRecord[]> {
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (options.clientId) { filters.push("client_id = ?"); values.push(options.clientId); }
    if (options.modelRef) { filters.push("model_ref = ?"); values.push(options.modelRef); }
    const limit = Math.max(1, Math.min(1_000, options.limit ?? 100));
    const rows = this.db.prepare(`
      SELECT * FROM usage_records
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY started_at DESC LIMIT ?
    `).all(...values, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToUsage);
  }

  async get(clientId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const row = this.db.prepare(
      "SELECT client_id, idempotency_key, request_hash, response_json, created_at FROM idempotency_records WHERE client_id = ? AND idempotency_key = ?",
    ).get(clientId, key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      clientId: String(row.client_id),
      key: String(row.idempotency_key),
      requestHash: String(row.request_hash),
      response: JSON.parse(String(row.response_json)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    };
  }

  async put(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    this.db.prepare(`
      INSERT OR IGNORE INTO idempotency_records(client_id, idempotency_key, request_hash, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.clientId, record.key, record.requestHash, JSON.stringify(record.response), record.createdAt);
    return (await this.get(record.clientId, record.key)) ?? record;
  }

  close(): void {
    if (this.ownsDatabase && this.db.isOpen) this.db.close();
  }

  private writeUsage(record: UsageRecord): void {
    this.db.prepare(`
      INSERT INTO usage_records(
        request_id, run_id, client_id, model_ref, provider_model, status,
        input_tokens, output_tokens, total_tokens, cached_tokens, estimated_cost,
        currency, provider_request_id, started_at, ended_at, latency_ms, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        run_id = excluded.run_id,
        client_id = excluded.client_id,
        model_ref = excluded.model_ref,
        provider_model = excluded.provider_model,
        status = excluded.status,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens,
        cached_tokens = excluded.cached_tokens,
        estimated_cost = excluded.estimated_cost,
        currency = excluded.currency,
        provider_request_id = excluded.provider_request_id,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        latency_ms = excluded.latency_ms,
        error_code = excluded.error_code
    `).run(
      record.requestId,
      record.runId,
      record.clientId,
      record.modelRef,
      record.providerModel,
      record.status,
      record.inputTokens,
      record.outputTokens,
      record.totalTokens,
      record.cachedTokens ?? null,
      record.estimatedCost ?? null,
      record.currency ?? null,
      record.providerRequestId ?? null,
      record.startedAt,
      record.endedAt ?? null,
      record.latencyMs ?? null,
      record.errorCode ?? null,
    );
  }
}

export class NativeRunStore {
  private readonly runs = new Map<string, { runId: string; sessionId: string; modelRef: string; events: AgentEvent[]; active: boolean }>();

  start(runId: string, sessionId: string, modelRef: string): void {
    this.runs.set(runId, { runId, sessionId, modelRef, events: [], active: true });
  }

  append(runId: string, event: AgentEvent): void {
    const run = this.runs.get(runId);
    if (run) run.events.push(structuredClone(event));
  }

  finish(runId: string, events: AgentEvent[]): void {
    const run = this.runs.get(runId);
    if (run) {
      run.events = structuredClone(events);
      run.active = false;
    }
  }

  get(runId: string): { runId: string; sessionId: string; modelRef: string; events: AgentEvent[]; active: boolean } | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
}

export type ComputeApiOptions = {
  registry: SqlitePresetModelRegistry;
  controller: RunController;
  sessions: SessionRepository;
  auth?: ServiceAuth;
  usage?: UsageRepository;
  idempotency?: IdempotencyRepository;
  nativeRuns?: NativeRunStore;
};

export function registerComputeRoutes(app: FastifyInstance, options: ComputeApiOptions): void {
  const auth = options.auth ?? new ServiceAuth();
  const usage = options.usage ?? new InMemoryUsageRepository();
  const idempotency = options.idempotency ?? new InMemoryIdempotencyRepository();
  const nativeRuns = options.nativeRuns ?? new NativeRunStore();

  app.get("/v1/models", async (request, reply) => {
    try {
      auth.authenticate(request.headers as Record<string, unknown>, "compute:models");
      const response: OpenAIModelList = {
        object: "list",
        data: options.registry.list().map((model) => ({
          id: model.ref,
          object: "model" as const,
          created: 0,
          owned_by: "anomalo",
          metadata: { name: model.name, version: model.version, description: model.description, compiled_hash: model.compiled_hash },
        })),
      };
      return reply.send(response);
    } catch (error) {
      return sendComputeError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/v1/chat/completions", async (request, reply) => {
    let prepared: PreparedChat;
    try {
      const client = auth.authenticate(request.headers as Record<string, unknown>, "compute:invoke");
      prepared = await prepareChat(request.body, client.id, request.headers as Record<string, unknown>, options, idempotency);
      if (prepared.existingResponse) {
        if (prepared.request.stream === true) return sendReplayStream(reply, prepared.existingResponse);
        return reply.send(prepared.existingResponse);
      }
    } catch (error) {
      return sendComputeError(reply, error);
    }

    if (prepared.request.stream === true) {
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache, no-transform");
      reply.raw.setHeader("connection", "keep-alive");
      try {
        await executeStream(prepared, reply.raw, options, usage, idempotency);
      } catch (error) {
        writeSse(reply.raw, { error: computeErrorPayload(error) });
        writeSseLine(reply.raw, "[DONE]");
      } finally {
        if (!reply.raw.writableEnded) reply.raw.end();
      }
      return;
    }

    try {
      const response = await executeNonStream(prepared, options, usage, idempotency);
      return reply.send(response);
    } catch (error) {
      return sendComputeError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string }; Body: unknown }>("/api/preset-models/:name/versions/:version/runs", async (request, reply) => {
    try {
      const client = auth.authenticate(request.headers as Record<string, unknown>, "compute:invoke");
      const ref = `${request.params.name}@${request.params.version}`;
      const model = resolvePublishedModel(options.registry, ref);
      const input = nativeRunInput(request.body, model);
      await bindSessionModel(options.sessions, input.sessionId, model.ref);
      nativeRuns.start(input.runId!, input.sessionId, model.ref);
      const events: AgentEvent[] = [];
      for await (const event of options.controller.start(input)) {
        events.push(event);
        nativeRuns.append(input.runId!, event);
      }
      nativeRuns.finish(input.runId!, events);
      return reply.send({ run_id: input.runId, session_id: input.sessionId, model: model.ref, client_id: client.id, events });
    } catch (error) {
      return sendComputeError(reply, error);
    }
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    try {
      auth.authenticate(request.headers as Record<string, unknown>, "compute:read");
      const run = nativeRuns.get(request.params.runId);
      if (!run) throw new ComputeRequestError(404, "run_not_found", "Run not found.");
      return reply.send({ run_id: run.runId, session_id: run.sessionId, model: run.modelRef, events: run.events, status: run.active ? "active" : nativeRunStatus(run.events) });
    } catch (error) {
      return sendComputeError(reply, error);
    }
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/events", async (request, reply) => {
    try {
      auth.authenticate(request.headers as Record<string, unknown>, "compute:read");
      const run = nativeRuns.get(request.params.runId);
      if (!run) throw new ComputeRequestError(404, "run_not_found", "Run not found.");
      return reply.send({ run_id: run.runId, events: run.events });
    } catch (error) {
      return sendComputeError(reply, error);
    }
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/stop", async (request, reply) => {
    try {
      auth.authenticate(request.headers as Record<string, unknown>, "compute:invoke");
      const run = nativeRuns.get(request.params.runId);
      if (!run) throw new ComputeRequestError(404, "run_not_found", "Run not found.");
      return reply.send(await options.controller.stop(run.sessionId as SessionId, "user_stop"));
    } catch (error) {
      return sendComputeError(reply, error);
    }
  });

  app.post<{ Params: { runId: string } }>("/api/runs/:runId/resume", async (request, reply) => {
    try {
      const client = auth.authenticate(request.headers as Record<string, unknown>, "compute:invoke");
      const previous = nativeRuns.get(request.params.runId);
      if (!previous) throw new ComputeRequestError(404, "run_not_found", "Run not found.");
      const model = resolvePublishedModel(options.registry, previous.modelRef);
      const input = nativeRunInput({ session_id: previous.sessionId, resume: true }, model);
      input.runId = previous.runId as NonNullable<StartRunRequest["runId"]>;
      await bindSessionModel(options.sessions, input.sessionId, model.ref);
      nativeRuns.start(input.runId!, input.sessionId, model.ref);
      const events: AgentEvent[] = [];
      for await (const event of options.controller.start(input)) {
        events.push(event);
        nativeRuns.append(input.runId!, event);
      }
      nativeRuns.finish(input.runId!, events);
      return reply.send({ run_id: input.runId, session_id: input.sessionId, model: model.ref, client_id: client.id, events });
    } catch (error) {
      return sendComputeError(reply, error);
    }
  });

  app.get<{ Params: { runId: string } }>("/ws/runs/:runId", { websocket: true }, (socket, request) => {
    try {
      auth.authenticate(request.headers as Record<string, unknown>, "compute:read");
      const run = nativeRuns.get(request.params.runId);
      if (!run) {
        socket.send(JSON.stringify({ type: "run.error", data: { error_code: "run_not_found", error: "Run not found." } }));
      } else {
        for (const event of run.events) socket.send(JSON.stringify(event));
      }
    } catch (error) {
      socket.send(JSON.stringify(computeErrorPayload(error)));
    } finally {
      socket.close();
    }
  });

  app.get("/api/manage/usage", async (request, reply) => {
    try {
      auth.authenticate(request.headers as Record<string, unknown>, "compute:read");
      const query = request.query as { client_id?: string; model?: string; limit?: string };
      const records = await usage.list({
        ...(query.client_id ? { clientId: query.client_id } : {}),
        ...(query.model ? { modelRef: query.model } : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      });
      return reply.send({ usage: records });
    } catch (error) {
      return sendComputeError(reply, error);
    }
  });
}

type PreparedChat = {
  request: OpenAIChatCompletionRequest;
  clientId: string;
  requestId: string;
  requestHash: string;
  idempotencyKey?: string | undefined;
  model: CompiledPresetModel;
  input: StartRunRequest;
  messages: OpenAIChatMessage[];
  startedAt: string;
  existingResponse?: Record<string, unknown> | undefined;
};

async function prepareChat(
  body: unknown,
  clientId: string,
  headers: Record<string, unknown>,
  options: ComputeApiOptions,
  idempotency: IdempotencyRepository,
): Promise<PreparedChat> {
  const validation = validateContract("openaiChatCompletionRequest", body);
  if (!validation.valid) throw new ComputeRequestError(400, "invalid_request", "Invalid OpenAI chat completion request.");
  const request = body as OpenAIChatCompletionRequest;
  const bodyRecord = body as Record<string, unknown>;
  for (const key of ["tools", "tool_choice", "provider", "prompt", "plugins"]) {
    if (bodyRecord[key] !== undefined) throw new ComputeRequestError(400, "invalid_request", `The ${key} field is controlled by the Preset Model.`);
  }
  for (const message of request.messages) {
    const candidate = message as Record<string, unknown>;
    if (candidate.tool_calls !== undefined) throw new ComputeRequestError(400, "invalid_request", "Client tool calls are not accepted by the compute API.");
  }
  if (request.messages.at(-1)?.role !== "user") throw new ComputeRequestError(400, "invalid_request", "The last message must be a user message.");
  const current = request.messages.at(-1)!;
  if (typeof current.content !== "string" || !current.content.trim()) throw new ComputeRequestError(400, "message_required", "The last user message must contain text.");

  const model = resolvePublishedModel(options.registry, request.model);
  const sessionId = readSessionId(request.metadata) ?? randomIds.sessionId();
  if (options.controller.hasActiveRun(sessionId)) throw new ComputeRequestError(409, "run_already_active", "A run is already active for this session.", true);
  await bindSessionModel(options.sessions, sessionId, model.ref);
  const requestId = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
  const idempotencyKey = header(headers, "idempotency-key");
  const requestHash = hash({ clientId, model: model.ref, request });
  if (idempotencyKey) {
    if (idempotencyKey.length > 255) throw new ComputeRequestError(400, "invalid_request", "Idempotency-Key is too long.");
    const existing = await idempotency.get(clientId, idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ComputeRequestError(409, "idempotency_key_reused", "The Idempotency-Key was already used with a different request.");
      return { request, clientId, requestId: String(existing.response.id ?? requestId), requestHash, idempotencyKey, model, input: {} as StartRunRequest, messages: request.messages, startedAt: new Date().toISOString(), existingResponse: existing.response };
    }
  }
  const messages = request.messages.map(toModelMessage);
  const historyMessages = messages.slice(0, -1);
  const allowedToolNames = model.toolCatalog.length > 0
    ? model.allowedToolNames ? model.allowedToolNames.filter((name) => model.toolCatalog.includes(name)) : model.toolCatalog
    : model.allowedToolNames;
  const input: StartRunRequest = {
    runId: randomIds.runId(),
    sessionId,
    message: current.content,
    resume: false,
    promptProfile: model.promptProfile ?? "agent",
    model: model.providerModel,
    presetModelRef: model.ref,
    compiledHash: model.compiledHash,
    searchMode: policyString(model, "search_mode") ?? "diy",
    ...(model.systemPrompt === undefined ? {} : { systemPrompt: model.systemPrompt }),
    ...(allowedToolNames ? { allowedToolNames: new Set(allowedToolNames) } : {}),
    ...(model.bootstrapTools ? { bootstrapTools: structuredClone(model.bootstrapTools) } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.response_format === undefined ? {} : { responseFormat: request.response_format }),
    ...(historyMessages.length ? { historyMessages } : {}),
  };
  return { request, clientId, requestId, requestHash, ...(idempotencyKey ? { idempotencyKey } : {}), model, input, messages: request.messages, startedAt: new Date().toISOString() };
}

async function executeNonStream(
  prepared: PreparedChat,
  options: ComputeApiOptions,
  usage: UsageRepository,
  idempotency: IdempotencyRepository,
): Promise<Record<string, unknown>> {
  const events = await executeWithUsage(prepared, options, usage);
  const response = completionResponse(prepared, events);
  await saveIdempotent(prepared, response, idempotency);
  return response;
}

async function executeStream(
  prepared: PreparedChat,
  raw: { write(chunk: string): boolean; end(): void; writableEnded: boolean },
  options: ComputeApiOptions,
  usage: UsageRepository,
  idempotency: IdempotencyRepository,
): Promise<void> {
  const responseId = prepared.requestId;
  const created = Math.floor(Date.now() / 1_000);
  writeSse(raw, { id: responseId, object: "chat.completion.chunk", created, model: prepared.model.ref, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const events = await executeWithUsage(prepared, options, usage, async (event) => {
    if (event.type !== "message.delta") return;
    const content = typeof event.data.content === "string" ? event.data.content : "";
    if (content) writeSse(raw, { id: responseId, object: "chat.completion.chunk", created, model: prepared.model.ref, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  });
  const response = completionResponse(prepared, events);
  const firstChoice = (response.choices as Array<Record<string, unknown>>)[0];
  const message = firstChoice?.message as Record<string, unknown> | undefined;
  const text = String(message?.content ?? "");
  if (!events.some((event) => event.type === "message.delta") && text) {
    writeSse(raw, { id: responseId, object: "chat.completion.chunk", created, model: prepared.model.ref, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  }
  writeSse(raw, { id: responseId, object: "chat.completion.chunk", created, model: prepared.model.ref, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: response.usage });
  writeSseLine(raw, "[DONE]");
  await saveIdempotent(prepared, response, idempotency);
}

async function executeWithUsage(
  prepared: PreparedChat,
  options: ComputeApiOptions,
  usage: UsageRepository,
  onEvent?: (event: AgentEvent) => void | Promise<void>,
): Promise<AgentEvent[]> {
  const started = Date.now();
  const begin: UsageRecord = {
    requestId: prepared.requestId,
    runId: prepared.input.runId!,
    clientId: prepared.clientId,
    modelRef: prepared.model.ref,
    providerModel: prepared.model.providerModel,
    status: "running",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    startedAt: prepared.startedAt,
  };
  await usage.begin(begin);
  const events: AgentEvent[] = [];
  try {
    for await (const event of options.controller.start(prepared.input)) {
      events.push(event);
      await onEvent?.(event);
    }
    const response = completionResponse(prepared, events);
    const eventError = terminalError(events);
    const usageSource = [...events].reverse().find((event) => event.type === "run.finished")?.data.usage;
    const providerRequestId = providerRequestIdOf(usageSource);
    const providerUsage = openAIUsageFromValue((response.usage as OpenAIUsage | undefined));
    const endedAt = new Date().toISOString();
    await usage.finish({
      ...begin,
      status: eventError ? eventError.status : "completed",
      inputTokens: providerUsage.prompt_tokens,
      outputTokens: providerUsage.completion_tokens,
      totalTokens: providerUsage.total_tokens,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(eventError ? { errorCode: eventError.code } : {}),
      endedAt,
      latencyMs: Date.now() - started,
    });
    if (eventError) throw new ComputeRequestError(eventError.status === "error" ? 502 : 499, eventError.code, eventError.message, eventError.code === "provider_unavailable");
    return events;
  } catch (error) {
    if (!(error instanceof ComputeRequestError)) {
      const endedAt = new Date().toISOString();
      await usage.finish({ ...begin, status: "error", endedAt, latencyMs: Date.now() - started, errorCode: "model_failed" });
    }
    throw error;
  }
}

function completionResponse(prepared: PreparedChat, events: AgentEvent[]): Record<string, unknown> {
  const finished = [...events].reverse().find((event) => event.type === "run.finished");
  const finalText = typeof finished?.data.final_text === "string"
    ? finished.data.final_text
    : events.filter((event) => event.type === "message.delta").map((event) => String(event.data.content ?? "")).join("");
  const usage = openAIUsage(finished?.data.usage, prepared.messages, finalText);
  return {
    id: prepared.requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: prepared.model.ref,
    choices: [{ index: 0, message: { role: "assistant", content: finalText }, finish_reason: "stop" }],
    usage,
  };
}

function terminalError(events: AgentEvent[]): { code: string; message: string; status: "error" | "stopped" } | undefined {
  const error = [...events].reverse().find((event) => event.type === "run.error" || event.type === "run.stopped");
  if (!error) return undefined;
  return {
    code: typeof error.data.error_code === "string" ? error.data.error_code : error.type === "run.stopped" ? "run_stopped" : "model_failed",
    message: typeof error.data.error === "string" ? error.data.error : "The run did not complete.",
    status: error.type === "run.stopped" ? "stopped" : "error",
  };
}

async function saveIdempotent(prepared: PreparedChat, response: Record<string, unknown>, idempotency: IdempotencyRepository): Promise<void> {
  if (!prepared.idempotencyKey) return;
  await idempotency.put({ clientId: prepared.clientId, key: prepared.idempotencyKey, requestHash: prepared.requestHash, response, createdAt: new Date().toISOString() });
}

function sendReplayStream(reply: FastifyReply, response: Record<string, unknown>): FastifyReply {
  reply.hijack();
  reply.raw.statusCode = 200;
  reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("cache-control", "no-cache, no-transform");
  const choices = response.choices as Array<Record<string, unknown>>;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const id = String(response.id ?? `chatcmpl_${randomUUID()}`);
  const model = String(response.model ?? "unknown");
  const created = Number(response.created ?? Math.floor(Date.now() / 1_000));
  writeSse(reply.raw, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  if (typeof message?.content === "string" && message.content) writeSse(reply.raw, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }] });
  writeSse(reply.raw, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: response.usage });
  writeSseLine(reply.raw, "[DONE]");
  reply.raw.end();
  return reply;
}

function nativeRunInput(body: unknown, model: CompiledPresetModel): StartRunRequest {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const message = typeof value.message === "string" ? value.message : "";
  if (value.resume !== true && !message.trim()) throw new ComputeRequestError(400, "message_required", "Message content is required.");
  const sessionId = typeof value.session_id === "string" && value.session_id ? value.session_id as SessionId : randomIds.sessionId();
  const allowedToolNames = model.toolCatalog.length > 0
    ? model.allowedToolNames ? model.allowedToolNames.filter((name) => model.toolCatalog.includes(name)) : model.toolCatalog
    : model.allowedToolNames;
  return {
    runId: randomIds.runId(),
    sessionId,
    message: message || null,
    resume: value.resume === true,
    promptProfile: model.promptProfile ?? "agent",
    model: model.providerModel,
    presetModelRef: model.ref,
    compiledHash: model.compiledHash,
    searchMode: policyString(model, "search_mode") ?? "diy",
    ...(model.systemPrompt === undefined ? {} : { systemPrompt: model.systemPrompt }),
    ...(allowedToolNames ? { allowedToolNames: new Set(allowedToolNames) } : {}),
    ...(model.bootstrapTools ? { bootstrapTools: structuredClone(model.bootstrapTools) } : {}),
  };
}

async function bindSessionModel(sessions: SessionRepository, sessionId: SessionId, ref: PresetModelRef): Promise<void> {
  if (!sessions.setPresetModel) return;
  const snapshot = await sessions.open(sessionId);
  const bound = typeof snapshot.metadata.preset_model_ref === "string" ? snapshot.metadata.preset_model_ref : undefined;
  if (bound && bound !== ref) throw new ComputeRequestError(409, "session_model_mismatch", `Session is bound to ${bound}; requested ${ref}.`);
  if (!bound) await sessions.setPresetModel(sessionId, ref);
}

function resolvePublishedModel(registry: SqlitePresetModelRegistry, ref: string): CompiledPresetModel {
  try {
    return registry.resolve(ref);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (["preset_model_compiled_hash_mismatch", "preset_model_plugin_lock_mismatch", "plugin_not_installed", "plugin_hash_mismatch"].includes(message)) {
      throw new ComputeRequestError(503, "preset_model_unavailable", "The requested Preset Model is unavailable.", true);
    }
    throw new ComputeRequestError(404, "preset_model_not_found", "The requested Preset Model was not found.");
  }
}

function toModelMessage(message: OpenAIChatMessage): ModelMessage {
  return {
    role: message.role,
    content: message.content ?? "",
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  };
}

function openAIUsage(value: unknown, messages: OpenAIChatMessage[], output: string): OpenAIUsage {
  const provider = openAIUsageFromValue(value);
  if (provider.total_tokens > 0) return provider;
  const promptTokens = estimateTokens(messages.map((message) => message.content ?? "").join("\n"));
  const completionTokens = estimateTokens(output);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function openAIUsageFromValue(value: unknown): OpenAIUsage {
  if (!value || typeof value !== "object") return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const record = value as Record<string, unknown>;
  const prompt = integer(record.promptTokens ?? record.prompt_tokens);
  const completion = integer(record.completionTokens ?? record.completion_tokens);
  const total = integer(record.totalTokens ?? record.total_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
    ...(integer(record.cachedTokens ?? record.cached_tokens) ? { prompt_tokens_details: { cached_tokens: integer(record.cachedTokens ?? record.cached_tokens) } } : {}),
  };
}

function providerRequestIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const requestId = (value as Record<string, unknown>).providerRequestId ?? (value as Record<string, unknown>).provider_request_id;
  return typeof requestId === "string" && requestId ? requestId : undefined;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function estimateTokens(value: string): number {
  return value.trim() ? Math.max(1, Math.ceil(value.length / 4)) : 0;
}

function policyString(model: CompiledPresetModel, key: string): string | undefined {
  const value = model.definition.policy?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function nativeRunStatus(events: AgentEvent[]): string {
  const terminal = [...events].reverse().find((event) => event.type.startsWith("run."));
  return terminal?.type.replace("run.", "") ?? "active";
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function readSessionId(metadata: Record<string, unknown> | undefined): SessionId | undefined {
  const value = metadata?.session_id;
  return typeof value === "string" && value ? value as SessionId : undefined;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function writeSse(raw: { write(chunk: string): boolean }, payload: unknown): void {
  writeSseLine(raw, JSON.stringify(payload));
}

function writeSseLine(raw: { write(chunk: string): boolean }, payload: string): void {
  raw.write(`data: ${payload}\n\n`);
}

function sendComputeError(reply: FastifyReply, error: unknown): FastifyReply {
  const payload = computeErrorPayload(error);
  const status = error instanceof ComputeRequestError ? error.statusCode : 500;
  return reply.code(status).send(payload);
}

function computeErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof ComputeRequestError) return { error: { message: error.message, type: "invalid_request_error", code: error.errorCode, retryable: error.retryable } };
  return { error: { message: error instanceof Error ? error.message : String(error), type: "server_error", code: "model_failed", retryable: false } };
}

function rowToUsage(row: Record<string, unknown>): UsageRecord {
  return {
    requestId: String(row.request_id),
    runId: String(row.run_id),
    clientId: String(row.client_id),
    modelRef: String(row.model_ref),
    providerModel: String(row.provider_model),
    status: String(row.status) as UsageRecord["status"],
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    ...(row.cached_tokens === null || row.cached_tokens === undefined ? {} : { cachedTokens: Number(row.cached_tokens) }),
    ...(row.estimated_cost === null || row.estimated_cost === undefined ? {} : { estimatedCost: Number(row.estimated_cost) }),
    ...(row.currency ? { currency: String(row.currency) } : {}),
    ...(row.provider_request_id ? { providerRequestId: String(row.provider_request_id) } : {}),
    startedAt: String(row.started_at),
    ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
    ...(row.latency_ms === null || row.latency_ms === undefined ? {} : { latencyMs: Number(row.latency_ms) }),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
  };
}
