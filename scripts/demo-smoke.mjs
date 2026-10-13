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
    await page.getByRole('button', { name: '介绍这个项目', exact: true }).click();
    await page.getByText('一个运行时，三种入口', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Inspector', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: '打开示例对话', exact: true }).click();
    await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.getByRole('button', { name: '暂停演示', exact: true }).click();
    await page.getByRole('button', { name: '继续演示', exact: true }).click();
    await page.getByRole('button', { name: 'Buddy', exact: true }).click();
    await page.getByRole('button', { name: '模拟连接', exact: true }).click();
    await page.getByText('模拟设备已连接', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
    await page.getByRole('button', { name: '试用 Research', exact: true }).click();
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await page.getByRole('button', { name: '运行示例', exact: true }).click();
    await page.getByText('示例运行完成', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await page.getByRole('button', { name: '查看 web-search', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    for (const tab of ['Agent', 'Bot', 'Buddy', 'Preset Models', 'Workflows', 'Plugins']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${tab} overflows at ${width}px`);
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
