// Deterministic local fixture: no provider keys, network model calls or real tools.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AgentCore } from '../apps/node-host/dist/core.js';
import { RunController } from '../apps/node-host/dist/controller.js';
import { AgentRuntimeAdapter } from '../apps/node-host/dist/agent-runtime-adapter.js';
import { RuntimeCatalog } from '../apps/node-host/dist/runtime-catalog.js';
import { RunControl } from '../apps/node-host/dist/run-control.js';
import { BotService } from '../apps/node-host/dist/bot-service.js';
import { BotToolRuntime } from '../apps/node-host/dist/bot-tools.js';
import { CompositeToolRuntime, asToolAdapter } from '../apps/node-host/dist/tools.js';
import { SqliteSessionAdapter } from '../apps/node-host/dist/sqlite.js';
import { SqlitePresetModelRegistry } from '../apps/node-host/dist/preset-models.js';
import { builtinPluginCatalog } from '../apps/node-host/dist/plugin-catalog.js';
import { ReplayContextBuilder } from '../apps/node-host/dist/context.js';
import { buildNodeHost } from '../apps/node-host/dist/host.js';
export async function createBotSmokeHost({ managementToken } = {}) {
    const db = new DatabaseSync(':memory:');
    const registry = new SqlitePresetModelRegistry(':memory:', { catalog: builtinPluginCatalog() });
    const base = registry.ensureBuiltinDefault({ model: 'smoke-model' });
    const definition = structuredClone(base.definition);
    definition.name = 'smoke-bot';
    definition.plugins = { fixed: ['bot-tools'] };
    const preset = registry.publish(registry.createDraft(definition).ref);
    const model = { model: 'smoke-model', async *stream(request, signal) {
            if (signal.aborted)
                throw new Error('Stopped');
            const message = request.messages.filter(x => x.role === 'user').at(-1)?.content ?? '';
            if (message.includes('__slow__'))
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, message.includes('__checkpoint__') ? 15000 : 2500);
                    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Stopped')); }, { once: true });
                });
            if (message.includes('记住') && request.messages.at(-1)?.role !== 'tool') {
                yield { type: 'tool.calls', calls: [{ id: 'remember', name: 'bot_memory_write', arguments: { content: '用户偏好中文交流', scope: 'user' } }] };
                return;
            }
            yield { type: 'text.delta', text: `完成：${message.slice(0, 80)}` };
            yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
            yield { type: 'done' };
        }, async complete() { return 'Goal: keep responding to the user. Preference: Chinese. All prior requests completed.'; } };
    const sessions = new SqliteSessionAdapter(':memory:');
    let bot;
    const tools = new CompositeToolRuntime([asToolAdapter('bot-tools', 100, new BotToolRuntime(() => bot))]);
    const core = new AgentCore({ model, tools, sessions, context: new ReplayContextBuilder(tools), prepareModelContext: (input, ctx, signal) => bot.prepareContext(input, ctx, signal), onUsage: (input, usage) => bot.recordUsage(input, usage), beforeComplete: (input, request) => bot.prepareCompletion(input, request) });
    const catalog = new RuntimeCatalog();
    catalog.register(new AgentRuntimeAdapter({ registry, controller: new RunController(core), prepareInput: (ctx, input) => bot.prepareInput(ctx, input) }));
    const control = new RunControl(db, catalog);
    bot = new BotService({ control, sessions, defaultModel: preset.ref, model });
    await bot.initialize();
    const app = await buildNodeHost({ sessions, model: model.model, presetModels: registry, defaultPresetModel: base.ref, runControl: control, bot, tools, managementToken, staticDir: resolve('runtime-bundle/app/frontend'), logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    bot.start();
    return { app, bot, control, url: `http://127.0.0.1:${app.server.address().port}`, async close() { await bot.close(); await app.close(); sessions.close(); registry.close(); db.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const fixture = await createBotSmokeHost();
    console.log(fixture.url);
    process.once('SIGINT', () => void fixture.close());
    process.once('SIGTERM', () => void fixture.close());
}
