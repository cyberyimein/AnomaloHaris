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
import { randomIds } from "./ids.js";
import type { SessionRepository } from "./session.js";
import type { SessionSnapshot } from "./types.js";

export type NodeHostOptions = {
  controller: RunController;
  sessions: SessionRepository;
  model: string;
  promptProfile?: string;
  searchMode?: string;
  temperature?: number;
  runtimeImpl?: string;
  sessionSchema?: number;
  staticDir?: string;
  logger?: boolean;
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
  }));

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

  app.delete<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
    const clear = (options.sessions as SessionRepository & { clear?: (sessionId: SessionId) => Promise<void> | void }).clear;
    if (clear) await clear.call(options.sessions, request.params.sessionId as SessionId);
    else return reply.code(501).send({ error: "Session deletion is not supported by this adapter." });
    return reply.code(204).send();
  });

  app.post<{ Body: unknown }>("/api/chat", async (request, reply) => {
    const parsed = parseRunRequest(request.body, reply);
    if (!parsed) return;
    const input = toStartRunRequest(parsed, options);
    const events = await collectRun(options.controller, input);
    return reply.send(summarizeRun(events, input.sessionId));
  });

  app.post<{ Body: unknown }>("/api/chat/stream", async (request, reply) => {
    const parsed = parseRunRequest(request.body, reply);
    if (!parsed) return;
    const input = toStartRunRequest(parsed, options);
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-cache");
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
    const sendState = async (): Promise<void> => {
      const snapshot = await options.sessions.open(sessionId);
      send({
        type: "session.state",
        session_id: sessionId,
        data: {
          can_resume: Boolean(snapshot.checkpoint),
          search_mode: snapshot.searchMode,
          runtime: options.runtimeImpl ?? "node",
        },
      });
    };
    const start = (input: StartRunRequest): void => {
      if (activeTask) {
        sendError("A run is already active for this session.", "run_already_active");
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
      if (activeTask) void options.controller.stop(sessionId, "disconnect");
    });
    socket.on("error", () => {
      closed = true;
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
          start(toStartRunRequest({ ...message, session_id: sessionId, message: null, resume: true }, options));
          return;
        case "user.message": {
          const content = typeof message.content === "string" ? message.content : "";
          if (!content.trim()) {
            sendError("Message content is required.", "message_required");
            return;
          }
          start(toStartRunRequest({ ...message, session_id: sessionId, message: content }, options));
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
  const input: StartRunRequest = {
    sessionId,
    message: typeof body.message === "string" ? body.message : null,
    resume: body.resume === true,
    promptProfile: typeof body.prompt_profile === "string" && body.prompt_profile
      ? body.prompt_profile
      : options.promptProfile ?? "agent",
    model: options.model,
    searchMode: typeof body.search_mode === "string" && body.search_mode
      ? body.search_mode
      : options.searchMode ?? "diy",
  };
  if (body.response_format && typeof body.response_format === "object") {
    input.responseFormat = body.response_format as ResponseFormat;
  }
  if (options.temperature !== undefined) input.temperature = options.temperature;
  return input;
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
    can_resume: Boolean(snapshot.checkpoint),
    updated_at: (snapshot as SessionSnapshot & { updatedAt?: string }).updatedAt,
  };
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
