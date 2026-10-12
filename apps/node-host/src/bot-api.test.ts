import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerBotRoutes } from './bot-api.js';
import { BotService } from './bot-service.js';
import { RunControl, type ExecutionRuntimeAdapter } from './run-control.js';
import { RuntimeCatalog } from './runtime-catalog.js';
import { InMemorySessionAdapter } from './session.js';
describe('Bot API', () => {
    it('validates settings, enforces management auth and returns bounded event snapshots', async () => {
        const db = new DatabaseSync(':memory:');
        const catalog = new RuntimeCatalog();
        const adapter: ExecutionRuntimeAdapter = { kind: 'preset_model', version: 'test', packageHash: 'test', capabilities: [], consumesHostSlot: true, isHealthy: () => true, resolve: ref => ({ kind: 'preset_model', ref, hash: 'test' }), stop: () => { }, async *start() { yield { type: 'agent.run.finished', data: { output: 'hello' }, terminal: 'succeeded' as const }; } };
        catalog.register(adapter);
        const control = new RunControl(db, catalog);
        const bot = new BotService({ control, sessions: new InMemorySessionAdapter(), defaultModel: 'anomaloharis@1' });
        const app = Fastify();
        registerBotRoutes(app, bot, 'secret');
        const headers = { 'x-anomaloharis-admin-token': 'secret' };
        try {
            expect((await app.inject('/api/bot')).statusCode).toBe(403);
            expect((await app.inject({ method: 'PATCH', url: '/api/bot/settings', headers, payload: { enabled: true } })).statusCode).toBe(400);
            const enabled = await app.inject({ method: 'PATCH', url: '/api/bot/settings', headers, payload: { expected_revision: 1, enabled: true } });
            expect(enabled.statusCode).toBe(200);
            const result = await app.inject({ method: 'POST', url: '/api/bot/messages', headers, payload: { request_id: 'api-msg', message: 'hello' } });
            expect(result.statusCode).toBe(202);
            const run = result.json().run_id;
            const events = await app.inject({ method: 'GET', url: `/api/bot/runs/${run}/events?limit=1`, headers });
            expect(events.statusCode).toBe(200);
            expect(events.json().events).toHaveLength(1);
            expect(events.json().has_more).toBe(true);
            expect((await app.inject({ method: 'GET', url: `/api/bot/runs/${run}/events?after_sequence=NaN`, headers })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url: '/api/bot/memories', headers, payload: { content: '中文偏好', source: 'user' } })).statusCode).toBe(400);
        }
        finally {
            await bot.close();
            await app.close();
            db.close();
        }
    });
});

describe('Bot local access boundary',()=>{
  it('requires management credentials for a remote address even without a configured token',async()=>{
    const db=new DatabaseSync(':memory:');const catalog=new RuntimeCatalog();
    const control=new RunControl(db,catalog);
    const bot=new BotService({control,sessions:new InMemorySessionAdapter(),defaultModel:'anomaloharis@1'});
    const app=Fastify();registerBotRoutes(app,bot);
    try {expect((await app.inject({method:'GET',url:'/api/bot',remoteAddress:'203.0.113.20'})).statusCode).toBe(403);}finally{await app.close();db.close();}
  });
});
