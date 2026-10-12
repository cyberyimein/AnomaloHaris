<template>
  <section class="bot-page">
    <Teleport to=".header-actions">
      <span class="connection-chip bot-status" role="status"><span class="status-dot" aria-hidden="true"></span>{{ connected ? statusLabel : '连接中断' }}</span>
      <button class="icon-button" type="button" :aria-label="`任务 ${tasks.length}`" title="任务" @click="openPanel('tasks')"><ListTodo :size="18" /></button>
      <button class="icon-button" type="button" aria-label="记忆" title="记忆" @click="openPanel('memory')"><BookOpen :size="18" /></button>
      <button class="icon-button" type="button" aria-label="设置" title="Bot 设置" @click="openPanel('settings')"><Settings2 :size="18" /></button>
    </Teleport>
    <p v-if="error || localError" class="bot-error" role="alert">{{ localError || error }}</p>
    <div class="bot-layout">
      <div class="bot-main">
        <div class="bot-history">
          <p v-if="!messages.length && !liveTurns.length" class="bot-empty">{{ profile?.enabled ? '随时告诉我你想做什么，也可以让我安排下次检查。' : 'Bot 尚未启用。打开设置，选择启用后开始。' }}</p>
          <details v-if="hasEarlier">
            <summary @click="loadEarlier">查看更早的完整记录</summary>
            <pre>{{ earlierHistory }}</pre>
          </details>
          <template v-for="message in messages" :key="message._entryId">
            <article v-if="message.role === 'user' || message.role === 'assistant' && message.content" class="bot-message" :class="message.role">
              <small>{{ message.role === 'user' ? '你' : 'Bot' }}</small>
              <div v-if="message.role === 'assistant'" class="markdown-body" v-html="renderMarkdown(message.content)">
              </div>
              <p v-else>{{ message.content }}</p>
            </article>
            <details v-else-if="message.role === 'tool'" class="bot-tool">
              <summary>{{ message.name || '工具结果' }}</summary>
              <pre>{{ message.content }}</pre>
            </details>
          </template>
          <template v-for="(turn,index) in liveTurns" :key="`live-${index}`">
            <article v-if="turn.role === 'user' || turn.role === 'assistant'" class="bot-message" :class="turn.role">
              <small>{{ turn.role === 'user' ? '你' : 'Bot' }}</small>
              <div v-if="turn.role === 'assistant'" class="markdown-body" v-html="turn.htmlContent"></div><p v-else>{{ turn.content }}</p>
            </article>
            <details v-else-if="turn.role === 'activity-group'" open class="bot-tool"><summary>执行过程 · {{ turn.status }}</summary><div v-for="item in turn.items" :key="item.id"><strong>{{ item.title }}</strong><pre>{{ item.body }}</pre></div></details>
          </template>
          <section v-if="results.length" class="bot-results"><h3>后台结果</h3>
            <article v-for="result in results" :key="result.id" class="bot-result">
              <small>{{ result.kind }} · {{ displayTime(result.created_at) }}</small><p>{{ result.summary }}</p>
              <button v-if="!result.read_at" @click="markRead(result.id)">标记已读</button>
              <button @click="showTask(result.task_id)">查看任务</button>
            </article>
          </section>
        </div>
        <form class="composer" @submit.prevent="send">
          <p v-if="profile?.pending_request" class="bot-composer-note">消息已排队，将在当前任务结束后执行。</p>
          <div class="composer-box bot-composer-box">
            <textarea ref="composerInput" v-model="draft" class="composer-input" rows="1" aria-label="Bot message" :placeholder="profile?.enabled ? '给 Bot 发消息…' : '在设置中启用 Bot 后开始对话'" :disabled="!canSend" @input="resizeComposer" @keydown="composerKeydown"></textarea>
            <span class="send-button-wrap">
              <button v-if="profile?.active_run_id" class="send-button stop-button" type="button" aria-label="停止本次执行" title="停止本次执行" :disabled="busy" @click="stop"><Square :size="17" fill="currentColor" /></button>
              <button v-else-if="checkpoint && profile?.enabled" class="send-button resume-button" type="button" aria-label="继续上次中断的执行" title="继续上次中断的执行" :disabled="busy" @click="resume"><Play :size="18" /></button>
              <button v-else class="send-button" type="submit" aria-label="发送" title="发送（Ctrl / ⌘ + Enter）" :disabled="!canSend || !draft.trim() || busy"><SendHorizontal :size="19" /></button>
            </span>
          </div>
        </form>
      </div>
    </div>
    <Teleport to="body">
      <Transition name="fade"><button v-if="panel" class="inspector-backdrop" type="button" aria-label="关闭面板遮罩" tabindex="-1" @click="closePanel"></button></Transition>
      <Transition name="drawer">
      <aside v-if="panel" ref="drawer" class="inspector-drawer bot-drawer" role="dialog" aria-modal="true" aria-labelledby="bot-panel-title" @keydown="drawerKeydown">
        <header class="drawer-header">
          <div><span class="drawer-kicker">{{ connected ? statusLabel : '连接中断' }}</span><h2 id="bot-panel-title">{{ panel === 'settings' ? 'Bot 设置' : panel === 'tasks' ? '任务' : '记忆' }}</h2></div>
          <button class="icon-button" type="button" aria-label="关闭面板" @click="closePanel"><X :size="18" /></button>
        </header>
        <div class="bot-drawer-body">
        <p v-if="error || localError" class="bot-error" role="alert">{{ localError || error }}</p>
        <div v-if="panel === 'settings'">

          <fieldset :disabled="busy || !profile"><legend>运行状态</legend>
            <label><input type="radio" name="bot-enabled" v-model="enabledChoice" :value="true" @change="setEnabled(true)">启用</label>
            <label><input type="radio" name="bot-enabled" v-model="enabledChoice" :value="false" @change="setEnabled(false)">停用</label>
          </fieldset>
          <p>启用后，Host 运行期间 Bot 可以接收消息并执行任务；离开此页面不会停止。</p>
          <form @submit.prevent="saveSettings">
            <label>Preset Model<input v-model="modelRef" :disabled="profile?.enabled" placeholder="anomaloharis-bot@1"></label>
            <label>时区<input v-model="timezone" placeholder="Asia/Tokyo"></label>
            <label>每日 token 配额<input v-model.number="dailyTokens" type="number" min="1000" max="10000000"></label>
            <label>上下文窗口（按所选模型设置）<input v-model.number="contextWindow" type="number" min="4096" max="1000000"></label>
            <button :disabled="busy || !profile">保存设置</button>
          </form>
          <p>今日使用：{{ profile?.budget.used_tokens || 0 }} tokens（其中估算 {{ profile?.budget.estimated_tokens || 0 }}）。摘要调用会预留额度；缺少 Provider 用量时保留估算。</p>
          <label>管理 Token<input v-model="adminToken" type="password" autocomplete="off" @input="tokenVerified = false"></label>
          <p>请输入服务端已配置的管理 Token。这里仅保存到当前浏览器；输入新值不会修改服务端 Token。OpenRouter API key 和服务调用 Token 不能代替管理 Token。</p>
          <button :disabled="busy" @click="saveToken">{{ busy ? '处理中…' : '保存并验证' }}</button>
          <p v-if="tokenVerified" role="status">管理 Token 已验证，可以使用 Bot。</p>
          <details><summary>上下文整理</summary><button :disabled="busy || !profile?.enabled || !!profile?.active_run_id || checkpoint" @click="compact">手动压缩</button><p>完整历史保留。窗口大小为估算，需匹配模型实际容量。</p><p>已压缩 {{ profile?.compactions.length || 0 }} 次。</p></details>
        </div>
        <div v-else-if="panel === 'tasks'">

          <form @submit.prevent="createTask">
            <label>标题<input v-model="taskTitle" required maxlength="200"></label>
            <label>任务指令<textarea v-model="taskPrompt" required></textarea></label>
            <label>时间规则<select v-model="scheduleType"><option value="once">一次性</option><option value="interval">固定间隔</option><option value="calendar">每天</option></select></label>
            <label v-if="scheduleType === 'once'">执行时间（{{ profile?.timezone }}）<input v-model="onceAt" type="datetime-local" required></label>
            <label v-else-if="scheduleType === 'interval'">间隔秒数<input v-model.number="everySeconds" type="number" min="60" required></label>
            <label v-else>每天几点（{{ profile?.timezone }}）<input v-model="localTime" type="time" required></label>
            <button :disabled="busy">添加任务</button>
          </form>
          <article v-for="task in tasks" :key="task.id" class="bot-task">
            <strong>{{ task.title }}</strong><small>{{ task.status }} · 下次 {{ displayTime(task.next_due_at) }}</small><p>{{ task.prompt }}</p>
            <button :disabled="busy || !profile?.enabled" @click="runTask(task)">立即执行</button>
            <button :disabled="busy" @click="patchTask(task,task.status === 'active' ? 'paused' : 'active')">{{ task.status === 'active' ? '暂停' : '启用' }}</button>
            <button :disabled="busy" @click="patchTask(task,'cancelled')">取消</button>
            <button :disabled="busy" @click="showTask(task.id)">记录</button>
            <pre v-if="Object.keys(task.state).length">{{ JSON.stringify(task.state,null,2) }}</pre>
          </article>
          <details v-if="taskDetails" open><summary>执行记录</summary><article v-for="run in taskDetails" :key="run.id"><p>{{ run.status }} · {{ displayTime(run.scheduled_at) }}</p><button v-if="run.run_id" @click="inspectRun(run.run_id)">查看工具与输出</button><button v-if="run.run_id && run.can_resume" :disabled="!profile?.enabled || busy || !!profile?.active_run_id" @click="resumeTaskRun(run)">从检查点继续</button></article><pre>{{ runDetails }}</pre></details>
        </div>
        <div v-else>
          <p>跨 Bot 会话使用。停止使用会保留来源和修订记录。</p>
          <form @submit.prevent="addMemory"><label>保存一条事实<textarea v-model="memoryText" required maxlength="8000"></textarea></label><button :disabled="busy">保存记忆</button></form>
          <article v-for="memory in memories" :key="memory.id" class="bot-memory">
            <textarea :value="memory.content" :aria-label="`Memory ${memory.id}`" @change="editMemory(memory,$event.target.value)"></textarea>
            <small>{{ memory.scope }} · {{ memory.status }} · 来源 {{ memory.source.type }} · revision {{ memory.revision }}</small>
            <button @click="toggleMemory(memory)">{{ memory.status === 'active' ? '停止使用' : '恢复使用' }}</button><button @click="memoryHistory(memory.id)">来源与修改记录</button>
          </article><pre v-if="memoryDetails">{{ memoryDetails }}</pre>
        </div>
        </div>
      </aside>
      </Transition>
    </Teleport>
  </section>
</template>
<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { BookOpen, ListTodo, Settings2, SendHorizontal, Square, Play, X } from '@lucide/vue';
import { createBotTransport } from './botTransport';
const props = defineProps({ management: { type: Object, required: true }, renderMarkdown: { type: Function, required: true } });
const transport = createBotTransport(props.management, props.renderMarkdown);
const { profile, error, connected, messages, tasks, memories, results, checkpoint, hasEarlier } = transport.state;
const liveTurns = transport.projection.state.conversationTurns;
const enabledChoice = ref(false);
let submittedMessage = null;
const panel = ref('');
const drawer = ref(null);
const composerInput = ref(null);
let panelTrigger = null;
function openPanel(value) {
    panelTrigger = document.activeElement;
    panel.value = value;
}
function closePanel() {
    panel.value = '';
    nextTick(() => panelTrigger?.focus());
}
watch(panel, async value => {
    if (value) {
        await nextTick();
        drawer.value?.querySelector('button')?.focus();
    }
});
function drawerKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
    }
    if (event.key !== 'Tab') return;
    const items = [...drawer.value.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')].filter(el => el.getClientRects().length);
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
    }
}
function resizeComposer() {
    const input = composerInput.value;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}
function composerKeydown(event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        void send();
    }
}
const draft = ref('');
watch(draft, () => nextTick(resizeComposer));
const busy = ref(false);
const localError = ref('');
const modelRef = ref('');
const timezone = ref('Asia/Tokyo');
const dailyTokens = ref(200000);
const contextWindow = ref(32000);
const adminToken = ref(props.management.state.input.value);
const tokenVerified = ref(false);
const taskTitle = ref('');
const taskPrompt = ref('');
const scheduleType = ref('once');
const onceAt = ref('');
const everySeconds = ref(600);
const localTime = ref('09:00');
const taskDetails = ref(null);
const selectedTaskId = ref(null);
let detailRequest = 0;
const runDetails = ref('');
const memoryText = ref('');
const memoryDetails = ref('');
const earlierHistory = ref('');
const statusLabel = computed(() => ({ disabled: '已停用', idle: '待命', working: '正在工作', stopping: '正在停用', starting: '启动中', degraded: '需要处理' }[profile.value?.runtime_state] || '加载中'));
const canSend = computed(() => connected.value && profile.value?.enabled && !['stopping', 'degraded'].includes(profile.value.runtime_state) && !profile.value.pending_request && !checkpoint.value);
watch(() => profile.value?.revision, () => { const p = profile.value; if (p) {
    enabledChoice.value = p.enabled;
    modelRef.value = p.preset_model_ref;
    timezone.value = p.timezone;
    dailyTokens.value = p.limits.daily_tokens;
    contextWindow.value = p.limits.context_window;
} });
onMounted(() => transport.start());
onBeforeUnmount(() => transport.close());
async function perform(fn) { if (busy.value)
    return; busy.value = true; localError.value = ''; try {
    return await fn();
}
catch (cause) {
    localError.value = cause.message;
}
finally {
    busy.value = false;
} }
async function send() { if (!canSend.value || !draft.value.trim())
    return; const text = draft.value; if (!submittedMessage || submittedMessage.message !== text)
    submittedMessage = { request_id: crypto.randomUUID(), message: text }; await perform(async () => { await transport.action('/messages', submittedMessage); draft.value = ''; submittedMessage = null; }); }
async function setEnabled(enabled) { await perform(() => transport.action('/settings', { expected_revision: profile.value.revision, enabled }, 'PATCH')); enabledChoice.value = profile.value.enabled; }
function saveSettings() { return perform(() => transport.action('/settings', { expected_revision: profile.value.revision, preset_model_ref: modelRef.value, timezone: timezone.value, limits: { daily_tokens: dailyTokens.value, context_window: contextWindow.value } }, 'PATCH')); }
function saveToken() {
    return perform(async () => {
        tokenVerified.value = false;
        props.management.state.input.value = adminToken.value;
        props.management.save();
        try {
            await props.management.requestJson('/api/bot');
        } catch (cause) {
            props.management.markError(cause);
            if (cause.status === 403) {
                throw new Error('Token 未通过验证。请输入服务端配置的管理 Token；保存到浏览器不会修改服务端 Token。');
            }
            throw cause;
        }
        await transport.refresh({ afterCurrent: true });
        tokenVerified.value = true;
    });
}
function stop() { return perform(() => transport.action(`/runs/${profile.value.active_run_id}/stop`, {})); }
function resume() { return perform(() => transport.action('/session/resume', { request_id: crypto.randomUUID() })); }
function compact() { return perform(() => transport.action('/session/compact', {})); }
function displayTime(value) { return value ? new Date(value).toLocaleString(undefined, { timeZone: profile.value?.timezone || 'Asia/Tokyo' }) : '—'; }
async function createTask() {
    await perform(async () => {
        let schedule;
        if (scheduleType.value === 'once') {
            const converted = await transport.post('/schedule-preview', { local_time: onceAt.value, timezone: profile.value.timezone });
            schedule = { type: 'once', at: converted.at };
        }
        else if (scheduleType.value === 'interval')
            schedule = { type: 'interval', everySeconds: everySeconds.value, anchorAt: new Date(Date.now() + everySeconds.value * 1000).toISOString() };
        else
            schedule = { type: 'calendar', localTime: localTime.value, timezone: profile.value.timezone };
        await transport.action('/tasks', { title: taskTitle.value, prompt: taskPrompt.value, schedule });
        taskTitle.value = '';
        taskPrompt.value = '';
    });
}
function runTask(task) { return perform(() => transport.action(`/tasks/${task.id}/run`, { request_id: crypto.randomUUID() })); }
function patchTask(task, status) { return perform(() => transport.action(`/tasks/${task.id}`, { expected_revision: task.revision, status }, 'PATCH')); }
async function loadTaskDetails(id) {
    const request = ++detailRequest;
    const result = await transport.request(`/tasks/${id}/runs`);
    if (request === detailRequest && selectedTaskId.value === id) taskDetails.value = result.runs;
}
async function showTask(id) {
    panel.value = 'tasks'; selectedTaskId.value = id;
    await perform(() => loadTaskDetails(id));
}
watch([selectedTaskId, panel, busy, tasks, () => profile.value?.active_run_id], () => {
    if (!selectedTaskId.value || panel.value !== 'tasks' || busy.value) return;
    void loadTaskDetails(selectedTaskId.value).catch(cause => {localError.value = cause.message;});
});
async function inspectRun(id) { await perform(async () => { let after = 0; const all = []; let page; do {
    page = await transport.request(`/runs/${id}/events?after_sequence=${after}`);
    all.push(...page.events);
    after = page.next_sequence;
} while (page.has_more); runDetails.value = JSON.stringify(all, null, 2); }); }
function resumeTaskRun(run) { return perform(() => transport.action(`/tasks/${run.task_id}/resume`, { run_id: run.run_id, request_id: crypto.randomUUID() })); }
function markRead(id) { return perform(() => transport.action(`/results/${id}/read`, {})); }
function addMemory() { return perform(async () => { await transport.action('/memories', { content: memoryText.value, scope: 'user' }); memoryText.value = ''; }); }
function editMemory(memory, content) { return perform(() => transport.action(`/memories/${memory.id}`, { expected_revision: memory.revision, content }, 'PATCH')); }
function toggleMemory(memory) { return perform(() => transport.action(`/memories/${memory.id}`, { expected_revision: memory.revision, status: memory.status === 'active' ? 'inactive' : 'active' }, 'PATCH')); }
function memoryHistory(id) { return perform(async () => { memoryDetails.value = JSON.stringify(await transport.request(`/memories/${id}/history`), null, 2); }); }
function loadEarlier() { return perform(async () => { const all = []; let offset = 0; let page; do {
    page = await transport.request(`/session?offset=${offset}&limit=500`);
    all.push(...page.messages);
    offset = all.length;
} while (offset < page.total); earlierHistory.value = JSON.stringify(all, null, 2); }); }
</script>
<style scoped>
.bot-page { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.bot-layout, .bot-main { display: flex; flex: 1; min-height: 0; min-width: 0; flex-direction: column; }
.bot-history { flex: 1; min-height: 0; overflow: auto; padding: 20px max(24px, calc((100% - 820px) / 2)); }
.bot-composer-box { grid-template-columns: minmax(0, 1fr) auto; }
.bot-composer-note { max-width: 820px; margin: 0 auto 10px; font-size: 12px; color: var(--muted); }
.bot-empty { margin: 0; min-height: 100%; display: grid; place-content: center; text-align: center; color: var(--muted); font-family: var(--font-display); font-size: 18px; line-height: 1.8; }
.bot-message { margin: 24px 0; line-height: 1.8; color: var(--text); }
.bot-message.user { margin-left: auto; width: fit-content; max-width: 85%; padding: 12px 18px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface-raised); }
.bot-message small { color: var(--muted); font-size: 11px; }
.bot-message p, .bot-result p { white-space: pre-wrap; overflow-wrap: anywhere; }
.bot-message p { margin: 4px 0; }
.bot-drawer { width: min(500px, calc(100vw - 24px)); }
.bot-drawer-body { padding: 20px 22px 28px; font-size: 13px; line-height: 1.65; }
.bot-drawer-body form { display: grid; gap: 16px; margin: 20px 0; }
.bot-drawer-body label { display: block; color: var(--text); }
.bot-drawer-body input:not([type=radio]), .bot-drawer-body textarea, .bot-drawer-body select { display: block; width: 100%; box-sizing: border-box; margin-top: 7px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-raised); color: var(--text); font: inherit; }
.bot-drawer-body textarea { min-height: 84px; resize: vertical; }
.bot-drawer-body input:focus-visible, .bot-drawer-body textarea:focus-visible, .bot-drawer-body select:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
.bot-drawer-body button, .bot-result button { border: 1px solid var(--line); background: var(--surface-raised); color: var(--text); border-radius: 9px; padding: 8px 12px; font: inherit; cursor: pointer; }
.bot-drawer-body button:hover:not(:disabled), .bot-result button:hover { background: var(--accent-soft); }
.bot-drawer-body form > button { justify-self: start; color: var(--accent-2); }
.bot-drawer-body fieldset { margin: 0; border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
.bot-drawer-body fieldset label { display: inline-flex; align-items: center; gap: 6px; margin-right: 24px; }
.bot-drawer-body input[type=radio] { accent-color: var(--accent-2); }
.bot-drawer-body p, .bot-task small, .bot-memory small { color: var(--muted); }
.bot-task, .bot-memory, .bot-result { padding: 18px 0; border-top: 1px solid var(--line); }
.bot-task small, .bot-memory small { display: block; margin: 6px 0; font-size: 11px; }
.bot-task button, .bot-memory button { margin: 4px 6px 0 0; }
.bot-drawer-body details { margin-top: 20px; }
.bot-tool { margin: 12px 0; font-size: 13px; color: var(--muted); }
.bot-page pre, .bot-drawer pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; max-height: 350px; overflow: auto; }
.bot-error { color: #b91c1c; font: 13px/1.6 var(--font-ui); margin: 8px 24px; }
.bot-drawer .bot-error { margin: 0 0 16px; }
.bot-results h3 { font-size: 14px; }
@media (max-width: 640px) { .bot-history { padding: 14px 20px; } .bot-status { display: none; } }
</style>
