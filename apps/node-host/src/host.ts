import { statSync } from "node:fs";
import { resolve } from "node:path";

import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import {
  validateContract,
  type AgentEvent,
  type ResponseFormat,
  type RunRequest,
  type SessionId,
} from "@anomalo/contracts";

import { RunController, type StartRunRequest } from "./controller.js";
import { type BrowserRegistration, BrowserToolBridge } from "./browser.js";
import { randomIds } from "./ids.js";
import type { CompiledPresetModel, SqlitePresetModelRegistry } from "./preset-models.js";
import type { SessionRepository } from "./session.js";
import type { SessionSnapshot, ToolContext } from "./types.js";
import type { ToolRuntime } from "./tools.js";

export type NodeHostOptions = {
  controller: RunController;
  sessions: SessionRepository;
  model: string;
  presetModels?: SqlitePresetModelRegistry;
  defaultPresetModel?: string;
  promptProfile?: string;
  searchMode?: string;
  temperature?: number;
  runtimeImpl?: string;
  sessionSchema?: number;
  staticDir?: string;
  logger?: boolean;
  browserBridge?: BrowserToolBridge;
  tools?: ToolRuntime;
};

export async function buildNodeHost(options: NodeHostOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger ?? false });
  await app.register(fastifyWebsocket);

  app.get("/health", async () => ({
    status: "ok",
    runtime: options.runtimeImpl ?? "node",
    session_schema: options.sessionSchema ?? 2,
  }));

  app.get("/api/runtime", async () => ({
    runtime: options.runtimeImpl ?? "node",
    session_schema: options.sessionSchema ?? 2,
    model: options.model,
    default_preset_model: options.defaultPresetModel,
  }));

  app.get("/api/preset-models", async () => ({
    preset_models: options.presetModels?.list() ?? [],
    default_preset_model: options.defaultPresetModel,
  }));

  app.get<{ Params: { modelRef: string } }>("/api/preset-models/:modelRef", async (request, reply) => {
    if (!options.presetModels) return reply.code(404).send({ error: "Preset Model registry is not configured." });
    try {
      return reply.send(serializePresetModel(options.presetModels.resolve(request.params.modelRef)));
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get("/api/agents", async () => ({
    agents: (options.presetModels?.list() ?? []).map(serializeLegacyAgent),
  }));

  app.get("/api/tools", async (request) => {
    if (!options.tools) return { tools: [], providers: [] };
    const query = request.query as { session_id?: string };
    const sessionId = typeof query.session_id === "string" && query.session_id
      ? query.session_id as SessionId
      : randomIds.sessionId();
    const snapshot = query.session_id ? await options.sessions.open(sessionId) : undefined;
    const context: ToolContext = {
      sessionId,
      runId: randomIds.runId(),
      searchMode: snapshot?.searchMode ?? "diy",
      model: options.model,
      activeSkills: new Set(snapshot?.activeSkills ?? []),
      activeMcpServers: new Set(snapshot?.activeMcpServers ?? []),
    };
    return { tools: await options.tools.list(context), providers: await options.tools.status(context) };
  });

  app.get("/api/sessions", async (request) => {
    const query = request.query as { limit?: string };
    const parsedLimit = query.limit === undefined ? undefined : Number(query.limit);
    const sessions = await options.sessions.list(
      parsedLimit === undefined || !Number.isFinite(parsedLimit) ? {} : { limit: parsedLimit },
    );
    return { sessions: sessions.map(serializeSummary) };
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
    const snapshot = await options.sessions.open(request.params.sessionId as SessionId);
    return reply.send(serializeSnapshot(snapshot));
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/web-traces", async (request, reply) => {
    const snapshot = await options.sessions.open(request.params.sessionId as SessionId);
    return reply.send({ session_id: snapshot.sessionId, traces: snapshot.webTraces });
  });

  app.delete<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
    const clear = (options.sessions as SessionRepository & { clear?: (sessionId: SessionId) => Promise<void> | void }).clear;
    if (clear) await clear.call(options.sessions, request.params.sessionId as SessionId);
    else return reply.code(501).send({ error: "Session deletion is not supported by this adapter." });
    return reply.code(204).send();
  });

  app.post<{ Body: unknown }>("/api/chat", async (request, reply) => {
    const parsed = parseRunRequest(request.body, reply);
    if (!parsed) return;
    let input: StartRunRequest;
    try {
      input = toStartRunRequest(parsed, options);
      await bindPresetModel(input, options);
    } catch (error) {
      return sendHostError(reply, error);
    }
    const events = await collectRun(options.controller, input);
    return reply.send(summarizeRun(events, input.sessionId));
  });

  app.post<{ Body: unknown }>("/api/chat/stream", async (request, reply) => {
    const parsed = parseRunRequest(request.body, reply);
    if (!parsed) return;
    let input: StartRunRequest;
    try {
      input = toStartRunRequest(parsed, options);
      await bindPresetModel(input, options);
    } catch (error) {
      return sendHostError(reply, error);
    }
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("X-Anomalo-Session-Id", input.sessionId);
    if (input.presetModelRef) reply.raw.setHeader("X-Anomalo-Agent-Id", input.presetModelRef);
    try {
      for await (const event of options.controller.start(input)) {
        if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(event)}\n`);
      }
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.post<{ Params: { agentRef: string }; Body: unknown }>("/api/agents/:agentRef/chat", async (request, reply) => {
    const parsed = parseRunRequest({ ...asObject(request.body), preset_model: request.params.agentRef }, reply);
    if (!parsed) return;
    let input: StartRunRequest;
    try {
      input = toStartRunRequest(parsed, options);
      await bindPresetModel(input, options);
    } catch (error) {
      return sendHostError(reply, error);
    }
    const events = await collectRun(options.controller, input);
    return reply.send(summarizeRun(events, input.sessionId));
  });

  app.post<{ Params: { agentRef: string }; Body: unknown }>("/api/agents/:agentRef/chat/stream", async (request, reply) => {
    const parsed = parseRunRequest({ ...asObject(request.body), preset_model: request.params.agentRef }, reply);
    if (!parsed) return;
    let input: StartRunRequest;
    try {
      input = toStartRunRequest(parsed, options);
      await bindPresetModel(input, options);
    } catch (error) {
      return sendHostError(reply, error);
    }
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("X-Anomalo-Session-Id", input.sessionId);
    if (input.presetModelRef) reply.raw.setHeader("X-Anomalo-Agent-Id", input.presetModelRef);
    try {
      for await (const event of options.controller.start(input)) {
        if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(event)}\n`);
      }
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.post<{ Body: unknown }>("/api/chat/stop", async (request, reply) => {
    const body = asObject(request.body);
    const sessionId = typeof body.session_id === "string" ? body.session_id as SessionId : undefined;
    if (!sessionId) return reply.code(400).send({ error: "session_id is required." });
    const reason = body.reason === "disconnect" ? "disconnect" : "user_stop";
    return reply.send(await options.controller.stop(sessionId, reason));
  });

  app.get<{ Params: { sessionId: string } }>("/ws/chat/:sessionId", { websocket: true }, (socket, request) => {
    const sessionId = request.params.sessionId as SessionId;
    let activeTask: Promise<void> | undefined;
    let closed = false;
    let initialized = false;

    const send = (message: unknown): void => {
      if (!closed && socket.readyState === 1) socket.send(JSON.stringify(message));
    };
    const sendError = (error: string, errorCode?: string): void => {
      send({ type: "client.error", error, ...(errorCode ? { data: { error_code: errorCode } } : {}) });
    };
    const browserRegistration: BrowserRegistration | undefined = options.browserBridge?.register(sessionId, send);
    const sendState = async (): Promise<void> => {
      const snapshot = await options.sessions.open(sessionId);
      send({
        type: "session.state",
        session_id: sessionId,
        data: {
          can_resume: Boolean(snapshot.checkpoint),
          search_mode: snapshot.searchMode,
          runtime: options.runtimeImpl ?? "node",
          preset_model: snapshot.metadata.preset_model_ref ?? options.defaultPresetModel,
        },
      });
    };
    const start = async (input: StartRunRequest): Promise<void> => {
      if (activeTask) {
        sendError("A run is already active for this session.", "run_already_active");
        return;
      }
      try {
        await bindPresetModel(input, options);
      } catch (error) {
        sendError(hostErrorMessage(error), hostErrorCode(error));
        return;
      }
      activeTask = (async () => {
        for await (const event of options.controller.start(input)) send(event);
      })().catch((error: unknown) => {
        sendError(error instanceof Error ? error.message : String(error), "worker_unavailable");
      }).finally(() => {
        activeTask = undefined;
      });
    };

    socket.on("message", (raw: { toString(): string }) => {
      void handleWebSocketMessage(raw.toString());
    });
    socket.on("close", () => {
      closed = true;
      if (browserRegistration) options.browserBridge?.unregister(browserRegistration);
      if (activeTask) void options.controller.stop(sessionId, "disconnect");
    });
    socket.on("error", () => {
      closed = true;
      if (browserRegistration) options.browserBridge?.unregister(browserRegistration, "socket_error");
      if (activeTask) void options.controller.stop(sessionId, "disconnect");
    });
    void sendState().catch((error: unknown) => sendError(error instanceof Error ? error.message : String(error)));

    async function handleWebSocketMessage(raw: string): Promise<void> {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        sendError("WebSocket messages must be valid JSON.", "invalid_message");
        return;
      }
      const validation = validateContract("connectionMessage", value);
      if (!validation.valid) {
        sendError("Invalid WebSocket control message.", "invalid_message");
        return;
      }
      const message = asObject(value);
      if (message.session_id !== undefined && message.session_id !== sessionId) {
        sendError("The message session_id does not match this connection.", "session_mismatch");
        return;
      }
      if (message.type === "client.hello") {
        if (initialized) {
          sendError("The client handshake has already completed.", "handshake_already_complete");
          return;
        }
        initialized = true;
        send({ type: "client.ready", session_id: sessionId, data: { runtime: options.runtimeImpl ?? "node" } });
        return;
      }
      initialized = true;
      switch (message.type) {
        case "ping":
          send({ type: "pong" });
          return;
        case "run.stop":
          if (!activeTask) {
            sendError("No active run to stop.", "no_active_run");
            return;
          }
          await options.controller.stop(sessionId, "user_stop");
          return;
        case "run.resume":
          try {
            void start(toStartRunRequest({ ...message, session_id: sessionId, message: null, resume: true }, options));
          } catch (error) {
            sendError(hostErrorMessage(error), hostErrorCode(error));
          }
          return;
        case "browser.tool.result": {
          const resultMessage = { ...message, session_id: sessionId };
          if (!options.browserBridge || !options.browserBridge.complete(resultMessage)) {
            sendError("No matching browser tool call is pending.", "unknown_tool_call");
          }
          return;
        }
        case "user.message": {
          const content = typeof message.content === "string" ? message.content : "";
          if (!content.trim()) {
            sendError("Message content is required.", "message_required");
            return;
          }
          try {
            void start(toStartRunRequest({ ...message, session_id: sessionId, message: content }, options));
          } catch (error) {
            sendError(hostErrorMessage(error), hostErrorCode(error));
          }
          return;
        }
        default:
          sendError(`Unsupported message type: ${String(message.type)}`, "unsupported_message");
      }
    }
  });

  if (options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: "/",
      wildcard: false,
      index: false,
    });
    app.get("/", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/*", async (request, reply) => {
      const pathname = request.url.split("?")[0] || "/";
      if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
      const root = resolve(options.staticDir!);
      const candidate = resolve(root, relative);
      if (candidate !== root && candidate.startsWith(`${root}/`)) {
        try {
          if (statSync(candidate).isFile()) return reply.sendFile(relative);
        } catch {
          // Fall through to the SPA shell for client-side routes and missing assets.
        }
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

function parseRunRequest(body: unknown, reply: FastifyReply): RunRequest | undefined {
  const validation = validateContract("runRequest", body);
  if (!validation.valid) {
    reply.code(400).send({ error: "Invalid run request.", details: validation.errors });
    return undefined;
  }
  return body as RunRequest;
}

function toStartRunRequest(
  request: RunRequest | Record<string, unknown>,
  options: NodeHostOptions,
): StartRunRequest {
  const body = request as Record<string, unknown>;
  const sessionId = typeof body.session_id === "string" && body.session_id
    ? body.session_id as SessionId
    : randomIds.sessionId();
  const requestedRef = typeof body.preset_model === "string" && body.preset_model
    ? body.preset_model
    : options.defaultPresetModel;
  let preset: CompiledPresetModel | undefined;
  if (requestedRef) {
    if (!options.presetModels) throw new HostRequestError(404, "preset_model_unavailable", "Preset Model registry is not configured.");
    try {
      preset = options.presetModels.resolve(requestedRef);
    } catch (error) {
      throw new HostRequestError(404, hostErrorCode(error), hostErrorMessage(error));
    }
  }
  const input: StartRunRequest = {
    sessionId,
    message: typeof body.message === "string" ? body.message : null,
    resume: body.resume === true,
    promptProfile: typeof body.prompt_profile === "string" && body.prompt_profile
      ? body.prompt_profile
      : preset?.promptProfile ?? options.promptProfile ?? "agent",
    model: preset?.providerModel ?? options.model,
    searchMode: typeof body.search_mode === "string" && body.search_mode
      ? body.search_mode
      : stringPolicy(preset, "search_mode") ?? options.searchMode ?? "diy",
  };
  if (preset) {
    input.presetModelRef = preset.ref;
    input.compiledHash = preset.compiledHash;
    if (preset.systemPrompt !== undefined) input.systemPrompt = preset.systemPrompt;
    if (preset.toolCatalog.length > 0) {
      const fixedTools = new Set(preset.toolCatalog);
      input.allowedToolNames = preset.allowedToolNames
        ? new Set(preset.allowedToolNames.filter((name) => fixedTools.has(name)))
        : fixedTools;
    } else if (preset.allowedToolNames) {
      input.allowedToolNames = new Set(preset.allowedToolNames);
    }
    if (preset.bootstrapTools) input.bootstrapTools = structuredClone(preset.bootstrapTools);
  }
  if (body.response_format && typeof body.response_format === "object") {
    input.responseFormat = body.response_format as ResponseFormat;
  }
  if (options.temperature !== undefined) input.temperature = options.temperature;
  return input;
}

async function bindPresetModel(input: StartRunRequest, options: NodeHostOptions): Promise<void> {
  if (!input.presetModelRef || !options.sessions.setPresetModel) return;
  const snapshot = await options.sessions.open(input.sessionId);
  const bound = typeof snapshot.metadata.preset_model_ref === "string"
    ? snapshot.metadata.preset_model_ref
    : undefined;
  if (bound && bound !== input.presetModelRef) {
    throw new HostRequestError(
      409,
      "session_model_mismatch",
      `Session is bound to ${bound}; requested ${input.presetModelRef}.`,
    );
  }
  if (!bound) await options.sessions.setPresetModel(input.sessionId, input.presetModelRef);
}

function stringPolicy(preset: CompiledPresetModel | undefined, key: string): string | undefined {
  const value = preset?.definition.policy?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function serializePresetModel(model: CompiledPresetModel): Record<string, unknown> {
  return {
    ref: model.ref,
    name: model.name,
    version: model.version,
    description: model.description,
    status: model.status,
    provider_model: model.providerModel,
    tool_protocol: model.toolProtocol,
    prompt_profile: model.promptProfile,
    fixed_plugins: model.fixedPlugins,
    plugin_locks: model.pluginLocks,
    tool_catalog: model.toolCatalog,
    allowed_tools: model.allowedToolNames,
    compiled_hash: model.compiledHash,
  };
}

function serializeLegacyAgent(summary: { ref: string; name: string; description: string; provider_model: string }): Record<string, unknown> {
  return {
    id: summary.ref,
    ref: summary.ref,
    name: summary.name,
    description: summary.description,
    ghost: false,
    model: summary.provider_model,
    tool_names: [],
    bootstrap_tools: [],
  };
}

class HostRequestError extends Error {
  constructor(readonly statusCode: number, readonly errorCode: string, message: string) {
    super(message);
    this.name = "HostRequestError";
  }
}

function sendHostError(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(hostErrorStatus(error)).send({
    error: hostErrorMessage(error),
    error_code: hostErrorCode(error),
  });
}

function hostErrorStatus(error: unknown): number {
  return error instanceof HostRequestError
    ? error.statusCode
    : hostErrorCode(error) === "session_model_mismatch" ? 409 : 500;
}

function hostErrorCode(error: unknown): string {
  if (error instanceof HostRequestError) return error.errorCode;
  if (error instanceof Error) {
    if (error.message === "preset_model_not_found" || error.message === "preset_model_not_published") return "preset_model_not_found";
    if (error.message === "invalid_preset_model_ref") return "invalid_request";
    if (error.message === "preset_model_retired") return "preset_model_not_found";
  }
  return "model_failed";
}

function hostErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectRun(controller: RunController, input: StartRunRequest): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of controller.start(input)) events.push(event);
  return events;
}

function summarizeRun(events: AgentEvent[], sessionId: SessionId): Record<string, unknown> {
  const finished = [...events].reverse().find((event: AgentEvent) => event.type === "run.finished");
  const finalData = finished?.data ?? {};
  return {
    session_id: sessionId,
    events,
    final_text: typeof finalData.final_text === "string" ? finalData.final_text : "",
    output: finalData.output,
    output_format: typeof finalData.output_format === "string" ? finalData.output_format : "text",
  };
}

function serializeSummary(summary: { sessionId: SessionId; title: string; messageCount: number; updatedAt: string; canResume: boolean }): Record<string, unknown> {
  return {
    session_id: summary.sessionId,
    title: summary.title,
    message_count: summary.messageCount,
    updated_at: summary.updatedAt,
    can_resume: summary.canResume,
  };
}

function serializeSnapshot(snapshot: SessionSnapshot): Record<string, unknown> {
  return {
    session_id: snapshot.sessionId,
    title: snapshot.title,
    messages: snapshot.messages,
    search_mode: snapshot.searchMode,
    active_skills: snapshot.activeSkills,
    active_mcp_servers: snapshot.activeMcpServers,
    web_traces: snapshot.webTraces,
    preset_model: snapshot.metadata.preset_model_ref,
    can_resume: Boolean(snapshot.checkpoint),
    updated_at: (snapshot as SessionSnapshot & { updatedAt?: string }).updatedAt,
  };
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
