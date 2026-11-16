import { createHash } from "node:crypto";

import { OpenAICompatibleAdapter, ProviderUnavailableError, type ModelAdapter, type ModelCompletion, type ModelRequest, type ModelStreamEvent } from "./model.js";
import type { CompiledPresetModel, SqlitePresetModelRegistry } from "./preset-models.js";
import type { ModelBindingSnapshot } from "./types.js";

export type ResolvedModelProvider = {
  baseUrl: string;
  apiKey?: string;
};

export type PresetModelAdapterOptions = {
  registry: SqlitePresetModelRegistry;
  model: string;
  baseUrl: string;
  apiKey?: string;
  resolveProvider?: (binding: ModelBindingSnapshot) => ResolvedModelProvider;
  fetchImpl?: typeof fetch;
};

/** Resolves credentials from each run's frozen catalog binding, then issues requests for that exact model snapshot. */
export class PresetModelAdapter implements ModelAdapter {
  readonly model: string;
  private readonly adapters = new Map<string, ModelAdapter>();

  constructor(private readonly options: PresetModelAdapterOptions) {
    this.model = options.model;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    yield* this.adapterFor(request).stream(request, signal);
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<string | ModelCompletion> {
    return this.adapterFor(request).complete(request, signal);
  }

  private adapterFor(request: ModelRequest): ModelAdapter {
    if (!request.presetModelRef) throw new Error("preset_model_required");
    const compiled = this.options.registry.resolveForBoundSession(request.presetModelRef);
    const binding = request.modelBinding
      ?? this.options.registry.resolvePresetBinding(request.presetModelRef)
      ?? bindingFromPreset(compiled);
    if (!binding.active) throw new ProviderUnavailableError(`Model Catalog entry ${binding.id} is disabled.`);
    if (binding.adapter !== "openai-compatible") {
      throw new Error(`provider_adapter_unsupported:${binding.adapter}`);
    }

    const provider = this.options.resolveProvider?.(binding) ?? {
      baseUrl: this.options.baseUrl,
      ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
    };
    const requestModel = request.model;
    const toolProtocol = request.toolProtocol ?? binding.toolProtocol ?? "auto";
    const cacheKey = [
      binding.id,
      binding.revision,
      requestModel,
      provider.baseUrl,
      binding.credentialRef ?? "default",
      toolProtocol,
      provider.apiKey ? createHash("sha256").update(provider.apiKey).digest("hex") : "missing",
    ].join("\u0000");
    const cached = this.adapters.get(cacheKey);
    if (cached) return cached;
    if (!provider.apiKey) {
      throw new ProviderUnavailableError(`No credential is configured for Preset Model ${compiled.ref}.`);
    }
    const adapter = new OpenAICompatibleAdapter({
      model: requestModel,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      toolProtocol,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    this.adapters.set(cacheKey, adapter);
    return adapter;
  }
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
