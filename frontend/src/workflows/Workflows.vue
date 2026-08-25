<template>
  <section class="workflows-view">
    <div class="workflows-shell">
      <header class="workflows-hero">
        <div>
          <span>Portable orchestration</span>
          <h2>Workflows</h2>
          <p>Import a versioned JSON definition, validate it against this Host's capabilities, then publish it by exact name@version.</p>
        </div>
        <div class="workflows-hero-actions">
          <button class="workflow-secondary-button" type="button" :disabled="loading" @click="refresh">
            <RefreshCw :size="16" /> Refresh
          </button>
          <button class="workflow-primary-button" type="button" :disabled="loading" @click="exportCapabilities">
            <Download :size="16" /> Export capabilities
          </button>
        </div>
      </header>

      <form v-if="management.state.accessRequired.value" class="workflow-access-card" @submit.prevent="$emit('save-management-token')">
        <div>
          <strong>Management access required</strong>
          <span>{{ management.state.hint.value }}</span>
        </div>
        <input v-model="management.state.input.value" type="password" autocomplete="current-password" placeholder="Admin token" />
        <button type="submit">Save token</button>
      </form>

      <p v-if="notice" class="workflow-notice" :class="{ error: noticeError }">{{ notice }}</p>

      <section class="workflow-capability-card">
        <div class="workflow-section-heading">
          <div>
            <span class="workflow-kicker">Capability manifest</span>
            <h3>{{ capabilities?.engine?.runtime_id || "workflow-runtime" }}</h3>
          </div>
          <code>{{ capabilities?.manifest_hash || "Not loaded" }}</code>
        </div>
        <div v-if="capabilities" class="workflow-metric-grid">
          <div><span>Nodes</span><strong>{{ capabilities.node_types.length }}</strong></div>
          <div><span>Preset Models</span><strong>{{ capabilities.preset_models.length }}</strong></div>
          <div><span>Plugin Operations</span><strong>{{ capabilities.plugin_operations.length }}</strong></div>
          <div><span>Graph</span><strong>{{ capabilities.limits.graph }}</strong></div>
        </div>
        <p v-else class="workflow-muted">Load the manifest to see what Urus can safely compose.</p>
      </section>

      <section class="workflow-import-card">
        <div class="workflow-section-heading">
          <div>
            <span class="workflow-kicker">Definition intake</span>
            <h3>Validate and import a draft</h3>
          </div>
          <label class="workflow-file-button">
            <Upload :size="16" /> Choose JSON
            <input type="file" accept="application/json,.json" @change="readFile" />
          </label>
        </div>
        <textarea v-model="definitionText" rows="12" spellcheck="false" placeholder="Paste a Workflow Definition JSON…"></textarea>
        <div class="workflow-action-row">
          <button class="workflow-secondary-button" type="button" :disabled="validating || !definitionText.trim()" @click="validateDefinition">
            {{ validating ? "Validating…" : "Validate" }}
          </button>
          <button class="workflow-primary-button" type="button" :disabled="importing || !validation?.valid" @click="importDraft">
            {{ importing ? "Importing…" : "Import as draft" }}
          </button>
        </div>
        <ValidationReport v-if="validation" :report="validation" />
      </section>

      <section class="workflow-list-card">
        <div class="workflow-section-heading">
          <div>
            <span class="workflow-kicker">Registry</span>
            <h3>Versioned definitions</h3>
          </div>
          <span class="workflow-muted">{{ workflows.length }} versions</span>
        </div>
        <div v-if="!workflows.length" class="workflow-empty">No Workflow Definitions have been imported yet.</div>
        <div v-else class="workflow-list">
          <button v-for="workflow in workflows" :key="workflow.ref" type="button" class="workflow-row" :class="{ selected: selectedRef === workflow.ref }" @click="selectWorkflow(workflow.ref)">
            <span class="workflow-status-dot" :data-status="workflow.status"></span>
            <span class="workflow-row-copy">
              <strong>{{ workflow.ref }}</strong>
              <span>{{ workflow.description || "No description" }}</span>
            </span>
            <span class="workflow-row-meta">{{ workflow.status }} · {{ workflow.definition_hash }}</span>
            <ChevronRight :size="17" />
          </button>
        </div>
      </section>

      <section v-if="selected" class="workflow-detail-card">
        <header class="workflow-detail-header">
          <div>
            <span class="workflow-kicker">Selected definition</span>
            <h3>{{ selected.ref }}</h3>
            <p>{{ selected.status }} · compiled {{ selected.compiled_hash }}</p>
          </div>
          <div class="workflow-action-row">
            <button class="workflow-secondary-button" type="button" @click="exportDefinition">Export JSON</button>
            <button v-if="selected.status === 'draft'" class="workflow-primary-button" type="button" @click="publish">Publish</button>
            <button v-if="selected.status === 'published'" class="workflow-secondary-button" type="button" @click="retire">Retire</button>
            <button v-if="selected.status === 'draft'" class="workflow-danger-button" type="button" @click="deleteDraft">Delete draft</button>
          </div>
        </header>
        <div class="workflow-detail-grid">
          <div>
            <span class="workflow-kicker">Dependency locks</span>
            <pre>{{ JSON.stringify(selected.dependency_locks, null, 2) }}</pre>
          </div>
          <div>
            <span class="workflow-kicker">Canonical definition</span>
            <pre>{{ JSON.stringify(selected.definition, null, 2) }}</pre>
          </div>
        </div>
      </section>

      <section v-if="selected?.status === 'published'" class="workflow-run-card">
        <div class="workflow-section-heading">
          <div>
            <span class="workflow-kicker">Execution</span>
            <h3>Test this published Workflow</h3>
          </div>
          <code v-if="runRecord">{{ runRecord.run_id }} · {{ runRecord.status }}</code>
        </div>
        <label class="workflow-run-auth">
          <span>Workflow service token (optional)</span>
          <input v-model="workflowToken" type="password" autocomplete="off" placeholder="Only needed for a protected Host" @change="saveWorkflowToken" />
        </label>
        <textarea v-model="runInputText" rows="7" spellcheck="false" placeholder="Workflow input JSON…"></textarea>
        <div class="workflow-action-row">
          <button class="workflow-primary-button" type="button" :disabled="running || !runInputText.trim()" @click="runWorkflow">
            {{ running ? "Running…" : "Run Workflow" }}
          </button>
          <button v-if="running" class="workflow-danger-button" type="button" @click="stopWorkflow">Stop</button>
          <button v-if="runRecord" class="workflow-secondary-button" type="button" @click="downloadRunInput">Download input</button>
          <button v-if="runRecord?.output !== undefined" class="workflow-secondary-button" type="button" @click="downloadRunOutput">Download output</button>
          <button v-if="runEvents.length" class="workflow-secondary-button" type="button" @click="downloadRunEvents">Download events</button>
        </div>
        <p v-if="runError" class="workflow-notice error">{{ runError }}</p>
        <div v-if="runEvents.length" class="workflow-run-events">
            <div v-for="event in runEvents" :key="`${event.run_id}-${event.sequence}`" class="workflow-run-event">
            <span>{{ event.sequence }}</span>
            <strong>{{ event.type }}</strong>
            <code>{{ event.data?.child_run_id || event.data?.node_id || event.data?.error_code || event.data?.status || "" }}</code>
          </div>
        </div>
        <pre v-if="runRecord?.output !== undefined">{{ JSON.stringify(runRecord.output, null, 2) }}</pre>
      </section>
    </div>
  </section>
</template>

<script setup>
import { ChevronRight, Download, RefreshCw, Upload } from "@lucide/vue";
import { onMounted, ref } from "vue";
import { createWorkflowTransport, downloadJson, parseWorkflowJson } from "./workflowTransport";
import ValidationReport from "./ValidationReport.vue";

const props = defineProps({ management: { type: Object, required: true } });
defineEmits(["save-management-token"]);

const workflowTokenStorageKey = "anomaloharis.workflowToken";
const workflowToken = ref(readWorkflowToken());
const transport = createWorkflowTransport({ management: props.management, workflowToken: workflowToken.value });
const capabilities = ref(null);
const workflows = ref([]);
const selected = ref(null);
const selectedRef = ref("");
const definitionText = ref("");
const validation = ref(null);
const loading = ref(false);
const validating = ref(false);
const importing = ref(false);
const notice = ref("");
const noticeError = ref(false);
const runInputText = ref("{}\n");
const runRecord = ref(null);
const runEvents = ref([]);
const running = ref(false);
const runError = ref("");

async function refresh() {
  loading.value = true;
  notice.value = "";
  try {
    const [manifest, list] = await Promise.all([transport.capabilities(), transport.list()]);
    capabilities.value = manifest;
    workflows.value = list.workflows || [];
    if (selectedRef.value) await selectWorkflow(selectedRef.value, { silent: true });
  } catch (error) {
    props.management.markError(error);
    setNotice(error?.message || "Workflow management is unavailable.", true);
  } finally {
    loading.value = false;
  }
}

async function validateDefinition() {
  const parsed = parseWorkflowJson(definitionText.value);
  if (parsed.error) {
    validation.value = { valid: false, errors: [{ code: "WORKFLOW_INVALID_JSON", path: "", message: parsed.error }], warnings: [], resolved_dependencies: [], definition_hash: "", capability_manifest_hash: "", compiled_hash: null };
    return;
  }
  validating.value = true;
  try {
    validation.value = (await transport.validate(parsed.value)).validation;
  } catch (error) {
    props.management.markError(error);
    setNotice(error?.message || "Workflow validation failed.", true);
  } finally {
    validating.value = false;
  }
}

async function importDraft() {
  const parsed = parseWorkflowJson(definitionText.value);
  if (parsed.error || !validation.value?.valid) return;
  importing.value = true;
  try {
    await transport.importDraft(parsed.value);
    setNotice("Workflow imported as a draft.");
    await refresh();
  } catch (error) {
    props.management.markError(error);
    setNotice(error?.message || "Workflow import failed.", true);
  } finally {
    importing.value = false;
  }
}

async function readFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  definitionText.value = await file.text();
  validation.value = null;
}

async function selectWorkflow(ref, options = {}) {
  selectedRef.value = ref;
  try {
    selected.value = (await transport.get(ref)).workflow;
  } catch (error) {
    if (!options.silent) setNotice(error?.message || "Workflow could not be loaded.", true);
  }
}

async function publish() {
  try {
    await transport.publish(selected.value.ref);
    setNotice("Workflow published.");
    await refresh();
  } catch (error) {
    setNotice(error?.message || "Workflow publish failed.", true);
  }
}

async function retire() {
  if (!globalThis.confirm?.("Retire this published Workflow? It will remain exportable but cannot run.")) return;
  try {
    await transport.retire(selected.value.ref);
    setNotice("Workflow retired.");
    await refresh();
  } catch (error) {
    setNotice(error?.message || "Workflow retire failed.", true);
  }
}

async function deleteDraft() {
  if (!globalThis.confirm?.("Delete this draft permanently?")) return;
  try {
    await transport.deleteDraft(selected.value.ref);
    selected.value = null;
    selectedRef.value = "";
    setNotice("Draft deleted.");
    await refresh();
  } catch (error) {
    setNotice(error?.message || "Draft deletion failed.", true);
  }
}

async function exportCapabilities() {
  const manifest = capabilities.value || await transport.capabilities();
  downloadJson(manifest, "anomaloharis-workflow-capabilities.json");
}

async function exportDefinition() {
  const definition = await transport.exportDefinition(selected.value.ref);
  downloadJson(definition, `${selected.value.name}-v${selected.value.version}.json`);
}

async function runWorkflow() {
  const parsed = parseWorkflowJson(runInputText.value);
  if (parsed.error) { runError.value = parsed.error; return; }
  saveWorkflowToken();
  running.value = true;
  runError.value = "";
  runEvents.value = [];
  runRecord.value = null;
  try {
    await transport.runStream(selected.value.ref, parsed.value, `workflows-tab-${Date.now()}`, (event) => {
      runEvents.value.push(event);
      if (!runRecord.value && event.run_id) runRecord.value = { run_id: event.run_id, status: "running" };
    });
    if (runRecord.value?.run_id) {
      runRecord.value = (await transport.getRun(runRecord.value.run_id)).run;
    }
  } catch (error) {
    runError.value = error?.message || "Workflow run failed.";
  } finally {
    running.value = false;
  }
}

async function stopWorkflow() {
  if (!runRecord.value?.run_id) return;
  saveWorkflowToken();
  try {
    await transport.stop(runRecord.value.run_id);
    const result = await transport.getRun(runRecord.value.run_id);
    runRecord.value = result.run;
    runEvents.value = (await transport.runEvents(runRecord.value.run_id)).events || runEvents.value;
  } catch (error) {
    runError.value = error?.message || "Workflow stop failed.";
  }
}

function setNotice(message, error = false) {
  notice.value = message;
  noticeError.value = error;
}

function readWorkflowToken() {
  try { return globalThis.localStorage?.getItem(workflowTokenStorageKey) || ""; } catch { return ""; }
}

function saveWorkflowToken() {
  transport.setWorkflowToken(workflowToken.value);
  try {
    if (workflowToken.value) globalThis.localStorage?.setItem(workflowTokenStorageKey, workflowToken.value);
    else globalThis.localStorage?.removeItem(workflowTokenStorageKey);
  } catch { /* storage is optional for embedded views */ }
}

function downloadRunInput() {
  if (!runRecord.value) return;
  downloadJson(redactWorkflowValue({ run_id: runRecord.value.run_id, input: runRecord.value.input }), `${selected.value.name}-run-input.json`);
}

function downloadRunOutput() {
  if (!runRecord.value) return;
  downloadJson(redactWorkflowValue({ run_id: runRecord.value.run_id, output: runRecord.value.output }), `${selected.value.name}-run-output.json`);
}

function downloadRunEvents() {
  downloadJson(redactWorkflowValue(runEvents.value), `${selected.value.name}-run-events.json`);
}

function redactWorkflowValue(value) {
  if (Array.isArray(value)) return value.map(redactWorkflowValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(token|secret|password|credential|api[_-]?key)/i.test(key) ? "[REDACTED]" : redactWorkflowValue(item),
  ]));
}

onMounted(refresh);
defineExpose({ refresh });

</script>
