import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCore } from './core.js';
import { RunController } from './controller.js';
import { AgentRuntimeAdapter } from './agent-runtime-adapter.js';
import { SqlitePresetModelRegistry } from './preset-models.js';
import { SqliteSessionAdapter } from './sqlite.js';
import { builtinPluginCatalog } from './plugin-catalog.js';
import { CompositeToolRuntime, asToolAdapter } from './tools.js';
import { BotToolRuntime } from './bot-tools.js';
import { BotService } from './bot-service.js';
import { RunControl, type ExecutionRuntimeAdapter, type RuntimeEvent } from './run-control.js';
import { RuntimeCatalog } from './runtime-catalog.js';
import { InMemorySessionAdapter } from './session.js';
import { Compaction } from './compaction.js';
import { ReplayModelAdapter, type ModelAdapter, type ModelRequest } from './model.js';
import type { SessionId, AgentRunInput } from './types.js';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0))
    if (db.isOpen)
        db.close(); });
function database() { const db = new DatabaseSync(':memory:'); databases.push(db); return db; }
async function finish(control: RunControl, id: string) { for await (const _ of control.events(id)) { } }
function schedulerFixture(model?: ModelAdapter, resolveModel?: (ref: string) => string) {
    const catalog = new RuntimeCatalog();
    const starts: string[] = [];
    const adapter: ExecutionRuntimeAdapter = {
        kind: 'preset_model', version: 'test', packageHash: 'test', capabilities: [], consumesHostSlot: true,
        isHealthy: () => true, resolve: ref => ({ kind: 'preset_model', ref, hash: 'test' }), stop: () => { },
        async *start(context): AsyncIterable<RuntimeEvent> { starts.push(context.runId); yield { type: 'agent.run.finished', terminal: 'succeeded', data: { output: 'done' } }; },
    };
    catalog.register(adapter);
    const control = new RunControl(database(), catalog);
    const sessions = new InMemorySessionAdapter();
    const bot = new BotService({ control, sessions, defaultModel: 'anomaloharis@1', ...(model ? { model } : {}), ...(resolveModel ? { resolveModel } : {}), now: () => '2026-10-10T00:00:00.000Z' });
    return { bot, control, sessions, starts };
}
it('keeps the new Run identity through two real SQLite task resumes and progress writes', async () => {
    const sessions = new SqliteSessionAdapter(':memory:', { database: database() });
    const registry = new SqlitePresetModelRegistry(':memory:', { database: database(), catalog: builtinPluginCatalog() });
    const base = registry.ensureBuiltinDefault({ model: 'replay-model' });
    const definition = structuredClone(base.definition);
    definition.name = 'resume-regression';
    definition.plugins = { fixed: ['bot-tools'] };
    const preset = registry.publish(registry.createDraft(definition).ref);
    const model = new ReplayModelAdapter([
        [{ type: 'text.delta', text: 'first interrupted' }, { type: 'done' }],
        [{ type: 'text.delta', text: 'second interrupted' }, { type: 'done' }],
        [{ type: 'tool.calls', calls: [{ id: 'progress', name: 'bot_task_update', arguments: { summary: 'progress belongs to this attempt', notify: false } }] }],
        [{ type: 'text.delta', text: 'done' }, { type: 'done' }],
    ]);
    let bot!: BotService;
    const tools = new CompositeToolRuntime([asToolAdapter('bot-tools', 100, new BotToolRuntime(() => bot))]);
    const core = new AgentCore({ model, sessions, tools, prepareModelContext: async (input, context, signal) => {
            const result = await bot.prepareContext(input, context, signal);
            if (abortNext) {
                abortNext = false;
                void control.stop(input.runId, 'user_stop');
            }
            return result;
        } });
    const catalog = new RuntimeCatalog();
    catalog.register(new AgentRuntimeAdapter({ registry, controller: new RunController(core), prepareInput: (context, input) => bot.prepareInput(context, input) }));
    const control = new RunControl(database(), catalog);
    bot = new BotService({ control, sessions, defaultModel: preset.ref, model });
    let abortNext = true;
    await bot.settings({ expected_revision: 1, enabled: true });
    const task = bot.createTask({ title: 'resume repeatedly', prompt: 'keep checking', schedule: { type: 'once', at: '2026-01-01T00:00:00Z' } });
    await bot.tick();
    const original = bot.taskRuns(task.id)[0]!.run_id!;
    await finish(control, original);
    await bot.tick();
    expect(control.get(original).status).toBe('stopped');
    const completedTask = bot.store.task(task.id)!;
    bot.store.saveTask({...completedTask, status: 'completed'});
    abortNext = true;
    const first = await bot.resumeTask(task.id, original, 'first-resume');
    await finish(control, first.run_id);
    await bot.tick();
    expect((await sessions.open((control.get(first.run_id).input as {
        session_id: string;
    }).session_id as SessionId)).checkpoint?.runId).toBe(first.run_id);
    const {default: Fastify} = await import('fastify');
    const {registerBotRoutes} = await import('./bot-api.js');
    const app = Fastify(); registerBotRoutes(app, bot);
    try {
        const response = await app.inject(`/api/bot/tasks/${task.id}/runs`);
        const rows = response.json().runs as Array<{run_id:string;can_resume:boolean}>;
        expect(rows.find(row => row.run_id === original)?.can_resume).toBe(false);
        expect(rows.find(row => row.run_id === first.run_id)?.can_resume).toBe(true);
    } finally { await app.close(); }

    const second = await bot.resumeTask(task.id, first.run_id, 'second-resume');
    await finish(control, second.run_id);
    await bot.tick();
    expect(control.get(second.run_id).status).toBe('succeeded');
    expect(control.eventsSnapshot(second.run_id).filter(x => x.type.startsWith('agent.')).every(x => x.run_id === second.run_id)).toBe(true);
    expect(bot.store.db.prepare('SELECT run_id FROM bot_task_updates').all()).toEqual([{ run_id: second.run_id }]);
    const session = (control.get(second.run_id).input as {
        session_id: string;
    }).session_id as SessionId;
    expect((await sessions.open(session)).checkpoint).toBeUndefined();
    expect(sessions.db.prepare('SELECT run_id FROM run_checkpoints WHERE session_id=?').all(session)).toEqual([]);
});
it.each(['cancelled', 'paused'] as const)('does not dispatch after %s while Session initialization is awaiting', async (status) => {
    const { bot, sessions, starts } = schedulerFixture();
    await bot.settings({ expected_revision: 1, enabled: true });
    const task = bot.createTask({ title: 'cancel race', prompt: 'check', schedule: { type: 'once', at: '2026-10-10T00:00:00Z' } });
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const open = sessions.open.bind(sessions);
    sessions.open = async (id) => { if (id.startsWith('bot_occurrence_')) {
        entered();
        await gate;
    } return open(id); };
    const tick = bot.tick();
    await waiting;
    bot.updateTask(task.id, { expected_revision: bot.store.task(task.id)!.revision, status });
    release();
    await tick;
    expect(starts).toEqual([]);
    expect(bot.store.task(task.id)?.status).toBe(status);
});
it('does not consume a cancelled manual wake-up even if Bot is subsequently re-enabled', async () => {
    const { bot, starts } = schedulerFixture();
    await bot.settings({ expected_revision: 1, enabled: true });
    const task = bot.createTask({ title: 'manual', prompt: 'check', schedule: { type: 'once', at: '2099-01-01T00:00:00Z' } });
    bot.store.db.prepare("INSERT INTO automation_occurrences VALUES('manual-pending',?,?,'pending','bot:manual:pending',NULL,NULL,0)").run(task.id, '2026-10-10T00:00:00Z');
    bot.updateTask(task.id, { expected_revision: task.revision, status: 'cancelled' });
    await bot.tick();
    expect(starts).toEqual([]);
});
it('includes long user-message tails and complete tool arguments in bounded summary requests', async () => {
    const marker = 'DO_NOT_DELETE_THE_PRODUCTION_DATABASE';
    const calls: ModelRequest[] = [];
    const model: ModelAdapter = { model: 'summary', async *stream() { }, async complete(request) { calls.push(request); return JSON.stringify(request.messages).includes(marker) ? marker : 'Keep the task goal.'; } };
    const compact = new Compaction(database(), model);
    const messages = [
        { role: 'user' as const, content: 'head '.repeat(8000) + marker, _entryId: 'long-user' },
        { role: 'assistant' as const, content: '', tool_calls: [{ id: 'call', name: 'read', arguments: { content: 'x'.repeat(8000) + marker } }], _entryId: 'call-entry' },
        { role: 'tool' as const, content: 'done', tool_call_id: 'call', _entryId: 'result' },
        { role: 'user' as const, content: 'next', _entryId: 'latest' },
    ];
    await compact.compact('long', messages, 'summary', undefined, new AbortController().signal, 10, 8192);
    expect(calls.map(x => JSON.stringify(x.messages)).join('')).toContain(marker);
    const fragments = calls.flatMap(request => JSON.parse(request.messages[1]!.content).transcript as Array<{
        entry_id: string;
        offset: number;
        text: string;
    }>);
    const restore = (id: string) => JSON.parse(fragments.filter(part => part.entry_id === id).sort((a, b) => a.offset - b.offset).map(part => part.text).join(''));
    expect(restore('long-user').content).toBe(messages[0]!.content);
    expect(restore('call-entry').tool_calls[0].arguments.content).toBe('x'.repeat(8000) + marker);
    expect(compact.project('long', messages)[0]?.content).toContain(marker);
    expect(calls.every(x => JSON.stringify(x.messages).length < 14000)).toBe(true);
});
async function journalForCompaction(bot: BotService, sessions: InMemorySessionAdapter) {
    const profile = await bot.snapshot();
    let parent: string | undefined;
    for (let index = 0; index < 4; index++) {
        const entry = `budget-entry-${index}`;
        await sessions.append([{ entryId: entry as any, sessionId: profile.main_session_id as SessionId, ...(parent ? { parentEntryId: parent as any } : {}), kind: 'message', role: index % 2 ? 'assistant' : 'user', payload: { content: `message ${index} ` + 'x'.repeat(2500) }, createdAt: '2026-10-10T00:00:00Z' }]);
        parent = entry;
    }
    return { profile, messages: await sessions.journal(profile.main_session_id as SessionId) };
}
it.each(['manual', 'automatic'])('blocks %s compaction before inference when daily quota is exhausted', async (mode) => {
    const model = new ReplayModelAdapter([], { completions: ['summary'] });
    const { bot, sessions } = schedulerFixture(model);
    await bot.settings({ expected_revision: 1, enabled: true, limits: { context_window: 4096 } });
    const { profile, messages } = await journalForCompaction(bot, sessions);
    bot.recordUsage({ botSession: true } as AgentRunInput, { promptTokens: 200000, completionTokens: 0, totalTokens: 200000 });
    if (mode === 'manual')
        await expect(bot.compactMain()).rejects.toThrow('budget');
    else
        await expect(bot.prepareContext({ botSession: true, runId: 'budget', sessionId: profile.main_session_id, message: 'next', model: 'summary' } as AgentRunInput, { messages, tools: [], diagnostics: { profile: 'agent', model: 'summary', searchMode: 'diy', segmentCounts: {}, totalMessageCount: messages.length, toolCount: 0 } }, new AbortController().signal)).rejects.toThrow('budget');
    expect(model.completeCalls).toHaveLength(0);
});
it('retains per-call usage if a later summary batch fails', async () => {
    let completeCalls = 0;
    const model: ModelAdapter = { model: 'summary', async *stream() { }, async complete() { if (++completeCalls === 1)
            return { text: 'summary', usage: { promptTokens: 111, completionTokens: 12, totalTokens: 123 } }; throw new Error('later summary failed'); } };
    const { bot, sessions } = schedulerFixture(model);
    await bot.settings({ expected_revision: 1, enabled: true, limits: { context_window: 4096 } });
    await journalForCompaction(bot, sessions);
    await expect(bot.compactMain()).rejects.toThrow('later summary failed');
    expect((await bot.snapshot()).budget.used_tokens).toBeGreaterThanOrEqual(123);
    expect(bot.compaction!.records((await bot.snapshot()).main_session_id)).toEqual([]);
});
it('dispatches an older active task beyond the UI history limit', async () => {
    const { bot, control } = schedulerFixture();
    await bot.settings({ expected_revision: 1, enabled: true });
    const old = bot.createTask({ title: 'old active', prompt: 'check', schedule: { type: 'once', at: '2026-10-10T00:00:00Z' } });
    for (let i = 0; i < 510; i++) {
        const task = bot.createTask({ title: `archive-${i}`, prompt: 'history', schedule: { type: 'once', at: '2099-01-01T00:00:00Z' } });
        bot.updateTask(task.id, { expected_revision: task.revision, status: 'cancelled' });
    }
    await bot.tick();
    const run = bot.taskRuns(old.id)[0]?.run_id;
    expect(run).toBeTruthy();
    if (run)
        await finish(control, run);
});
it('reconciles and finds a pending occurrence beyond the UI occurrence limit', async () => {
    const { bot, control } = schedulerFixture();
    await bot.settings({ expected_revision: 1, enabled: true });
    const task = bot.createTask({ title: 'old pending', prompt: 'check', schedule: { type: 'once', at: '2099-01-01T00:00:00Z' } });
    bot.store.db.prepare("INSERT INTO automation_occurrences VALUES('old-pending',?,?,'pending','old-key',NULL,NULL,0)").run(task.id, '2026-10-10T00:00:00Z');
    const insert = bot.store.db.prepare("INSERT INTO automation_occurrences VALUES(?,?,?,'succeeded',?,NULL,NULL,0)");
    for (let i = 0; i < 1010; i++)
        insert.run(`archived-${i}`, task.id, '2026-10-10T00:00:00Z', `archive-key-${i}`);
    await bot.tick();
    const row = bot.store.db.prepare("SELECT run_id FROM automation_occurrences WHERE id='old-pending'").get()!;
    expect(row.run_id).toBeTruthy();
    if (row.run_id)
        await finish(control, String(row.run_id));
    await bot.tick();
    expect(bot.store.db.prepare("SELECT status FROM automation_occurrences WHERE id='old-pending'").get()?.status).toBe('succeeded');
});
it('checks the remaining quota again before every summary batch', async () => {
    let calls = 0;
    const model: ModelAdapter = { model: 'summary', async *stream() { }, async complete() { calls++; return { text: 'summary', usage: { promptTokens: 2800, completionTokens: 100, totalTokens: 2900 } }; } };
    const { bot, sessions } = schedulerFixture(model);
    await bot.settings({ expected_revision: 1, enabled: true, limits: { context_window: 4096, daily_tokens: 3000 } });
    await journalForCompaction(bot, sessions);
    await expect(bot.compactMain()).rejects.toThrow('budget');
    expect(calls).toBe(1);
    expect((await bot.snapshot()).budget.used_tokens).toBe(2900);
    expect((await bot.snapshot()).budget.estimated_tokens).toBe(0);
    expect(bot.compaction!.records((await bot.snapshot()).main_session_id)).toHaveLength(0);
});
it('accounts for an invalid empty summary before rejecting its projection', async () => {
    const model: ModelAdapter = { model: 'summary', async *stream() { }, async complete() { return { text: '', usage: { promptTokens: 120, completionTokens: 3, totalTokens: 123 } }; } };
    const { bot, sessions } = schedulerFixture(model);
    await bot.settings({ expected_revision: 1, enabled: true, limits: { context_window: 4096 } });
    await journalForCompaction(bot, sessions);
    await expect(bot.compactMain()).rejects.toThrow('empty');
    expect((await bot.snapshot()).budget.used_tokens).toBe(123);
    expect((await bot.snapshot()).budget.estimated_tokens).toBe(0);
});
it('passes the summary output limit through the actual provider adapter', async () => {
    const { OpenAICompatibleAdapter } = await import('./model.js');
    let payload: any;
    const adapter = new OpenAICompatibleAdapter({ model: 'summary', baseUrl: 'https://example.test/v1', apiKey: 'test-only', toolProtocol: 'none', fetchImpl: (async (_url, init) => {
            payload = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ choices: [{ message: { content: 'summary' } }] }), { status: 200 });
        }) as typeof fetch });
    await adapter.complete({ model: 'summary', maxTokens: 512, tools: [], messages: [{ role: 'user', content: 'summarize' }] }, new AbortController().signal);
    expect(payload.max_tokens).toBe(512);
});

it('recovers an explicitly requested paused-task run with its original admission context', async () => {
  const { bot, control, starts } = schedulerFixture();
  await bot.settings({ expected_revision: 1, enabled: true });
  const task = bot.createTask({ title: 'manual recovery', prompt: 'check', schedule: { type: 'once', at: '2099-01-01T00:00:00Z' } });
  const paused = bot.updateTask(task.id, { expected_revision: task.revision, status: 'paused' });
  bot.store.ownSession('bot_manual_recovery', task.target_ref);
  const key = 'bot:manual:recover';
  const input = { session_id: 'bot_manual_recovery', message: 'explicit manual check' };
  bot.store.db.prepare("INSERT INTO automation_occurrences VALUES('recover-occurrence',?,?,'linked',?,?,'recover-run',0)")
    .run(task.id, '2026-10-10T00:00:00Z', key, JSON.stringify({ input, targetHash: 'test', manualRevision: paused.revision }));
  bot.store.db.prepare(`INSERT INTO execution_runs(run_id,runtime_kind,target_ref,target_hash,runtime_adapter_version,runtime_adapter_hash,client_id,status,input_json,metadata_json,idempotency_key,request_hash,created_at)
    VALUES('recover-run','preset_model',?,'test','test','test','local-bot','queued',?,?,?,'hash','2026-10-10T00:00:00Z')`)
    .run(task.target_ref, JSON.stringify(input), JSON.stringify({ task_id: task.id, occurrence_id: 'recover-occurrence' }), key);
  await control.recover(); await finish(control, 'recover-run'); await bot.tick();
  expect(starts).toEqual(['recover-run']);
  expect(control.get('recover-run').status).toBe('succeeded');
  expect(bot.store.task(task.id)?.status).toBe('paused');
});

it.each(['sqlite','memory'])('rejects a stale checkpoint transfer without changing ownership (%s)', async backend => {
  const sessions = backend === 'sqlite' ? new SqliteSessionAdapter(':memory:', {database: database()}) : new InMemorySessionAdapter();
  const sessionId = 'transfer-session' as SessionId;
  await sessions.beginRun({runId: 'current' as any, sessionId, status: 'active', config: {}, startedAt: '2026-10-10T00:00:00Z'});
  await sessions.checkpoint({runId: 'current' as any, sessionId, reason: 'stopped', iteration: 1, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', state: {
    promptProfile: 'agent', originalUserContent: 'check', currentUserMessage: {role: 'user', content: 'check'}, assistantText: '', pendingToolCalls: [], completedToolCallIds: [], loopMessages: [], bootstrapContext: [], searchMode: 'diy',
  }});
  await expect(sessions.beginRun({runId: 'stale-new' as any, resumedFromRunId: 'not-current' as any, sessionId, status: 'active', config: {}, startedAt: '2026-10-10T00:01:00Z'})).rejects.toThrow('checkpoint_resume_conflict');
  expect((await sessions.resume(sessionId)).runId).toBe('current');
  if (sessions instanceof SqliteSessionAdapter) expect(sessions.db.prepare("SELECT run_id FROM runs WHERE run_id='stale-new'").get()).toBeUndefined();
});

it('uses the selected Preset Model name for manual compaction instead of the global default', async () => {
  const model = new ReplayModelAdapter([], { model: 'global-default', completions: Array(40).fill('summary') });
  const { bot, sessions } = schedulerFixture(model, () => 'selected-provider-model');
  await bot.settings({ expected_revision: 1, enabled: true, limits: {context_window: 4096} });
  await journalForCompaction(bot, sessions);
  await bot.compactMain();
  expect(model.completeCalls.every(request => request.model === 'selected-provider-model')).toBe(true);
});
it('blocks structured finalization after the streamed draft exhausts the Bot budget', async () => {
  const model = new ReplayModelAdapter([[
    {type: 'text.delta', text: 'draft'}, {type: 'usage', usage: {promptTokens: 900, completionTokens: 100, totalTokens: 1000}}, {type: 'done'},
  ]], {completions: ['{}']});
  const { bot, sessions } = schedulerFixture(model);
  await bot.settings({expected_revision: 1, enabled: true, limits: {daily_tokens: 1000}});
  const profile = await bot.snapshot();
  const core = new AgentCore({model, sessions, tools: new CompositeToolRuntime([]),
    prepareModelContext: (input,context,signal) => bot.prepareContext(input,context,signal),
    onUsage: (input,usage) => bot.recordUsage(input,usage),
    beforeComplete: (input,request) => bot.prepareCompletion(input,request),
  });
  const events = [];
  for await (const event of core.execute({sessionId: profile.main_session_id,runId: 'finalizer-budget',botSession: true,message: 'produce JSON',resume: false,promptProfile: 'agent',model: 'replay-model',searchMode: 'diy',responseFormat: {type:'json_object'}} as AgentRunInput,new AbortController().signal)) events.push(event);
  expect(model.completeCalls).toHaveLength(0);
  expect(events.at(-1)?.type).toBe('run.error');
});
