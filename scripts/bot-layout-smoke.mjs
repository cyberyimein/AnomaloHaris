import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBotSmokeHost } from './bot-smoke-host.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const fixture = await createBotSmokeHost();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('output/playwright', { recursive: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url);
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.locator('.bot-status').filter({ hasText: '已停用' }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('.bot-page h2').count(), 0);
    const composer = page.locator('.bot-composer-box');
    const before = await composer.boundingBox();
    assert.ok(before.width <= 820 && before.x >= 0 && before.x + before.width <= width);
    await page.screenshot({ path: `output/playwright/bot-chat-${width}.png` });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.waitForTimeout(300);
    assert.equal(await dialog.evaluate(el => getComputedStyle(el).position), 'fixed');
    assert.deepEqual(await composer.boundingBox(), before);
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.screenshot({ path: `output/playwright/bot-settings-${width}.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', { name: '任务 0', exact: true }).click();
    await dialog.waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `output/playwright/bot-tasks-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Bot layout passed: desktop/mobile, shared composer, overlay drawer, Escape/focus restoration, no horizontal overflow.');
} finally {
  await browser.close();
  await fixture.close();
}
