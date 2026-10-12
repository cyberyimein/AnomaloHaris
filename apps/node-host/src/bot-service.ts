import { randomUUID } from 'node:crypto';
import type { BotSettings, BotTaskInput, BotTask, SessionId, ExecutionRun } from '@anomaloharis/contracts';
import { BotStore, BOT_CLIENT, type BotRequest, type Occurrence } from './bot-store.js';
import { nextScheduledTime, initialDue } from './automation.js';
import { MemoryStore } from './memory.js';
import { Compaction, estimateTokens } from './compaction.js';
import { RunControl, RunControlError, type RunRequest, type RunContext } from './run-control.js';
import type { SessionRepository } from './session.js';
import type { ModelAdapter, ModelUsage, ModelRequest } from './model.js';
import type { AgentRunInput, BuiltContext } from './types.js';
const terminal = (status: string) => ['succeeded', 'failed', 'stopped'].includes(status);
export class BotService {
    readonly store: BotStore;
    readonly memory: MemoryStore;
    readonly compaction: Compaction | undefined;
    private readonly now: () => string;
    private timer: ReturnType<typeof setInterval> | undefined;
    private ticking = false;
    private closing = false;
    private compacting = false;
    private compactAbort: AbortController | undefined;
    private readonly memorySnapshots = new Map<string, string>();
    lastError: string | null = null;
    constructor(readonly options: {
        control: RunControl;
        sessions: SessionRepository;
        defaultModel: string;
        now?: () => string;
        model?: ModelAdapter;
        projectId?: string;
        resolveModel?: (ref: string) => string;
    }) {
        this.now = options.now ?? (() => new Date().toISOString());
        this.store = new BotStore(options.control.db, options.defaultModel, this.now);
        this.memory = new MemoryStore(options.control.db, options.projectId ?? 'workspace', this.now);
        this.compaction = options.model ? new Compaction(options.control.db, options.model, { beforeRequest: request => this.reserveSummaryRequest(request) }) : undefined;
        this.store.db.exec('CREATE TABLE IF NOT EXISTS bot_usage(day TEXT PRIMARY KEY,tokens INTEGER NOT NULL,estimated_tokens INTEGER NOT NULL DEFAULT 0);');
        if (!this.store.db.prepare('PRAGMA table_info(bot_usage)').all().some(row => row.name === 'estimated_tokens')) {
            this.store.db.exec('ALTER TABLE bot_usage ADD COLUMN estimated_tokens INTEGER NOT NULL DEFAULT 0');
        }
        options.control.setAdmission((request, runId) => this.admit(request, runId));
    }
    async initialize(): Promise<void> {
        const p = this.store.profile();
        await this.options.sessions.open(p.main_session_id as SessionId);
        await this.options.sessions.setPresetModel?.(p.main_session_id as SessionId, p.preset_model_ref);
    }
    start(): void {
        if (this.timer)
            return;
        this.timer = setInterval(() => { void this.tick().catch(error => { this.lastError = error instanceof Error ? error.message : String(error); }); }, 5000);
        this.timer.unref();
        void this.tick().catch(error => { this.lastError = String(error); });
    }
    async close(): Promise<void> {
        this.closing = true;
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        this.compactAbort?.abort();
        await Promise.allSettled(this.active().map(run => this.options.control.stop(run.run_id, 'user_stop')));
    }
    active(): ExecutionRun[] {
        return this.store.db.prepare("SELECT run_id FROM execution_runs WHERE client_id=? AND status IN ('queued','running','stopping')").all(BOT_CLIENT).map(x => this.options.control.get(String(x.run_id)));
    }
    ownsSession(id: string): boolean { return this.store.owns(id); }
    assertRun(id: string): ExecutionRun {
        const run = this.options.control.get(id);
        if (run.client_id !== BOT_CLIENT)
            throw new RunControlError(404, 'run_not_found', 'Bot run not found.');
        return run;
    }
    private assertEnabled(): void {
        if (this.closing)
            throw new RunControlError(409, 'bot_stopping', 'Host is shutting down.');
        if (!this.store.profile().enabled)
            throw new RunControlError(409, 'bot_disabled', 'Bot is disabled. Enable it in settings.');
    }
    private admit(request: RunRequest, runId?: string): void {
        const input = request.input as {
            session_id?: string;
            agent_input?: {
                sessionId?: string;
            };
        } | null;
        const sessionIds = [input?.session_id, input?.agent_input?.sessionId];
        if (request.clientId !== BOT_CLIENT) {
            if (sessionIds.some(id => typeof id === 'string' && this.ownsSession(id)))
                throw new RunControlError(403, 'bot_session_owned', 'Bot session must use the Bot entry point.');
            return;
        }
        this.assertEnabled();
        if (typeof request.metadata?.task_id === 'string' && !request.parentRunId) {
            const task = this.store.task(request.metadata.task_id);
            const occurrence = request.idempotency_key ? this.store.occurrenceByKey(request.idempotency_key) : undefined;
            if (!task || (task.status !== 'active' && !(request.idempotency_key?.startsWith('bot:task-resume:') && ['waiting_user', 'completed'].includes(task.status)) && (!occurrence || !this.canDispatchTask(task, occurrence)))) {
                throw new RunControlError(409, 'bot_task_inactive', 'Task was paused or cancelled before execution.');
            }
        }
        if (!request.parentRunId && this.active().some(run => !run.parent_run_id && run.run_id !== runId && run.idempotency_key !== request.idempotency_key)) {
            throw new RunControlError(409, 'bot_busy', 'Another Bot run is active.');
        }
        if (this.usedTokens() >= this.store.profile().limits.daily_tokens)
            throw new RunControlError(409, 'bot_budget_exhausted', 'Bot daily token budget exhausted.');
    }
    async snapshot() {
        await this.initialize();
        const p = this.store.profile();
        const active = this.active();
        let runtime_state = p.enabled ? (active.length || this.compacting ? 'working' : 'idle') : (active.length || this.compacting ? 'stopping' : 'disabled');
        if (p.enabled)
            try {
                this.options.control.runtimes.resolve('preset_model', p.preset_model_ref);
            }
            catch (error) {
                runtime_state = 'degraded';
                this.lastError = String(error);
            }
        return { ...p, runtime_state, active_run_id: active[0]?.run_id ?? null, pending_request: this.store.requests().find(x => x.status === 'pending') ?? null,
            waiting_count: this.store.countTasks('waiting_user'), error: this.lastError,
            budget: { used_tokens: this.usedTokens(), estimated_tokens: Number(this.store.db.prepare('SELECT estimated_tokens FROM bot_usage WHERE day=?').get(this.day())?.estimated_tokens ?? 0), daily_tokens: p.limits.daily_tokens, measurement: 'reported usage plus conservative estimates for summary requests without usage' },
            compactions: this.compaction?.records(p.main_session_id) ?? [] };
    }
    async settings(patch: BotSettings) {
        const before = this.store.profile();
        if (before.revision !== patch.expected_revision)
            throw new RunControlError(409, 'bot_revision_conflict', 'Bot settings changed. Refresh and try again.');
        if (patch.enabled && (!before.enabled && this.active().length || this.compacting))
            throw new RunControlError(409, 'bot_stopping', 'Wait for the current operation to stop.');
        const next = { ...before, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.timezone ? { timezone: patch.timezone } : {}), limits: { ...before.limits, ...patch.limits }, revision: before.revision + 1 };
        new Intl.DateTimeFormat('en', { timeZone: next.timezone }).format();
        const ref = patch.preset_model_ref ?? before.preset_model_ref;
        if (next.enabled || ref !== before.preset_model_ref)
            this.options.control.runtimes.resolve('preset_model', ref);
        if (ref !== before.preset_model_ref) {
            if (before.enabled || this.active().length)
                throw new RunControlError(409, 'bot_model_busy', 'Disable Bot before changing its model.');
            const old = await this.options.sessions.open(before.main_session_id as SessionId);
            if (old.checkpoint)
                throw new RunControlError(409, 'bot_resume_required', 'Resolve the previous checkpoint before changing model.');
            if (this.store.profile().revision !== before.revision)
                throw new RunControlError(409, 'bot_revision_conflict', 'Bot settings changed.');
            next.main_session_id = `bot_${randomUUID()}`;
            next.preset_model_ref = ref;
            this.store.ownSession(next.main_session_id, ref);
        }
        this.store.saveProfile(next);
        if (!next.enabled) {
            this.store.db.prepare("UPDATE bot_requests SET status='cancelled' WHERE status='pending'").run();
            this.compactAbort?.abort();
            for (const run of this.active())
                void this.options.control.stop(run.run_id, 'user_stop').catch(error => { this.lastError = String(error); });
        }
        return this.snapshot();
    }
    async message(id: string, message: string): Promise<BotRequest> {
        const existing = this.store.request(id);
        if (existing) {
            if (existing.message !== message)
                throw new RunControlError(409, 'bot_request_conflict', 'Request ID reused with a different message.');
            return existing;
        }
        this.assertEnabled();
        if (this.compacting || this.store.requests().some(x => x.status === 'pending'))
            throw new RunControlError(409, 'bot_input_pending', 'One message is already pending.');
        const p = this.store.profile();
        if (estimateTokens(message) > p.limits.context_window - Math.max(2048, Math.floor(p.limits.context_window * .15)))
            throw new RunControlError(400, 'bot_input_too_large', 'Message exceeds the configured context budget. Shorten it before sending.');
        if ((await this.options.sessions.open(p.main_session_id as SessionId)).checkpoint)
            throw new RunControlError(409, 'bot_resume_required', 'Resume the interrupted run before sending another message.');
        this.assertEnabled();
        const concurrent = this.store.request(id);
        if (concurrent) {
            if (concurrent.message !== message)
                throw new RunControlError(409, 'bot_request_conflict', 'Request ID reused.');
            return concurrent;
        }
        if (this.store.requests().some(x => x.status === 'pending'))
            throw new RunControlError(409, 'bot_input_pending', 'One message is already pending.');
        this.store.db.prepare("INSERT INTO bot_requests VALUES(?,?,?,'pending',NULL,NULL,?)").run(id, message, p.main_session_id, this.now());
        await this.tick();
        return this.store.request(id)!;
    }
    tasks(): BotTask[] { return this.store.tasks(); }
    createTask(input: BotTaskInput): BotTask {
        if (this.store.countTasks('active') >= 100)
            throw new RunControlError(409, 'bot_task_limit', 'At most 100 active tasks are allowed.');
        return this.store.createTask(input, this.store.profile().preset_model_ref);
    }
    updateTask(id: string, patch: {
        expected_revision: number;
        title?: string;
        prompt?: string;
        schedule?: BotTask['schedule'];
        status?: string;
    }): BotTask {
        const task = this.store.task(id);
        if (!task)
            throw new RunControlError(404, 'task_not_found', 'Task not found.');
        if (task.revision !== patch.expected_revision)
            throw new RunControlError(409, 'task_revision_conflict', 'Task revision changed.');
        const next = { ...task, revision: task.revision + 1 };
        if (patch.title !== undefined)
            next.title = patch.title;
        if (patch.prompt !== undefined)
            next.prompt = patch.prompt;
        if (patch.status)
            next.status = patch.status as BotTask['status'];
        if (patch.schedule) {
            next.schedule = patch.schedule;
            next.schedule_revision++;
            next.next_due_at = initialDue(patch.schedule, this.now());
        }
        if (next.status === 'active' && !next.next_due_at) {
            next.schedule_revision++;
            next.next_due_at = initialDue(next.schedule, this.now());
        }
        this.store.saveTask(next);
        if (next.status === 'cancelled') {
            for (const occurrence of this.store.workOccurrences().filter(row => row.task_id === id && ['pending', 'dispatching'].includes(row.status))) {
                const existing = this.options.control.findRunByKey(BOT_CLIENT, occurrence.dispatch_key);
                this.store.db.prepare('UPDATE automation_occurrences SET status=?,run_id=? WHERE id=?')
                    .run(existing ? 'linked' : 'skipped', existing?.run_id ?? null, occurrence.id);
            }
        }
        return next;
    }
    taskRuns(id: string): Occurrence[] { return this.store.occurrences(id); }
    async runTask(id: string, requestId: string) {
        this.assertEnabled();
        const task = this.store.task(id);
        if (!task)
            throw new RunControlError(404, 'task_not_found', 'Task not found.');
        const key = `bot:manual:${id}:${requestId}`;
        if (task.status === 'cancelled')
            throw new RunControlError(409, 'bot_task_cancelled', 'Reactivate the cancelled task before executing it.');
        if (!this.store.occurrenceByKey(key)) {
            const occurrenceId = randomUUID();
            this.store.db.prepare("INSERT OR IGNORE INTO automation_occurrences VALUES(?,?,?,'pending',?,?,NULL,0)").run(occurrenceId, id, this.now(), key, JSON.stringify({ ...this.occurrenceInput(task, occurrenceId), manualRevision: task.revision }));
        }
        await this.tick();
        return this.store.occurrenceByKey(key)!;
    }
    async resume(requestId: string) {
        this.assertEnabled();
        const old = this.options.control.findRunByKey(BOT_CLIENT, `bot:resume:${requestId}`);
        if (old)
            return { run_id: old.run_id };
        if (this.active().length || this.compacting)
            throw new RunControlError(409, 'bot_busy', 'Bot is busy.');
        const p = this.store.profile();
        if (!(await this.options.sessions.open(p.main_session_id as SessionId)).checkpoint)
            throw new RunControlError(409, 'checkpoint_not_found', 'No checkpoint to resume.');
        const handle = this.options.control.start({ kind: 'preset_model', ref: p.preset_model_ref }, { clientId: BOT_CLIENT, input: { session_id: p.main_session_id, resume: true }, idempotency_key: `bot:resume:${requestId}` });
        return { run_id: handle.runId };
    }
    async resumeTask(taskId: string, runId: string, requestId: string): Promise<{
        run_id: string;
    }> {
        this.assertEnabled();
        const previous = this.assertRun(runId);
        if (!['failed', 'stopped'].includes(previous.status))
            throw new RunControlError(409, 'bot_resume_required', 'Only an interrupted task run can resume.');
        if (previous.metadata?.task_id !== taskId)
            throw new RunControlError(404, 'run_not_found', 'Run does not belong to this task.');
        const key = `bot:task-resume:${taskId}:${requestId}`;
        const existing = this.options.control.findRunByKey(BOT_CLIENT, key);
        if (existing) {
            const id = String(existing.metadata?.occurrence_id);
            this.store.db.prepare("INSERT OR IGNORE INTO automation_occurrences VALUES(?,?,?,'linked',?,NULL,?,0)").run(id, taskId, existing.created_at, key, existing.run_id);
            return { run_id: existing.run_id };
        }
        if (this.active().length || this.compacting)
            throw new RunControlError(409, 'bot_busy', 'Bot is busy.');
        const sessionId = (previous.input as {
            session_id: string;
        }).session_id;
        const snapshot = await this.options.sessions.open(sessionId as SessionId);
        if (!snapshot.checkpoint || snapshot.checkpoint.runId !== runId)
            throw new RunControlError(409, 'checkpoint_not_found', 'No matching checkpoint for this task run.');
        const target = this.options.control.runtimes.resolve('preset_model', previous.target_ref).target;
        if (target.hash !== previous.target_hash)
            throw new RunControlError(409, 'bot_target_changed', 'The task model changed. Start a new attempt instead of resuming the old checkpoint.');
        const task = this.store.task(taskId);
        if (!task || task.status === 'cancelled' || task.status === 'paused')
            throw new RunControlError(409, 'bot_task_inactive', 'Reactivate the task before resuming.');
        const occurrenceId = randomUUID();
        const handle = this.options.control.start({ kind: 'preset_model', ref: previous.target_ref }, { clientId: BOT_CLIENT, input: { session_id: sessionId, resume: true }, metadata: { task_id: taskId, occurrence_id: occurrenceId }, idempotency_key: key });
        this.store.db.prepare("INSERT INTO automation_occurrences VALUES(?,?,?,'linked',?,NULL,?,0)").run(occurrenceId, taskId, this.now(), key, handle.runId);
        return { run_id: handle.runId };
    }
    async tick(): Promise<void> {
        if (this.ticking || this.closing)
            return;
        this.ticking = true;
        try {
            this.reconcile();
            if (!this.store.profile().enabled || this.compacting || this.active().length)
                return;
            const pending = this.store.requests().find(x => x.status === 'pending');
            if (pending) {
                await this.dispatchMessage(pending);
                return;
            }
            this.materializeDue();
            for (const occurrence of this.store.workOccurrences().filter(x => ['pending', 'dispatching'].includes(x.status))) {
                const task = this.store.task(occurrence.task_id);
                if (task && this.canDispatchTask(task, occurrence)) {
                    await this.dispatchOccurrence(occurrence, task);
                    break;
                }
            }
            this.lastError = null;
        }
        finally {
            this.ticking = false;
        }
    }
    private async dispatchMessage(request: BotRequest): Promise<void> {
        const key = `bot:message:${request.id}`;
        try {
            let run = this.options.control.findRunByKey(BOT_CLIENT, key);
            if (!run) {
                const p = this.store.profile();
                await this.options.sessions.open(request.session_id as SessionId);
                this.assertEnabled();
                if (this.store.request(request.id)?.status !== 'pending')
                    return;
                const input = { session_id: request.session_id, message: request.message };
                const handle = this.options.control.start({ kind: 'preset_model', ref: p.preset_model_ref }, { clientId: BOT_CLIENT, input, idempotency_key: key });
                run = this.options.control.get(handle.runId);
            }
            this.store.db.prepare("UPDATE bot_requests SET status='dispatched',run_id=? WHERE id=?").run(run.run_id, request.id);
        }
        catch (error) {
            this.store.db.prepare("UPDATE bot_requests SET status='failed' WHERE id=?").run(request.id);
            this.lastError = String(error);
            throw error;
        }
    }
    private materializeDue(): void {
        const now = this.now();
        for (const task of this.store.dueTasks(now)) {
            if (task.status !== 'active' || !task.next_due_at || task.next_due_at > now)
                continue;
            try {
                this.options.control.runtimes.resolve('preset_model', task.target_ref);
            }
            catch (error) {
                task.status = 'waiting_user';
                task.state = { ...task.state, error: String(error) };
                task.revision++;
                this.store.saveTask(task);
                continue;
            }
            const scheduled = task.next_due_at;
            const key = `bot:task:${task.id}:${task.schedule_revision}:${scheduled}`;
            let missed = 0;
            if (task.schedule.type === 'interval')
                missed = Math.max(0, Math.floor((Date.parse(now) - Date.parse(scheduled)) / (task.schedule.everySeconds * 1000)));
            if (task.schedule.type === 'once' && task.schedule.expiresAt && Date.parse(task.schedule.expiresAt) < Date.parse(now)) {
                task.status = 'completed';
                task.next_due_at = null;
                task.state = { ...task.state, expired: true };
                task.revision++;
                this.store.saveTask(task);
                this.store.db.prepare("INSERT OR IGNORE INTO automation_occurrences VALUES(?,?,?,'skipped',?,NULL,NULL,0)").run(randomUUID(), task.id, scheduled, key);
                continue;
            }
            this.store.db.exec('BEGIN IMMEDIATE');
            try {
                // Only one outstanding occurrence per task; missed ticks coalesce.
                const pending = this.store.outstandingOccurrence(task.id);
                if (!pending) {
                    const id = randomUUID();
                    const frozen = this.occurrenceInput(task, id);
                    this.store.db.prepare("INSERT OR IGNORE INTO automation_occurrences VALUES(?,?,?,'pending',?,?,NULL,?)").run(id, task.id, scheduled, key, JSON.stringify(frozen), missed);
                }
                task.next_due_at = nextScheduledTime(task.schedule, now);
                task.revision++;
                this.store.saveTask(task);
                this.store.db.exec('COMMIT');
            }
            catch (error) {
                this.store.db.exec('ROLLBACK');
                throw error;
            }
        }
    }
    private occurrenceInput(task: BotTask, id: string): {
        input: unknown;
        targetHash: string;
    } {
        const target = this.options.control.runtimes.resolve('preset_model', task.target_ref).target;
        const sessionId = task.session_policy === 'persistent' ? `bot_task_${task.id}` : `bot_occurrence_${id}`;
        this.store.ownSession(sessionId, task.target_ref);
        return { targetHash: target.hash, input: { session_id: sessionId, message: `Scheduled task: ${task.title}\n${task.prompt}\nCurrent task state: ${JSON.stringify(task.state)}\nUse bot_task_update to record progress and whether a meaningful notification is needed.` } };
    }
    private canDispatchTask(task: BotTask, occurrence: Occurrence): boolean {
        if (task.status === 'cancelled')
            return false;
        if (task.status === 'active')
            return true;
        if (!occurrence.dispatch_key.startsWith('bot:manual:') || !occurrence.request_json)
            return false;
        const frozen = JSON.parse(occurrence.request_json) as {
            manualRevision?: number;
        };
        return frozen.manualRevision === task.revision;
    }
    private async dispatchOccurrence(occurrence: Occurrence, task: BotTask): Promise<void> {
        try {
            let run = this.options.control.findRunByKey(BOT_CLIENT, occurrence.dispatch_key);
            if (!run) {
                let frozen = occurrence.request_json ? JSON.parse(occurrence.request_json) as {
                    input: unknown;
                    targetHash: string;
                } : null;
                const target = this.options.control.runtimes.resolve('preset_model', task.target_ref).target;
                if (frozen && frozen.targetHash !== target.hash)
                    throw new RunControlError(409, 'bot_target_changed', 'Task model changed after the occurrence was prepared.');
                if (!frozen) {
                    const sessionId = task.session_policy === 'persistent' ? `bot_task_${task.id}` : `bot_occurrence_${occurrence.id}`;
                    this.store.ownSession(sessionId, task.target_ref);
                    frozen = { input: { session_id: sessionId, message: `Scheduled task: ${task.title}\n${task.prompt}\nCurrent task state: ${JSON.stringify(task.state)}\nUse bot_task_update to record progress and whether a meaningful notification is needed.` }, targetHash: target.hash };
                    this.store.db.prepare("UPDATE automation_occurrences SET status='dispatching',request_json=? WHERE id=?").run(JSON.stringify(frozen), occurrence.id);
                }
                const input = frozen.input as {
                    session_id: string;
                };
                await this.options.sessions.open(input.session_id as SessionId);
                if ((await this.options.sessions.open(input.session_id as SessionId)).checkpoint)
                    throw new RunControlError(409, 'bot_resume_required', 'Task has an interrupted checkpoint. Inspect it before rerunning.');
                this.assertEnabled();
                // Final synchronous check: no awaits between this and RunControl.start().
                const currentTask = this.store.task(task.id);
                const currentOccurrence = this.store.occurrenceByKey(occurrence.dispatch_key);
                if (!currentTask || !currentOccurrence || !['pending', 'dispatching'].includes(currentOccurrence.status)
                    || !this.canDispatchTask(currentTask, currentOccurrence))
                    return;
                if (this.options.control.runtimes.resolve('preset_model', task.target_ref).target.hash !== frozen.targetHash)
                    throw new RunControlError(409, 'bot_target_changed', 'Task model changed before dispatch.');
                const handle = this.options.control.start({ kind: 'preset_model', ref: task.target_ref }, { clientId: BOT_CLIENT, input: frozen.input, metadata: { task_id: task.id, occurrence_id: occurrence.id }, idempotency_key: occurrence.dispatch_key });
                run = this.options.control.get(handle.runId);
            }
            this.store.db.prepare("UPDATE automation_occurrences SET status='linked',run_id=? WHERE id=?").run(run.run_id, occurrence.id);
        }
        catch (error) {
            const latest = this.store.task(task.id);
            if (latest && !['cancelled', 'paused'].includes(latest.status)) {
                latest.status = 'waiting_user';
                latest.state = { ...latest.state, error: String(error) };
                latest.revision++;
                this.store.saveTask(latest);
            }
            this.store.db.prepare("UPDATE automation_occurrences SET status='failed' WHERE id=? AND status IN ('pending','dispatching')").run(occurrence.id);
            this.lastError = String(error);
        }
    }
    private reconcile(): void {
        for (const id of this.memorySnapshots.keys()) {
            if (terminal(this.options.control.get(id).status))
                this.memorySnapshots.delete(id);
        }
        for (const occurrence of this.store.workOccurrences().filter(x => x.run_id && x.status === 'linked')) {
            const run = this.options.control.get(occurrence.run_id!);
            if (!terminal(run.status))
                continue;
            const task = this.store.task(occurrence.task_id);
            if (!task)
                continue;
            const update = this.store.db.prepare('SELECT state_json FROM bot_task_updates WHERE run_id=?').get(run.run_id);
            const state = update ? JSON.parse(String(update.state_json)) : null;
            if (state)
                task.state = state;
            const userSuspended = ['cancelled', 'paused'].includes(task.status);
            if (run.status === 'succeeded') {
                task.consecutive_failures = 0;
                if (!userSuspended && state?.waiting_user)
                    task.status = 'waiting_user';
                else if (!userSuspended && (state?.completed || task.schedule.type === 'once' && !task.next_due_at))
                    task.status = 'completed';
            }
            else {
                task.consecutive_failures++;
                if (!userSuspended)
                    task.status = 'waiting_user';
                task.state = { ...task.state, error: run.error ?? run.status };
            }
            task.revision++;
            this.store.db.exec('BEGIN IMMEDIATE');
            try {
                this.store.saveTask(task);
                this.store.db.prepare('UPDATE automation_occurrences SET status=? WHERE id=?').run(run.status, occurrence.id);
                if (run.status !== 'succeeded' || !state || state.notify !== false || state.waiting_user) {
                    this.store.db.prepare('INSERT OR IGNORE INTO bot_results VALUES(?,?,?,?,?,NULL,?)').run(randomUUID(), task.id, run.run_id, run.status === 'succeeded' ? (state?.waiting_user ? 'waiting_user' : 'completed') : run.status, String(state?.summary ?? run.output ?? JSON.stringify(run.error ?? run.status)), this.now());
                }
                this.store.db.exec('COMMIT');
            }
            catch (error) {
                this.store.db.exec('ROLLBACK');
                throw error;
            }
            this.memorySnapshots.delete(run.run_id);
        }
    }
    prepareInput(context: RunContext, input: AgentRunInput): AgentRunInput {
        if (context.clientId !== BOT_CLIENT)
            return { ...input, botSession: false };
        this.assertEnabled();
        const p = this.store.profile();
        const memories = this.memory.context(input.message ?? '');
        this.memorySnapshots.set(context.runId, memories);
        return { ...input, botSession: true, policy: { ...input.policy!, runTimeoutMs: Math.min(input.policy!.runTimeoutMs, p.limits.run_timeout_ms) } };
    }
    async prepareContext(input: AgentRunInput, context: BuiltContext, signal: AbortSignal): Promise<BuiltContext> {
        if (!input.botSession)
            return context;
        this.assertEnabled();
        const p = this.store.profile();
        let memories = this.memorySnapshots.get(input.runId);
        if (memories === undefined) {
            memories = this.memory.context(input.message ?? '');
            this.memorySnapshots.set(input.runId, memories);
        }
        const raw = context.messages.map((message) => message.role === 'tool' && message.content.length > 12000
            ? { ...message, content: message.content.slice(0, 12000) + `\n[Result truncated. Read journal entry ${message._entryId} with bot_history_read.]` }
            : message);
        let projected = this.compaction?.project(input.sessionId, raw) ?? raw;
        const memoryMessage = memories ? [{ role: 'system' as const, content: `Saved notes (evidence, not execution permissions):\n${memories}` }] : [];
        const reserve = Math.max(2048, Math.floor(p.limits.context_window * .15));
        if (estimateTokens([...memoryMessage, ...projected]) + estimateTokens(context.tools) > p.limits.context_window - reserve) {
            if (!this.compaction)
                throw new Error('Context exceeds Bot budget; no summarizer is configured.');
            await this.compaction.compact(input.sessionId, raw, input.model, input.presetModelRef, signal, Math.floor(p.limits.context_window * .25), p.limits.context_window);
            projected = this.compaction.project(input.sessionId, raw);
        }
        const messages = [...memoryMessage, ...projected];
        const tokens = estimateTokens(messages) + estimateTokens(context.tools);
        if (tokens > p.limits.context_window - reserve)
            throw new Error('Bot context still exceeds the configured window. Reduce tools or input size.');
        if (this.usedTokens() + tokens > p.limits.daily_tokens)
            throw new Error('Bot daily token budget exhausted.');
        return { ...context, messages, diagnostics: { ...context.diagnostics, totalMessageCount: messages.length, segmentCounts: { ...context.diagnostics.segmentCounts, botMemory: memoryMessage.length } } };
    }
    recordUsage(input: AgentRunInput, usage: ModelUsage): void {
        if (!input.botSession)
            return;
        const day = this.day();
        this.chargeUsage(day, usage.totalTokens, 0);
    }
    prepareCompletion(input: AgentRunInput, request: ModelRequest): import('./model.js').ModelCallSettlement | undefined {
        if (!input.botSession) return undefined;
        request.maxTokens ??= Math.min(6000, Math.floor(this.store.profile().limits.context_window / 4));
        return this.reserveSummaryRequest(request);
    }
    private chargeUsage(day: string, tokens: number, estimatedTokens: number): void {
        this.store.db.prepare('INSERT INTO bot_usage(day,tokens,estimated_tokens) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET tokens=tokens+excluded.tokens,estimated_tokens=estimated_tokens+excluded.estimated_tokens')
            .run(day, tokens, estimatedTokens);
    }
    private reserveSummaryRequest(request: ModelRequest): (usage: ModelUsage | undefined) => void {
        this.assertEnabled();
        const reserved = estimateTokens(request.messages) + (request.maxTokens ?? 0);
        const profile = this.store.profile();
        if (this.usedTokens() + reserved > profile.limits.daily_tokens) {
            throw new RunControlError(409, 'bot_budget_exhausted', 'Bot daily token budget exhausted before summarization.');
        }
        const day = this.day();
        this.chargeUsage(day, reserved, reserved);
        let settled = false;
        return usage => {
            if (settled)
                throw new Error('Summary usage was settled twice.');
            settled = true;
            if (usage && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) {
                this.chargeUsage(day, usage.totalTokens - reserved, -reserved);
            }
        };
    }
    private day(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: this.store.profile().timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(this.now())); }
    private usedTokens(): number { return Number(this.store.db.prepare('SELECT tokens FROM bot_usage WHERE day=?').get(this.day())?.tokens ?? 0); }
    async compactMain(): Promise<void> {
        this.assertEnabled();
        if (!this.compaction)
            throw new RunControlError(503, 'bot_capability_unavailable', 'Summarizer is not configured.');
        if (this.active().length || this.compacting || this.ticking)
            throw new RunControlError(409, 'bot_busy', 'Stop the run before manual compaction.');
        this.compacting = true;
        this.compactAbort = new AbortController();
        try {
            const p = this.store.profile();
            const snapshot = await this.options.sessions.open(p.main_session_id as SessionId);
            if (snapshot.checkpoint)
                throw new RunControlError(409, 'bot_resume_required', 'Resume the checkpoint first.');
            const target = this.options.control.runtimes.resolve('preset_model', p.preset_model_ref);
            const model = this.options.resolveModel?.(p.preset_model_ref) ?? this.options.model!.model;
            const journal = await this.options.sessions.journal?.(p.main_session_id as SessionId) ?? snapshot.messages;
            const keepTokens = Math.min(Math.floor(p.limits.context_window * .25), Math.max(1, Math.floor(estimateTokens(journal) * .25)));
            await this.compaction.compact(p.main_session_id, journal, model, target.target.ref, this.compactAbort.signal, keepTokens, p.limits.context_window);
        }
        finally {
            this.compacting = false;
            this.compactAbort = undefined;
        }
    }
    taskUpdate(runId: string, state: Record<string, unknown>): void {
        const run = this.assertRun(runId);
        if (!run.metadata?.task_id)
            throw new RunControlError(400, 'task_context_required', 'This run is not a scheduled task.');
        this.store.db.prepare('INSERT INTO bot_task_updates VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET state_json=excluded.state_json').run(runId, String(run.metadata.task_id), JSON.stringify(state));
    }
}
