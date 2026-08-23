<template>
  <section class="preset-agents-view">
    <div class="preset-agents-shell">
      <header class="preset-agents-hero">
        <div>
          <span>Reusable AI services</span>
          <h2>Preset Models</h2>
          <p>Define a fixed prompt, provider and plugin combination, then call it by name and version.</p>
        </div>
        <button class="preset-primary-button" type="button" @click="beginCreate">
          <Plus :size="17" />
          New model
        </button>
      </header>

      <form
        v-if="management.state.accessRequired.value"
        class="preset-access-card"
        @submit.prevent="$emit('save-management-token')"
      >
        <div>
          <strong>Management access required</strong>
          <span>{{ management.state.hint.value }}</span>
        </div>
        <input
          v-model="management.state.input.value"
          type="password"
          autocomplete="current-password"
          placeholder="Admin token"
        />
        <button type="submit">Save token</button>
      </form>

      <div v-if="notice" class="preset-notice" :class="{ error: noticeIsError }">
        {{ notice }}
      </div>

      <div v-if="loading" class="preset-empty">Loading preset models…</div>
      <div v-else-if="!agents.length && !editing" class="preset-empty">
        <Ghost :size="30" />
        <strong>No preset models yet</strong>
        <span>Create one for your coding workflow or another external application.</span>
      </div>

      <div v-else class="preset-agent-grid">
        <button
          v-for="agent in agents"
          :key="agent.id"
          class="preset-agent-card"
          :class="{ selected: form.id === agent.id }"
          type="button"
          @click="editAgent(agent)"
        >
          <span class="preset-agent-ghost">{{ agent.ghost || "👻" }}</span>
          <span class="preset-agent-card-copy">
            <strong>{{ agent.name }}</strong>
            <span>{{ agent.description || "No description" }}</span>
          </span>
          <span class="preset-agent-card-meta">
            {{ agent.model }} · {{ agent.tool_names.length }} tools
            <span v-if="agent.status"> · {{ agent.status }}</span>
            <span v-if="agent.search_mode"> · {{ searchModeLabel(agent.search_mode) }}</span>
            <span v-if="agent.bootstrap_tools?.length"> · {{ agent.bootstrap_tools.length }} startup</span>
          </span>
          <ChevronRight :size="18" />
        </button>
      </div>

      <form v-if="editing" class="preset-editor" @submit.prevent="saveAgent">
        <header>
          <div>
            <span>{{ form.id ? "Create new version" : "Create preset model" }}</span>
            <h3>{{ form.name || "Untitled model" }}</h3>
          </div>
          <button class="preset-icon-button" type="button" aria-label="Close editor" @click="closeEditor">
            <X :size="19" />
          </button>
        </header>

        <div class="preset-form-grid">
          <label class="preset-field preset-ghost-field">
            <span>Ghost</span>
            <input v-model="form.ghost" maxlength="32" placeholder="👻" />
          </label>
          <label class="preset-field">
            <span>Name</span>
            <input v-model="form.name" required maxlength="80" placeholder="fomc-brief" />
          </label>
          <label class="preset-field">
            <span>Version</span>
            <input v-model.number="form.version" type="number" min="1" required />
          </label>
          <label class="preset-field preset-field-wide">
            <span>Description</span>
            <input
              v-model="form.description"
              maxlength="500"
              placeholder="Summarizes a focused research brief"
            />
          </label>
          <label class="preset-field preset-field-wide">
            <span>System prompt</span>
            <textarea
              v-model="form.system_prompt"
              required
              rows="10"
              placeholder="You are a focused research analyst…"
            ></textarea>
          </label>
          <label class="preset-field preset-field-model">
            <span>LLM model</span>
            <input v-model="form.model" required placeholder="deepseek/deepseek-v4-flash" />
          </label>
          <label class="preset-field preset-field-temperature">
            <span>Temperature</span>
            <input v-model.number="form.temperature" type="number" min="0" max="2" step="0.1" />
          </label>
        </div>

        <fieldset class="preset-tools-fieldset">
          <legend>Available tools</legend>
          <p>Only checked tools are exposed to this preset model. An empty selection means no tools.</p>
          <div class="preset-tool-grid">
            <label
              v-for="tool in tools"
              :key="`${tool.source}:${tool.name}`"
              class="preset-tool-option"
            >
              <input v-model="form.tool_names" type="checkbox" :value="tool.name" />
              <span>
                <strong>{{ tool.name }}</strong>
                <small>{{ tool.source }}</small>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset v-if="retrievalToolSelected" class="preset-tools-fieldset preset-retrieval-fieldset">
          <legend>Retrieval mode</legend>
          <p>Choose how this preset model should use the selected web_search tool.</p>
          <div class="preset-retrieval-grid">
            <label
              v-for="option in searchModeOptions"
              :key="option.id"
              class="preset-retrieval-option"
              :class="{ selected: form.search_mode === option.id }"
            >
              <input v-model="form.search_mode" type="radio" name="preset-search-mode" :value="option.id" />
              <span>
                <strong>{{ option.label }}</strong>
                <small>{{ option.description }}</small>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset class="preset-tools-fieldset preset-bootstrap-fieldset">
          <legend>Startup context</legend>
          <p>These runtime values are supplied before the first model request and are not model-selected tools.</p>
          <div class="preset-bootstrap-grid">
            <label v-for="clock in startupClocks" :key="clock.timezone" class="preset-bootstrap-option">
              <input
                type="checkbox"
                :checked="hasBootstrapClock(clock.timezone)"
                @change="setBootstrapClock(clock, $event.target.checked)"
              />
              <span>
                <strong>{{ clock.label }}</strong>
                <small>{{ clock.timezone }}</small>
              </span>
            </label>
          </div>
        </fieldset>

        <section v-if="form.id" class="preset-api-callout">
          <span>API reference</span>
          <code>POST /api/preset-models/{{ encodeURIComponent(form.name) }}/versions/{{ form.version }}/runs</code>
          <small>Model Ref: {{ form.name }}@{{ form.version }}</small>
        </section>

        <footer>
          <button
            v-if="form.id"
            class="preset-danger-button"
            type="button"
            :disabled="saving"
            @click="retireModel"
          >
            <Trash2 :size="16" />
            Retire
          </button>
          <span class="preset-footer-spacer"></span>
          <button class="preset-secondary-button" type="button" @click="closeEditor">Cancel</button>
          <button class="preset-primary-button" type="submit" :disabled="saving">
            <Save :size="16" />
            {{ saving ? "Saving…" : form.id ? "Publish new version" : "Create model" }}
          </button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup>
import {
  ChevronRight,
  Ghost,
  Plus,
  Save,
  Trash2,
  X,
} from "@lucide/vue";
import { computed, onMounted, reactive, ref } from "vue";
import { pluginBindingsForTools } from "./pluginBindings.js";

const props = defineProps({
  management: { type: Object, required: true },
});
defineEmits(["save-management-token"]);

const agents = ref([]);
const tools = ref([]);
const loading = ref(true);
const saving = ref(false);
const editing = ref(false);
const notice = ref("");
const noticeIsError = ref(false);
const defaults = reactive({ model: "openai/gpt-4o-mini", temperature: 0.4 });
const searchModeOptions = ref(fallbackSearchModeOptions());
const form = reactive(emptyForm());
const startupClocks = [
  { label: "Local time", timezone: "Asia/Tokyo" },
  { label: "US Eastern time", timezone: "America/New_York" },
];

function emptyForm() {
  return {
    id: "",
    version: 1,
    name: "",
    description: "",
    ghost: "👻",
    system_prompt: "",
    model: defaults?.model || "openai/gpt-4o-mini",
    temperature: defaults?.temperature ?? 0.4,
    tool_names: [],
    search_mode: "diy",
    bootstrap_tools: [],
    fixed_plugins: ["host-core"],
  };
}

function replaceForm(value) {
  const toolNames = [...(value?.tool_names || [])];
  Object.assign(form, emptyForm(), value, {
    version: Number(value?.version || 1),
    tool_names: toolNames,
    search_mode: toolNames.includes("web_search") ? value?.search_mode || "diy" : null,
    bootstrap_tools: [...(value?.bootstrap_tools || [])],
    fixed_plugins: [...(value?.fixed_plugins || ["host-core"])],
  });
}

const retrievalToolSelected = computed(() => form.tool_names.includes("web_search"));

function beginCreate() {
  replaceForm({});
  editing.value = true;
  notice.value = "";
}

function editAgent(agent) {
  replaceForm(agent);
  editing.value = true;
  notice.value = "";
}

function hasBootstrapClock(timezone) {
  return form.bootstrap_tools.some(
    (tool) => tool?.name === "time_now" && tool?.arguments?.timezone === timezone,
  );
}

function setBootstrapClock(clock, enabled) {
  form.bootstrap_tools = form.bootstrap_tools.filter(
    (tool) => !(tool?.name === "time_now" && tool?.arguments?.timezone === clock.timezone),
  );
  if (enabled) {
    form.bootstrap_tools.push({
      name: "time_now",
      arguments: { timezone: clock.timezone },
      resultKey: clock.timezone === "America/New_York" ? "us_eastern_time" : "local_time",
      required: true,
    });
  }
}

function closeEditor() {
  editing.value = false;
  replaceForm({});
}

async function load() {
  loading.value = true;
  notice.value = "";
  try {
    const [modelData, toolResponse] = await Promise.all([
      props.management.requestJson("/api/manage/preset-models"),
      props.management.requestJson("/api/manage/tools"),
    ]);
    agents.value = (modelData.preset_models || []).map(toAgentForm);
    tools.value = toolResponse.tools || [];
  } catch (error) {
    props.management.markError(error);
    showNotice(error.message || String(error), true);
  } finally {
    loading.value = false;
  }
}

function toAgentForm(model) {
  const definition = model?.definition || {};
  const provider = definition.provider || {};
  const plugins = definition.plugins || {};
  const policy = definition.policy || {};
  return {
    id: model.ref,
    ref: model.ref,
    version: Number(model.version || 1),
    name: model.name,
    description: model.description || "",
    ghost: definition.metadata?.ghost || "👻",
    system_prompt: definition.prompt?.system || "",
    prompt_profile: definition.prompt?.profile || "agent",
    model: provider.model || model.provider_model || defaults.model,
    temperature: Number(policy.temperature ?? defaults.temperature),
    tool_names: [...(plugins.allowed_tools || model.tool_catalog || [])],
    search_mode: policy.search_mode || "diy",
    bootstrap_tools: [...(plugins.bootstrap_tools || [])],
    fixed_plugins: [...(plugins.fixed || model.fixed_plugins || ["host-core"])],
    status: model.status,
  };
}

function splitModelRef(ref) {
  const value = String(ref || "");
  const at = value.lastIndexOf("@");
  return at > 0 ? { name: value.slice(0, at), version: Number(value.slice(at + 1)) } : null;
}

async function saveAgent() {
  saving.value = true;
  notice.value = "";
  const nextVersion = form.id ? Number(form.version || 1) + 1 : Number(form.version || 1);
  const toolNames = [...new Set(form.tool_names)];
  const payload = {
    name: form.name.trim().toLowerCase(),
    version: nextVersion,
    description: form.description,
    provider: { adapter: "openai-compatible", model: form.model, tool_protocol: "auto" },
    prompt: { profile: form.prompt_profile || "agent", system: form.system_prompt },
    plugins: {
      fixed: pluginBindingsForTools(toolNames, tools.value),
      allowed_tools: toolNames,
      bootstrap_tools: form.bootstrap_tools,
    },
    policy: {
      temperature: Number(form.temperature),
      search_mode: retrievalToolSelected.value ? form.search_mode : "diy",
    },
    metadata: { ghost: form.ghost },
  };
  try {
    const created = await props.management.requestJson("/api/manage/preset-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const ref = `${payload.name}@${nextVersion}`;
    await props.management.requestJson(`/api/manage/preset-models/${encodeURIComponent(payload.name)}/versions/${nextVersion}/validate`, { method: "POST" });
    const published = await props.management.requestJson(`/api/manage/preset-models/${encodeURIComponent(payload.name)}/versions/${nextVersion}/publish`, { method: "POST" });
    await load();
    editAgent(toAgentForm(published.preset_model || created.preset_model));
    showNotice(`Published ${ref}.`);
  } catch (error) {
    props.management.markError(error);
    showNotice(error.message || String(error), true);
  } finally {
    saving.value = false;
  }
}

async function retireModel() {
  if (!window.confirm(`Retire preset model “${form.name}@${form.version}”?`)) return;
  const ref = splitModelRef(form.id || `${form.name}@${form.version}`);
  if (!ref) return;
  saving.value = true;
  try {
    await props.management.requestJson(`/api/manage/preset-models/${encodeURIComponent(ref.name)}/versions/${ref.version}/retire`, { method: "POST" });
    const retiredName = `${ref.name}@${ref.version}`;
    closeEditor();
    await load();
    showNotice(`Retired ${retiredName}.`);
  } catch (error) {
    props.management.markError(error);
    showNotice(error.message || String(error), true);
  } finally {
    saving.value = false;
  }
}

function showNotice(message, isError = false) {
  notice.value = message;
  noticeIsError.value = isError;
}

function searchModeLabel(mode) {
  return searchModeOptions.value.find((option) => option.id === mode)?.label || mode;
}

function fallbackSearchModeOptions() {
  return [
    {
      id: "native",
      label: "Model-native search",
      description: "Use the preset model through the standard Responses API web_search_preview tool.",
    },
    {
      id: "subagent",
      label: "Web research subagent",
      description: "Delegate research to the fixed DeepSeek V4 Flash 0731 subagent.",
    },
    {
      id: "diy",
      label: "DIY web tools",
      description: "Use AnomaloHaris's existing DuckDuckGo search and page-fetch tools.",
    },
  ];
}

onMounted(load);

defineExpose({ refresh: load });
</script>

<style scoped>
.preset-agents-view { min-height: 0; overflow: auto; padding: 34px clamp(18px, 5vw, 64px) 42px; }
.preset-agents-shell { width: min(1180px, 100%); margin: 0 auto; }
.preset-agents-hero { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.preset-agents-hero span, .preset-editor header span, .preset-api-callout > span { color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
.preset-agents-hero h2 { margin: 6px 0 4px; font-size: clamp(27px, 4vw, 42px); font-weight: 500; }
.preset-agents-hero p { max-width: 620px; margin: 0; color: var(--muted); }
.preset-primary-button, .preset-secondary-button, .preset-danger-button, .preset-access-card button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; border: 1px solid var(--line); border-radius: 9px; padding: 0 14px; font: inherit; cursor: pointer; }
.preset-primary-button { border-color: var(--text); background: var(--text); color: var(--surface); }
.preset-secondary-button, .preset-danger-button { background: var(--surface); color: var(--text); }
.preset-danger-button { color: #a13a35; }
.preset-primary-button:disabled, .preset-danger-button:disabled { opacity: .55; cursor: wait; }
.preset-access-card, .preset-notice { margin-bottom: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 14px; }
.preset-access-card { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 320px) auto; align-items: center; gap: 12px; }
.preset-access-card div { display: grid; gap: 3px; }
.preset-access-card span { color: var(--muted); font-size: 12px; }
.preset-access-card input, .preset-field input, .preset-field textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; padding: 10px 11px; }
.preset-notice { font-size: 13px; }
.preset-notice.error { border-color: rgba(161,58,53,.35); color: #a13a35; }
.preset-empty { display: grid; place-items: center; gap: 8px; min-height: 240px; border: 1px dashed var(--line); border-radius: 16px; color: var(--muted); text-align: center; }
.preset-agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
.preset-agent-card { display: grid; grid-template-columns: 48px minmax(0,1fr) auto; grid-template-areas: "ghost copy arrow" "ghost meta arrow"; align-items: center; gap: 4px 12px; min-height: 118px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--text); padding: 17px; text-align: left; cursor: pointer; transition: border-color 140ms ease, transform 140ms ease; }
.preset-agent-card:hover, .preset-agent-card.selected { border-color: rgba(31,32,35,.4); transform: translateY(-2px); }
.preset-agent-ghost { grid-area: ghost; display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; background: var(--surface-muted); font-size: 25px; }
.preset-agent-card-copy { grid-area: copy; display: grid; min-width: 0; gap: 3px; }
.preset-agent-card-copy strong { font-size: 16px; }
.preset-agent-card-copy span, .preset-agent-card-meta { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.preset-agent-card-meta { grid-area: meta; }
.preset-agent-card > svg { grid-area: arrow; color: var(--muted); }
.preset-editor { margin-top: 22px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); padding: clamp(18px, 3vw, 28px); }
.preset-editor > header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 22px; }
.preset-editor h3 { margin: 5px 0 0; font-size: 24px; font-weight: 500; }
.preset-icon-button { display: grid; place-items: center; width: 38px; height: 38px; border: 1px solid var(--line); border-radius: 9px; background: transparent; color: var(--text); cursor: pointer; }
.preset-form-grid { display: grid; grid-template-columns: 110px minmax(220px, 1fr) minmax(160px, .7fr); gap: 16px; }
.preset-field { display: grid; align-content: start; gap: 7px; }
.preset-field > span, .preset-tools-fieldset legend { font-size: 12px; font-weight: 600; }
.preset-field-wide { grid-column: 1 / -1; }
.preset-field-model { grid-column: 1 / 3; }
.preset-field textarea { resize: vertical; line-height: 1.5; }
.preset-ghost-field input { font-size: 20px; }
.preset-tools-fieldset { margin: 22px 0 0; border: 0; border-top: 1px solid var(--line); padding: 20px 0 0; }
.preset-tools-fieldset p { margin: 4px 0 14px; color: var(--muted); font-size: 12px; }
.preset-tool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; max-height: 290px; overflow: auto; }
.preset-tool-option { display: flex; align-items: start; gap: 9px; border: 1px solid var(--line); border-radius: 9px; padding: 10px; cursor: pointer; }
.preset-tool-option span { display: grid; gap: 2px; min-width: 0; }
.preset-tool-option strong { overflow-wrap: anywhere; font-size: 12px; }
.preset-tool-option small { color: var(--muted); font-size: 10px; }
.preset-retrieval-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.preset-retrieval-option { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 9px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); padding: 11px; cursor: pointer; }
.preset-retrieval-option.selected { border-color: var(--text); }
.preset-retrieval-option input { margin-top: 2px; }
.preset-retrieval-option span { display: grid; gap: 4px; }
.preset-retrieval-option strong { font-size: 13px; }
.preset-retrieval-option small { color: var(--muted); font-size: 11px; line-height: 1.4; }
.preset-bootstrap-fieldset { margin-top: 16px; }
.preset-bootstrap-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
.preset-bootstrap-option { display: flex; align-items: start; gap: 9px; border: 1px solid var(--line); border-radius: 9px; padding: 10px; cursor: pointer; }
.preset-bootstrap-option span { display: grid; gap: 2px; }
.preset-bootstrap-option small { color: var(--muted); font-size: 10px; }
.preset-api-callout { display: grid; gap: 7px; margin-top: 20px; border-radius: 10px; background: var(--surface-muted); padding: 14px; }
.preset-api-callout code { overflow-wrap: anywhere; font-size: 13px; }
.preset-api-callout small { color: var(--muted); }
.preset-editor footer { display: flex; align-items: center; gap: 10px; margin-top: 22px; }
.preset-footer-spacer { flex: 1; }
@media (max-width: 720px) {
  .preset-agents-hero { align-items: start; flex-direction: column; }
  .preset-access-card { grid-template-columns: 1fr; }
  .preset-form-grid { grid-template-columns: 84px 1fr; }
  .preset-field-wide, .preset-field-model { grid-column: 1 / -1; }
  .preset-field-temperature { grid-column: 1 / -1; }
  .preset-retrieval-grid { grid-template-columns: 1fr; }
  .preset-editor footer { flex-wrap: wrap; }
}
</style>
