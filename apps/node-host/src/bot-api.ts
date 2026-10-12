import { createHash, timingSafeEqual } from 'node:crypto';
import Ajv from 'ajv';
import type { FastifyInstance } from 'fastify';
import { BotSettingsSchema, BotMessageSchema, BotTaskSchema, BotTaskPatchSchema, BotMemorySchema, BotMemoryPatchSchema, BotRequestIdSchema, BotLocalTimeSchema, BotTaskResumeSchema, type BotSettings, type BotTaskInput, type BotMemoryInput, type SessionId } from '@anomaloharis/contracts';
import { resolveLocalDateTime } from './tools.js';
import { BotService } from './bot-service.js';
import { RunControlError } from './run-control.js';
const ajv = new Ajv({ allErrors: true });
const validators = { settings: ajv.compile(BotSettingsSchema), message: ajv.compile(BotMessageSchema), task: ajv.compile(BotTaskSchema), taskPatch: ajv.compile(BotTaskPatchSchema), memory: ajv.compile(BotMemorySchema), memoryPatch: ajv.compile(BotMemoryPatchSchema), request: ajv.compile(BotRequestIdSchema), localTime: ajv.compile(BotLocalTimeSchema), taskResume: ajv.compile(BotTaskResumeSchema) };
function validate(kind: keyof typeof validators, value: unknown): void {
    if (!validators[kind](value))
        throw new RunControlError(400, 'invalid_bot_request', ajv.errorsText(validators[kind].errors));
}
function pageNumber(value: unknown, fallback: number, max: number): number {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < 0 || result > max)
        throw new RunControlError(400, 'invalid_cursor', 'Invalid pagination value.');
    return result;
}
export function registerBotRoutes(root: FastifyInstance, bot: BotService, token?: string): void {
    void root.register(async (app) => {
        app.addHook('preHandler', async (request) => {
            if (!token) {
                const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
                if (!local) throw new RunControlError(403, 'management_access_required', 'Management API requires an admin token for remote Bot access.');
                return;
            }
            const provided = request.headers['x-anomaloharis-admin-token'];
            if (typeof provided !== 'string' || !timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(provided).digest()))
                throw new RunControlError(403, 'management_access_required', 'Management API requires a valid admin token.');
        });
        app.setErrorHandler((error, _request, reply) => {
            const known = error instanceof RunControlError;
            void reply.code(known ? error.statusCode : 400).send({ error: error instanceof Error ? error.message : String(error), error_code: known ? error.errorCode : 'invalid_bot_request' });
        });
        app.get('', async () => bot.snapshot());
        app.patch('/settings', async (request) => { validate('settings', request.body); return bot.settings(request.body as BotSettings); });
        app.get('/session', async (request) => {
            const query = request.query as {
                session_id?: string;
                offset?: string;
                limit?: string;
            };
            const id = query.session_id ?? bot.store.profile().main_session_id;
            if (!bot.ownsSession(id))
                throw new RunControlError(404, 'session_not_found', 'Bot session not found.');
            const snapshot = await bot.options.sessions.open(id as SessionId);
            const offset = pageNumber(query.offset, 0, Number.MAX_SAFE_INTEGER);
            const limit = pageNumber(query.limit, 100, 500);
            const requests = bot.store.requests().filter(x => x.session_id === id);
            return { session_id: id, messages: (await bot.options.sessions.journal?.(id as SessionId) ?? snapshot.messages).slice(offset, offset + limit), total: snapshot.messages.length, checkpoint: Boolean(snapshot.checkpoint), requests, active_run_id: bot.active().find(x => (x.input as {
                    session_id?: string;
                }).session_id === id)?.run_id ?? null };
        });
        app.post('/messages', async (request, reply) => {
            validate('message', request.body);
            const body = request.body as {
                request_id: string;
                message: string;
            };
            return reply.code(202).send(await bot.message(body.request_id, body.message));
        });
        app.get<{
            Params: {
                id: string;
            };
        }>('/requests/:id', async (request) => { const result = bot.store.request(request.params.id); if (!result)
            throw new RunControlError(404, 'request_not_found', 'Request not found.'); return result; });
        app.get<{
            Params: {
                id: string;
            };
        }>('/runs/:id/events', async (request) => {
            const run = bot.assertRun(request.params.id);
            const query = request.query as {
                after_sequence?: string;
                limit?: string;
            };
            const after = pageNumber(query.after_sequence, 0, Number.MAX_SAFE_INTEGER);
            const limit = pageNumber(query.limit, 200, 500);
            if (limit === 0)
                throw new RunControlError(400, 'invalid_cursor', 'limit must be positive.');
            const rows = bot.store.db.prepare('SELECT event_json FROM execution_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(run.run_id, after, limit + 1);
            const events = rows.slice(0, limit).map(x => JSON.parse(String(x.event_json)));
            return { run_id: run.run_id, status: run.status, events, next_sequence: events.at(-1)?.sequence ?? after, has_more: rows.length > limit };
        });
        app.post<{
            Params: {
                id: string;
            };
        }>('/runs/:id/stop', async (request) => { bot.assertRun(request.params.id); return bot.options.control.stop(request.params.id, 'user_stop'); });
        app.post('/session/resume', async (request) => { validate('request', request.body); return bot.resume((request.body as {
            request_id: string;
        }).request_id); });
        app.post('/session/compact', async () => { await bot.compactMain(); return { compacted: true }; });
        app.post('/schedule-preview', async (request) => { validate('localTime', request.body); const body = request.body as {
            local_time: string;
            timezone: string;
        }; return { at: resolveLocalDateTime(body.local_time, body.timezone, 0).toISOString() }; });
        app.get('/tasks', async () => ({ tasks: bot.tasks() }));
        app.post('/tasks', async (request, reply) => { validate('task', request.body); return reply.code(201).send(bot.createTask(request.body as BotTaskInput)); });
        app.patch<{
            Params: {
                id: string;
            };
        }>('/tasks/:id', async (request) => { validate('taskPatch', request.body); return bot.updateTask(request.params.id, request.body as Parameters<BotService['updateTask']>[1]); });
        app.post<{
            Params: {
                id: string;
            };
        }>('/tasks/:id/run', async (request, reply) => { validate('request', request.body); return reply.code(202).send(await bot.runTask(request.params.id, (request.body as {
            request_id: string;
        }).request_id)); });
        app.post<{
            Params: {
                id: string;
            };
        }>('/tasks/:id/resume', async (request, reply) => { validate('taskResume', request.body); const body = request.body as {
            request_id: string;
            run_id: string;
        }; return reply.code(202).send(await bot.resumeTask(request.params.id, body.run_id, body.request_id)); });
        app.get<{
            Params: {
                id: string;
            };
        }>('/tasks/:id/runs', async (request) => {
            const task = bot.store.task(request.params.id);
            if (!task) throw new RunControlError(404, 'task_not_found', 'Task not found.');
            const checkpoints = new Map<string, Promise<string | undefined>>();
            const runs = await Promise.all(bot.taskRuns(task.id).map(async occurrence => {
                if (!occurrence.run_id) return {...occurrence, can_resume: false};
                const run = bot.assertRun(occurrence.run_id);
                const sessionId = (run.input as {session_id?: string}).session_id;
                let checkpointId: string | undefined;
                if (sessionId && ['stopped','failed'].includes(run.status)) {
                    if (!checkpoints.has(sessionId)) checkpoints.set(sessionId,
                        bot.options.sessions.open(sessionId as SessionId).then(snapshot => snapshot.checkpoint?.runId));
                    checkpointId = await checkpoints.get(sessionId);
                }
                return {...occurrence, status: run.status,
                    can_resume: !['cancelled','paused'].includes(task.status) && checkpointId === run.run_id};
            }));
            return {runs};
        });
        app.get('/results', async () => ({ results: bot.store.results() }));
        app.post<{
            Params: {
                id: string;
            };
        }>('/results/:id/read', async (request) => { bot.store.db.prepare('UPDATE bot_results SET read_at=? WHERE id=?').run(new Date().toISOString(), request.params.id); return { read: true }; });
        app.get('/memories', async (request) => { const query = request.query as {
            q?: string;
        }; return { memories: query.q ? bot.memory.search(query.q) : bot.memory.list() }; });
        app.post('/memories', async (request, reply) => { validate('memory', request.body); return reply.code(201).send(bot.memory.write(request.body as BotMemoryInput, { type: 'user', via: 'bot_ui' })); });
        app.patch<{
            Params: {
                id: string;
            };
        }>('/memories/:id', async (request) => { validate('memoryPatch', request.body); const body = request.body as {
            expected_revision: number;
            content?: string;
            status?: 'active' | 'inactive';
        }; return bot.memory.update(request.params.id, body.expected_revision, body, { type: 'user', via: 'bot_ui' }); });
        app.get<{
            Params: {
                id: string;
            };
        }>('/memories/:id/history', async (request) => ({ changes: bot.memory.history(request.params.id) }));
    }, { prefix: '/api/bot' });
}
