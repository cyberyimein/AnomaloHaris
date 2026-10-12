// Run after building contracts, node-host and frontend.
// PLAYWRIGHT_MODULE may point to a bundled playwright/index.mjs installation.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBotSmokeHost } from './bot-smoke-host.mjs';
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const fixture = await createBotSmokeHost();
const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
    await page.goto(fixture.url);
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.locator('.bot-status').filter({hasText:'已停用'}).waitFor();
    assert.equal((await fixture.bot.snapshot()).enabled, false);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('radio', { name: '启用', exact: true }).check();
    await page.locator('.bot-status').filter({hasText:'待命'}).waitFor();
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();
    await page.getByLabel('Bot message').fill('__slow__ 关页后继续');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.locator('.bot-message.assistant').filter({ hasText: '关页后继续' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.locator('.bot-message.assistant').filter({ hasText: '关页后继续' }).waitFor();
    await page.getByLabel('Bot message').fill('记住我的偏好');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('完成：记住我的偏好', { exact: true }).waitFor();
    await page.getByRole('button', { name: '记忆', exact: true }).click();
    const memory = fixture.bot.memory.list()[0];
    await page.getByLabel(`Memory ${memory.id}`).waitFor();
    assert.equal(memory.content, '用户偏好中文交流');
    await page.getByLabel(`Memory ${memory.id}`).fill('用户偏好日文交流');
    await page.getByRole('heading', { name: '记忆', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(fixture.bot.memory.list()[0].content, '用户偏好日文交流');
    await page.getByRole('button', { name: '停止使用', exact: true }).click();
    await page.getByRole('button', { name: '恢复使用', exact: true }).waitFor();
    assert.equal(fixture.bot.memory.search('日文').length, 0);
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();
    await page.getByRole('button', { name: '任务', exact: false }).first().click();
    await page.getByLabel('标题', { exact: true }).fill('自动检查');
    await page.getByLabel('任务指令', { exact: true }).fill('检查状态');
    await page.getByLabel('执行时间', { exact: false }).fill('2026-10-10T00:00');
    await page.getByRole('button', { name: '添加任务', exact: true }).click();
    await page.getByText('自动检查', { exact: true }).waitFor();
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();
    await fixture.bot.tick();
    await page.waitForTimeout(100);
    await fixture.bot.tick();
    await page.getByRole('heading', { name: '后台结果', exact: true }).waitFor();
    const count = fixture.bot.store.results().length;
    assert.equal(count, 1);
    await page.reload();
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.getByRole('heading', { name: '后台结果', exact: true }).waitFor();
    assert.equal(fixture.bot.store.results().length, count);
    // Exercise two interrupted resumptions through the page, backed by SQLite.
    const checkpointTask = fixture.bot.createTask({title:'连续恢复检查',prompt:'__slow__ __checkpoint__ check status',schedule:{type:'once',at:'2099-01-01T00:00:00Z'}});
    await fixture.bot.runTask(checkpointTask.id,'checkpoint-original');
    await page.getByRole('button',{name:'停止本次执行',exact:true}).click();
    await fixture.bot.tick();
    await page.getByRole('button',{name:'任务',exact:false}).first().click();
    const taskCard = page.locator('.bot-task').filter({hasText:'连续恢复检查'});
    await taskCard.getByRole('button',{name:'记录',exact:true}).click();
    for(let attempt=0;attempt<2;attempt++) {
      await page.getByRole('button',{name:'从检查点继续',exact:true}).first().click();
      await page.getByRole('button',{name:'关闭面板',exact:true}).click();
      await page.getByRole('button',{name:'停止本次执行',exact:true}).click();
      await fixture.bot.tick();
      await page.getByRole('button',{name:'任务',exact:false}).first().click();
      await taskCard.getByRole('button',{name:'记录',exact:true}).click();
    }
    const resumedRuns = fixture.bot.taskRuns(checkpointTask.id);
    assert.equal(resumedRuns.length,3);
    assert.equal(new Set(resumedRuns.map(run=>run.run_id)).size,3);
    const latestRun = fixture.control.get(resumedRuns[0].run_id);
    const checkpoint = (await fixture.bot.options.sessions.open(latestRun.input.session_id)).checkpoint;
    assert.equal(checkpoint.runId,latestRun.run_id);
    await page.getByRole('button',{name:'关闭面板',exact:true}).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByText('上下文整理',{exact:true}).click();
    await page.getByRole('button',{name:'手动压缩',exact:true}).click();
    await page.getByText('已压缩 1 次。',{exact:true}).waitFor();
    assert.equal(fixture.bot.compaction.records((await fixture.bot.snapshot()).main_session_id).length,1);
    await page.getByRole('radio', { name: '停用', exact: true }).check();
    await page.locator('.bot-status').filter({hasText:'已停用'}).waitFor();
    assert.equal(await page.getByLabel('Bot message').isDisabled(), true);
    // A rejected settings mutation must restore the server-confirmed radio.
    await page.route('**/api/bot/settings', route => route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'simulated save failure'})}));
    await page.getByRole('radio',{name:'启用',exact:true}).check();
    await page.locator('.bot-drawer').getByRole('alert').filter({hasText:'simulated save failure'}).waitFor();
    assert.equal(await page.getByRole('radio',{name:'停用',exact:true}).isChecked(),true);
    await page.unroute('**/api/bot/settings');
    await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await page.waitForTimeout(300);

    assert.deepEqual(errors, []);
    await mkdir('output/playwright', { recursive: true });
    await page.screenshot({ path: 'output/playwright/bot-smoke.png', fullPage: true });
    console.log('Bot Playwright smoke passed: enable, persistent conversation, background continuation, memory edit/deactivate, task result, refresh, two checkpoint resumes with SQLite, disable.');
}
catch (error) {
    console.error((await page.locator('body').innerText()).slice(0, 6000));
    console.error('Runs', fixture.bot.store.db.prepare('SELECT status,error_json FROM execution_runs').all());
    throw error;
}
finally {
    await browser.close();
    await fixture.close();
}
