<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ArrowUp, Check, ChevronRight, History, PanelRightOpen, Play, X } from '@lucide/vue';
import shrimp from '../assets/anomaloharis-shrimp.png';
import './demo.css';

const tabs = ['Agent', 'Bot', 'Buddy', 'Preset Models', 'Workflows', 'Plugins'];
const view = ref('Agent');
const input = ref('');
const turns = ref([]);
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
  { name: 'Default', subtitle: 'General purpose', description: '通用助手：从对话开始，按需调用工具，保留会话上下文。', tools: ['web-search', 'memory'], color: 'blue' },
  { name: 'Research', subtitle: 'Explore & synthesize', description: '研究助手：检索线索，比较来源，整理成可追踪的研究笔记。', tools: ['web-search', 'python', 'memory'], color: 'teal' },
  { name: 'Companion', subtitle: 'Remember & respond', description: '陪伴助手：维护偏好和目标，通过 Bot 与 Buddy 延续互动。', tools: ['bot-tools', 'buddy-tools', 'memory'], color: 'rose' },
];
const plugins = [
  { name: 'web-search', description: '搜索与网页阅读', detail: '为模型提供搜索和网页阅读工具，让信息来源可以追踪。', tools: ['web_search', 'web_read'], status: 'Research' },
  { name: 'python', description: '计算与研究实验', detail: '提供 Python 执行入口，用于计算和研究实验。此展示页仅展示工具定义。', tools: ['python_execute'], status: 'Research' },
  { name: 'memory', description: '会话记忆与上下文', detail: '把用户偏好和已完成的工作带回下一次对话。演示状态只保留在当前页面内。', tools: ['memory_read', 'memory_write'], status: 'Shared' },
  { name: 'bot-tools', description: '持续目标与任务', detail: '支持 Bot 的任务、记忆与运行控制，构建持续交互的入口。', tools: ['bot_memory_write', 'bot_task_create'], status: 'Bot' },
  { name: 'buddy-tools', description: '具身交互与设备状态', detail: '将运行时输出映射为 Buddy 的表达和动作。这里没有连接真实硬件。', tools: ['buddy_state', 'buddy_action'], status: 'Buddy' },
];
const steps = ['准备上下文', '研究助手整理线索', '生成研究摘要', '完成运行'];
const inspector = computed(() => ({ model: selectedModel.value, session: 'demo-session', runtime: 'Browser simulation', tools: models.find(model => model.name === selectedModel.value)?.tools || [] }));

function later(callback, delay) {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer);
}
function setView(tab) { view.value = tab; }
function responseFor(message) {
  if (/架构|architecture|运行时/.test(message)) return '一个运行时，三种入口。\n\nAgent 提供直接对话；Bot 围绕持续目标管理任务与记忆；Buddy 将交互延伸到 StackChan 设备。它们共享会话、模型配置与工具能力。\n\nPreset Models 定义模型的能力组合，Workflows 将多个步骤编排起来，Plugins 提供可复用的工具。';
  if (/研究|research|线索/.test(message)) return '研究示例 · Anomalocaris\n\n1. 明确问题：奇虾的前附肢如何参与捕食？\n2. 整理线索：比较形态描述、运动范围与捕食假说。\n3. 下一步：把来源、假设和待验证问题记录为结构化笔记。\n\n这是预设的展示内容，没有实际搜索或模型推理。可以打开 Workflows 查看一个研究流程的模拟运行。';
  return '一个运行时，三种入口。\n\nAnomaloHaris 是一个本地 AI 运行时项目，把 Agent 实验、持续交互的 Bot 和具身 Buddy 放在同一套架构中，并以奇虾研究作为一个具体的应用方向。\n\n你可以切换顶部入口，查看模型预设、运行示例工作流，或模拟连接 Buddy。\n\n当前是无后端的交互 demo，回复来自预设内容。';
}
async function scrollConversation() {
  await nextTick();
  conversation.value?.scrollTo({ top: conversation.value.scrollHeight, behavior: 'smooth' });
}
function send(message = input.value) {
  const text = message.trim();
  if (!text || running.value) return;
  input.value = '';
  turns.value.push({ role: 'user', text });
  running.value = true;
  const current = ++generation;
  scrollConversation();
  later(() => {
    if (current !== generation) return;
    turns.value.push({ role: 'assistant', text: responseFor(text) });
    running.value = false;
    scrollConversation();
  }, 850);
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
  turns.value = [{ role: 'user', text: '介绍一下系统架构' }, { role: 'assistant', text: responseFor('架构') }];
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
    <div class="demo-disclosure">项目交互展示 · 全部使用模拟数据，不连接模型、后台或真实设备。</div>

    <template v-if="view === 'Agent' || view === 'Bot'">
      <div class="demo-chat-toolbar">
        <span><i class="demo-dot"></i>{{ view === 'Bot' ? (paused ? 'Bot · 已暂停' : 'Bot · 持续目标演示') : `${selectedModel} · 演示会话` }}</span>
        <div>
          <button v-if="view === 'Bot'" @click="paused = !paused">{{ paused ? '继续演示' : '暂停演示' }}</button>
          <button @click="reset">新对话</button>
          <button @click="openDialog('history')"><History :size="15" />History</button>
          <button @click="openDialog('inspector')"><PanelRightOpen :size="15" />Inspector</button>
        </div>
      </div>
      <main ref="conversation" class="demo-conversation" aria-label="Conversation">
        <section v-if="!turns.length" class="demo-empty">
          <div class="demo-emblem"><img :src="shrimp" alt="AnomaloHaris shrimp mascot" /></div>
          <span class="demo-kicker">{{ view === 'Bot' ? 'A CONTINUOUS COMPANION' : 'A LOCAL AI HARNESS' }}</span>
          <h1>{{ view === 'Bot' ? 'A little continuity.' : 'Ready when you are.' }}</h1>
          <p>{{ view === 'Bot' ? '让任务、记忆和对话延续下去。' : '从一段对话，探索一个运行时。' }}</p>
          <div class="demo-suggestions">
            <button @click="send('介绍这个项目')" :disabled="paused && view === 'Bot'">介绍这个项目<ChevronRight :size="14" /></button>
            <button @click="send('解释系统架构')" :disabled="paused && view === 'Bot'">解释系统架构<ChevronRight :size="14" /></button>
            <button @click="send('展示一个研究示例')" :disabled="paused && view === 'Bot'">展示一个研究示例<ChevronRight :size="14" /></button>
          </div>
        </section>
        <div v-else class="demo-messages">
          <article v-for="(turn, index) in turns" :key="index" class="demo-message" :class="turn.role">
            <small>{{ turn.role === 'user' ? 'YOU' : 'ANOMALOHARIS · PRESET RESPONSE' }}</small>
            <p>{{ turn.text }}</p>
          </article>
          <div v-if="running" class="demo-activity" role="status"><span class="demo-dot"></span>正在播放演示回复…</div>
        </div>
      </main>
      <footer class="demo-composer-wrap">
        <form class="demo-composer" @submit.prevent="send()">
          <textarea v-model="input" aria-label="Message" placeholder="输入消息，体验预设回复…" rows="2" :disabled="running || (view === 'Bot' && paused)" @keydown.enter.exact.prevent="send()"></textarea>
          <div><span>{{ selectedModel }} <span class="demo-composer-note">/ browser demo</span></span><button type="submit" aria-label="Send message" :disabled="running || !input.trim() || (view === 'Bot' && paused)"><ArrowUp :size="20" /></button></div>
        </form>
        <p>回复为预设演示内容 · 页面刷新后清空 · 请勿输入个人或敏感信息</p>
      </footer>
    </template>

    <main v-else class="demo-page">
      <template v-if="view === 'Buddy'">
        <div class="demo-heading"><span class="demo-kicker">EMBODIED INTERACTION</span><h1>A presence beyond the screen.</h1><p>把同一套运行时延伸到 StackChan，探索对话与具身表达。</p></div>
        <div class="demo-buddy-grid">
          <section class="demo-card demo-device-card">
            <div class="demo-device" :class="{ connected }"><div class="demo-device-screen"><div class="demo-eyes"><i></i><i></i></div><div class="demo-mouth"></div></div><div class="demo-device-base"></div></div>
            <span class="demo-kicker">STACKCHAN · SIMULATION</span><h2>{{ connected ? 'Hello, human.' : 'Waiting for a hello.' }}</h2>
            <p role="status">{{ connected ? '模拟设备已连接' : '设备尚未连接 · 演示状态' }}</p>
            <button class="demo-primary" @click="connected = !connected">{{ connected ? '断开模拟连接' : '模拟连接' }}</button>
          </section>
          <div class="demo-card"><h2>Runtime → Buddy</h2><p>会话、模型和工具共享运行时，Buddy 负责把交互转化为设备状态与表达。</p><dl class="demo-facts"><div><dt>Connection</dt><dd>{{ connected ? 'Simulated online' : 'Offline' }}</dd></div><div><dt>Expression</dt><dd>{{ connected ? 'Curious' : 'Idle' }}</dd></div><div><dt>Motion</dt><dd>演示模式</dd></div><div><dt>Hardware</dt><dd>未连接真实硬件</dd></div></dl><div class="demo-soft-note">点击「模拟连接」可预览状态变化。此页不会访问本地网络或控制设备。</div></div>
        </div>
      </template>
      <template v-if="view === 'Preset Models'">
        <div class="demo-heading"><span class="demo-kicker">CAPABILITY COMPOSITION</span><h1>Same runtime. Different intent.</h1><p>用模型预设组织指令与工具，给每一种任务合适的能力组合。</p></div>
        <div class="demo-card-grid">
          <article v-for="model in models" :key="model.name" class="demo-card demo-model-card">
            <div class="demo-model-mark" :class="model.color">{{ model.name[0] }}</div><span class="demo-kicker">{{ model.subtitle }}</span><h2>{{ model.name }}</h2><p>{{ model.description }}</p>
            <div class="demo-tags"><span v-for="tool in model.tools" :key="tool">{{ tool }}</span></div>
            <button class="demo-secondary" @click="tryModel(model.name)">试用 {{ model.name }}<ChevronRight :size="15" /></button>
          </article>
        </div>
        <p class="demo-caption">示意预设，不对应线上模型服务。试用后可在 Agent 页体验预设回复。</p>
      </template>
      <template v-if="view === 'Workflows'">
        <div class="demo-heading"><span class="demo-kicker">ORCHESTRATED RESEARCH</span><h1>From a question to a trail.</h1><p>把研究任务拆成明确步骤，在同一个运行时内追踪执行进度。</p></div>
        <section class="demo-card demo-workflow">
          <div class="demo-section-heading"><div><span class="demo-kicker">EXAMPLE WORKFLOW · V1</span><h2>奇虾研究摘要</h2><p>问题 → 上下文 → 研究 → 摘要</p></div><button class="demo-primary" :disabled="workflowRunning" @click="runWorkflow"><Play :size="15" />{{ workflowRunning ? '演示运行中…' : '运行示例' }}</button></div>
          <ol class="demo-timeline"><li v-for="(step, index) in steps" :key="step" :class="{ complete: workflowStep >= index, current: workflowRunning && workflowStep === index }"><span><Check v-if="workflowStep > index || workflowDone" :size="17" /><template v-else>{{ index + 1 }}</template></span><div><strong>{{ step }}</strong><small>{{ index === 0 ? '建立研究问题与上下文' : index === 1 ? '模拟调用 Research 预设' : index === 2 ? '整理结论与待验证问题' : '保留运行记录' }}</small></div></li></ol>
          <div v-if="workflowDone" class="demo-result" role="status"><span class="demo-kicker">示例运行完成</span><h3>Research note / Anomalocaris</h3><p>研究主题：前附肢形态与捕食假说。后续可比较不同形态描述，列出证据和待验证问题。</p><small>此摘要是预设演示内容；没有实际检索、工具调用或模型执行。</small></div>
          <div v-else class="demo-soft-note">这是浏览器内播放的流程示例，帮助展示编排与运行记录的体验。</div>
        </section>
      </template>
      <template v-if="view === 'Plugins'">
        <div class="demo-heading"><span class="demo-kicker">REUSABLE CAPABILITIES</span><h1>Tools with a place to belong.</h1><p>把工具能力组织为插件，再按任务组合到模型预设和运行时中。</p></div>
        <div class="demo-plugin-list"><article v-for="plugin in plugins" :key="plugin.name" class="demo-card demo-plugin"><div class="demo-plugin-icon">{{ plugin.name.slice(0, 2) }}</div><div><h2>{{ plugin.name }}</h2><p>{{ plugin.description }}</p></div><span class="demo-plugin-status">{{ plugin.status }}</span><button :aria-label="`查看 ${plugin.name}`" class="demo-secondary" @click="openDialog('plugin', plugin)">查看<ChevronRight :size="15" /></button></article></div>
      </template>
      <footer class="demo-page-footer">AnomaloHaris · Project showcase <span>Browser-only / No live services</span></footer>
    </main>

    <div v-if="dialog" class="demo-overlay" @click.self="closeDialog">
      <section ref="dialogElement" role="dialog" aria-modal="true" aria-labelledby="demo-dialog-title" tabindex="-1" class="demo-dialog">
        <div class="demo-section-heading"><h2 id="demo-dialog-title">{{ dialog.type === 'history' ? '示例会话' : dialog.type === 'inspector' ? 'Agent inspector' : dialog.plugin.name }}</h2><button aria-label="Close dialog" @click="closeDialog"><X :size="20" /></button></div>
        <template v-if="dialog.type === 'history'"><p>预设会话，用于展示历史记录的交互方式。</p><button class="demo-history-item" aria-label="打开示例对话" @click="openHistory"><span>介绍一下系统架构<small>2 messages · 示例数据</small></span><ChevronRight :size="18" /></button></template>
        <template v-if="dialog.type === 'inspector'"><p>查看当前演示会话的配置。</p><dl class="demo-facts"><div v-for="(value, key) in inspector" :key="key"><dt>{{ key }}</dt><dd>{{ Array.isArray(value) ? value.join(', ') : value }}</dd></div></dl><div class="demo-soft-note">这是展示配置。真实项目由本地 Host 执行模型与工具调用。</div></template>
        <template v-if="dialog.type === 'plugin'"><p>{{ dialog.plugin.detail }}</p><span class="demo-kicker">ILLUSTRATIVE TOOL CATALOG</span><div class="demo-tags"><span v-for="tool in dialog.plugin.tools" :key="tool">{{ tool }}</span></div><div class="demo-soft-note">插件未在此站点执行，工具名称用于说明能力边界。</div></template>
      </section>
    </div>
  </div>
</template>
