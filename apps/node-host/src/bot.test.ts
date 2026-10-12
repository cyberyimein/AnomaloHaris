import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BotService } from './bot-service.js';
import { RuntimeCatalog } from './runtime-catalog.js';
import { RunControl, type ExecutionRuntimeAdapter, type RuntimeEvent } from './run-control.js';
import { InMemorySessionAdapter } from './session.js';
import { nextScheduledTime } from './automation.js';
import { MemoryStore } from './memory.js';
import { Compaction } from './compaction.js';
import { ReplayModelAdapter } from './model.js';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0))
    if (db.isOpen)
        db.close(); });
function db(path = ':memory:') { const d = new DatabaseSync(path); databases.push(d); return d; }
function setup(path = ':memory:') {
    const database = db(path);
    const catalog = new RuntimeCatalog();
    const starts: string[] = [];
    const adapter: ExecutionRuntimeAdapter = {
        kind: 'preset_model', version: 'test', packageHash: 'sha256:test', capabilities: [], consumesHostSlot: true,
        isHealthy: () => true, resolve: (ref) => ({ kind: 'preset_model', ref, hash: 'sha256:test' }), stop: () => { },
        async *start(ctx): AsyncIterable<RuntimeEvent> { starts.push(ctx.runId); yield { type: 'agent.run.finished', data: { output: 'done', usage: { totalTokens: 10 } }, terminal: 'succeeded' }; },
    };
    catalog.register(adapter);
    const control = new RunControl(database, catalog);
    const sessions = new InMemorySessionAdapter();
    let now = new Date('2026-10-10T00:00:00Z');
    const bot = new BotService({ control, sessions, defaultModel: 'anomaloharis@1', now: () => now.toISOString() });
    return { bot, control, database, starts, sessions, advance: (seconds: number) => { now = new Date(+now + seconds * 1000); } };
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 10)); }
describe('Bot lifecycle and dispatch', () => {
    it('is disabled by default, keeps one identity and rejects execution while disabled', async () => {
        const { bot } = setup();
        const first = await bot.snapshot();
        expect(first.enabled).toBe(false);
        expect((await bot.snapshot()).main_session_id).toBe(first.main_session_id);
        await expect(bot.message('m1', 'hello')).rejects.toMatchObject({ errorCode: 'bot_disabled' });
    });
    it('persists enabled, dispatches an idempotent message without a UI subscriber', async () => {
        const { bot, starts } = setup();
        await bot.settings({ expected_revision: 1, enabled: true });
        const first = await bot.message('m1', 'hello');
        const duplicate = await bot.message('m1', 'hello');
        expect(duplicate.id).toBe(first.id);
        await settle();
        await bot.tick();
        expect(starts).toHaveLength(1);
        await expect(bot.message('m1', 'different')).rejects.toMatchObject({ errorCode: 'bot_request_conflict' });
        await expect(bot.settings({ expected_revision: 1, enabled: false })).rejects.toMatchObject({ errorCode: 'bot_revision_conflict' });
    });
    it('blocks other entry points from executing a Bot session', async () => {
        const { bot, control } = setup();
        const profile = await bot.snapshot();
        expect(() => control.start({ kind: 'preset_model', ref: 'anomaloharis@1' }, {
            clientId: 'ordinary-chat', input: { session_id: profile.main_session_id, message: 'bypass' },
        })).toThrow('Bot session');
    });
    it('merges missed intervals and does not overlap a task', async () => {
        const { bot, advance, starts } = setup();
        await bot.settings({ expected_revision: 1, enabled: true });
        const task = bot.createTask({ title: 'watch', prompt: 'check status', schedule: { type: 'interval', everySeconds: 60, anchorAt: '2026-10-10T00:01:00Z' } });
        advance(600);
        await bot.tick();
        await settle();
        await bot.tick();
        expect(starts).toHaveLength(1);
        expect(bot.taskRuns(task.id)[0]?.missed_count).toBe(9);
        expect(bot.tasks()[0]?.next_due_at).toBe('2026-10-10T00:11:00.000Z');
    });
    it('does not replay a dispatch after the target has changed', async () => {
        const { bot, control, database, starts } = setup();
        await bot.settings({ expected_revision: 1, enabled: true });
        const task = bot.createTask({ title: 'check', prompt: 'check', schedule: { type: 'once', at: '2026-10-10T00:00:00Z' } });
        await bot.tick();
        await settle();
        database.prepare("UPDATE automation_occurrences SET status = 'dispatching', run_id = NULL WHERE task_id = ?").run(task.id);
        await bot.tick();
        expect(starts).toHaveLength(1);
        expect(bot.taskRuns(task.id)[0]?.run_id).toBeTruthy();
        expect(control.eventsSnapshot(String(bot.taskRuns(task.id)[0]?.run_id)).length).toBeGreaterThan(0);
    });
    it('stops queued Bot runs on recovery when disabled', async () => {
        const { bot, control, database, starts } = setup();
        const p = await bot.snapshot();
        database.prepare(`INSERT INTO execution_runs(run_id,runtime_kind,target_ref,target_hash,runtime_adapter_version,runtime_adapter_hash,client_id,status,input_json,metadata_json,request_hash,created_at)
      VALUES ('recovery','preset_model','anomaloharis@1','sha256:test','test','sha256:test','local-bot','queued',?,'{}','hash','2026-10-10T00:00:00Z')`).run(JSON.stringify({ session_id: p.main_session_id }));
        await control.recover();
        expect(control.get('recovery').status).toBe('failed');
        expect(starts).toHaveLength(0);
    });
});
describe('Calendar scheduling', () => {
    it('uses the configured timezone and skips a nonexistent daylight-saving time', () => {
        const rule = { type: 'calendar' as const, localTime: '02:30', timezone: 'America/New_York' };
        expect(nextScheduledTime(rule, '2026-03-08T00:00:00Z')).toBe('2026-03-09T06:30:00.000Z');
    });
    it('only executes the first occurrence of a repeated local time', () => {
        expect(nextScheduledTime({ type: 'calendar', localTime: '01:30', timezone: 'America/New_York' }, '2026-11-01T05:31:00Z')).toBe('2026-11-02T06:30:00.000Z');
    });
});
describe('Durable memory', () => {
    it('preserves sources and revisions, searches Chinese and excludes inactive entries', () => {
        const store = new MemoryStore(db());
        const first = store.write({ content: '项目使用 TypeScript，偏好中文交流', scope: 'user' }, { type: 'user' });
        expect(store.search('中文').map(x => x.id)).toContain(first.id);
        store.update(first.id, first.revision, { content: '偏好日文交流' });
        expect(() => store.update(first.id, first.revision, { content: 'stale' })).toThrow('revision');
        store.update(first.id, 2, { status: 'inactive' });
        expect(store.search('日文')).toEqual([]);
        expect(store.history(first.id)).toHaveLength(3);
    });
});
describe('Compaction projection', () => {
    it('keeps tool call/result together, saves summary without deleting transcript', async () => {
        const model = new ReplayModelAdapter([], { completions: ['Goal: keep working.'] });
        const compact = new Compaction(db(), model);
        const messages = [
            { role: 'user' as const, content: 'old request', _entryId: 'u1' },
            { role: 'assistant' as const, content: '', tool_calls: [{ id: 't1', name: 'read', arguments: {} }], _entryId: 'a1' },
            { role: 'tool' as const, content: 'old result', tool_call_id: 't1', _entryId: 't1' },
            { role: 'user' as const, content: 'new request', _entryId: 'u2' },
        ];
        await compact.compact('s1', messages, 'replay-model', undefined, new AbortController().signal, 50);
        const projected = compact.project('s1', messages);
        expect(projected[0]?.content).toContain('Goal:');
        expect(projected.at(-1)?.content).toBe('new request');
        expect(messages).toHaveLength(4);
    });
    it('does not commit an empty summary', async () => {
        const compact = new Compaction(db(), new ReplayModelAdapter([], { completions: [''] }));
        const messages = [{ role: 'user' as const, content: 'old', _entryId: 'u1' }, { role: 'user' as const, content: 'new', _entryId: 'u2' }];
        await expect(compact.compact('s', messages, 'm', undefined, new AbortController().signal, 1)).rejects.toThrow('empty');
        expect(compact.project('s', messages)).toEqual(messages);
    });
});
describe('Bot running AgentCore', () => {
    it('executes authorized schedule and memory tools, retaining progress across new messages', async () => {
        const { AgentCore } = await import('./core.js');
        const { RunController } = await import('./controller.js');
        const { AgentRuntimeAdapter } = await import('./agent-runtime-adapter.js');
        const { SqlitePresetModelRegistry } = await import('./preset-models.js');
        const { builtinPluginCatalog } = await import('./plugin-catalog.js');
        const { BotToolRuntime } = await import('./bot-tools.js');
        const { CompositeToolRuntime, asToolAdapter } = await import('./tools.js');
        const { ReplayContextBuilder } = await import('./context.js');
        const registry = new SqlitePresetModelRegistry(':memory:', { database: db(), catalog: builtinPluginCatalog() });
        const base = registry.ensureBuiltinDefault({ model: 'replay-model' });
        const definition = structuredClone(base.definition);
        definition.name = 'bot-test';
        definition.plugins = { fixed: ['bot-tools'] };
        const preset = registry.publish(registry.createDraft(definition).ref);
        const model = new ReplayModelAdapter([
            [{ type: 'tool.calls', calls: [{ id: 'save', name: 'bot_memory_write', arguments: { content: '用户偏好中文交流', scope: 'user' } }, { id: 'schedule', name: 'bot_schedule', arguments: { title: 'check', prompt: 'check status', schedule: { type: 'once', at: '2099-01-01T00:00:00Z' } } }] }],
            [{ type: 'text.delta', text: 'Saved and scheduled.' }, { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }, { type: 'done' }],
            [{ type: 'text.delta', text: 'I remember.' }, { type: 'done' }],
        ]);
        const sessions = new InMemorySessionAdapter();
        let bot!: BotService;
        const tools = new CompositeToolRuntime([asToolAdapter('bot-tools', 100, new BotToolRuntime(() => bot))]);
        const core = new AgentCore({ model, tools, sessions, context: new ReplayContextBuilder(tools), prepareModelContext: (input, context, signal) => bot.prepareContext(input, context, signal), onUsage: (input, usage) => bot.recordUsage(input, usage) });
        const catalog = new RuntimeCatalog();
        catalog.register(new AgentRuntimeAdapter({ registry, controller: new RunController(core), prepareInput: (ctx, input) => bot.prepareInput(ctx, input) }));
        const control = new RunControl(db(), catalog);
        bot = new BotService({ control, sessions, defaultModel: preset.ref, model });
        await bot.settings({ expected_revision: 1, enabled: true });
        const first = await bot.message('tool-test', '记住我的偏好，并安排检查');
        for await (const _ of control.events(first.run_id!)) { /* drain recorded run */ }
        expect(control.get(first.run_id!).status).toBe('succeeded');
        expect(bot.memory.search('中文')).toHaveLength(1);
        expect(bot.tasks()).toHaveLength(1);
        expect(model.streamCalls[0]?.tools.map(x => x.name)).toContain('bot_schedule');
        const second = await bot.message('memory-test', '你还记得我的交流偏好吗？');
        for await (const _ of control.events(second.run_id!)) { /* finish */ }
        expect(model.streamCalls.at(-1)?.messages.some(x => x.content.includes('用户偏好中文交流'))).toBe(true);
        expect((await bot.snapshot()).budget.used_tokens).toBe(110);
        const journal = await sessions.journal!((await bot.snapshot()).main_session_id as import('@anomaloharis/contracts').SessionId);
        expect(new Set(journal.map(x => x._entryId)).size).toBe(journal.length);
    });
});
describe('Task change boundaries', () => {
    it('keeps a pending occurrence input stable when the task prompt changes', async () => {
        const { bot, database } = setup();
        await bot.settings({ expected_revision: 1, enabled: true });
        const task = bot.createTask({ title: 'original', prompt: 'old instruction', schedule: { type: 'once', at: '2026-10-10T00:00:00Z' } });
        // Persisted pending dispatch represents a Host restart before start().
        const frozen = { targetHash: 'sha256:test', input: { session_id: 'bot_frozen', message: 'old instruction' } };
        bot.store.ownSession('bot_frozen', 'anomaloharis@1');
        database.prepare("INSERT INTO automation_occurrences VALUES('frozen',?,?,'pending','frozen-key',?,NULL,0)").run(task.id, '2026-10-10T00:00:00Z', JSON.stringify(frozen));
        bot.updateTask(task.id, { expected_revision: task.revision, prompt: 'new instruction' });
        await bot.tick();
        const run = bot.options.control.get(bot.taskRuns(task.id).find(x => x.id === 'frozen')!.run_id!);
        expect(run.input).toMatchObject({ message: 'old instruction' });
        await settle();
    });
    it('does not overwrite a user cancellation when a running task completes', async () => {
        const { bot } = setup();
        await bot.settings({ expected_revision: 1, enabled: true });
        const task = bot.createTask({ title: 'cancel', prompt: 'check', schedule: { type: 'once', at: '2026-10-10T00:00:00Z' } });
        await bot.tick();
        const current = bot.tasks()[0]!;
        bot.updateTask(task.id, { expected_revision: current.revision, status: 'cancelled' });
        await settle();
        await bot.tick();
        expect(bot.tasks()[0]?.status).toBe('cancelled');
    });
});
describe('Single Host ownership', () => {
    it('refuses another owner and releases the operating-system lock on close', async () => {
        const { mkdtempSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { HostLock } = await import('./host-lock.js');
        const path = join(mkdtempSync(join(tmpdir(), 'anomaloharis-bot-lock-')), 'host.lock.sqlite3');
        const first = new HostLock(path);
        expect(() => new HostLock(path)).toThrow('already owns');
        first.close();
        const next = new HostLock(path);
        next.close();
    });
});
describe('Trusted Bot ownership', () => {
    it('checks every session selector and rejects forged Bot flags on normal runs', async () => {
        const { bot, control } = setup();
        const p = await bot.snapshot();
        expect(() => control.start({ kind: 'preset_model', ref: 'anomaloharis@1' }, { clientId: 'ordinary-chat', input: { session_id: 'ordinary', agent_input: { sessionId: p.main_session_id } } })).toThrow('Bot session');
        const ordinary = bot.prepareInput({ runId: 'ordinary', clientId: 'ordinary-chat', target: { kind: 'preset_model', ref: 'm@1', hash: 'x' }, metadata: {}, signal: new AbortController().signal }, { botSession: true } as import('./types.js').AgentRunInput);
        expect(ordinary.botSession).toBe(false);
    });
});
describe('Compaction within a long Bot run', () => {
    it('journals tool rounds and resumes from a compacted transcript without duplicate entries', async () => {
        const { AgentCore } = await import('./core.js');
        const { DeterministicToolRuntime } = await import('./tools.js');
        const sessions = new InMemorySessionAdapter();
        const model = new ReplayModelAdapter([
            [{ type: 'tool.calls', calls: [{ id: 'one', name: 'read', arguments: {} }] }],
            [{ type: 'tool.calls', calls: [{ id: 'two', name: 'read', arguments: {} }] }],
            [{ type: 'text.delta', text: 'finished' }, { type: 'done' }],
        ], { completions: ['Goal: read the documents; first document inspected.'] });
        const tools = new DeterministicToolRuntime([{ name: 'read', description: 'read', parameters: { type: 'object' } }], { read: () => ({ name: 'read', ok: true, content: 'x'.repeat(1000), data: {} }) });
        const compact = new Compaction(db(), model);
        let requests = 0;
        const core = new AgentCore({ model, tools, sessions, prepareModelContext: async (input, context, signal) => {
                requests++;
                if (requests === 3)
                    await compact.compact(input.sessionId, context.messages, input.model, undefined, signal, 10);
                return { ...context, messages: compact.project(input.sessionId, context.messages) };
            } });
        const input = { sessionId: 'long-bot', runId: 'long-run', botSession: true, message: 'read docs', resume: false, promptProfile: 'agent', model: 'replay-model', searchMode: 'diy' } as import('./types.js').AgentRunInput;
        const events = [];
        for await (const event of core.execute(input, new AbortController().signal))
            events.push(event);
        expect(events.at(-1)?.type).toBe('run.finished');
        const raw = await sessions.journal!(input.sessionId);
        expect(raw.filter(x => x.role === 'tool')).toHaveLength(2);
        expect(new Set(raw.map(x => x._entryId)).size).toBe(raw.length);
        expect(model.streamCalls.at(-1)?.messages[0]?.content).toContain('Earlier conversation summary');
    });
});
describe('Large summarization input', () => {
    it('summarizes bounded batches before committing one durable projection', async () => {
        const model = new ReplayModelAdapter([], { completions: Array(100).fill('Goal: continue the task. Documents reviewed.') });
        const compact = new Compaction(db(), model);
        const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: 'history '.repeat(1000), _entryId: `entry-${i}` }));
        messages.push({ role: 'user', content: 'continue', _entryId: 'latest' });
        await compact.compact('large', messages, 'model', undefined, new AbortController().signal, 500, 8192);
        expect(model.completeCalls.length).toBeGreaterThan(1);
        expect(model.completeCalls.every(x => JSON.stringify(x.messages).length < 12000)).toBe(true);
        expect(compact.records('large')).toHaveLength(1);
        expect(compact.project('large', messages).at(-1)?.content).toBe('continue');
    });
});
describe('Explicit task retry', () => {
    it('can run a paused task manually without reactivating its schedule', async () => {
        const { bot, starts } = setup();
        await bot.settings({ expected_revision: 1, enabled: true });
        const task = bot.createTask({ title: 'paused', prompt: 'check', schedule: { type: 'interval', everySeconds: 60, anchorAt: '2099-01-01T00:00:00Z' } });
        bot.updateTask(task.id, { expected_revision: 1, status: 'paused' });
        await bot.runTask(task.id, 'manual');
        await settle();
        await bot.tick();
        expect(starts).toHaveLength(1);
        expect(bot.tasks()[0]?.status).toBe('paused');
    });
});
describe('Task checkpoint resume', () => {
    it('requires an interrupted run and associates an explicit resume with its task', async () => {
        const { bot, control, database, sessions } = setup();
        await bot.settings({ expected_revision: 1, enabled: true });
        const task = bot.createTask({ title: 'resume', prompt: 'check', schedule: { type: 'once', at: '2026-10-10T00:00:00Z' } });
        await bot.tick();
        await settle();
        const occurrence = bot.taskRuns(task.id)[0]!;
        const run = control.get(occurrence.run_id!);
        await expect(bot.resumeTask(task.id, run.run_id, 'resume')).rejects.toThrow('interrupted');
        database.prepare("UPDATE execution_runs SET status='stopped' WHERE run_id=?").run(run.run_id);
        const sessionId = (run.input as {
            session_id: string;
        }).session_id as import('@anomaloharis/contracts').SessionId;
        await sessions.checkpoint({ runId: run.run_id as import('@anomaloharis/contracts').RunId, sessionId, reason: 'stopped', iteration: 1, createdAt: 'now', updatedAt: 'now', state: { promptProfile: 'agent', originalUserContent: 'check', currentUserMessage: { role: 'user', content: 'check' }, assistantText: '', pendingToolCalls: [], completedToolCallIds: [], loopMessages: [], bootstrapContext: [], searchMode: 'diy' } });
        const resumed = await bot.resumeTask(task.id, run.run_id, 'resume');
        await settle();
        expect(control.get(resumed.run_id).metadata?.task_id).toBe(task.id);
        expect(bot.taskRuns(task.id).some(x => x.run_id === resumed.run_id)).toBe(true);
        expect((await bot.resumeTask(task.id, run.run_id, 'resume')).run_id).toBe(resumed.run_id);
    });
});
describe('On-disk restart', () => {
    it('preserves enabled, identity, tasks and memory after reopening SQLite', async () => {
        const { mkdtempSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const path = join(mkdtempSync(join(tmpdir(), 'anomaloharis-bot-restart-')), 'runs.sqlite3');
        const first = setup(path);
        await first.bot.settings({ expected_revision: 1, enabled: true });
        const identity = (await first.bot.snapshot()).main_session_id;
        first.bot.createTask({ title: 'durable', prompt: 'check', schedule: { type: 'once', at: '2099-01-01T00:00:00Z' } });
        first.bot.memory.write({ content: '用户偏好中文交流' }, { type: 'user' });
        await first.bot.close();
        first.database.close();
        const second = setup(path);
        await second.control.recover();
        expect(await second.bot.snapshot()).toMatchObject({ enabled: true, main_session_id: identity });
        expect(second.bot.tasks()[0]?.title).toBe('durable');
        expect(second.bot.memory.search('中文')).toHaveLength(1);
    });
});

describe('Resume after compaction', () => {
  it('restores a checkpoint using the same Entry boundaries without replaying completed tools', async () => {
    const {AgentCore}=await import('./core.js');const {DeterministicToolRuntime}=await import('./tools.js');
    const sessions=new InMemorySessionAdapter();const stop=new AbortController();
    const model=new ReplayModelAdapter([
      [{type:'tool.calls',calls:[{id:'one',name:'read',arguments:{}}]}],
      [{type:'tool.calls',calls:[{id:'two',name:'read',arguments:{}}]}],
      [{type:'text.delta',text:'interrupted'},{type:'done'}],
      [{type:'text.delta',text:'resumed'},{type:'done'}],
    ],{completions:['Goal: finish reading; first document has been read.']});
    const tools=new DeterministicToolRuntime([{name:'read',description:'read',parameters:{type:'object'}}],{read:()=>({name:'read',ok:true,content:'x'.repeat(1000),data:{}})});
    const compact=new Compaction(db(),model);let requestNumber=0;
    const core=new AgentCore({model,tools,sessions,prepareModelContext:async(input,context,signal)=>{
      if(++requestNumber===3){await compact.compact(input.sessionId,context.messages,input.model,undefined,signal,10);stop.abort('user_stop');}
      return {...context,messages:compact.project(input.sessionId,context.messages)};
    }});
    const input={sessionId:'resume-bot',runId:'before-stop',botSession:true,message:'read documents',resume:false,promptProfile:'agent',model:'replay-model',searchMode:'diy'} as import('./types.js').AgentRunInput;
    const first=[];for await(const event of core.execute(input,stop.signal))first.push(event);
    expect(first.at(-1)?.type).toBe('run.stopped');
    const before=await sessions.journal!(input.sessionId);
    const second=[];for await(const event of core.execute({...input,runId:'after-resume' as import('@anomaloharis/contracts').RunId,message:null,resume:true},new AbortController().signal))second.push(event);
    expect(second.at(-1)?.type).toBe('run.finished');
    expect(tools.calls).toHaveLength(2);
    const after=await sessions.journal!(input.sessionId);
    expect(after.slice(0,before.length).map(x=>x._entryId)).toEqual(before.map(x=>x._entryId));
    expect(after.at(-1)?.content).toBe('resumed');
    expect(after.filter(x=>x.role==='user')).toHaveLength(1);
  });
});
