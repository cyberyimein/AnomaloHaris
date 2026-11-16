import { registerBotRoutes } from "./bot-api.js";
import type { BotService } from "./bot-service.js";
import { statSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

import fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import {
  canonicalizePresetModelRef,
  legacyNamingAdapter,
  validateContract,
  type AgentEvent,
  type ResponseFormat,
  type RunRequest,
  type SessionId,
} from "@anomaloharis/contracts";

import type { StartRunRequest } from "./controller.js";
import { type BrowserRegistration, BrowserToolBridge } from "./browser.js";
import { BuddyDashboardError, type BuddyDashboardClient } from "./buddy-dashboard.js";
import { projectNativeEvent, registerComputeRoutes, type ComputeApiOptions } from "./compute-api.js";
import { randomIds } from "./ids.js";
import { DEFAULT_PRESET_MODEL_REF, type CompiledPresetModel, SqlitePresetModelRegistry } from "./preset-models.js";
import type { ModelBinding, ModelCatalogEntry, ModelCatalogDefaults, ModelCatalogProvider } from "./model-catalog.js";
import { ModelCatalogRevisionConflictError } from "./model-catalog.js";
import type { SessionRepository } from "./session.js";
import type { SessionSnapshot, SessionSummary, ToolContext } from "./types.js";
import type { ToolRuntime } from "./tools.js";
import type { FileResourceLoader, ResourceSkillSummary } from "./resources.js";
import { SKILL_ACTIVATE_TOOL_NAME, type CompiledSkillSnapshot } from "./skills.js";
import type { PluginCatalog } from "./plugin-catalog.js";
import type { PluginHost } from "./plugins.js";
import { DEFAULT_SUBAGENT_MODEL, isSearchMode } from "./retrieval.js";
import { PYTHON_SANDBOX_TOOL_NAME, type PythonSandboxRuntime } from "./python-sandbox.js";
import { registerWorkflowManagementRoutes } from "./workflow-api.js";
import type { WorkflowManagement } from "@anomaloharis/workflow-runtime";
import type { RunControl } from "./run-control.js";

export type NodeHostOptions = {
  sessions: SessionRepository;
  bot?: BotService;
  model: string;
  presetModels?: SqlitePresetModelRegistry;
  defaultPresetModel?: string;
  staticDir?: string;
  logger?: boolean;
  browserBridge?: BrowserToolBridge;
  tools?: ToolRuntime;
  compute?: Omit<ComputeApiOptions, "registry" | "sessions">;
  resources?: FileResourceLoader;
  skillSnapshot?: CompiledSkillSnapshot | undefined;
  managementToken?: string;
  plugins?: PluginHost;
  pluginCatalog?: PluginCatalog;
  buddy?: BuddyDashboardClient;
  providerCredits?: () => Promise<unknown>;
  subagentModel?: string;
  pythonSandbox?: PythonSandboxRuntime;
  workflowManagement?: WorkflowManagement;
  runControl: RunControl;
  workflowRefAllowlist?: readonly string[];
};

export async function buildNodeHost(options: NodeHostOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger ?? false });
  const activeAgentRuns = new Map<SessionId, string>();
  await app.register(fastifyWebsocket);
  if (options.bot) {
    registerBotRoutes(app, options.bot, options.managementToken);
    app.addHook("preHandler", async (request, reply) => {
      if (request.url.startsWith("/api/bot")) return;
      const body = asObject(request.body);
      const params = asObject(request.params);
      const query = asObject(request.query);
      const metadata = asObject(body.metadata);
      const ids = [params.sessionId, params.session_id, body.session_id, query.session_id, metadata.session_id];
      if (ids.some((id) => typeof id === "string" && options.bot!.ownsSession(id))) {
        return reply.code(403).send({ error: "Bot session must use the Bot entry point.", error_code: "bot_session_owned" });
      }
    });
  }

  app.get("/health", async () => ({
    status: "ok",
    runtime: "node",
    session_schema: 2,
  }));

  app.get("/api/runtime", async () => ({
    runtime: "node",
    session_schema: 2,
    model: currentDefaultModel(options),
    default_model_id: options.presetModels?.modelCatalog.getDefaults().defaultModelId ?? null,
    default_preset_model: options.defaultPresetModel,
  }));

  registerWorkflowManagementRoutes(app, {
    ...(options.workflowManagement ? { management: options.workflowManagement } : {}),
    ...(options.managementToken ? { managementToken: options.managementToken } : {}),
    runControl: options.runControl,
    ...(options.compute?.auth ? { serviceAuth: options.compute.auth } : {}),
    ...(options.workflowRefAllowlist ? { workflowRefAllowlist: options.workflowRefAllowlist } : {}),
    ...(options.compute?.nativeRuns ? { nativeRuns: options.compute.nativeRuns } : {}),
  });

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
    return reply.send(searchModePayload(request.params.sessionId, snapshot.searchMode, currentDefaultModel(options), currentResearchModel(options)));
  });

  app.patch<{ Params: { sessionId: string }; Body: unknown }>("/api/sessions/:sessionId/search-mode", async (request, reply) => {
    const sessionId = request.params.sessionId as SessionId;
    if (activeAgentRuns.has(sessionId)) return reply.code(409).send({ error: "Stop the active run before changing search mode.", error_code: "run_already_active" });
    const snapshot = await options.sessions.open(sessionId);
    if (snapshot.checkpoint) return reply.code(409).send({ error: "Clear or resume the checkpoint before changing search mode.", error_code: "search_mode_checkpoint_active" });
    const mode = asObject(request.body).mode;
    if (!isSearchMode(mode)) return reply.code(400).send({ error: "Invalid search mode.", error_code: "invalid_search_mode" });
    if (!options.sessions.setSearchMode) return reply.code(501).send({ error: "Search mode persistence is not supported." });
    await options.sessions.setSearchMode(sessionId, mode);
    return reply.send(searchModePayload(sessionId, mode, currentDefaultModel(options), currentResearchModel(options)));
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/skills", async (request, reply) => {
    const snapshot = await options.sessions.open(request.params.sessionId as SessionId);
    const query = request.query as { preset_model?: string };
    const boundModel = sessionSkillModelMismatch(snapshot, query.preset_model);
    if (boundModel) return reply.code(409).send({ error: `Session is bound to ${boundModel}; requested ${query.preset_model}.`, error_code: "session_model_mismatch" });
    return reply.send({
      session_id: request.params.sessionId,
      active_skills: snapshot.activeSkills,
      skills: sessionSkillSummaries(options, snapshot, query.preset_model),
    });
  });

  app.put<{ Params: { sessionId: string }; Body: unknown }>("/api/sessions/:sessionId/skills", async (request, reply) => {
    const sessionId = request.params.sessionId as SessionId;
    if (!options.sessions.setResources) return reply.code(501).send({ error: "Session resource persistence is not supported." });
    const active = readStringArray(asObject(request.body).active_skills);
    const query = request.query as { preset_model?: string };
    const snapshot = await options.sessions.open(sessionId);
    const boundModel = sessionSkillModelMismatch(snapshot, query.preset_model);
    if (boundModel) return reply.code(409).send({ error: `Session is bound to ${boundModel}; requested ${query.preset_model}.`, error_code: "session_model_mismatch" });
    const available = new Set(sessionSkillSummaries(options, snapshot, query.preset_model).map((skill) => skill.name));
    const unknown = active.find((name) => !available.has(name));
    if (unknown) return reply.code(404).send({ error: `Unknown skill: ${unknown}`, error_code: "resource_not_found" });
    await options.sessions.setResources(sessionId, active, snapshot.activeMcpServers);
    const activeSkills = [...new Set(active)].sort();
    return reply.send({
      session_id: sessionId,
      active_skills: activeSkills,
      skills: sessionSkillSummaries(options, { ...snapshot, activeSkills }, query.preset_model),
    });
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

  app.get("/api/models", async () => {
    const model = currentDefaultModel(options);
    return { models: [{ id: model, model, object: "model", owned_by: "anomaloharis" }] };
  });

  app.get("/api/manage/providers", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ providers: [{ id: "default", adapter: "openai-compatible", model: currentDefaultModel(options) }] });
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
      const query = request.query as { include_history?: string };
      const includeHistory = query.include_history === "true";
      const models = (options.presetModels?.list({
        includeDraft: true,
        ...(includeHistory ? { includeRetired: true, includeHistory: true } : {}),
      }) ?? []).map((summary) => {
        const model = options.presetModels!.resolve(summary.ref, { allowDraft: true, allowRetired: true });
        return serializePresetModel(model, true, options.presetModels!.resolvePresetBinding(model.ref));
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
      const { definition, providerModelId } = readPresetModelMutation(request.body);
      const created = options.presetModels.createDraft(definition as any, { modelId: providerModelId });
      return reply.code(201).send({ preset_model: serializePresetModel(created, true, options.presetModels.resolvePresetBinding(created.ref)) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.put<{ Params: { name: string; version: string }; Body: unknown }>("/api/manage/preset-models/:name/versions/:version", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.presetModels) throw new HostRequestError(503, "preset_model_unavailable", "Preset Model registry is not configured.");
      const { definition, providerModelId } = readPresetModelMutation(request.body);
      const ref = `${request.params.name}@${request.params.version}`;
      if (providerModelId !== undefined) {
        const current = options.presetModels.resolve(ref, { allowDraft: true });
        definition.provider = structuredClone(current.definition.provider);
      }
      const updated = options.presetModels.update(ref, definition as any, { modelId: providerModelId });
      return reply.send({ preset_model: serializePresetModel(updated, true, options.presetModels.resolvePresetBinding(updated.ref)) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string } }>("/api/manage/preset-models/:name/versions/:version/publish", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.presetModels) throw new HostRequestError(503, "preset_model_unavailable", "Preset Model registry is not configured.");
      const ref = `${request.params.name}@${request.params.version}`;
      const published = options.defaultPresetModel
        ? options.presetModels.publish(ref, { defaultRef: options.defaultPresetModel })
        : options.presetModels.publish(ref);
      return reply.send({ preset_model: serializePresetModel(published, true, options.presetModels.resolvePresetBinding(published.ref)) });
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
      return reply.send({ preset_model: serializePresetModel(retired, true, options.presetModels.resolvePresetBinding(retired.ref)) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string } }>("/api/manage/preset-models/:name/versions/:version/validate", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.presetModels) throw new HostRequestError(503, "preset_model_unavailable", "Preset Model registry is not configured.");
      const model = options.presetModels.resolve(`${request.params.name}@${request.params.version}`, { allowDraft: true });
      return reply.send({ valid: true, preset_model: serializePresetModel(model, true, options.presetModels.resolvePresetBinding(model.ref)) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get("/api/manage/model-catalog", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const catalog = requireModelCatalog(options.presetModels);
      return reply.send({
        models: catalog.listModels().map(serializeModelCatalogEntry),
        defaults: serializeModelCatalogDefaults(catalog.getDefaults()),
      });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get("/api/manage/model-catalog/defaults", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ defaults: serializeModelCatalogDefaults(requireModelCatalog(options.presetModels).getDefaults()) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.put<{ Body: unknown }>("/api/manage/model-catalog/defaults", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const body = asObject(request.body);
      const defaultModelId = requiredString(body.default_model_id, "default_model_id");
      const researchModelId = requiredString(body.research_model_id, "research_model_id");
      const defaults = requireModelCatalog(options.presetModels).setDefaults({
        defaultModelId,
        researchModelId,
        expectedRevision: requiredRevision(body.expected_revision),
      });
      return reply.send({ defaults: serializeModelCatalogDefaults(defaults) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/manage/model-catalog", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const body = asObject(request.body);
      const model = requireModelCatalog(options.presetModels).createModel(readModelCatalogProvider(body));
      return reply.code(201).send({ model: serializeModelCatalogEntry(model) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/manage/model-catalog/:id", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const body = asObject(request.body);
      const model = requireModelCatalog(options.presetModels).updateModel(request.params.id, {
        ...readModelCatalogProviderPatch(body),
        expectedRevision: requiredRevision(body.expected_revision),
      });
      return reply.send({ model: serializeModelCatalogEntry(model) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/manage/model-catalog/:id/activate", async (request, reply) => {
    return setModelCatalogActive(request, reply, options, true);
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/manage/model-catalog/:id/deactivate", async (request, reply) => {
    return setModelCatalogActive(request, reply, options, false);
  });

  app.delete<{ Params: { id: string }; Querystring: { expected_revision?: string } }>("/api/manage/model-catalog/:id", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const expectedRevision = Number((request.query as { expected_revision?: string }).expected_revision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new HostRequestError(400, "invalid_request", "expected_revision must be a positive integer.");
      requireModelCatalog(options.presetModels).deleteModel(request.params.id, expectedRevision);
      return reply.send({ deleted: true, model_id: request.params.id });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/manage/model-catalog/:id/history", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const history = requireModelCatalog(options.presetModels).getModelHistory(request.params.id).map(serializeModelCatalogEntry);
      return reply.send({ history });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/manage/model-catalog/:id/restore", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const body = asObject(request.body);
      const model = requireModelCatalog(options.presetModels).restoreModelRevision(
        request.params.id,
        requiredRevision(body.revision),
        requiredRevision(body.expected_revision),
      );
      return reply.send({ model: serializeModelCatalogEntry(model) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/manage/model-catalog/:id/impact", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const impact = requireModelCatalog(options.presetModels).listModelImpact(request.params.id);
      return reply.send({ model_id: impact.modelId, preset_refs: impact.presetRefs, default_keys: impact.defaultKeys });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/manage/model-catalog/:id/replace", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const body = asObject(request.body);
      const presetRefs = body.preset_refs === undefined ? undefined : readStringArray(body.preset_refs);
      const result = requireModelCatalog(options.presetModels).replaceModelReferences(request.params.id, {
        targetModelId: requiredString(body.target_model_id, "target_model_id"),
        ...(presetRefs ? { presetRefs } : {}),
        includeDefaults: body.include_defaults === true,
        expectedRevision: requiredRevision(body.expected_revision),
      });
      return reply.send({
        source_model_id: request.params.id,
        target_model_id: body.target_model_id,
        updated_preset_refs: result.updatedPresetRefs,
        updated_default_keys: result.updatedDefaultKeys,
      });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  if (options.compute && options.presetModels) {
    registerComputeRoutes(app, {
      ...options.compute,
      registry: options.presetModels,
      sessions: options.sessions,
      runControl: options.runControl,
    });
  }

  app.get("/api/preset-models", async () => ({
    preset_models: (options.presetModels?.list() ?? []).map((summary) => {
      try {
        const model = options.presetModels!.resolve(summary.ref);
        return serializePresetModel(model, false, options.presetModels!.resolvePresetBinding(model.ref));
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
      const model = options.presetModels.resolve(request.params.modelRef);
      return reply.send(serializePresetModel(model, false, options.presetModels.resolvePresetBinding(model.ref)));
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get<{ Params: { name: string; version: string } }>("/api/preset-models/:name/versions/:version", async (request, reply) => {
    if (!options.presetModels) return reply.code(404).send({ error: "Preset Model registry is not configured." });
    try {
      const model = options.presetModels.resolve(`${request.params.name}@${request.params.version}`);
      return reply.send(serializePresetModel(model, false, options.presetModels.resolvePresetBinding(model.ref)));
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
    const explicitRef = query.preset_model ?? query.model;
    const boundModel = snapshot ? sessionSkillModelMismatch(snapshot, explicitRef) : undefined;
    if (boundModel) return reply.code(409).send({ error: `Session is bound to ${boundModel}; requested ${explicitRef}.`, error_code: "session_model_mismatch" });
    const requestedRef = explicitRef ?? boundRef ?? options.defaultPresetModel;
    const interactiveDefault = !explicitRef
      && requestedRef === options.defaultPresetModel
      && requestedRef === DEFAULT_PRESET_MODEL_REF;
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
    const skillSnapshot = preset ? preset.skillSnapshot : options.skillSnapshot;
    const providerBinding = requestedRef && options.presetModels
      ? interactiveDefault
        ? options.presetModels.getDefaultModelBinding("default")
        : options.presetModels.resolvePresetBinding(requestedRef)
      : undefined;
    const providerModel = providerBinding?.model ?? preset?.providerModel ?? currentDefaultModel(options);
    if (skillSnapshot?.skills.length && allowedToolNames) allowedToolNames.add(SKILL_ACTIVATE_TOOL_NAME);
    if (interactiveDefault && options.pythonSandbox && allowedToolNames) allowedToolNames.add(PYTHON_SANDBOX_TOOL_NAME);
    const allowedPluginIds = preset ? new Set(preset.fixedPlugins.map((selector) => selector.split("@")[0]!)) : undefined;
    if (interactiveDefault && allowedPluginIds && options.pythonSandbox) allowedPluginIds.add("python-sandbox");
    const context: ToolContext = {
      sessionId,
      runId: randomIds.runId(),
      searchMode: interactiveDefault ? snapshot?.searchMode ?? "diy" : preset?.policy.searchMode ?? snapshot?.searchMode ?? "diy",
      model: providerModel,
      activeSkills: new Set(snapshot?.activeSkills ?? []),
      activeMcpServers: new Set(snapshot?.activeMcpServers ?? []),
      ...(skillSnapshot ? { skillSnapshot } : {}),
      ...(allowedPluginIds ? { allowedPluginIds } : {}),
      ...(preset ? { allowedPluginLocks: structuredClone(preset.pluginLocks) } : {}),
    };
    const tools = await options.tools.list(context);
    return {
      model_ref: preset?.ref,
      provider_model: providerModel,
      tools: allowedToolNames ? tools.filter((tool) => allowedToolNames.has(tool.name)) : tools,
      providers: await options.tools.status(context),
    };
  });

  app.get("/api/plugins", async () => ({ plugins: pluginStatuses(options.pluginCatalog, options.plugins) }));

  app.get("/api/manage/plugins", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ plugins: pluginStatuses(options.pluginCatalog, options.plugins) });
    } catch (error) {
      return sendHostError(reply, error);
    }
  });

  app.get("/api/buddy/status", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.buddy) throw new HostRequestError(503, "buddy_unavailable", "Buddy dashboard is not configured.");
      return reply.send(await options.buddy.status());
    } catch (error) {
      return sendBuddyError(reply, error);
    }
  });

  app.get("/api/buddy/observation", async (request, reply) => {
    try {
      requireConfiguredBuddyManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.buddy) throw new HostRequestError(503, "buddy_unavailable", "Buddy dashboard is not configured.");
      return reply.send(await options.buddy.observation());
    } catch (error) {
      return sendBuddyError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/buddy/invoke", async (request, reply) => {
    try {
      requireConfiguredBuddyManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.buddy) throw new HostRequestError(503, "buddy_unavailable", "Buddy dashboard is not configured.");
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as Record<string, unknown>
        : {};
      return reply.send(await options.buddy.invoke(body));
    } catch (error) {
      return sendBuddyError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/buddy/agent", async (request, reply) => {
    try {
      requireConfiguredBuddyManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.buddy) throw new HostRequestError(503, "buddy_unavailable", "Buddy dashboard is not configured.");
      const body = asObject(request.body);
      if (typeof body.enabled !== "boolean") throw new HostRequestError(400, "invalid_request", "enabled must be a boolean.");
      return reply.send(await options.buddy.setAgentEnabled(body.enabled));
    } catch (error) {
      return sendBuddyError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/buddy/permissions", async (request, reply) => {
    try {
      requireConfiguredBuddyManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      if (!options.buddy) throw new HostRequestError(503, "buddy_unavailable", "Buddy dashboard is not configured.");
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as Record<string, unknown>
        : {};
      return reply.send(await options.buddy.setPermission(body));
    } catch (error) {
      return sendBuddyError(reply, error);
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
    return { sessions: sessions.filter((session) => !options.bot?.ownsSession(session.sessionId)).map(serializeSummary) };
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
    const snapshot = await options.sessions.open(request.params.sessionId as SessionId);
    return reply.send(serializeSnapshot(snapshot));
  });

  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/web-traces", async (request, reply) => {
    const snapshot = await options.sessions.open(request.params.sessionId as SessionId);
    return reply.send({ session_id: snapshot.sessionId, traces: snapshot.webTraces });
  });

  app.get<{ Params: { executionId: string; name: string }; Querystring: { session_id?: string; artifact_token?: string } }>("/api/artifacts/python/:executionId/:name", async (request, reply) => {
    const sessionId = typeof request.query.session_id === "string" ? request.query.session_id : "";
    const accessToken = typeof request.query.artifact_token === "string" ? request.query.artifact_token : "";
    const artifact = options.pythonSandbox?.readArtifact(request.params.executionId, request.params.name, sessionId, accessToken);
    if (!artifact) return reply.code(404).send({ error: "Artifact not found." });
    const inline = artifact.mediaType.startsWith("image/");
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${request.params.name}"`)
      .type(artifact.mediaType)
      .send(artifact.content);
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
    const events = await collectRun(options.runControl, input, activeAgentRuns);
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
    reply.raw.setHeader("X-AnomaloHaris-Session-Id", input.sessionId);
    if (input.presetModelRef) reply.raw.setHeader("X-AnomaloHaris-Agent-Id", input.presetModelRef);
    try {
      for await (const event of startAgentRun(options.runControl, input, activeAgentRuns)) {
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
    const runId = activeAgentRuns.get(sessionId);
    if (!runId) return reply.send({ stopped: false, reason: "no_active_run" });
    const result = await options.runControl.stop(runId, reason);
    return reply.send({ ...result, reason });
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
        for await (const event of startAgentRun(options.runControl, input, activeAgentRuns)) send(event);
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
      const runId = activeAgentRuns.get(sessionId);
      if (runId) void options.runControl.stop(runId, "disconnect");
    });
    socket.on("error", () => {
      closed = true;
      if (browserRegistration) options.browserBridge?.unregister(browserRegistration, "socket_error");
      const runId = activeAgentRuns.get(sessionId);
      if (runId) void options.runControl.stop(runId, "disconnect");
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
          const runId = activeAgentRuns.get(sessionId);
          if (!runId) {
            sendError("No active run to stop.", "no_active_run");
            return;
          }
          await options.runControl.stop(runId, "user_stop");
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
  const interactiveDefault = !explicitRef
    && requestedRef === options.defaultPresetModel
    && requestedRef === DEFAULT_PRESET_MODEL_REF;
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
      const responseFormatAllowed = key === "response_format" && preset.allowResponseFormatOverride;
      if (!responseFormatAllowed && body[key] !== undefined && body[key] !== null) {
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
    searchMode: interactiveDefault
      ? existingSession.searchMode
      : !preset && typeof body.search_mode === "string" && body.search_mode
        ? body.search_mode
        : preset?.policy.searchMode ?? "diy",
    ...(preset?.toolProtocol ? { toolProtocol: preset.toolProtocol } : {}),
    ...(preset?.status === "retired" ? { allowRetiredPresetModel: true } : {}),
  };
  const skillSnapshot = preset ? preset.skillSnapshot : options.skillSnapshot;
  if (skillSnapshot) input.skillSnapshot = skillSnapshot;
  if (!isSearchMode(input.searchMode)) {
    throw new HostRequestError(400, "invalid_search_mode", "Invalid search mode. Choose native, subagent, or diy.");
  }
  if (preset) {
    input.presetModelRef = preset.ref;
    input.compiledHash = preset.compiledHash;
    input.toolProtocol = preset.toolProtocol;
    input.policy = structuredClone(preset.policy);
    const allowedPluginIds = new Set(preset.fixedPlugins.map((selector) => selector.split("@")[0]!));
    if (interactiveDefault && options.pythonSandbox) allowedPluginIds.add("python-sandbox");
    input.allowedPluginIds = allowedPluginIds;
    input.allowedPluginLocks = structuredClone(preset.pluginLocks);
    if (preset.systemPrompt !== undefined) input.systemPrompt = preset.systemPrompt;
    if (preset.toolCatalog.length > 0) {
      const fixedTools = new Set(preset.toolCatalog);
      if (interactiveDefault && options.pythonSandbox) fixedTools.add(PYTHON_SANDBOX_TOOL_NAME);
      if (skillSnapshot?.skills.length) fixedTools.add(SKILL_ACTIVATE_TOOL_NAME);
      input.allowedToolNames = preset.allowedToolNames
        ? new Set(preset.allowedToolNames.filter((name) => fixedTools.has(name)))
        : fixedTools;
    } else if (preset.allowedToolNames) {
      input.allowedToolNames = new Set(preset.allowedToolNames);
    }
    if (skillSnapshot?.skills.length && input.allowedToolNames) {
      input.allowedToolNames = new Set([...input.allowedToolNames, SKILL_ACTIVATE_TOOL_NAME]);
    }
    if (preset.bootstrapTools) input.bootstrapTools = structuredClone(preset.bootstrapTools);
  }
  if ((!preset || preset.allowResponseFormatOverride) && body.response_format && typeof body.response_format === "object") {
    input.responseFormat = body.response_format as ResponseFormat;
  }
  if (preset) {
    if (preset.policy.temperature !== undefined) input.temperature = preset.policy.temperature;
    if (preset.policy.responseFormat !== undefined && !(preset.allowResponseFormatOverride && body.response_format)) {
      input.responseFormat = structuredClone(preset.policy.responseFormat);
    }
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

function serializePresetModel(model: CompiledPresetModel, includeDefinition = false, binding?: ModelBinding): Record<string, unknown> {
  return {
    ref: model.ref,
    name: model.name,
    version: model.version,
    description: model.description,
    status: model.status,
    provider_model: binding?.model ?? model.providerModel,
    provider_model_id: binding?.id ?? null,
    provider_model_active: binding?.active ?? null,
    provider_model_revision: binding?.revision ?? null,
    tool_protocol: binding?.toolProtocol ?? model.toolProtocol,
    prompt_profile: model.promptProfile,
    skills: model.skillSnapshot?.skills.map(({ name, description, contentHash }) => ({ name, description, content_hash: contentHash })) ?? [],
    fixed_plugins: model.fixedPlugins,
    plugin_locks: model.pluginLocks,
    tool_catalog: model.toolCatalog,
    allowed_tools: model.allowedToolNames,
    bootstrap_tools: model.bootstrapTools ?? [],
    allow_response_format_override: model.allowResponseFormatOverride,
    policy: structuredClone(model.policy),
    compiled_hash: model.compiledHash,
    ...(includeDefinition ? { definition: structuredClone(model.definition) } : {}),
  };
}

function serializeModelCatalogEntry(model: ModelCatalogEntry & { updatedAt?: string }): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    adapter: model.adapter,
    model: model.model,
    ...(model.credentialRef ? { credential_ref: model.credentialRef } : {}),
    ...(model.toolProtocol ? { tool_protocol: model.toolProtocol } : {}),
    ...(model.capabilities ? { capabilities: structuredClone(model.capabilities) } : {}),
    active: model.active,
    revision: model.revision,
    created_at: model.createdAt,
    updated_at: model.updatedAt,
    usage_count: model.usageCount,
  };
}

function serializeModelCatalogDefaults(defaults: ModelCatalogDefaults): Record<string, unknown> {
  return {
    ...(defaults.defaultModelId ? { default_model_id: defaults.defaultModelId } : {}),
    ...(defaults.researchModelId ? { research_model_id: defaults.researchModelId } : {}),
    revision: defaults.revision,
    updated_at: defaults.updatedAt,
  };
}

function requireModelCatalog(registry: SqlitePresetModelRegistry | undefined) {
  if (!registry) throw new HostRequestError(503, "model_catalog_unavailable", "Model catalog is not configured.");
  return registry.modelCatalog;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HostRequestError(400, "invalid_request", `${field} is required.`);
  return value.trim();
}

function requiredRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new HostRequestError(400, "invalid_request", "expected_revision must be a non-negative integer.");
  return Number(value);
}

function readModelCatalogProvider(body: Record<string, unknown>): {
  id: string;
  name: string;
  adapter: string;
  model: string;
  credentialRef?: string;
  toolProtocol?: ModelCatalogProvider["toolProtocol"];
  capabilities?: Record<string, unknown>;
} {
  const provider = readModelCatalogProviderPatch(body);
  return {
    id: requiredString(body.id, "id"),
    name: requiredString(body.name, "name"),
    adapter: provider.adapter ?? requiredString(body.adapter, "adapter"),
    model: provider.model ?? requiredString(body.model, "model"),
    ...(provider.credentialRef ? { credentialRef: provider.credentialRef } : {}),
    ...(provider.toolProtocol ? { toolProtocol: provider.toolProtocol } : {}),
    ...(provider.capabilities ? { capabilities: provider.capabilities } : {}),
  };
}

function readModelCatalogProviderPatch(body: Record<string, unknown>): {
  name?: string;
  adapter?: string;
  model?: string;
  credentialRef?: string | null;
  toolProtocol?: ModelCatalogProvider["toolProtocol"] | null;
  capabilities?: Record<string, unknown> | null;
} {
  const patch: ReturnType<typeof readModelCatalogProviderPatch> = {};
  if (Object.hasOwn(body, "name")) patch.name = requiredString(body.name, "name");
  if (Object.hasOwn(body, "adapter")) patch.adapter = requiredString(body.adapter, "adapter");
  if (Object.hasOwn(body, "model")) patch.model = requiredString(body.model, "model");
  if (Object.hasOwn(body, "credential_ref")) {
    patch.credentialRef = body.credential_ref === null ? null : requiredString(body.credential_ref, "credential_ref");
  }
  if (Object.hasOwn(body, "tool_protocol")) {
    patch.toolProtocol = body.tool_protocol === null ? null : requiredString(body.tool_protocol, "tool_protocol") as ModelCatalogProvider["toolProtocol"];
  }
  if (Object.hasOwn(body, "capabilities")) {
    if (body.capabilities !== null && (typeof body.capabilities !== "object" || Array.isArray(body.capabilities))) {
      throw new HostRequestError(400, "invalid_request", "capabilities must be an object or null.");
    }
    patch.capabilities = body.capabilities as Record<string, unknown> | null;
  }
  return patch;
}

function readPresetModelMutation(bodyValue: unknown): { definition: Record<string, any>; providerModelId?: string } {
  const body = asObject(bodyValue);
  const definition = { ...body } as Record<string, any>;
  const providerModelId = typeof definition.provider_model_id === "string" ? definition.provider_model_id : undefined;
  delete definition.provider_model_id;
  if (!definition.provider || typeof definition.provider !== "object") throw new HostRequestError(400, "invalid_request", "provider is required.");
  return { definition, ...(providerModelId ? { providerModelId } : {}) };
}

async function setModelCatalogActive(
  request: { headers: Record<string, unknown>; params: { id: string }; body: unknown },
  reply: FastifyReply,
  options: NodeHostOptions,
  active: boolean,
): Promise<FastifyReply> {
  try {
    requireManagementAccess(request.headers, options.managementToken);
    const expectedRevision = requiredRevision(asObject(request.body).expected_revision);
    const model = requireModelCatalog(options.presetModels).setModelActive(request.params.id, active, expectedRevision);
    return reply.send({ model: serializeModelCatalogEntry(model) });
  } catch (error) {
    return sendHostError(reply, error);
  }
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

function sendBuddyError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BuddyDashboardError) {
    return reply.code(error.statusCode).send({ error: error.message, error_code: error.errorCode });
  }
  return sendHostError(reply, error);
}

function hostErrorStatus(error: unknown): number {
  if (error instanceof HostRequestError) return error.statusCode;
  const code = hostErrorCode(error);
  if (code === "preset_model_not_found") return 404;
  if (["session_model_mismatch", "preset_model_default_cannot_retire", "preset_model_version_not_monotonic", "model_catalog_revision_conflict", "model_catalog_model_exists", "model_catalog_model_referenced", "model_catalog_model_disabled", "model_catalog_preset_binding_conflict", "model_catalog_default_preset_binding_required"].includes(code)) return 409;
  if (["invalid_preset_model_definition", "invalid_request", "model_catalog_invalid_request", "model_catalog_adapter_unsupported", "model_catalog_same_replacement"].includes(code) || code.startsWith("model_catalog_invalid_")) return 400;
  if (code === "model_catalog_model_not_found" || code === "model_catalog_revision_not_found") return 404;
  return 500;
}

function hostErrorCode(error: unknown): string {
  if (error instanceof HostRequestError) return error.errorCode;
  if (error instanceof ModelCatalogRevisionConflictError) return "model_catalog_revision_conflict";
  if (error instanceof Error) {
    if (error.message.startsWith("model_catalog_")) return error.message;
    if (error.message === "preset_model_not_found" || error.message === "preset_model_not_published") return "preset_model_not_found";
    if (error.message === "invalid_preset_model_ref") return "invalid_request";
    if (error.message === "preset_model_retired") return "preset_model_not_found";
    if (error.message === "preset_model_default_cannot_retire") return "preset_model_default_cannot_retire";
    if (error.message === "preset_model_version_not_monotonic") return "preset_model_version_not_monotonic";
    if (error.message === "tool_protocol_none_with_tools" || error.message === "unsupported_tool_execution_policy" || error.message.startsWith("skill_") || error.message.startsWith("invalid_policy:") || error.message.startsWith("invalid_preset_model_definition:") || error.message.startsWith("tool_not_bound:")) {
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
  const provided = legacyNamingAdapter.readHeader(headers, "x-anomaloharis-admin-token") ?? "";
  const expectedHash = createHash("sha256").update(configuredToken).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  if (!provided || !timingSafeEqual(expectedHash, providedHash)) {
    throw new HostRequestError(403, "forbidden", "Management API requires X-AnomaloHaris-Admin-Token.");
  }
}

function requireConfiguredBuddyManagementAccess(headers: Record<string, unknown>, configuredToken: string | undefined): void {
  if (!configuredToken) {
    throw new HostRequestError(
      403,
      "forbidden",
      "Management API requires ANOMALOHARIS_ADMIN_TOKEN to be configured for Buddy controls.",
    );
  }
  requireManagementAccess(headers, configuredToken);
}

function pluginStatuses(catalog: PluginCatalog | undefined, plugins: PluginHost | undefined): Array<Record<string, unknown>> {
  const loaded = new Map((plugins?.status() ?? []).map((status) => [status.id, status]));
  if (!catalog) return [...loaded.values()].map((status) => ({ ...status, tools: [...status.tools], capabilities: [...status.capabilities] }));
  return catalog.list().map((manifest) => {
    const status = loaded.get(manifest.id);
    return {
      id: manifest.id,
      version: manifest.version,
      compatibility: manifest.compatibility,
      enabled: status?.enabled ?? false,
      loaded: status?.loaded ?? false,
      state: status ? (status.loaded ? "loaded" : status.error ? "failed" : "disabled") : "catalogued",
      required: status?.required ?? manifest.required === true,
      tools: status?.tools?.length ? [...status.tools] : [...(manifest.toolNames ?? [])],
      capabilities: status?.capabilities?.length ? [...status.capabilities] : [...(manifest.capabilities ?? [])],
      ...(status?.failures ? { failures: status.failures } : {}),
      ...(status?.circuitOpen ? { circuitOpen: true } : {}),
      ...(status?.error ? { error: status.error } : {}),
    };
  });
}

function currentDefaultModel(options: NodeHostOptions): string {
  return options.presetModels?.getDefaultModelBinding("default")?.model ?? options.model;
}

function currentResearchModel(options: NodeHostOptions): string {
  return options.presetModels?.getDefaultModelBinding("research")?.model ?? options.subagentModel ?? DEFAULT_SUBAGENT_MODEL;
}

function searchModePayload(sessionId: string, mode: string, model: string, subagentModel = DEFAULT_SUBAGENT_MODEL): Record<string, unknown> {
  return {
    session_id: sessionId,
    mode,
    model,
    subagent_model: subagentModel,
    modes: [
      { id: "native", label: "Provider-native web search", description: "Use the active model to execute the Provider's native web retrieval capability.", provider: "responses_api" },
      { id: "subagent", label: "Web research subagent", description: `Run an isolated ${subagentModel} child AgentCore with web_search as its only capability.`, provider: "responses_api_subagent" },
      { id: "diy", label: "DIY web tools", description: "Use AnomaloHaris's Node web search and fetch tools.", provider: "duckduckgo_html" },
    ],
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function sessionSkillModelMismatch(snapshot: SessionSnapshot, explicitPresetRef?: string): string | undefined {
  const boundRef = typeof snapshot.metadata.preset_model_ref === "string" ? snapshot.metadata.preset_model_ref : undefined;
  if (!boundRef || !explicitPresetRef) return undefined;
  const normalizedBound = canonicalizePresetModelRef(boundRef.trim().toLowerCase());
  const normalizedRequested = canonicalizePresetModelRef(explicitPresetRef.trim().toLowerCase());
  return normalizedBound === normalizedRequested ? undefined : boundRef;
}

function sessionSkillSummaries(
  options: NodeHostOptions,
  snapshot: SessionSnapshot,
  explicitPresetRef?: string,
): ResourceSkillSummary[] {
  const activeNames = new Set(snapshot.activeSkills);
  const summaries = new Map<string, ResourceSkillSummary>();
  const boundRef = typeof snapshot.metadata.preset_model_ref === "string" ? snapshot.metadata.preset_model_ref : undefined;
  const requestedRef = boundRef || explicitPresetRef || options.defaultPresetModel;
  let presetResolved = false;
  if (requestedRef && options.presetModels) {
    try {
      const preset = boundRef && requestedRef === boundRef
        ? options.presetModels.resolveForBoundSession(requestedRef)
        : options.presetModels.resolve(requestedRef);
      presetResolved = true;
      for (const skill of preset.skillSnapshot?.skills ?? []) {
        summaries.set(skill.name, {
          name: skill.name,
          summary: skill.description,
          enabled: true,
          active: activeNames.has(skill.name),
          instructions_available: true,
        });
      }
    } catch {
      // A debug/UI resource query should remain usable if its optional model ref
      // has just been retired or removed; the run path still returns the exact error.
    }
  }
  // A bound Session must never fall back to the current deployment catalog:
  // that catalog may belong to a different model revision (or a different
  // model entirely). Keep the fallback only for genuinely unbound sessions.
  if (!presetResolved && !boundRef) {
    for (const skill of options.resources?.skills(activeNames) ?? []) summaries.set(skill.name, skill);
  }
  return [...summaries.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function collectRun(runControl: RunControl, input: StartRunRequest, activeRuns: Map<SessionId, string>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of startAgentRun(runControl, input, activeRuns)) events.push(event);
  return events;
}

async function* startAgentRun(runControl: RunControl, input: StartRunRequest, activeRuns: Map<SessionId, string>): AsyncIterable<AgentEvent> {
  if (!input.presetModelRef) throw new Error("preset_model_ref_required");
  const handle = runControl.start(
    { kind: "preset_model", ref: input.presetModelRef },
    { clientId: "local", input: { agent_input: input } },
    { allowRetiredTarget: input.allowRetiredPresetModel === true },
  );
  activeRuns.set(input.sessionId, handle.runId);
  try {
    const projection = { run_id: handle.runId, input: { agent_input: input } };
    for await (const event of handle) {
      const projected = projectNativeEvent(projection, event);
      if (projected) yield projected;
    }
  } finally {
    if (activeRuns.get(input.sessionId) === handle.runId) activeRuns.delete(input.sessionId);
  }
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
