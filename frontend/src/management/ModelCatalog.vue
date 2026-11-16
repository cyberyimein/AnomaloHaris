<template>
  <section class="model-catalog-view">
    <div class="model-catalog-shell">
      <header class="catalog-hero">
        <div>
          <span>Provider configuration</span>
          <h2>Models</h2>
        </div>
        <button class="catalog-primary" type="button" :disabled="loading || !catalogAvailable" @click="beginCreate">
          <Plus :size="16" /> Add model
        </button>
      </header>

      <form v-if="management.state.accessRequired.value" class="catalog-access" @submit.prevent="$emit('save-management-token')">
        <div><strong>Management access required</strong><span>{{ management.state.hint.value }}</span></div>
        <input v-model="management.state.input.value" type="password" autocomplete="current-password" placeholder="Admin token" />
        <button type="submit">Save token</button>
      </form>

      <div v-if="notice" class="catalog-notice" :class="{ error: noticeIsError }" role="status">{{ notice }}</div>
      <div v-if="loading" class="catalog-empty">Loading models…</div>

      <template v-else>
        <section class="catalog-defaults" aria-labelledby="catalog-defaults-heading">
          <div class="catalog-section-heading">
            <div><span>Routing</span><h3 id="catalog-defaults-heading">System defaults</h3></div>
            <button class="catalog-secondary" type="button" :disabled="defaultsSaving || !catalogAvailable || !defaultsDirty" @click="saveDefaults">Save defaults</button>
          </div>
          <div class="catalog-default-grid">
            <label>
              <span>Default model</span>
              <select v-model="defaultsDraft.default_model_id" :disabled="!catalogAvailable || !models.length">
                <option v-for="model in defaultChoices('default_model_id')" :key="model.id" :value="model.id" :disabled="!model.active">{{ modelLabel(model) }}</option>
              </select>
            </label>
            <label>
              <span>Research subagent</span>
              <select v-model="defaultsDraft.research_model_id" :disabled="!catalogAvailable || !models.length">
                <option v-for="model in defaultChoices('research_model_id')" :key="model.id" :value="model.id" :disabled="!model.active">{{ modelLabel(model) }}</option>
              </select>
            </label>
          </div>
          <p v-if="defaultsError" class="catalog-inline-error">{{ defaultsError }}</p>
        </section>

        <div class="catalog-content">
          <section class="catalog-list" aria-label="Model catalog">
            <div v-if="!models.length" class="catalog-empty">No models configured.</div>
            <button v-for="model in models" :key="model.id" class="catalog-row" :class="{ selected: selectedId === model.id, inactive: !model.active }" type="button" @click="selectModel(model)">
              <span class="catalog-row-main">
                <strong>{{ model.name }}</strong>
                <code>{{ model.model }}</code>
              </span>
              <span class="catalog-row-meta">
                <span>{{ model.adapter }}</span>
                <span>{{ model.usage_count }} references</span>
                <span class="catalog-status" :class="{ off: !model.active }">{{ model.active ? 'Active' : 'Disabled' }}</span>
              </span>
            </button>
          </section>

          <section v-if="editing" class="catalog-editor" aria-label="Model details">
            <header class="catalog-editor-heading">
              <div><span>{{ creating ? 'New catalog entry' : 'Model entry' }}</span><h3>{{ draft.name || 'Untitled model' }}</h3></div>
              <button class="catalog-icon-button" type="button" aria-label="Close editor" @click="closeEditor">×</button>
            </header>

            <form class="catalog-fields" @submit.prevent="saveModel">
              <label v-if="creating"><span>Stable ID</span><input v-model.trim="draft.id" required pattern="[a-z][a-z0-9._-]{0,63}" placeholder="deepseek-flash" /></label>
              <label><span>Display name</span><input v-model.trim="draft.name" required maxlength="100" placeholder="DeepSeek Flash" /></label>
              <label><span>Provider</span><select v-model="draft.adapter"><option value="openai-compatible">OpenAI compatible</option><option v-if="draft.adapter && draft.adapter !== 'openai-compatible'" :value="draft.adapter">{{ draft.adapter }}</option></select></label>
              <label class="catalog-field-wide"><span>Actual model ID</span><input v-model.trim="draft.model" required placeholder="provider/model-version" /></label>
              <label><span>Credential reference</span><input v-model.trim="draft.credential_ref" placeholder="openrouter-primary" /></label>
              <label><span>Tool protocol</span><select v-model="draft.tool_protocol"><option value="auto">Auto</option><option value="openai">OpenAI</option><option value="dsml">DeepSeek</option><option value="none">None</option></select></label>

              <div v-if="!creating" class="catalog-impact catalog-field-wide">
                <strong>Used by</strong>
                <span>{{ impactSummary }}</span>
                <ul v-if="impactRefs.length"><li v-for="ref in impactRefs" :key="ref">{{ ref }}</li></ul>
                <p v-if="impactError" class="catalog-inline-error">{{ impactError }}</p>
              </div>

              <div v-if="!creating && selectedModel" class="catalog-actions catalog-field-wide">
                <button class="catalog-primary" type="submit" :disabled="saving || !catalogAvailable || !dirty || !impact">{{ saving ? 'Saving…' : 'Save model' }}</button>
                <button v-if="selectedModel.active" class="catalog-secondary" type="button" :disabled="saving || !catalogAvailable || !impact" @click="setActive(false)">Disable</button>
                <button v-else class="catalog-secondary" type="button" :disabled="saving || !catalogAvailable || !impact" @click="setActive(true)">Activate</button>
                <button class="catalog-secondary" type="button" :disabled="saving || !catalogAvailable || (!impactRefs.length && !impactDefaults.length) || !impact" @click="openReplacement">Replace references…</button>
                <button class="catalog-danger" type="button" :title="Number(selectedModel.usage_count) > 0 ? 'Move all references before deleting this model.' : 'Delete this unused catalog entry.'" :disabled="saving || !catalogAvailable || !impact || Number(selectedModel.usage_count) > 0" @click="deleteModel">Delete</button>
                <small v-if="selectedModel.active && (impactRefs.length || impactDefaults.length)" class="catalog-warning">Disabling blocks new calls for these references until this model is activated or replaced.</small>
                <small v-if="Number(selectedModel.usage_count) > 0" class="catalog-action-note">Move all references before deleting this model.</small>
              </div>
              <div v-else class="catalog-actions catalog-field-wide">
                <button class="catalog-primary" type="submit" :disabled="saving || !catalogAvailable">{{ saving ? 'Creating…' : 'Create model' }}</button>
              </div>
            </form>

            <section v-if="!creating && history.length" class="catalog-history">
              <h4>Previous configurations</h4>
              <div v-for="entry in history" :key="entry.revision" class="catalog-history-row">
                <span>Revision {{ entry.revision }} · {{ entry.model }}</span>
                <button class="catalog-text-button" type="button" :disabled="saving || !catalogAvailable || !impact || entry.revision === selectedModel?.revision" @click="restore(entry.revision)">Restore</button>
              </div>
            </section>
          </section>
        </div>
      </template>

      <div v-if="replacementOpen" class="catalog-modal-backdrop" @click.self="replacementOpen = false">
        <section class="catalog-modal" role="dialog" aria-modal="true" aria-labelledby="replacement-title">
          <header><div><span>Move references</span><h3 id="replacement-title">Replace {{ selectedModel?.name }}</h3></div><button class="catalog-icon-button" type="button" aria-label="Close" @click="replacementOpen = false">×</button></header>
          <label><span>Move to</span><select v-model="replacementTarget"><option disabled value="">Choose a model</option><option v-for="model in models.filter((item) => item.active && item.id !== selectedId)" :key="model.id" :value="model.id">{{ modelLabel(model) }}</option></select></label>
          <fieldset><legend>References to move</legend>
            <label v-for="ref in impactRefs" :key="ref" class="catalog-check"><input v-model="replacementRefs" type="checkbox" :value="ref" /><span>{{ ref }}</span></label>
            <label v-if="impactDefaults.length" class="catalog-check"><input v-model="replacementDefaults" type="checkbox" /><span>Move {{ impactDefaults.map(defaultLabel).join(' and ') }}</span></label>
          </fieldset>
          <p class="catalog-preview">{{ replacementSummary }}</p>
          <p v-if="replacementError" class="catalog-inline-error">{{ replacementError }}</p>
          <footer><button class="catalog-secondary" type="button" @click="replacementOpen = false">Cancel</button><button class="catalog-primary" type="button" :disabled="saving || !replacementTarget || (!replacementRefs.length && !replacementDefaults)" @click="replaceReferences">{{ saving ? 'Applying…' : 'Apply replacement' }}</button></footer>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { Plus } from '@lucide/vue';

const props = defineProps({ management: { type: Object, required: true } });
defineEmits(['save-management-token']);

const target = '/api/manage/model-catalog';
const models = ref([]);
const defaults = ref({ default_model_id: '', research_model_id: '', revision: 0 });
const defaultsDraft = reactive({ default_model_id: '', research_model_id: '' });
const selectedId = ref('');
const selectedModel = computed(() => models.value.find((model) => model.id === selectedId.value) || null);
const editing = ref(false);
const creating = ref(false);
const loading = ref(true);
const catalogAvailable = ref(false);
const saving = ref(false);
const defaultsSaving = ref(false);
const notice = ref('');
const noticeIsError = ref(false);
const defaultsError = ref('');
const impactError = ref('');
const impact = ref(null);
const history = ref([]);
const replacementOpen = ref(false);
const replacementTarget = ref('');
const replacementRefs = ref([]);
const replacementDefaults = ref(false);
const replacementError = ref('');
let selectionRequestId = 0;
const draft = reactive(emptyDraft());

const defaultsDirty = computed(() => defaultsDraft.default_model_id !== defaults.value.default_model_id || defaultsDraft.research_model_id !== defaults.value.research_model_id);
const dirty = computed(() => !selectedModel.value || ['name', 'adapter', 'model', 'credential_ref', 'tool_protocol'].some((key) => value(draft[key]) !== value(selectedModel.value[key])));
const impactRefs = computed(() => impact.value?.preset_refs || []);
const impactDefaults = computed(() => impact.value?.default_keys || []);
const impactSummary = computed(() => {
  if (!impact.value) return impactError.value ? 'Reference details unavailable' : 'Loading references…';
  const count = impactRefs.value.length + impactDefaults.value.length;
  return count ? `${count} reference${count === 1 ? '' : 's'} use this model` : 'No current references';
});
const replacementSummary = computed(() => {
  const count = replacementRefs.value.length + (replacementDefaults.value ? impactDefaults.value.length : 0);
  return `${count} reference${count === 1 ? '' : 's'} will use ${models.value.find((item) => item.id === replacementTarget.value)?.name || 'the selected model'}.`;
});

watch(selectedModel, (model) => {
  if (model && editing.value && !creating.value) Object.assign(draft, toDraft(model));
});

function emptyDraft() { return { id: '', name: '', adapter: 'openai-compatible', model: '', credential_ref: '', tool_protocol: 'auto' }; }
function value(input) { return String(input ?? ''); }
function toDraft(model) { return { id: model.id, name: model.name || '', adapter: model.adapter || 'openai-compatible', model: model.model || '', credential_ref: model.credential_ref || '', tool_protocol: model.tool_protocol || 'auto' }; }
function modelLabel(model) { return `${model.name} · ${model.model}${model.active ? '' : ' · Disabled'}`; }
function defaultLabel(key) { return key === 'default_model_id' ? 'System default' : 'Research subagent default'; }
function defaultChoices(key) {
  const selectedId = defaultsDraft[key];
  const selected = models.value.find((model) => model.id === selectedId);
  if (selectedId && !selected) {
    return [{ id: selectedId, name: 'Unavailable binding', model: selectedId, active: false }];
  }
  const choices = models.value.filter((model) => model.active || model.id === selectedId);
  return selected && !choices.some((model) => model.id === selected.id) ? [selected, ...choices] : choices;
}
function setNotice(message, isError = false) { notice.value = message; noticeIsError.value = isError; }
function handleError(error) {
  const code = String(error?.code || '').toLowerCase();
  if (error?.status === 409 && code.includes('revision')) return 'This model changed elsewhere. Refresh and review the latest configuration.';
  if (error?.status === 409) return error?.message || 'This change conflicts with the current model references.';
  return error?.message || String(error);
}
function clearDraft() { Object.assign(draft, emptyDraft()); }

async function refresh() {
  loading.value = true;
  catalogAvailable.value = false;
  defaultsError.value = '';
  try {
    const data = await props.management.requestJson(target);
    models.value = Array.isArray(data.models) ? data.models : [];
    catalogAvailable.value = true;
    defaults.value = { ...(data.defaults || {}), revision: data.defaults?.revision ?? data.revision ?? 0 };
    Object.assign(defaultsDraft, { default_model_id: defaults.value.default_model_id || '', research_model_id: defaults.value.research_model_id || '' });
    if (!models.value.some((model) => model.id === selectedId.value)) selectedId.value = models.value[0]?.id || '';
    if (selectedModel.value && editing.value && !creating.value) Object.assign(draft, toDraft(selectedModel.value));
    if (!editing.value && models.value.length) selectModel(models.value[0]);
  } catch (error) {
    props.management.markError(error);
    setNotice(handleError(error), true);
  } finally {
    loading.value = false;
  }
}

async function selectModel(model) {
  const requestId = ++selectionRequestId;
  selectedId.value = model.id;
  editing.value = true;
  creating.value = false;
  Object.assign(draft, toDraft(model));
  impact.value = null;
  impactError.value = '';
  history.value = [];
  try {
    const [impactData, historyData] = await Promise.all([
      props.management.requestJson(`${target}/${encodeURIComponent(model.id)}/impact`),
      props.management.requestJson(`${target}/${encodeURIComponent(model.id)}/history`),
    ]);
    if (requestId !== selectionRequestId || selectedId.value !== model.id) return;
    impact.value = impactData;
    history.value = Array.isArray(historyData.revisions) ? historyData.revisions : Array.isArray(historyData.history) ? historyData.history : [];
  } catch (error) {
    if (requestId !== selectionRequestId || selectedId.value !== model.id) return;
    impactError.value = handleError(error);
  }
}

function beginCreate() {
  selectionRequestId += 1;
  selectedId.value = '';
  editing.value = true;
  creating.value = true;
  history.value = [];
  impact.value = null;
  clearDraft();
  setNotice('');
}
function closeEditor() { selectionRequestId += 1; editing.value = false; creating.value = false; clearDraft(); }

async function saveModel() {
  saving.value = true;
  setNotice('');
  const body = { ...draft };
  if (!body.credential_ref) delete body.credential_ref;
  if (!creating.value) delete body.id;
  try {
    if (creating.value) {
      const created = await props.management.requestJson(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setNotice(`Created ${created.model?.name || draft.name}.`);
      await refresh();
      if (created.model?.id) await selectModel(models.value.find((model) => model.id === created.model.id) || { ...created.model });
    } else if (selectedModel.value) {
      await props.management.requestJson(`${target}/${encodeURIComponent(selectedId.value)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, expected_revision: selectedModel.value.revision }) });
      setNotice('Model updated. New runs will use this configuration.');
      await refresh();
      if (selectedModel.value) await selectModel(selectedModel.value);
    }
  } catch (error) {
    setNotice(handleError(error), true);
    if (error?.status === 409) await refresh();
  } finally {
    saving.value = false;
  }
}

async function saveDefaults() {
  defaultsSaving.value = true;
  defaultsError.value = '';
  try {
    const data = await props.management.requestJson(`${target}/defaults`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...defaultsDraft, expected_revision: defaults.value.revision }) });
    defaults.value = { ...(data.defaults || data), revision: data.defaults?.revision ?? data.revision ?? defaults.value.revision };
    Object.assign(defaultsDraft, { default_model_id: defaults.value.default_model_id || '', research_model_id: defaults.value.research_model_id || '' });
    setNotice('System defaults saved.');
  } catch (error) {
    const message = handleError(error);
    if (error?.status === 409) {
      await refresh();
      defaultsError.value = message;
    } else {
      defaultsError.value = message;
    }
  } finally {
    defaultsSaving.value = false;
  }
}

async function setActive(active) {
  if (!selectedModel.value) return;
  saving.value = true;
  try {
    const action = active ? 'activate' : 'deactivate';
    await props.management.requestJson(`${target}/${encodeURIComponent(selectedId.value)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: selectedModel.value.revision }) });
    setNotice(active ? 'Model activated.' : 'Model disabled. Existing references are preserved.');
    await refresh();
  } catch (error) {
    setNotice(handleError(error), true);
    if (error?.status === 409) await refresh();
  } finally {
    saving.value = false;
  }
}

async function deleteModel() {
  if (!selectedModel.value || Number(selectedModel.value.usage_count) > 0) return;
  saving.value = true;
  try {
    await props.management.requestJson(`${target}/${encodeURIComponent(selectedId.value)}?expected_revision=${encodeURIComponent(selectedModel.value.revision)}`, { method: 'DELETE' });
    setNotice('Model deleted.');
    selectedId.value = '';
    editing.value = false;
    await refresh();
  } catch (error) {
    setNotice(handleError(error), true);
  } finally {
    saving.value = false;
  }
}

function openReplacement() {
  replacementOpen.value = true;
  replacementTarget.value = '';
  replacementRefs.value = [...impactRefs.value];
  replacementDefaults.value = impactDefaults.value.length > 0;
  replacementError.value = '';
}

async function replaceReferences() {
  if (!selectedModel.value) return;
  saving.value = true;
  replacementError.value = '';
  try {
    await props.management.requestJson(`${target}/${encodeURIComponent(selectedId.value)}/replace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_model_id: replacementTarget.value, preset_refs: replacementRefs.value, include_defaults: replacementDefaults.value, expected_revision: selectedModel.value.revision }) });
    replacementOpen.value = false;
    setNotice('References replaced. Preset versions were preserved.');
    await refresh();
    if (selectedModel.value) await selectModel(selectedModel.value);
  } catch (error) {
    replacementError.value = handleError(error);
    if (error?.status === 409) await refresh();
  } finally {
    saving.value = false;
  }
}

async function restore(revision) {
  if (!selectedModel.value) return;
  saving.value = true;
  try {
    await props.management.requestJson(`${target}/${encodeURIComponent(selectedId.value)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, expected_revision: selectedModel.value.revision }) });
    setNotice(`Restored revision ${revision} as a new model revision.`);
    await refresh();
    if (selectedModel.value) await selectModel(selectedModel.value);
  } catch (error) {
    setNotice(handleError(error), true);
    if (error?.status === 409) await refresh();
  } finally {
    saving.value = false;
  }
}

onMounted(refresh);
defineExpose({ refresh });
</script>

<style scoped>
.model-catalog-view { min-height: 0; overflow: auto; padding: 34px clamp(18px, 5vw, 64px) 42px; }
.model-catalog-shell { width: min(1180px, 100%); margin: 0 auto; }
.catalog-hero, .catalog-section-heading, .catalog-editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.catalog-hero { align-items: end; margin-bottom: 24px; }
.catalog-hero>div>span, .catalog-section-heading>div>span, .catalog-editor-heading>div>span { color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
.catalog-hero h2 { margin: 6px 0 0; font-size: clamp(27px, 4vw, 42px); font-weight: 500; }
.catalog-section-heading h3, .catalog-editor-heading h3 { margin: 4px 0 0; font-size: 22px; font-weight: 500; }
.catalog-primary, .catalog-secondary, .catalog-danger, .catalog-access button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; border: 1px solid var(--line); border-radius: 9px; padding: 0 14px; color: var(--text); background: var(--surface); font: inherit; cursor: pointer; }
.catalog-primary { border-color: var(--text); background: var(--text); color: var(--surface); }
.catalog-danger { color: #a13a35; }
.catalog-primary:disabled, .catalog-secondary:disabled, .catalog-danger:disabled { opacity: .5; cursor: not-allowed; }
.catalog-notice, .catalog-access, .catalog-defaults, .catalog-row, .catalog-editor, .catalog-empty { border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
.catalog-notice { margin-bottom: 14px; padding: 12px 14px; font-size: 13px; }
.catalog-notice.error, .catalog-inline-error { color: #a13a35; }
.catalog-access { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 320px) auto; gap: 12px; align-items: center; padding: 14px; margin-bottom: 16px; }
.catalog-access>div { display: grid; gap: 3px; }
.catalog-access span { color: var(--muted); font-size: 12px; }
.catalog-access input, .catalog-fields input, .catalog-fields select, .catalog-default-grid select, .catalog-modal select { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; background: var(--surface); color: var(--text); font: inherit; }
.catalog-defaults { padding: 20px; margin-bottom: 16px; }
.catalog-default-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 18px; }
.catalog-default-grid label, .catalog-fields label, .catalog-modal>label { display: grid; align-content: start; gap: 7px; min-width: 0; }
.catalog-default-grid label>span, .catalog-fields label>span, .catalog-modal>label>span { font-size: 12px; font-weight: 600; }
.catalog-content { display: grid; grid-template-columns: minmax(280px, .9fr) minmax(360px, 1.1fr); align-items: start; gap: 16px; }
.catalog-list { display: grid; gap: 9px; min-width: 0; }
.catalog-row { display: grid; gap: 7px; width: 100%; padding: 15px; color: var(--text); text-align: left; cursor: pointer; transition: border-color .15s ease, transform .15s ease; }
.catalog-row:hover, .catalog-row.selected { border-color: #1f202366; transform: translateY(-1px); }
.catalog-row.inactive { opacity: .68; }
.catalog-row-main { display: grid; gap: 4px; min-width: 0; }
.catalog-row-main strong { font-size: 15px; }
.catalog-row-main code { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.catalog-row-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--muted); font-size: 11px; }
.catalog-status { color: #507850; }
.catalog-status.off { color: #9c6a34; }
.catalog-editor { min-width: 0; padding: 20px; }
.catalog-editor-heading { margin-bottom: 20px; align-items: start; }
.catalog-icon-button { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--text); font-size: 22px; cursor: pointer; }
.catalog-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; }
.catalog-field-wide { grid-column: 1 / -1; }
.catalog-impact { border-radius: 10px; background: var(--surface-muted); padding: 13px; font-size: 12px; }
.catalog-impact>strong { display: block; margin-bottom: 5px; }
.catalog-impact ul { display: grid; gap: 4px; max-height: 136px; overflow: auto; padding-left: 18px; margin: 9px 0 0; color: var(--muted); }
.catalog-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px; }
.catalog-warning, .catalog-action-note { flex: 1 1 100%; font-size: 12px; line-height: 1.5; }
.catalog-warning { color: #9c6a34; }
.catalog-action-note { color: var(--muted); }
.catalog-history { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 16px; }
.catalog-history h4 { margin: 0 0 8px; font-size: 13px; }
.catalog-history-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.catalog-text-button { border: 0; background: transparent; color: var(--text); text-decoration: underline; cursor: pointer; font: inherit; }
.catalog-empty { display: grid; place-items: center; min-height: 90px; padding: 14px; color: var(--muted); }
.catalog-inline-error { margin: 9px 0 0; font-size: 12px; }
.catalog-modal-backdrop { position: fixed; z-index: 90; inset: 0; display: grid; place-items: center; padding: 18px; background: #15151566; }
.catalog-modal { width: min(560px, 100%); max-height: min(82vh, 700px); overflow: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); padding: 22px; box-shadow: 0 24px 70px #0003; }
.catalog-modal>header, .catalog-modal>footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.catalog-modal>header { margin-bottom: 20px; }
.catalog-modal h3 { margin: 5px 0 0; font-size: 22px; font-weight: 500; }
.catalog-modal>header>div>span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
.catalog-modal fieldset { display: grid; gap: 9px; margin: 18px 0; border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.catalog-modal legend { padding: 0 6px; font-size: 12px; font-weight: 600; }
.catalog-check { display: flex; align-items: center; gap: 9px; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.catalog-check input { flex: 0 0 auto; accent-color: var(--text); }
.catalog-preview { border-radius: 8px; background: var(--surface-muted); padding: 11px; font-size: 12px; }
.catalog-modal>footer { justify-content: flex-end; margin-top: 20px; }
@media (max-width: 760px) {
  .catalog-content { grid-template-columns: 1fr; }
  .catalog-access { grid-template-columns: 1fr; }
}
@media (max-width: 520px) {
  .model-catalog-view { padding: 22px 14px 34px; }
  .catalog-defaults, .catalog-editor { padding: 15px; }
  .catalog-default-grid, .catalog-fields { grid-template-columns: 1fr; }
  .catalog-field-wide { grid-column: auto; }
  .catalog-actions>* { flex: 1 1 calc(50% - 8px); }
  .catalog-hero { align-items: center; }
  .catalog-row-meta { gap: 6px 9px; }
}
</style>
