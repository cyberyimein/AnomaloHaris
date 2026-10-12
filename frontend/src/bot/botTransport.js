import { ref } from 'vue';
import { createAgentSessionProjection } from '../agent/agentSessionProjection';
export function createBotTransport(management, renderMarkdown) {
    const profile = ref(null);
    const error = ref('');
    const connected = ref(false);
    const messages = ref([]);
    const tasks = ref([]);
    const memories = ref([]);
    const results = ref([]);
    const checkpoint = ref(false);
    const hasEarlier = ref(false);
    const projection = createAgentSessionProjection({ renderMarkdown });
    let timer;
    let closed = false;
    let refreshPromise;
    let activeRun = null;
    let sequence = 0;
    let controller;
    async function request(path, options = {}) {
        return management.requestJson(`/api/bot${path}`, { ...options, ...(controller ? { signal: controller.signal } : {}) });
    }
    function post(path, body = {}) { return request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
    function refresh({ afterCurrent = false } = {}) {
        if (closed) return Promise.resolve();
        if (refreshPromise) {
            return afterCurrent ? refreshPromise.then(() => refresh()) : refreshPromise;
        }
        refreshPromise = fetchState().finally(() => { refreshPromise = null; });
        return refreshPromise;
    }
    async function fetchState() {
        controller = new AbortController();
        try {
            const next = await request('');
            if (closed)
                return;
            if (profile.value && next.revision < profile.value.revision) return;
            profile.value = next;
            let history = await request('/session?limit=500');
            hasEarlier.value = history.total > 500;
            if (hasEarlier.value)
                history = await request(`/session?limit=500&offset=${history.total - 500}`);
            if (closed)
                return;
            checkpoint.value = history.checkpoint;
            const run = history.active_run_id;
            if (activeRun !== run || !run) {
                projection.reset();
                messages.value = history.messages.filter(message => !run || message._runId !== run);
                activeRun = run;
                sequence = 0;
                if (run) {
                    const input = history.requests.find(item => item.run_id === run);
                    if (input)
                        projection.beginUserTurn(input.message);
                }
            }
            if (run) {
                let page;
                do {
                    page = await request(`/runs/${encodeURIComponent(run)}/events?after_sequence=${sequence}&limit=200`);
                    if (closed)
                        return;
                    for (const event of page.events) {
                        if (event.sequence <= sequence)
                            continue;
                        sequence = event.sequence;
                        if (event.type.startsWith('agent.')) {
                            projection.handle({ ...event, schema_version: 1, session_id: history.session_id, type: event.data.original_type || event.type.slice(6) });
                        }
                    }
                } while (page.has_more);
            }
            const [taskData, memoryData, resultData] = await Promise.all([request('/tasks'), request('/memories'), request('/results')]);
            if (closed)
                return;
            tasks.value = taskData.tasks;
            memories.value = memoryData.memories;
            results.value = resultData.results;
            connected.value = true;
            error.value = '';
        }
        catch (cause) {
            if (!closed && cause.name !== 'AbortError') {
                connected.value = false;
                error.value = cause.message;
                management.markError(cause);
            }
        }
        finally {
            controller = null;
        }
    }
    function schedule() {
        if (closed)
            return;
        clearTimeout(timer);
        timer = setTimeout(async () => { await refresh(); schedule(); }, document.hidden ? 15000 : profile.value?.active_run_id ? 1000 : 5000);
    }
    function visibility() { if (!document.hidden) {
        void refresh();
        schedule();
    } }
    function start() { closed = false; void refresh().then(schedule); document.addEventListener('visibilitychange', visibility); }
    function close() { closed = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); projection.clearMarkdownRenderTimers(); }
    async function action(path, body, method = 'POST') {
        try {
            const value = await request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            if (path === "/settings" && typeof value.enabled === "boolean") profile.value = value;
            await refresh();
            return value;
        }
        catch (cause) {
            error.value = cause.message;
            throw cause;
        }
    }
    return { state: { profile, error, connected, messages, tasks, memories, results, checkpoint, hasEarlier }, projection, start, close, refresh, action, request, post };
}
