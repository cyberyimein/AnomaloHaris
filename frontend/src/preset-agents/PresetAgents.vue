<template>
  <section class="preset-agents-view">
    <div class="preset-agents-shell">
      <header class="preset-agents-hero">
        <div>
          <span>Reusable AI services</span>
          <h2>Preset Agents</h2>
          <p>Define focused agents once, then call them by name or ID from other systems.</p>
        </div>
        <button class="preset-primary-button" type="button" @click="beginCreate">
          <Plus :size="17" />
          New agent
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

      <div v-if="loading" class="preset-empty">Loading preset agents…</div>
      <div v-else-if="!agents.length && !editing" class="preset-empty">
        <Ghost :size="30" />
        <strong>No preset agents yet</strong>
        <span>Create one for your stock system or another external application.</span>
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
          </span>
          <ChevronRight :size="18" />
        </button>
      </div>

      <form v-if="editing" class="preset-editor" @submit.prevent="saveAgent">
        <header>
          <div>
            <span>{{ form.id ? "Edit preset" : "Create preset" }}</span>
            <h3>{{ form.name || "Untitled agent" }}</h3>
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
          <label class="preset-field preset-field-wide">
            <span>Description</span>
            <input
              v-model="form.description"
              maxlength="500"
              placeholder="Summarizes central-bank decisions for the stock workflow"
            />
          </label>
          <label class="preset-field preset-field-wide">
            <span>System prompt</span>
            <textarea
              v-model="form.system_prompt"
              required
              rows="10"
              placeholder="You are a focused market-news analyst…"
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
          <p>Only checked tools are exposed to this agent. An empty selection means no tools.</p>
          <div class="preset-tool-grid">
            <label v-for="tool in tools" :key="`${tool.source}:${tool.name}`" class="preset-tool-option">
              <input v-model="form.tool_names" type="checkbox" :value="tool.name" />
              <span>
                <strong>{{ tool.name }}</strong>
                <small>{{ tool.source }}</small>
              </span>
            </label>
          </div>
        </fieldset>

        <section v-if="form.id" class="preset-api-callout">
          <span>API reference</span>
          <code>POST /api/agents/{{ encodeURIComponent(form.name) }}/chat</code>
          <small>ID: {{ form.id }}</small>
        </section>

        <footer>
          <button
            v-if="form.id"
            class="preset-danger-button"
            type="button"
            :disabled="saving"
            @click="deleteAgent"
          >
            <Trash2 :size="16" />
            Delete
          </button>
          <span class="preset-footer-spacer"></span>
          <button class="preset-secondary-button" type="button" @click="closeEditor">Cancel</button>
          <button class="preset-primary-button" type="submit" :disabled="saving">
            <Save :size="16" />
            {{ saving ? "Saving…" : "Save agent" }}
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
import { onMounted, reactive, ref } from "vue";

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
const form = reactive(emptyForm());

function emptyForm() {
  return {
    id: "",
    name: "",
    description: "",
    ghost: "👻",
    system_prompt: "",
    model: defaults?.model || "openai/gpt-4o-mini",
    temperature: defaults?.temperature ?? 0.4,
    tool_names: [],
    bootstrap_tools: [],
  };
}

function replaceForm(value) {
  Object.assign(form, emptyForm(), value, {
    tool_names: [...(value?.tool_names || [])],
    bootstrap_tools: [...(value?.bootstrap_tools || [])],
  });
}

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

function closeEditor() {
  editing.value = false;
  replaceForm({});
}

async function load() {
  loading.value = true;
  notice.value = "";
  try {
    const [agentData, toolResponse] = await Promise.all([
      props.management.requestJson("/api/manage/agents"),
      fetch("/api/tools").then(async (response) => {
        if (!response.ok) throw new Error("Unable to load tools.");
        return response.json();
      }),
    ]);
    agents.value = agentData.agents || [];
    Object.assign(defaults, agentData.defaults || {});
    tools.value = toolResponse.tools || [];
  } catch (error) {
    props.management.markError(error);
    showNotice(error.message || String(error), true);
  } finally {
    loading.value = false;
  }
}

async function saveAgent() {
  saving.value = true;
  notice.value = "";
  const payload = {
    name: form.name,
    description: form.description,
    ghost: form.ghost,
    system_prompt: form.system_prompt,
    model: form.model,
    temperature: form.temperature,
    tool_names: form.tool_names,
    bootstrap_tools: form.bootstrap_tools,
  };
  try {
    const url = form.id ? `/api/manage/agents/${encodeURIComponent(form.id)}` : "/api/manage/agents";
    const data = await props.management.requestJson(url, {
      method: form.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await load();
    editAgent(data.agent);
    showNotice(`Saved ${data.agent.name}.`);
  } catch (error) {
    props.management.markError(error);
    showNotice(error.message || String(error), true);
  } finally {
    saving.value = false;
  }
}

async function deleteAgent() {
  if (!window.confirm(`Delete preset agent “${form.name}”?`)) return;
  saving.value = true;
  try {
    const response = await props.management.request(
      `/api/manage/agents/${encodeURIComponent(form.id)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.detail || "Unable to delete preset agent.");
      error.status = response.status;
      error.detail = payload.detail;
      throw error;
    }
    const deletedName = form.name;
    closeEditor();
    await load();
    showNotice(`Deleted ${deletedName}.`);
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
  .preset-editor footer { flex-wrap: wrap; }
}
</style>
