import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { legacyNamingAdapter, type WorkflowRef } from "@anomaloharis/contracts";
import {
  WorkflowRuntimeError,
  type StoredWorkflow,
  type WorkflowManagement,
} from "@anomaloharis/workflow-runtime";
import { validateContract, type ExecutionRun, type ExecutionRunEvent, type StopReason } from "@anomaloharis/contracts";
import { RunControl, RunControlError, type RunHandle } from "./run-control.js";
import {
  ComputeRequestError,
  nativeRunStatusForExecution,
  nativeSessionId,
  projectNativeEvents,
  ServiceAuth,
  type NativeRunRepository,
} from "./compute-api.js";

export type WorkflowApiOptions = {
  management?: WorkflowManagement;
  managementToken?: string;
  runControl: RunControl;
  serviceAuth?: ServiceAuth;
  workflowRefAllowlist?: readonly string[];
  nativeRuns?: NativeRunRepository;
};

export function registerWorkflowManagementRoutes(app: FastifyInstance, options: WorkflowApiOptions): void {
  app.get<{ Querystring: { download?: string } }>("/api/manage/workflow-capabilities", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const manifest = runtime(options).capabilities();
      if (request.query.download === "true" || request.query.download === "1") {
        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.header("Content-Disposition", 'attachment; filename="anomaloharis-workflow-capabilities.json"');
      }
      return reply.send(manifest);
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/manage/workflows/validate", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ validation: await runtime(options).validate(request.body) });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/manage/workflows/import", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const result = await runtime(options).importDraft(request.body);
      return reply.code(result.idempotent ? 200 : 201).send(result);
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.get("/api/manage/workflows", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ workflows: await runtime(options).list({ includeDraft: true, includeRetired: true }) });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.get<{ Params: { name: string; version: string } }>("/api/manage/workflows/:name/versions/:version", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ workflow: serializeStored(await runtime(options).get(refFromParams(request.params), { allowDraft: true, allowRetired: true })) });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.get<{ Params: { name: string; version: string } }>("/api/manage/workflows/:name/versions/:version/export", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const ref = refFromParams(request.params);
      const definition = await runtime(options).exportDefinition(ref);
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${safeFilename(definition.metadata.name)}-v${definition.metadata.version}.json"`);
      return reply.send(definition);
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string } }>("/api/manage/workflows/:name/versions/:version/validate", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      const workflow = await runtime(options).get(refFromParams(request.params), { allowDraft: true, allowRetired: true });
      return reply.send({ validation: await runtime(options).validate(workflow.definition) });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string } }>("/api/manage/workflows/:name/versions/:version/publish", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ workflow: serializeStored(await runtime(options).publish(refFromParams(request.params))) });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string } }>("/api/manage/workflows/:name/versions/:version/retire", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      return reply.send({ workflow: serializeStored(await runtime(options).retire(refFromParams(request.params))) });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.delete<{ Params: { name: string; version: string } }>("/api/manage/workflows/:name/versions/:version", async (request, reply) => {
    try {
      requireManagementAccess(request.headers as Record<string, unknown>, options.managementToken);
      await runtime(options).deleteDraft(refFromParams(request.params));
      return reply.code(204).send();
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  registerWorkflowRunRoutes(app, options);
}

function registerWorkflowRunRoutes(app: FastifyInstance, options: WorkflowApiOptions & { runControl: RunControl }): void {
  const auth = options.serviceAuth ?? new ServiceAuth();
  const runControl = options.runControl;
  app.post<{ Params: { name: string; version: string }; Body: unknown }>("/api/workflows/:name/versions/:version/runs", async (request, reply) => {
    try {
      const client = auth.authenticate(request.headers as Record<string, unknown>, "workflow:run");
      const body = parseRunRequest(request.body);
      const ref = refFromParams(request.params);
      assertWorkflowAllowed(ref, options.workflowRefAllowlist, client.workflowRefs);
      const handle = runControl.start({ kind: "workflow", ref }, { ...body, clientId: client.id, permissions: [...client.scopes] });
      const events = await collectRun(handle);
      return reply.code(handle.existing ? 200 : 201).send({ run: serializeRun(runControl.get(handle.runId)), events });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.post<{ Params: { name: string; version: string }; Body: unknown }>("/api/workflows/:name/versions/:version/runs/stream", async (request, reply) => {
    try {
      const client = auth.authenticate(request.headers as Record<string, unknown>, "workflow:run");
      const body = parseRunRequest(request.body);
      const ref = refFromParams(request.params);
      assertWorkflowAllowed(ref, options.workflowRefAllowlist, client.workflowRefs);
      const handle = runControl.start({ kind: "workflow", ref }, { ...body, clientId: client.id, permissions: [...client.scopes] });
      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache, no-transform");
      for await (const event of handle) reply.raw.write(`${JSON.stringify(event)}\n`);
      if (!reply.raw.writableEnded) reply.raw.end();
      return reply;
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    try {
      const run = getRunOrUndefined(runControl, request.params.runId);
      if (!run) {
        const client = auth.authenticate(request.headers as Record<string, unknown>, "compute:read");
        const legacy = getLegacyRun(options.nativeRuns, request.params.runId, client.id);
        return reply.send(legacyNativeResponse(legacy));
      }
      const client = authenticateRun(auth, request.headers as Record<string, unknown>, run, "read");
      assertRunAccess(run, client.id, options, client.workflowRefs);
      if (run.runtime_kind === "preset_model") return reply.send(nativeExecutionResponse(run, runControl.eventsSnapshot(run.run_id)));
      return reply.send({ run: serializeRun(run) });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.get<{ Params: { runId: string }; Querystring: { after_sequence?: string } }>("/api/runs/:runId/events", async (request, reply) => {
    try {
      const run = getRunOrUndefined(runControl, request.params.runId);
      if (!run) {
        const client = auth.authenticate(request.headers as Record<string, unknown>, "compute:read");
        const legacy = getLegacyRun(options.nativeRuns, request.params.runId, client.id);
        return reply.send({ run_id: legacy.runId, events: legacy.events });
      }
      const client = authenticateRun(auth, request.headers as Record<string, unknown>, run, "read");
      assertRunAccess(run, client.id, options, client.workflowRefs);
      const after = Math.max(0, Number(request.query.after_sequence ?? "0") || 0);
      if (run.runtime_kind === "preset_model") return reply.send({ run_id: run.run_id, events: projectNativeEvents(run, runControl.eventsSnapshot(run.run_id, after)) });
      const events: ExecutionRunEvent[] = [];
      for await (const event of runControl.events(run.run_id, after)) events.push(event);
      return reply.send({ run_id: run.run_id, events });
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });

  app.post<{ Params: { runId: string }; Body: unknown }>("/api/runs/:runId/stop", async (request, reply) => {
    try {
      const run = getRunOrUndefined(runControl, request.params.runId);
      if (!run) {
        const client = auth.authenticate(request.headers as Record<string, unknown>, "compute:invoke");
        getLegacyRun(options.nativeRuns, request.params.runId, client.id);
        throw new RunControlError(409, "legacy_run_read_only", "Legacy Native Runs are read-only and cannot be stopped.");
      }
      const client = authenticateRun(auth, request.headers as Record<string, unknown>, run, "run");
      assertRunAccess(run, client.id, options, client.workflowRefs);
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
      const reason = parseStopReason(body.reason);
      if (run.runtime_kind === "preset_model") {
        const result = await runControl.stop(run.run_id, reason);
        return reply.send({ ...result, reason });
      }
      return reply.send(await runControl.stop(run.run_id, reason));
    } catch (error) {
      return sendWorkflowError(reply, error);
    }
  });
}

function parseRunRequest(body: unknown): { input: unknown; idempotency_key?: string; metadata?: Record<string, unknown> } {
  const validation = validateContract("workflowRunRequest", body);
  if (!validation.valid) throw new RunControlError(400, "invalid_workflow_run_request", "Invalid Workflow Run request.");
  const value = body as { input: unknown; idempotency_key?: string; metadata?: Record<string, unknown> };
  return {
    input: structuredClone(value.input),
    ...(value.idempotency_key ? { idempotency_key: value.idempotency_key } : {}),
    ...(value.metadata ? { metadata: structuredClone(value.metadata) } : {}),
  };
}

async function collectRun(handle: RunHandle): Promise<ExecutionRunEvent[]> {
  const events: ExecutionRunEvent[] = [];
  for await (const event of handle) events.push(event);
  return events;
}

function serializeRun(run: ExecutionRun): Record<string, unknown> {
  return structuredClone(run) as unknown as Record<string, unknown>;
}

function authenticateRun(auth: ServiceAuth, headers: Record<string, unknown>, run: ExecutionRun, action: "read" | "run") {
  const scope = run.runtime_kind === "workflow"
    ? action === "read" ? "workflow:read" : "workflow:run"
    : action === "read" ? "compute:read" : "compute:invoke";
  return auth.authenticate(headers, scope);
}

function assertRunOwner(run: ExecutionRun, clientId: string): void {
  if (run.client_id !== clientId && clientId !== "local") throw new RunControlError(403, "forbidden", "The service client does not own this Run.");
}

function assertRunAccess(run: ExecutionRun, clientId: string, options: WorkflowApiOptions, clientAllowlist?: ReadonlySet<string>): void {
  assertRunOwner(run, clientId);
  if (run.runtime_kind === "workflow") assertWorkflowAllowed(run.target_ref, options.workflowRefAllowlist, clientAllowlist);
}

function getRunOrUndefined(runControl: RunControl, runId: string): ExecutionRun | undefined {
  try {
    return runControl.get(runId);
  } catch (error) {
    if (error instanceof RunControlError && error.errorCode === "run_not_found") return undefined;
    throw error;
  }
}

function getLegacyRun(repository: NativeRunRepository | undefined, runId: string, clientId: string) {
  const run = repository?.get(runId);
  if (!run || run.clientId !== clientId) throw new RunControlError(404, "run_not_found", "Run not found.");
  return run;
}

function nativeExecutionResponse(run: ExecutionRun, unifiedEvents: readonly ExecutionRunEvent[]): Record<string, unknown> {
  const events = projectNativeEvents(run, unifiedEvents);
  return {
    run_id: run.run_id,
    session_id: nativeSessionId(run),
    model: run.target_ref,
    client_id: run.client_id,
    events,
    status: nativeRunStatusForExecution(run, events),
  };
}

function legacyNativeResponse(run: { runId: string; sessionId: string; modelRef: string; events: unknown[]; active: boolean }): Record<string, unknown> {
  const events = run.events;
  const status = run.active ? "active" : (events.length > 0 ? String((events[events.length - 1] as { type?: unknown }).type ?? "active").replace(/^run\./, "") : "active");
  return { run_id: run.runId, session_id: run.sessionId, model: run.modelRef, events, status };
}

function parseStopReason(value: unknown): StopReason {
  if (value === undefined) return "user_stop";
  if (value === "user_stop" || value === "disconnect" || value === "timeout" || value === "fail_fast" || value === "host_shutdown") return value;
  throw new RunControlError(400, "invalid_stop_reason", "Stop reason is not supported.");
}

function assertWorkflowAllowed(ref: string, allowlist: readonly string[] | undefined, clientAllowlist?: ReadonlySet<string>): void {
  if (allowlist && allowlist.length > 0 && !allowlist.includes(ref)) throw new RunControlError(403, "workflow_ref_forbidden", `Workflow ${ref} is not allowed for this Host.`);
  if (clientAllowlist && clientAllowlist.size > 0 && !clientAllowlist.has(ref)) throw new RunControlError(403, "workflow_ref_forbidden", `Workflow ${ref} is not allowed for this service client.`);
}

function runtime(options: WorkflowApiOptions): WorkflowManagement {
  if (!options.management) throw new WorkflowRuntimeError("workflow_unavailable", "Workflow Runtime is not configured.", 503);
  return options.management;
}

function serializeStored(stored: StoredWorkflow): Record<string, unknown> {
  return {
    ref: stored.ref,
    name: stored.name,
    version: stored.version,
    description: stored.description,
    status: stored.status,
    definition_hash: stored.definition_hash,
    compiled_hash: stored.compiled_hash,
    capability_manifest_hash: stored.capability_manifest_hash,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
    ...(stored.published_at ? { published_at: stored.published_at } : {}),
    ...(stored.retired_at ? { retired_at: stored.retired_at } : {}),
    definition: structuredClone(stored.definition),
    compiled: structuredClone(stored.compiled),
    dependency_locks: structuredClone(stored.dependency_locks),
    validation: structuredClone(stored.validation),
  };
}

function refFromParams(params: { name: string; version: string }): WorkflowRef {
  return `${params.name}@${params.version}` as WorkflowRef;
}

function safeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, "-").replace(/^-+|-+$/g, "") || "workflow";
}

function requireManagementAccess(headers: Record<string, unknown>, configuredToken: string | undefined): void {
  if (!configuredToken) return;
  const provided = legacyNamingAdapter.readHeader(headers, "x-anomaloharis-admin-token") ?? "";
  const expectedHash = createHash("sha256").update(configuredToken).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  if (!provided || !timingSafeEqual(expectedHash, providedHash)) {
    throw new WorkflowRuntimeError("forbidden", "Management API requires X-AnomaloHaris-Admin-Token.", 403);
  }
}

function sendWorkflowError(reply: FastifyReply, error: unknown): FastifyReply {
  const knownError = error instanceof WorkflowRuntimeError || error instanceof RunControlError || error instanceof ComputeRequestError;
  const status = knownError ? error.statusCode : 500;
  const payload: Record<string, unknown> = {
    error: error instanceof Error ? error.message : String(error),
    error_code: knownError ? error.errorCode : "workflow_runtime_error",
  };
  if (error instanceof WorkflowRuntimeError && error.validation) payload.validation = error.validation;
  return reply.code(status).send(payload);
}
