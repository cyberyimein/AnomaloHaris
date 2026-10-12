import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createBotSmokeHost } from './bot-smoke-host.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const token = 'fixture-admin-token';
const fixture = await createBotSmokeHost({ managementToken: token });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(fixture.url);
  await page.getByRole('button', { name: 'Bot', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const drawer = page.getByRole('dialog');
  const input = drawer.getByLabel('管理 Token', { exact: true });
  await input.fill('incorrect-token');
  await drawer.getByRole('button', { name: '保存并验证', exact: true }).click();
  await drawer.getByRole('alert').filter({ hasText: 'Token 未通过验证' }).waitFor();
  assert.equal(await page.getByRole('radio', { name: '启用', exact: true }).isDisabled(), true);
  await input.fill(token);
  await drawer.getByRole('button', { name: '保存并验证', exact: true }).click();
  await drawer.getByRole('status').filter({ hasText: '管理 Token 已验证' }).waitFor();
  assert.equal(await page.getByRole('radio', { name: '启用', exact: true }).isDisabled(), false);
  assert.equal(await drawer.getByRole('alert').count(), 0);
  await page.reload();
  await page.getByRole('button', { name: 'Bot', exact: true }).click();
  await page.locator('.bot-status').filter({ hasText: '已停用' }).waitFor();
  console.log('Bot token verification passed: incorrect rejected, correct verified, controls restored, persisted across reload.');
} finally {
  await browser.close();
  await fixture.close();
}
