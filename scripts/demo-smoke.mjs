import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('output/playwright', { recursive: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    const backendRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/\/(api|ws|health)(\/|\?|$)/.test(new URL(request.url()).pathname)) backendRequests.push(request.url());
    });
    await page.goto(process.env.DEMO_URL || 'http://127.0.0.1:4174');
    await page.getByText('Interactive demo', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Introduce the project', exact: true }).click();
    await page.getByText('One runtime, three ways to interact', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Run a tool-calling demo', exact: true }).click();
    await page.getByText('Tool-calling run complete', { exact: false }).waitFor();
    assert.equal(await page.locator('.demo-tool-call').count(), 4);
    await page.locator('.demo-tool-call summary').first().click();
    await page.getByText('Anomalocaris feeding appendages', { exact: false }).first().waitFor();
    await page.getByRole('button', { name: 'Inspector', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: 'Open example conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.getByRole('heading', { name: 'Your AI, on standby. 24/7.', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pause standby', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Plan a daily check-in', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Resume standby', exact: true }).click();
    await page.getByRole('button', { name: 'Buddy', exact: true }).click();
    await page.getByRole('button', { name: 'Simulate connection', exact: true }).click();
    await page.getByText('Simulated device connected', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
    await page.getByRole('button', { name: 'Try Research', exact: true }).click();
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await page.getByRole('button', { name: 'Run example', exact: true }).click();
    await page.getByText('Example run complete', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await page.getByRole('button', { name: 'View web-search', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    for (const tab of ['Agent', 'Bot', 'Buddy', 'Preset Models', 'Workflows', 'Plugins']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${tab} overflows at ${width}px`);
      assert.equal(await page.locator('body').evaluate(el => /[\u4e00-\u9fff]/.test(el.innerText)), false, `${tab} contains non-English copy`);
      await page.screenshot({ path: `output/playwright/demo-${tab.replaceAll(' ', '-').toLowerCase()}-${width}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(backendRequests, []);
    await page.close();
  }
  console.log('Demo smoke passed: six views, chat, dialogs, preset selection, workflow, simulated device; desktop/mobile; no backend requests or page errors.');
} finally {
  await browser.close();
}
