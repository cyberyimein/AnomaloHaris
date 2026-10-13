<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ArrowUp, Check, ChevronRight, History, PanelRightOpen, Play, X } from '@lucide/vue';
import shrimp from '../assets/anomaloharis-shrimp.png';
import './demo.css';

const tabs = ['Agent', 'Bot', 'Buddy', 'Preset Models', 'Workflows', 'Plugins'];
const view = ref('Agent');
const input = ref('');
const conversations = ref({ Agent: [], Bot: [] });
const turns = computed({
  get: () => conversations.value[view.value] || [],
  set: value => { conversations.value[view.value] = value; },
});
const running = ref(false);
const paused = ref(false);
const connected = ref(false);
const selectedModel = ref('Default');
const dialog = ref(null);
const dialogElement = ref(null);
const conversation = ref(null);
const workflowStep = ref(-1);
const workflowRunning = ref(false);
const workflowDone = ref(false);
const rememberedFocus = ref(null);
const timers = new Set();
let generation = 0;
const models = [
  { name: 'Default', subtitle: 'General purpose', description: 'A general-purpose agent with the full demo tool catalog: search, reading, computation, memory and runtime actions.', tools: ['web-search', 'python', 'memory', 'bot-tools', 'buddy-tools'], color: 'blue' },
  { name: 'Research', subtitle: 'Explore & synthesize', description: 'Find leads, compare sources and turn evidence into traceable research notes.', tools: ['web-search', 'python', 'memory'], color: 'teal' },
  { name: 'Companion', subtitle: 'Remember & respond', description: 'Carry preferences and goals forward through Bot and embodied Buddy interactions.', tools: ['bot-tools', 'buddy-tools', 'memory'], color: 'rose' },
];
const plugins = [
  { name: 'web-search', description: 'Search and web reading', detail: 'Search and read web pages while keeping a trace of the sources used.', tools: ['web_search', 'web_read'], status: 'Research' },
  { name: 'python', description: 'Computation and experiments', detail: 'A Python execution interface for calculations and research experiments. This demo shows simulated calls.', tools: ['python_execute'], status: 'Research' },
  { name: 'memory', description: 'Memory and context', detail: 'Bring preferences and completed work into the next conversation. Demo state stays in this browser page.', tools: ['memory_read', 'memory_write'], status: 'Shared' },
  { name: 'bot-tools', description: 'Continuous goals and tasks', detail: 'Give Bot task, memory and run controls for ongoing assistance and on-demand responses.', tools: ['bot_memory_write', 'bot_task_create'], status: 'Bot' },
  { name: 'buddy-tools', description: 'Embodied interaction and state', detail: 'Map runtime output to Buddy expressions and actions. No real hardware is connected here.', tools: ['buddy_state', 'buddy_action'], status: 'Buddy' },
];
const steps = ['Prepare context', 'Research agent gathers leads', 'Generate a research note', 'Complete the run'];
const exampleCalls = [
  {
    name: 'web_search',
    description: 'Find research leads',
    arguments: { query: 'Anomalocaris feeding appendages' },
    result: { leads: ['Frontal appendage morphology', 'Feeding hypotheses'], simulated: true },
  },
  {
    name: 'web_read',
    description: 'Read a selected source',
    arguments: { source_id: 'demo-source-01' },
    result: { excerpt: 'Example notes on appendage shape and movement range.', simulated: true },
  },
  {
    name: 'python_execute',
    description: 'Compute a comparison',
    arguments: { code: 'measurements = [12, 15, 18]\nprint(sum(measurements) / len(measurements))' },
    result: { stdout: '15.0', data: 'Illustrative measurements, not research evidence' },
  },
  {
    name: 'memory_write',
    description: 'Save the research context',
    arguments: { note: 'Compare appendage morphology and feeding hypotheses.' },
    result: { status: 'Recorded in this demo trace only', simulated: true },
  },
];
const inspector = computed(() => ({ model: selectedModel.value, session: 'demo-session', runtime: 'Browser simulation', tools: models.find(model => model.name === selectedModel.value)?.tools || [] }));

function later(callback, delay) {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer);
}
function setView(tab) { view.value = tab; }
function responseFor(message, targetView) {
  if (targetView === 'Bot') {
    return 'Your AI, on standby. 24/7.\n\nBot is the always-ready AI experience: respond when you need help, keep track of ongoing goals, and pick up work with the right context.\n\nA daily check-in can review open tasks, recall your preferences and summarize what needs attention.\n\nThis page demonstrates that experience with a preset response. It does not run a background service or send real reminders.';
  }
  if (/architecture|runtime/i.test(message)) {
    return 'One runtime, three ways to interact.\n\nAgent handles direct conversations and tool calling. Bot is the 24/7 standby AI experience for ongoing goals, tasks and memory. Buddy extends interaction to a StackChan device.\n\nThey share sessions, model presets and reusable tool capabilities. Workflows orchestrate explicit steps on the same runtime.';
  }
  if (/tool|research|search|compute/i.test(message)) {
    return 'Tool-calling run complete.\n\nThe agent searched for research leads, read a selected source, calculated a comparison and saved a research note. Expand each call above to inspect its arguments and result.\n\nIn the actual runtime, tool results return to the model so it can choose its next step and produce a final answer. This demo replays that complete loop with illustrative data.';
  }
  return 'One runtime, three ways to interact.\n\nAnomaloHaris brings together a tool-calling Agent, a 24/7 standby Bot and an embodied Buddy. Preset Models compose instructions and tools; Workflows coordinate multi-step work; Plugins supply reusable capabilities.\n\nTry the tool-calling demo to follow search, reading, computation and memory from request to result. All activity here is simulated.';
}
async function scrollConversation() {
  await nextTick();
  conversation.value?.scrollTo({ top: conversation.value.scrollHeight, behavior: 'smooth' });
}
function send(message = input.value) {
  const text = message.trim();
  const targetView = view.value;
  if (!text || running.value || (targetView === 'Bot' && paused.value)) return;
  const targetTurns = conversations.value[targetView];
  input.value = '';
  targetTurns.push({ role: 'user', text });
  running.value = true;
  const current = ++generation;
  scrollConversation();
  const useTools = targetView === 'Agent' && /tool|research|search|compute/i.test(text);
  if (useTools) {
    const trace = reactive({ role: 'tools', calls: [] });
    targetTurns.push(trace);
    exampleCalls.forEach((call, index) => {
      later(() => {
        if (current !== generation) return;
        trace.calls.push({ ...call, status: 'Running' });
        scrollConversation();
      }, index * 900);
      later(() => {
        if (current !== generation) return;
        trace.calls[index].status = 'Complete';
        scrollConversation();
      }, index * 900 + 650);
    });
  }
  later(() => {
    if (current !== generation) return;
    targetTurns.push({ role: 'assistant', text: responseFor(text, targetView) });
    running.value = false;
    scrollConversation();
  }, useTools ? 3700 : 850);
}
function reset() {
  generation++;
  running.value = false;
  turns.value = [];
  input.value = '';
}
function openDialog(type, plugin = null) {
  rememberedFocus.value = document.activeElement;
  dialog.value = { type, plugin };
  nextTick(() => dialogElement.value?.focus());
}
function closeDialog() {
  dialog.value = null;
  rememberedFocus.value?.focus();
}
function handleKeyboard(event) {
  if (event.key === 'Escape' && dialog.value) closeDialog();
  if (event.key === 'Tab' && dialog.value) {
    const elements = [...dialogElement.value.querySelectorAll('button, [href], input, textarea, [tabindex="0"]')];
    const first = elements[0];
    const last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogElement.value)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogElement.value)) { event.preventDefault(); first?.focus(); }
  }
}
function openHistory() {
  reset();
  turns.value = [{ role: 'user', text: 'Explain the system architecture' }, { role: 'assistant', text: responseFor('architecture', 'Agent') }];
  view.value = 'Agent';
  closeDialog();
}
function tryModel(name) { selectedModel.value = name; view.value = 'Agent'; reset(); }
function runWorkflow() {
  workflowRunning.value = true;
  workflowDone.value = false;
  workflowStep.value = 0;
  steps.forEach((_, index) => {
    later(() => {
      workflowStep.value = index;
      if (index === steps.length - 1) { workflowRunning.value = false; workflowDone.value = true; }
    }, index * 750);
  });
}
onMounted(() => document.addEventListener('keydown', handleKeyboard));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeyboard);
  timers.forEach(clearTimeout);
});
</script>

<template>
  <div class="demo-shell">
    <header class="demo-topbar">
      <a class="demo-brand" href="#" @click.prevent="setView('Agent')" aria-label="AnomaloHaris home">
        <img :src="shrimp" alt="" />
        <span><strong>AnomaloHaris</strong><small>A Caris · Local Harness</small></span>
      </a>
      <nav class="demo-nav" aria-label="Primary">
        <button v-for="tab in tabs" :key="tab" :class="{ active: view === tab }" :aria-current="view === tab ? 'page' : undefined" @click="setView(tab)">{{ tab }}</button>
      </nav>
      <span class="demo-badge"><i></i>Interactive demo</span>
    </header>
    <div class="demo-disclosure">Project showcase · Simulated tool calls and activity. No live models, backend or hardware.</div>

    <template v-if="view === 'Agent' || view === 'Bot'">
      <div class="demo-chat-toolbar">
        <span><i class="demo-dot"></i>{{ view === 'Bot' ? (paused ? 'Bot · Standby paused' : 'Bot · 24/7 standby concept') : `${selectedModel} · Demo session` }}</span>
        <div>
          <button v-if="view === 'Bot'" @click="paused = !paused">{{ paused ? 'Resume standby' : 'Pause standby' }}</button>
          <button @click="reset">New conversation</button>
          <button @click="openDialog('history')"><History :size="15" />History</button>
          <button @click="openDialog('inspector')"><PanelRightOpen :size="15" />Inspector</button>
        </div>
      </div>
      <section v-if="view === 'Bot'" class="demo-standby" aria-label="Bot standby overview">
        <div><span class="demo-kicker">24/7 STANDBY AI</span><strong>{{ paused ? 'Standby paused' : 'Ready when you need it' }}</strong></div>
        <div><span>Ongoing goals</span><strong>Research follow-up</strong></div>
        <div><span>Check-in</span><strong>Daily review · Example</strong></div>
        <p>Keep context, respond on demand and follow through on tasks. Simulated activity only.</p>
      </section>
      <main ref="conversation" class="demo-conversation" aria-label="Conversation">
        <section v-if="!turns.length" class="demo-empty">
          <div class="demo-emblem"><img :src="shrimp" alt="AnomaloHaris shrimp mascot" /></div>
          <span class="demo-kicker">{{ view === 'Bot' ? 'ALWAYS READY, ALWAYS IN CONTEXT' : 'FULL TOOL-CALLING AGENT' }}</span>
          <h1>{{ view === 'Bot' ? 'Your AI, on standby. 24/7.' : 'Ready when you are.' }}</h1>
          <p>{{ view === 'Bot' ? 'Ready for a message, a task or a scheduled check-in.' : 'Search, read, compute and remember — with every call visible.' }}</p>
          <div class="demo-suggestions">
            <template v-if="view === 'Agent'">
              <button @click="send('Introduce the project')">Introduce the project<ChevronRight :size="14" /></button>
              <button @click="send('Explain the architecture')">Explain the architecture<ChevronRight :size="14" /></button>
              <button @click="send('Run a tool-calling demo')">Run a tool-calling demo<ChevronRight :size="14" /></button>
            </template>
            <template v-else>
              <button @click="send('Plan a daily check-in')" :disabled="paused">Plan a daily check-in<ChevronRight :size="14" /></button>
              <button @click="send('Keep track of my research')" :disabled="paused">Keep track of my research<ChevronRight :size="14" /></button>
            </template>
          </div>
          <div v-if="view === 'Agent'" class="demo-capability-line">Full tool calling · Search & read · Python · Memory · Runtime actions</div>
        </section>
        <div v-else class="demo-messages">
          <article v-for="(turn, index) in turns" :key="index" class="demo-message" :class="turn.role">
            <template v-if="turn.role === 'tools'">
              <small>TOOL-CALLING TRACE · SIMULATED</small>
              <details v-for="(call, callIndex) in turn.calls" :key="callIndex" class="demo-tool-call">
                <summary><span>{{ call.name }}<small>{{ call.description }}</small></span><span class="demo-tool-status" :class="{ complete: call.status === 'Complete' }">{{ call.status }}</span></summary>
                <div class="demo-tool-details"><strong>Arguments</strong><pre>{{ JSON.stringify(call.arguments, null, 2) }}</pre><template v-if="call.status === 'Complete'"><strong>Result</strong><pre>{{ JSON.stringify(call.result, null, 2) }}</pre></template><p v-else role="status">Simulating tool execution…</p></div>
              </details>
            </template>
            <template v-else>
              <small>{{ turn.role === 'user' ? 'YOU' : 'ANOMALOHARIS · PRESET RESPONSE' }}</small>
              <p>{{ turn.text }}</p>
            </template>
          </article>
          <div v-if="running" class="demo-activity" role="status"><span class="demo-dot"></span>Playing the simulated run…</div>
        </div>
      </main>
      <footer class="demo-composer-wrap">
        <form class="demo-composer" @submit.prevent="send()">
          <textarea v-model="input" aria-label="Message" placeholder="Ask a question or try a demo scenario…" rows="2" :disabled="running || (view === 'Bot' && paused)" @keydown.enter.exact.prevent="send()"></textarea>
          <div><span>{{ selectedModel }} <span class="demo-composer-note">/ browser demo</span></span><button type="submit" aria-label="Send message" :disabled="running || !input.trim() || (view === 'Bot' && paused)"><ArrowUp :size="20" /></button></div>
        </form>
        <p>Simulated responses · State resets on refresh · Please avoid personal or sensitive information</p>
      </footer>
    </template>

    <main v-else class="demo-page">
      <template v-if="view === 'Buddy'">
        <div class="demo-heading"><span class="demo-kicker">EMBODIED INTERACTION</span><h1>A presence beyond the screen.</h1><p>Extend the shared runtime to StackChan and explore embodied conversation.</p></div>
        <div class="demo-buddy-grid">
          <section class="demo-card demo-device-card">
            <div class="demo-device" :class="{ connected }"><div class="demo-device-screen"><div class="demo-eyes"><i></i><i></i></div><div class="demo-mouth"></div></div><div class="demo-device-base"></div></div>
            <span class="demo-kicker">STACKCHAN · SIMULATION</span><h2>{{ connected ? 'Hello, human.' : 'Waiting for a hello.' }}</h2>
            <p role="status">{{ connected ? 'Simulated device connected' : 'Device offline · Demo state' }}</p>
            <button class="demo-primary" @click="connected = !connected">{{ connected ? 'Disconnect simulation' : 'Simulate connection' }}</button>
          </section>
          <div class="demo-card"><h2>Runtime → Buddy</h2><p>Sessions, models and tools share one runtime. Buddy turns interaction into device state and expression.</p><dl class="demo-facts"><div><dt>Connection</dt><dd>{{ connected ? 'Simulated online' : 'Offline' }}</dd></div><div><dt>Expression</dt><dd>{{ connected ? 'Curious' : 'Idle' }}</dd></div><div><dt>Motion</dt><dd>Simulation</dd></div><div><dt>Hardware</dt><dd>No real hardware connected</dd></div></dl><div class="demo-soft-note">Select Simulate connection to preview the state change. This page does not access your local network or control devices.</div></div>
        </div>
      </template>
      <template v-if="view === 'Preset Models'">
        <div class="demo-heading"><span class="demo-kicker">CAPABILITY COMPOSITION</span><h1>Same runtime. Different intent.</h1><p>Compose instructions and tools into a model preset suited to each task.</p></div>
        <div class="demo-card-grid">
          <article v-for="model in models" :key="model.name" class="demo-card demo-model-card">
            <div class="demo-model-mark" :class="model.color">{{ model.name[0] }}</div><span class="demo-kicker">{{ model.subtitle }}</span><h2>{{ model.name }}</h2><p>{{ model.description }}</p>
            <div class="demo-tags"><span v-for="tool in model.tools" :key="tool">{{ tool }}</span></div>
            <button class="demo-secondary" @click="tryModel(model.name)">Try {{ model.name }}<ChevronRight :size="15" /></button>
          </article>
        </div>
        <p class="demo-caption">Illustrative presets, with no live model service. Select a preset to try its simulated Agent experience.</p>
      </template>
      <template v-if="view === 'Workflows'">
        <div class="demo-heading"><span class="demo-kicker">ORCHESTRATED RESEARCH</span><h1>From a question to a trail.</h1><p>Break research into explicit steps and follow execution in the shared runtime.</p></div>
        <section class="demo-card demo-workflow">
          <div class="demo-section-heading"><div><span class="demo-kicker">EXAMPLE WORKFLOW · V1</span><h2>Anomalocaris research note</h2><p>Question → Context → Research → Summary</p></div><button class="demo-primary" :disabled="workflowRunning" @click="runWorkflow"><Play :size="15" />{{ workflowRunning ? 'Running example…' : 'Run example' }}</button></div>
          <ol class="demo-timeline"><li v-for="(step, index) in steps" :key="step" :class="{ complete: workflowStep >= index, current: workflowRunning && workflowStep === index }"><span><Check v-if="workflowStep > index || workflowDone" :size="17" /><template v-else>{{ index + 1 }}</template></span><div><strong>{{ step }}</strong><small>{{ index === 0 ? 'Define the question and context' : index === 1 ? 'Simulate the Research preset' : index === 2 ? 'Organize findings and open questions' : 'Keep an execution record' }}</small></div></li></ol>
          <div v-if="workflowDone" class="demo-result" role="status"><span class="demo-kicker">Example run complete</span><h3>Research note / Anomalocaris</h3><p>Research topic: frontal appendage morphology and feeding hypotheses. Compare descriptions and record evidence and open questions.</p><small>A preset research example; no actual retrieval, tool execution or model inference takes place.</small></div>
          <div v-else class="demo-soft-note">A browser simulation showing the experience of orchestration and execution records.</div>
        </section>
      </template>
      <template v-if="view === 'Plugins'">
        <div class="demo-heading"><span class="demo-kicker">REUSABLE CAPABILITIES</span><h1>Tools with a place to belong.</h1><p>Organize tool capabilities into plugins and compose them into presets and the runtime.</p></div>
        <div class="demo-plugin-list"><article v-for="plugin in plugins" :key="plugin.name" class="demo-card demo-plugin"><div class="demo-plugin-icon">{{ plugin.name.slice(0, 2) }}</div><div><h2>{{ plugin.name }}</h2><p>{{ plugin.description }}</p></div><span class="demo-plugin-status">{{ plugin.status }}</span><button :aria-label="`View ${plugin.name}`" class="demo-secondary" @click="openDialog('plugin', plugin)">View<ChevronRight :size="15" /></button></article></div>
      </template>
      <footer class="demo-page-footer">AnomaloHaris · Project showcase <span>Browser-only / No live services</span></footer>
    </main>

    <div v-if="dialog" class="demo-overlay" @click.self="closeDialog">
      <section ref="dialogElement" role="dialog" aria-modal="true" aria-labelledby="demo-dialog-title" tabindex="-1" class="demo-dialog">
        <div class="demo-section-heading"><h2 id="demo-dialog-title">{{ dialog.type === 'history' ? 'Example conversation' : dialog.type === 'inspector' ? 'Agent inspector' : dialog.plugin.name }}</h2><button aria-label="Close dialog" @click="closeDialog"><X :size="20" /></button></div>
        <template v-if="dialog.type === 'history'"><p>A preset conversation illustrating how history works.</p><button class="demo-history-item" aria-label="Open example conversation" @click="openHistory"><span>Explain the system architecture<small>2 messages · Example data</small></span><ChevronRight :size="18" /></button></template>
        <template v-if="dialog.type === 'inspector'"><p>Inspect the current demo session configuration.</p><dl class="demo-facts"><div v-for="(value, key) in inspector" :key="key"><dt>{{ key }}</dt><dd>{{ Array.isArray(value) ? value.join(', ') : value }}</dd></div></dl><div class="demo-soft-note">This is a showcase configuration. The local Host executes model and tool calls in the actual project.</div></template>
        <template v-if="dialog.type === 'plugin'"><p>{{ dialog.plugin.detail }}</p><span class="demo-kicker">ILLUSTRATIVE TOOL CATALOG</span><div class="demo-tags"><span v-for="tool in dialog.plugin.tools" :key="tool">{{ tool }}</span></div><div class="demo-soft-note">Plugins do not execute on this site. Tool names illustrate the available capabilities.</div></template>
      </section>
    </div>
  </div>
</template>
