import { statSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
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
import { registerComputeRoutes, type ComputeApiOptions } from "./compute-api.js";
import { randomIds } from "./ids.js";
import type { CompiledPresetModel, SqlitePresetModelRegistry } from "./preset-models.js";
import type { SessionRepository } from "./session.js";
import type { SessionSnapshot, SessionSummary, ToolContext } from "./types.js";
import type { ToolRuntime } from "./tools.js";
import type { FileResourceLoader } from "./resources.js";
import type { PluginHost } from "./plugins.js";

export type NodeHostOptions = {
  controller: RunController;
  sessions: SessionRepository;
  model: string;
  presetModels?: SqlitePresetModelRegistry;
  defaultPresetModel?: string;
  staticDir?: string;
  logger?: boolean;
  browserBridge?: BrowserToolBridge;
  tools?: ToolRuntime;
  compute?: Omit<ComputeApiOptions, "registry" | "controller" | "sessions">;
  resources?: FileResourceLoader;
  managementToken?: string;
  plugins?: PluginHost;
  providerCredits?: () => Promise<unknown>;
};

export async function buildNodeHost(options: NodeHostOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger ?? false });
  await app.register(fastifyWebsocket);

  app.get("/health", async () => ({
    status: "ok",
    runtime: "node",
    session_schema: 2,
  }));

  app.get("/api/runtime", async () => ({
    runtime: "node",
    session_schema: 2,
    model: options.model,
    default_preset_model: options.defaultPresetModel,
  }));

  app.get("/api/prompts", async (_request, reply) => {
    if (!options.resources) return reply.code(404).send({ error: "Resource loader is not configured." });
    return reply.send(options.resources.prompt("agent"));
  });

  app.get("/api/memory", async (_request, reply) => {
    if (!options.resources) return reply.code(404).send({ error: "Resource loader is not configured." });
    return reply.send(options.resources.memory());
  });

  app.get("/api/skills", async (_request, reply) => {
    if (!options.resources) return reply.code(404).send({ error: "Resource loader is not configured." });
    return reply.send({ skills: options.resources.skills() });
  });

  app.get("/api/mcp", async (_request, reply) => {
    if (!options.resources) return reply.code(404).send({ error: "Resource loader is not configured." });
    return reply.send({ servers: options.resources.mcpServers() });
  });

  app.post("/api/mcp/reload", async (_request, reply) => {
    if (!options.resources) return reply.code(404).send({ error: "Resource loader is not configured." });
    return reply.send({ reloaded: true, servers: options.resources.mcpServers() });
  });

  app.post<{ Body: unknown }>("/api/memory/upload", async (request, reply) => {
    if (!options.resources) return reply.code(404).send({ error: "Resource loader is not configured." });
    const body = asObject(request.body);
    const content = typeof body.content === "string" ? body.content : typeof request.body === "string" ? request.body : undefined;
    if (content === undefined) return reply.code(400).send({ error: "content is required." });
    try {
      return reply.send(options.resources.saveMemory(content));
    } catch (error) {
      return reply.code(413).send({ error: hostErrorMessage(error), error_code: "memory_too_large" });
    }
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/search-mode", async (request, reply) => {
    const snapshot = await options.sessions.open(request.params.sessionId as SessionId);
    return reply.send(searchModePayload(request.params.sessionId, snapshot.searchMode, options.model));
  });

  app.patch<{ Params: { sessionId: string }; Body: unknown }>("/api/sessions/:sessionId/search-mode", async (request, reply) => {
    const sessionId = request.params.sessionId as SessionId;
    if (options.controller.hasActiveRun(sessionId)) return reply.code(409).send({ error: "Stop the active run before changing search mode.", error_code: "run_already_active" });
    const mode = asObject(request.body).mode;
    if (typeof mode !== "string" || !["native", "subagent", "diy"].includes(mode)) return reply.code(400).send({ error: "Invalid search mode.", error_code: "invalid_search_mode" });
    if (!options.sessions.setSearchMode) return reply.code(501).send({ error: "Search mode persistence is not supported." });
    await options.sessions.setSearchMode(sessionId, mode);
    return reply.send(searchModePayload(sessionId, mode, options.model));
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/skills", async (request, reply) => {
    const snapshot = await options.sessions.open(request.params.sessionId as SessionId);
    return reply.send({ session_id: request.params.sessionId, active_skills: snapshot.activeSkills, skills: options.resources?.skills(new Set(snapshot.activeSkills)) ?? [] });
  });

  app.put<{ Params: { sessionId: string }; Body: unknown }>("/api/sessions/:sessionId/skills", async (request, reply) => {
    const sessionId = request.params.sessionId as SessionId;
    if (!options.sessions.setResources) return reply.code(501).send({ error: "Session resource persistence is not supported." });
    const active = readStringArray(asObject(request.body).active_skills);
    const available = new Set((options.resources?.skills() ?? []).map((skill) => skill.name));
    const unknown = active.find((name) => !available.has(name));
    if (unknown) return reply.code(404).send({ error: `Unknown skill: ${unknown}`, error_code: "resource_not_found" });
    const snapshot = await options.sessions.open(sessionId);
    await options.sessions.setResources(sessionId, active, snapshot.activeMcpServers);
    return reply.send({ session_id: sessionId, active_skills: [...new Set(active)].sort(), skills: options.resources?.skills(new Set(active)) ?? [] });
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/mcp", async (request, reply) => {
    const snapshot = await options.sessions.open(request.params.sessionId as SessionId);
    return reply.send({ session_id: request.params.sessionId, active_servers: snapshot.activeMcpServers, servers: options.resources?.mcpServers(new Set(snapshot.activeMcpServers)) ?? [] });
  });

  app.put<{ Params: { sessionId: string }; Body: unknown }>("/api/sessions/:sessionId/mcp", async (request, reply) => {
    const sessionId = request.params.sessionId as SessionId;
    if (!options.sessions.setResources) return reply.code(501).send({ error: "Session resource persistence is not supported." });
    const active = readStringArray(asObject(request.body).active_servers);
    const available = new Set((options.resources?.mcpServers() ?? []).map((server) => server.name));
    const unknown = active.find((name) => !available.has(name));
    if (unknown) return reply.code(404).send({ error: `Unknown MCP server: ${unknown}`, error_code: "resource_not_found" });
    const snapshot = await options.sessions.open(sessionId);
    await options.sessions.setResources(sessionId, snapshot.activeSkills, active);
    return reply.send({ session_id: sessionId, active_servers: [...new Set(active)].sort(), servers: options.resources?.mcpServers(new Set(active)) ?? [] });
  });

  app.get("/api/models", async () => ({ models: [{ id: options.model, model: options.model, object: "model", owned_by: "anomaloharis" }] }));

  app.get("/api/manage/providers", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ providers: [{ id: "default", adapter: "openai-compatible", model: options.model }] });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get("/api/openrouter/credits", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.providerCredits) throw new HostRequestError(503, "provider_unavailable", "Provider credits are not configured.");
      return reply.send(await options.providerCredits());
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get("/api/manage/preset-models", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const models = (options.presetModels?.list({ includeDraft: true, includeRetired: true }) ?? []).map((summary) => {
        const model = options.presetModels!.resolve(summary.ref, { allowDraft: true, allowRetired: true });
        return serializePresetModel(model, true);
      });
      return reply.send({ preset_models: models });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/manage/preset-models", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.presetModels) throw new HostRequestError(503, "preset_model_unavailable", "Preset Model registry is not configured.");
      const created = options.presetModels.createDraft(request.body as any);
      return reply.code(201).send({ preset_model: serializePresetModel(created, true) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string } }>("/api/manage/preset-models/:name/versions/:version/publish", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.presetModels) throw new HostRequestError(503, "preset_model_unavailable", "Preset Model registry is not configured.");
      return reply.send({ preset_model: serializePresetModel(options.presetModels.publish(`${request.params.name}@${request.params.version}`), true) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string } }>("/api/manage/preset-models/:name/versions/:version/retire", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.presetModels) throw new HostRequestError(503, "preset_model_unavailable", "Preset Model registry is not configured.");
      const ref = `${request.params.name}@${request.params.version}`;
      const retired = options.defaultPresetModel
        ? options.presetModels.retire(ref, { defaultRef: options.defaultPresetModel })
        : options.presetModels.retire(ref);
      return reply.send({ preset_model: serializePresetModel(retired, true) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string } }>("/api/manage/preset-models/:name/versions/:version/validate", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.presetModels) throw new HostRequestError(503, "preset_model_unavailable", "Preset Model registry is not configured.");
      const model = options.presetModels.resolve(`${request.params.name}@${request.params.version}`, { allowDraft: true });
      return reply.send({ valid: true, preset_model: serializePresetModel(model, true) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  if (options.compute && options.presetModels) {
    registerComputeRoutes(app, {
      ...options.compute,
      registry: options.presetModels,
      controller: options.controller,
      sessions: options.sessions,
    });
  }

  app.get("/api/preset-models", async () => ({
    preset_models: (options.presetModels?.list() ?? []).map((summary) => {
      try {
        return serializePresetModel(options.presetModels!.resolve(summary.ref));
      } catch (error) {
        return {
          ...summary,
          availability: "unavailable",
          error_code: hostErrorCode(error),
          tool_catalog: [],
          allowed_tools: [],
        };
      }
    }),
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

  app.get<{ Params: { name: string; version: string } }>("/api/preset-models/:name/versions/:version", async (request, reply) => {
    if (!options.presetModels) return reply.code(404).send({ error: "Preset Model registry is not configured." });
    try {
      return reply.send(serializePresetModel(options.presetModels.resolve(`${request.params.name}@${request.params.version}`)));
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get("/api/tools", async (request, reply) => {
    if (!options.tools) return { tools: [], providers: [] };
    const query = request.query as { session_id?: string; preset_model?: string; model?: string };
    const sessionId = typeof query.session_id === "string" && query.session_id
      ? query.session_id as SessionId
      : randomIds.sessionId();
    const snapshot = query.session_id ? await options.sessions.open(sessionId) : undefined;
    const boundRef = typeof snapshot?.metadata.preset_model_ref === "string" ? snapshot.metadata.preset_model_ref : undefined;
    const requestedRef = query.preset_model ?? query.model ?? boundRef ?? options.defaultPresetModel;
    let preset: CompiledPresetModel | undefined;
    if (requestedRef && options.presetModels) {
      try {
        preset = boundRef && boundRef === requestedRef
          ? options.presetModels.resolveForBoundSession(requestedRef)
          : options.presetModels.resolve(requestedRef);
      } catch (error) {
        return sendHostError(reply, error);
      }
    }
    const allowedToolNames = preset?.allowedToolNames
      ? new Set(preset.allowedToolNames)
      : preset?.toolCatalog.length
        ? new Set(preset.toolCatalog)
        : undefined;
    const context: ToolContext = {
      sessionId,
      runId: randomIds.runId(),
      searchMode: preset?.policy.searchMode ?? snapshot?.searchMode ?? "diy",
      model: preset?.providerModel ?? options.model,
      activeSkills: new Set(snapshot?.activeSkills ?? []),
      activeMcpServers: new Set(snapshot?.activeMcpServers ?? []),
      ...(preset ? { allowedPluginIds: new Set(preset.fixedPlugins.map((selector) => selector.split("@")[0]!)) } : {}),
      ...(preset ? { allowedPluginLocks: structuredClone(preset.pluginLocks) } : {}),
    };
    const tools = await options.tools.list(context);
    return {
      model_ref: preset?.ref,
      provider_model: preset?.providerModel ?? options.model,
      tools: allowedToolNames ? tools.filter((tool) => allowedToolNames.has(tool.name)) : tools,
      providers: await options.tools.status(context),
    };
  });

  app.get("/api/plugins", async () => ({ plugins: options.plugins?.status() ?? [] }));

  app.get("/api/manage/plugins", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ plugins: options.plugins?.status() ?? [] });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get("/api/manage/tools", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.tools) return reply.send({ tools: [], providers: [] });
      const context: ToolContext = {
        sessionId: randomIds.sessionId(),
        runId: randomIds.runId(),
        searchMode: "diy",
        model: options.model,
        activeSkills: new Set(),
        activeMcpServers: new Set(),
      };
      return reply.send({ tools: await options.tools.list(context), providers: await options.tools.status(context) });
    } catch (error) {
      return sendHostError(reply, error);
    }
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
      input = await toStartRunRequest(parsed, options);
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
      input = await toStartRunRequest(parsed, options);
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
          runtime: "node",
          preset_model: snapshot.metadata.preset_model_ref ?? options.defaultPresetModel,
        },
      });
    };
    const start = async (inputOrPromise: StartRunRequest | Promise<StartRunRequest>): Promise<void> => {
      if (activeTask) {
        sendError("A run is already active for this session.", "run_already_active");
        return;
      }
      let input: StartRunRequest;
      try {
        input = await inputOrPromise;
        await bindPresetModel(input, options);
      } catch (error) {
        sendError(hostErrorMessage(error), hostErrorCode(error));
        return;
      }
      activeTask = (async () => {
        for await (const event of options.controller.start(input)) send(event);
      })().catch((error: unknown) => {
        sendError(error instanceof Error ? error.message : String(error), "model_failed");
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
        send({ type: "client.ready", session_id: sessionId, data: { runtime: "node" } });
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
          void start(toStartRunRequest({ ...message, session_id: sessionId, message: null, resume: true }, options));
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
          void start(toStartRunRequest({ ...message, session_id: sessionId, message: content }, options));
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

async function toStartRunRequest(
  request: RunRequest | Record<string, unknown>,
  options: NodeHostOptions,
): Promise<StartRunRequest> {
  const body = request as Record<string, unknown>;
  const sessionId = typeof body.session_id === "string" && body.session_id
    ? body.session_id as SessionId
    : randomIds.sessionId();
  const explicitRef = typeof body.preset_model === "string" && body.preset_model
    ? body.preset_model
    : undefined;
  const existingSession = await options.sessions.open(sessionId);
  const boundRef = typeof existingSession.metadata.preset_model_ref === "string"
    ? existingSession.metadata.preset_model_ref
    : undefined;
  const requestedRef = explicitRef ?? boundRef ?? options.defaultPresetModel;
  let preset: CompiledPresetModel | undefined;
  if (requestedRef) {
    if (!options.presetModels) throw new HostRequestError(404, "preset_model_unavailable", "Preset Model registry is not configured.");
    try {
      preset = boundRef && requestedRef === boundRef
        ? options.presetModels.resolveForBoundSession(requestedRef)
        : options.presetModels.resolve(requestedRef);
    } catch (error) {
      throw new HostRequestError(404, hostErrorCode(error), hostErrorMessage(error));
    }
  }
  if (preset) {
    for (const key of ["temperature", "response_format", "tools", "tool_choice", "provider", "prompt", "plugins"]) {
      if (body[key] !== undefined && body[key] !== null) {
        throw new HostRequestError(400, "preset_model_override_forbidden", `The ${key} field is controlled by the Preset Model.`);
      }
    }
  }
  const input: StartRunRequest = {
    sessionId,
    message: typeof body.message === "string" ? body.message : null,
    resume: body.resume === true,
    promptProfile: typeof body.prompt_profile === "string" && body.prompt_profile
      ? body.prompt_profile
      : preset?.promptProfile ?? "agent",
    model: preset?.providerModel ?? options.model,
    searchMode: !preset && typeof body.search_mode === "string" && body.search_mode
      ? body.search_mode
    : preset?.policy.searchMode ?? "diy",
    ...(preset?.toolProtocol ? { toolProtocol: preset.toolProtocol } : {}),
  };
  if (preset) {
    input.presetModelRef = preset.ref;
    input.compiledHash = preset.compiledHash;
    input.toolProtocol = preset.toolProtocol;
    input.policy = structuredClone(preset.policy);
    input.allowedPluginIds = new Set(preset.fixedPlugins.map((selector) => selector.split("@")[0]!));
    input.allowedPluginLocks = structuredClone(preset.pluginLocks);
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
  if (!preset && body.response_format && typeof body.response_format === "object") {
    input.responseFormat = body.response_format as ResponseFormat;
  }
  if (preset) {
    if (preset.policy.temperature !== undefined) input.temperature = preset.policy.temperature;
    if (preset.policy.responseFormat !== undefined) input.responseFormat = structuredClone(preset.policy.responseFormat);
  }
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

function serializePresetModel(model: CompiledPresetModel, includeDefinition = false): Record<string, unknown> {
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
    bootstrap_tools: model.bootstrapTools ?? [],
    policy: structuredClone(model.policy),
    compiled_hash: model.compiledHash,
    ...(includeDefinition ? { definition: structuredClone(model.definition) } : {}),
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
  if (error instanceof HostRequestError) return error.statusCode;
  const code = hostErrorCode(error);
  if (["session_model_mismatch", "preset_model_default_cannot_retire"].includes(code)) return 409;
  if (code === "invalid_preset_model_definition") return 400;
  return 500;
}

function hostErrorCode(error: unknown): string {
  if (error instanceof HostRequestError) return error.errorCode;
  if (error instanceof Error) {
    if (error.message === "preset_model_not_found" || error.message === "preset_model_not_published") return "preset_model_not_found";
    if (error.message === "invalid_preset_model_ref") return "invalid_request";
    if (error.message === "preset_model_retired") return "preset_model_not_found";
    if (error.message === "preset_model_default_cannot_retire") return "preset_model_default_cannot_retire";
    if (error.message === "tool_protocol_none_with_tools" || error.message === "unsupported_tool_execution_policy" || error.message.startsWith("invalid_policy:") || error.message.startsWith("invalid_preset_model_definition:") || error.message.startsWith("tool_not_bound:")) {
      return "invalid_preset_model_definition";
    }
  }
  return "model_failed";
}

function hostErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireManagementAccess(headers: Record<string, unknown>, configuredToken: string | undefined): void {
  if (!configuredToken) return;
  const provided = typeof headers["x-anomalo-admin-token"] === "string" ? headers["x-anomalo-admin-token"] : "";
  const expectedHash = createHash("sha256").update(configuredToken).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  if (!provided || !timingSafeEqual(expectedHash, providedHash)) {
    throw new HostRequestError(403, "forbidden", "Management API requires X-Anomalo-Admin-Token.");
  }
}

function searchModePayload(sessionId: string, mode: string, model: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    mode,
    model,
    subagent_model: model,
    modes: [
      { id: "native", label: "Model-native search", description: "Use the provider's native search capability when configured.", provider: "provider" },
      { id: "subagent", label: "Web research subagent", description: "Delegate research to the configured research model.", provider: "provider_subagent" },
      { id: "diy", label: "DIY web tools", description: "Use AnomaloHaris's Node web search and fetch tools.", provider: "duckduckgo_html" },
    ],
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
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

function serializeSummary(summary: SessionSummary): Record<string, unknown> {
  return {
    session_id: summary.sessionId,
    title: summary.title,
    message_count: summary.messageCount,
    updated_at: summary.updatedAt,
    can_resume: summary.canResume,
    ...(summary.presetModelRef ? { preset_model: summary.presetModelRef } : {}),
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
