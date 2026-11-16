import { createHash } from "node:crypto";

import type { AgentEvent, PresetModelRef, RunId, SessionId, StopReason } from "@anomaloharis/contracts";

import { RunController } from "./controller.js";
import type { CompiledPresetModel, SqlitePresetModelRegistry } from "./preset-models.js";
import type {
  ExecutionRuntimeAdapter,
  ResolvedExecutionTarget,
  RunRequest,
  RunContext,
  RuntimeEvent,
  RuntimeResolveOptions,
} from "./run-control.js";
import type { AgentRunInput, AgentPolicy, ModelBindingSnapshot } from "./types.js";
import { SKILL_ACTIVATE_TOOL_NAME } from "./skills.js";

export type AgentInvocation = {
  message?: string | null;
  session_id?: string;
  resume?: boolean;
  response_format?: AgentRunInput["responseFormat"];
  model_binding?: ModelBindingSnapshot;
  research_model_binding?: ModelBindingSnapshot;
  /** Internal callers can provide the full legacy input to preserve behavior. */
  agent_input?: AgentRunInput;
};

type ModelBindingRegistry = {
  resolvePresetBinding(ref: string): ModelBindingSnapshot | undefined;
  getDefaultModelBinding(kind: "default" | "research"): ModelBindingSnapshot | undefined;
};

/**
 * Adapter around the existing AgentCore seam. It translates only the run
 * envelope; ProviderGateway, tool loops and Session checkpoints remain owned by
 * AgentCore and are intentionally not imported by Workflow Runtime.
 */
export class AgentRuntimeAdapter implements ExecutionRuntimeAdapter {
  readonly kind = "preset_model" as const;
  readonly version = "1.0.0";
  readonly packageHash = packageHash("@anomaloharis/agent-runtime-adapter", this.version);
  readonly capabilities = ["agent-core", "session-checkpoint", "tool-loop"] as const;
  readonly consumesHostSlot = true;
  private readonly sessions = new Map<string, SessionId>();

  constructor(private readonly options: {
    registry: SqlitePresetModelRegistry;
    controller: RunController;
    defaultPresetModelRef?: string;
    prepareInput?: (context: RunContext, input: AgentRunInput) => AgentRunInput;
  }) {}

  prepareInput({ target, request }: { runId: string; target: ResolvedExecutionTarget; request: RunRequest }): unknown {
    const model = resolvePublished(this.options.registry, target.ref, target.allowRetired === true);
    const registry = this.options.registry as SqlitePresetModelRegistry & ModelBindingRegistry;
    const presetBinding = registry.resolvePresetBinding(model.ref);
    const configuredDefault = model.ref === this.options.defaultPresetModelRef
      ? registry.getDefaultModelBinding("default")
      : undefined;
    const modelBinding = snapshotBinding(presetBinding ?? configuredDefault ?? bindingFromPreset(model));
    if (!modelBinding.active) throw new Error(`model_catalog_binding_inactive:${modelBinding.id}`);
    const researchBinding = registry.getDefaultModelBinding("research");
    const invocation = withoutCallerBindings(toInvocation(request.input));
    return {
      ...invocation,
      model_binding: modelBinding,
      ...(researchBinding ? { research_model_binding: snapshotBinding(researchBinding) } : {}),
      ...(invocation.agent_input ? {
        agent_input: {
          ...invocation.agent_input,
          model: modelBinding.model,
          modelBinding,
          toolProtocol: modelBinding.toolProtocol ?? model.toolProtocol,
          ...(researchBinding ? { researchModelBinding: snapshotBinding(researchBinding) } : {}),
        },
      } : {}),
    };
  }

  isHealthy(): boolean {
    return this.options.registry.db.isOpen;
  }

  resolve(ref: string, options: RuntimeResolveOptions = {}): ResolvedExecutionTarget {
    const model = resolvePublished(this.options.registry, ref, options.allowRetired === true);
    return {
      kind: this.kind,
      ref: model.ref,
      hash: normalizeHash(model.compiledHash),
      ...(options.allowRetired ? { allowRetired: true } : {}),
    };
  }

  async *start(context: RunContext, input: unknown): AsyncIterable<RuntimeEvent> {
    const model = resolvePublished(this.options.registry, context.target.ref, context.target.allowRetired === true);
    if (normalizeHash(model.compiledHash) !== context.target.hash) {
      throw new Error(`preset_model_target_changed:${context.target.ref}`);
    }
    const invocation = toInvocation(input);
    const baseInput = invocation.agent_input ?? buildAgentInput(context, model, invocation);
    const registry = this.options.registry as SqlitePresetModelRegistry & ModelBindingRegistry;
    const presetBinding = registry.resolvePresetBinding(model.ref);
    const configuredDefault = model.ref === this.options.defaultPresetModelRef
      ? registry.getDefaultModelBinding("default")
      : undefined;
    const modelBinding = snapshotBinding(invocation.model_binding ?? baseInput.modelBinding ?? presetBinding ?? configuredDefault ?? bindingFromPreset(model));
    if (!modelBinding.active) throw new Error(`model_catalog_binding_inactive:${modelBinding.id}`);
    const researchModelBinding = invocation.research_model_binding ?? baseInput.researchModelBinding ?? registry.getDefaultModelBinding("research");
    const withBindings: AgentRunInput = {
      ...baseInput,
      model: modelBinding.model,
      modelBinding,
      toolProtocol: modelBinding.toolProtocol ?? baseInput.toolProtocol,
      ...(researchModelBinding ? { researchModelBinding: snapshotBinding(researchModelBinding) } : {}),
    };
    const agentInput = this.options.prepareInput ? this.options.prepareInput(context, withBindings) : withBindings;
    this.sessions.set(context.runId, agentInput.sessionId);
    try {
      for await (const event of this.options.controller.start({ ...agentInput, runId: context.runId as RunId }, context.signal)) {
        yield projectAgentEvent(event);
      }
    } finally {
      this.sessions.delete(context.runId);
    }
  }

  async stop(runId: string, reason: StopReason): Promise<void> {
    const sessionId = this.sessions.get(runId);
    if (sessionId) await this.options.controller.stop(sessionId, reason === "disconnect" ? "disconnect" : "user_stop");
  }
}

function resolvePublished(registry: SqlitePresetModelRegistry, ref: string, allowRetired = false): CompiledPresetModel {
  const model = registry.resolve(ref, { ...(allowRetired ? { allowRetired: true } : {}) });
  if (model.status !== "published" && !(allowRetired && model.status === "retired")) throw new Error(`preset_model_unavailable:${ref}`);
  return model;
}

function toInvocation(value: unknown): AgentInvocation {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as AgentInvocation;
  return { message: typeof value === "string" ? value : JSON.stringify(value) };
}

function withoutCallerBindings(invocation: AgentInvocation): AgentInvocation {
  const sanitized: AgentInvocation = { ...invocation };
  delete sanitized.model_binding;
  delete sanitized.research_model_binding;
  if (sanitized.agent_input) {
    sanitized.agent_input = { ...sanitized.agent_input };
    delete sanitized.agent_input.modelBinding;
    delete sanitized.agent_input.researchModelBinding;
  }
  return sanitized;
}

function buildAgentInput(
  context: RunContext,
  model: CompiledPresetModel,
  invocation: AgentInvocation,
): AgentRunInput {
  const sessionId = (invocation.session_id || `run_${context.runId}`) as SessionId;
  const allowedToolNames = model.toolCatalog.length > 0
    ? model.allowedToolNames ? model.allowedToolNames.filter((name) => model.toolCatalog.includes(name)) : [...model.toolCatalog]
    : model.allowedToolNames;
  const policy = structuredClone(model.policy) as AgentPolicy;
  const skillSnapshot = model.skillSnapshot;
  if (skillSnapshot?.skills.length && allowedToolNames && !allowedToolNames.includes(SKILL_ACTIVATE_TOOL_NAME)) {
    allowedToolNames.push(SKILL_ACTIVATE_TOOL_NAME);
  }
  return {
    runId: context.runId as RunId,
    sessionId,
    message: invocation.message ?? null,
    resume: invocation.resume === true,
    promptProfile: model.promptProfile,
    systemPrompt: model.systemPrompt,
    model: model.providerModel,
    presetModelRef: model.ref,
    compiledHash: model.compiledHash,
    ...(skillSnapshot ? { skillSnapshot } : {}),
    toolProtocol: model.toolProtocol,
    policy,
    allowedPluginIds: new Set(model.fixedPlugins.map((selector) => selector.split("@")[0]!)),
    allowedPluginLocks: structuredClone(model.pluginLocks),
    searchMode: model.policy.searchMode ?? "diy",
    ...(allowedToolNames ? { allowedToolNames: new Set(allowedToolNames) } : {}),
    ...(model.bootstrapTools ? { bootstrapTools: structuredClone(model.bootstrapTools) } : {}),
    ...(invocation.response_format ? { responseFormat: structuredClone(invocation.response_format) } : model.policy.responseFormat ? { responseFormat: structuredClone(model.policy.responseFormat) } : {}),
    ...(model.policy.temperature === undefined ? {} : { temperature: model.policy.temperature }),
  };
}

function snapshotBinding(binding: ModelBindingSnapshot): ModelBindingSnapshot {
  return structuredClone(binding);
}

function bindingFromPreset(model: CompiledPresetModel): ModelBindingSnapshot {
  return {
    id: `legacy:${model.ref}`,
    adapter: model.definition.provider.adapter,
    model: model.providerModel,
    ...(model.credentialRef ? { credentialRef: model.credentialRef } : {}),
    toolProtocol: model.toolProtocol,
    revision: 0,
    active: true,
  };
}

function projectAgentEvent(event: AgentEvent): RuntimeEvent {
  if (event.type === "run.finished") return { type: "agent.run.finished", data: { ...event.data, original_type: event.type, output: event.data.final_text }, terminal: "succeeded" };
  if (event.type === "run.stopped") return { type: "agent.run.stopped", data: { ...event.data, original_type: event.type }, terminal: "stopped" };
  if (event.type === "run.error") return { type: "agent.run.error", data: { ...event.data, original_type: event.type }, terminal: "failed" };
  return { type: `agent.${event.type}`, data: { ...event.data, original_type: event.type } };
}

function normalizeHash(value: string): `sha256:${string}` {
  return (value.startsWith("sha256:") ? value : `sha256:${value}`) as `sha256:${string}`;
}

function packageHash(name: string, version: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${name}@${version}`).digest("hex")}`;
}
