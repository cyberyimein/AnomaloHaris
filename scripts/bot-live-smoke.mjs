// Opt-in real OpenRouter verification. Only synthetic prompts and temporary databases.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
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
import { OpenAICompatibleAdapter } from '../apps/node-host/dist/model.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not configured.');
const modelName = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4.1-flash-1017';
const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1';
if (new URL(baseUrl).hostname !== 'openrouter.ai') throw new Error('This script is limited to the configured OpenRouter endpoint.');
const report = { model: modelName, provider: 'OpenRouter', checks: {}, requests: [], synthetic_data_only: true };
let pauseBeforeNextRequest = false;
let signalEntered;
let requestCount = 0;
const metric = payload => {
  if (!payload.usage) return;
  report.requests.push({model:payload.model ?? modelName,prompt_tokens:payload.usage.prompt_tokens,completion_tokens:payload.usage.completion_tokens,total_tokens:payload.usage.total_tokens,cost_usd:payload.usage.cost});
};
const fetchImpl = async (url, init) => {
  if (pauseBeforeNextRequest) {
    pauseBeforeNextRequest = false;
    signalEntered?.();
    await new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(new Error('Verification stop before dispatch.'));
      init.signal?.addEventListener('abort', () => reject(new Error('Verification stop before dispatch.')), {once:true});
    });
  }
  if (++requestCount > 12) throw new Error('Real verification request limit reached (12).');
  const body = JSON.parse(String(init.body));
  body.max_tokens = Math.min(body.max_tokens ?? 2000, 2000);
  if (body.stream) body.stream_options = {include_usage:true};
  const response = await fetch(url, {...init,body:JSON.stringify(body),signal:AbortSignal.any([init.signal,AbortSignal.timeout(60000)])});
  if (!response.ok) {
    let code = response.status;
    try { const payload=await response.json();code=payload.error?.code??code; } catch {}
    throw new Error(`OpenRouter verification HTTP ${response.status}, code ${code}.`);
  }
  if (!body.stream) {
    const text=await response.text();metric(JSON.parse(text));
    return new Response(text,{status:response.status,headers:response.headers});
  }
  let buffer='';const decoder=new TextDecoder();
  const stream=response.body.pipeThrough(new TransformStream({transform(chunk,controller){
    buffer+=decoder.decode(chunk,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';
    for(const line of lines){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;try{metric(JSON.parse(data));}catch{}}
    controller.enqueue(chunk);
  }}));
  return new Response(stream,{status:response.status,headers:response.headers});
};
const provider=new OpenAICompatibleAdapter({model:modelName,baseUrl,apiKey:key,toolProtocol:'auto',fetchImpl});
const database=new DatabaseSync(':memory:');
const sessions=new SqliteSessionAdapter(':memory:');
const registry=new SqlitePresetModelRegistry(':memory:',{catalog:builtinPluginCatalog()});
const base=registry.ensureBuiltinDefault({model:modelName});
const definition=structuredClone(base.definition);
definition.name='live-bot-verification';
definition.prompt={system:'这是一次真实模型功能验证。只允许操作本轮临时 Bot 记录。按用户指令调用工具，确认成功后再回应。不要执行外部操作，不要伪造记忆或调度成功。回复简短。'};
definition.plugins={fixed:['bot-tools']};
definition.policy={max_tool_iterations:6,run_timeout_ms:120000,search_mode:'diy'};
const preset=registry.publish(registry.createDraft(definition).ref);
let bot;
const tools=new CompositeToolRuntime([asToolAdapter('bot-tools',100,new BotToolRuntime(()=>bot))]);
const core=new AgentCore({model:provider,tools,sessions,context:new ReplayContextBuilder(tools),prepareModelContext:(input,context,signal)=>bot.prepareContext(input,context,signal),onUsage:(input,usage)=>bot.recordUsage(input,usage),beforeComplete:(input,request)=>bot.prepareCompletion(input,request)});
const catalog=new RuntimeCatalog();
catalog.register(new AgentRuntimeAdapter({registry,controller:new RunController(core),prepareInput:(context,input)=>bot.prepareInput(context,input)}));
const control=new RunControl(database,catalog);
bot=new BotService({control,sessions,defaultModel:preset.ref,model:provider,resolveModel:ref=>registry.resolve(ref).providerModel});
async function finish(id){for await(const _ of control.events(id)){}const run=control.get(id);if(run.status!=='succeeded')throw new Error(`Verification run ${run.status}: ${JSON.stringify(run.error)}`);return run;}
const marker='LIVE_CARIS_42';
try {
  await bot.settings({expected_revision:1,enabled:true});
  console.log(`Live model: ${modelName}; synthetic data; at most 12 API requests.`);
  const first=await bot.message('live-write-schedule',`请严格通过工具完成两件事：1. 使用 bot_memory_write 保存“本轮验证代号是 ${marker}”，scope=user；2. 使用 bot_schedule 创建一次性任务，title=真实验证提醒，at=2099-01-01T00:00:00Z，prompt=“先通过 bot_memory_search 查询验证代号，再用 bot_task_update 将实际代号原样写入 summary，notify=false、completed=true”。完成后只回复一句确认。`);
  const firstRun=await finish(first.run_id);
  assert.ok(bot.memory.list().some(memory=>memory.content.includes(marker)),'Real model did not write the expected memory.');
  const task=bot.tasks().find(task=>task.title.includes('真实验证提醒'));
  assert.ok(task,'Real model did not schedule the requested task.');
  assert.equal(task.schedule.type,'once');
  report.checks.tool_memory_write=true;report.checks.tool_schedule=true;
  console.log('Passed: real tool calls saved memory and a one-time task.');
  const occurrence=await bot.runTask(task.id,'live-task');
  const taskRun=await finish(occurrence.run_id);await bot.tick();
  const state=bot.store.task(task.id).state;
  assert.ok(String(state.summary).includes(marker),'Fresh task Session did not recall the saved marker.');
  assert.equal(state.notify,false);
  report.checks.cross_session_memory=true;report.checks.task_progress=true;
  console.log('Passed: separate task Session recalled memory and recorded progress.');
  await bot.compactMain();
  const profile=await bot.snapshot();
  const records=bot.compaction.records(profile.main_session_id);
  assert.ok(records.length>0,'Real summarization was not persisted.');
  assert.ok(String(records.at(-1).summary).includes(marker),'Real summary omitted the verification marker.');
  report.checks.real_compaction=true;
  console.log('Passed: real summary persisted the marker.');
  pauseBeforeNextRequest=true;
  const entered=new Promise(resolve=>{signalEntered=resolve;});
  const stopped=await bot.message('live-stop','不要调用工具，只回复 LIVE_RESUME_OK。');
  await entered;
  await control.stop(stopped.run_id,'user_stop');
  assert.equal(control.get(stopped.run_id).status,'stopped');
  const resumed=await bot.resume('live-resume');
  const resumedRun=await finish(resumed.run_id);
  assert.notEqual(resumed.run_id,stopped.run_id);
  assert.ok(String(resumedRun.output).includes('LIVE_RESUME_OK'));
  assert.equal((await sessions.open(profile.main_session_id)).checkpoint,undefined);
  report.checks.resume_after_compaction=true;
  report.usage=(await bot.snapshot()).budget;
  report.api_requests=requestCount;
  report.reported_total_tokens=report.requests.reduce((sum,item)=>sum+(item.total_tokens??0),0);
  report.reported_cost_usd=report.requests.reduce((sum,item)=>sum+(item.cost_usd??0),0);
  report.completed=true;
  console.log(JSON.stringify(report,null,2));
  await writeFile('/private/tmp/anomaloharis-bot-live-report.json',JSON.stringify(report,null,2));
} catch(error) {
  report.completed=false;report.api_requests=requestCount;report.error=error.message;
  await writeFile('/private/tmp/anomaloharis-bot-live-report.json',JSON.stringify(report,null,2));
  console.error(`Live verification failed: ${error.message}`);
  process.exitCode=1;
} finally {
  await bot.close();sessions.close();registry.close();database.close();
}
