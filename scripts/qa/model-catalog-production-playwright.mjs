import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const baseUrl = (process.env.MODEL_CATALOG_BASE_URL || 'http://192.168.31.31:8000').replace(/\/$/, '');
const adminEnvPath = process.env.MODEL_CATALOG_ADMIN_ENV;
const playwrightPath = process.env.PLAYWRIGHT_MODULE || process.env.BUDDY_PLAYWRIGHT_MODULE;
const { chromium } = playwrightPath ? await import(playwrightPath) : await import('playwright');
const outputBase = `output/playwright/model-catalog-production-${Date.now()}`;
const reportPath = process.env.MODEL_CATALOG_PRODUCTION_REPORT || `${outputBase}.json`;
const screenshots = {
  modelsDesktop: process.env.MODEL_CATALOG_PRODUCTION_MODELS_SCREENSHOT || `${outputBase}-models-desktop.png`,
  presetDesktop: process.env.MODEL_CATALOG_PRODUCTION_PRESET_SCREENSHOT || `${outputBase}-preset-desktop.png`,
  modelsMobile: process.env.MODEL_CATALOG_PRODUCTION_MODELS_MOBILE_SCREENSHOT || `${outputBase}-models-mobile.png`,
  presetMobile: process.env.MODEL_CATALOG_PRODUCTION_PRESET_MOBILE_SCREENSHOT || `${outputBase}-preset-mobile.png`,
};

function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  if (!value) return '';
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    let closingQuote = -1;
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === quote && value[index - 1] !== '\\') {
        closingQuote = index;
        break;
      }
    }
    if (closingQuote >= 0) {
      const inner = value.slice(1, closingQuote);
      if (quote === '"') {
        try { return JSON.parse(`"${inner}"`); } catch { return inner; }
      }
      return inner;
    }
  }
  const commentStart = value.search(/\s+#/);
  return commentStart < 0 ? value : value.slice(0, commentStart).trimEnd();
}

async function readAdminToken() {
  if (!adminEnvPath) throw new Error('Set MODEL_CATALOG_ADMIN_ENV to the private deployment env file path.');
  let content;
  try {
    content = await readFile(resolve(adminEnvPath), 'utf8');
  } catch {
    throw new Error('Could not read the private env file named by MODEL_CATALOG_ADMIN_ENV.');
  }
  const entries = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) entries.set(match[1], parseEnvValue(match[2]));
  }
  const canonicalAdminToken = entries.get('ANOMALOHARIS_ADMIN_TOKEN');
  const legacyAdminToken = entries.get('ANOMALO_ADMIN_TOKEN'); // naming-compat
  const token = canonicalAdminToken ?? legacyAdminToken; // naming-compat
  if (!token) throw new Error('The private env file does not contain a non-empty admin token.');
  return token;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertNoHorizontalOverflow(page, width, view) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    bodyViewport: document.body.clientWidth,
    body: document.body.scrollWidth,
  }));
  if (dimensions.document > dimensions.viewport || dimensions.body > dimensions.bodyViewport) {
    throw new Error(`${view} overflows horizontally at ${width}px: ${JSON.stringify(dimensions)}`);
  }
}

async function assertHeaderDoesNotOverlap(page, width) {
  const boxes = await page.evaluate(() => {
    const nav = document.querySelector('.app-nav')?.getBoundingClientRect();
    const actions = document.querySelector('.header-actions')?.getBoundingClientRect();
    return nav && actions
      ? { nav: { left: nav.left, right: nav.right, top: nav.top, bottom: nav.bottom }, actions: { left: actions.left, right: actions.right, top: actions.top, bottom: actions.bottom } }
      : null;
  });
  if (!boxes) throw new Error('The primary navigation or status area is missing.');
  const overlaps = boxes.nav.right > boxes.actions.left && boxes.nav.left < boxes.actions.right
    && boxes.nav.bottom > boxes.actions.top && boxes.nav.top < boxes.actions.bottom;
  if (overlaps) throw new Error(`Primary navigation overlaps the status area at ${width}px: ${JSON.stringify(boxes)}`);
}

async function saveScreenshot(page, path) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const screenshot = await page.screenshot({ fullPage: true });
  await writeFile(path, screenshot, { flag: 'wx' });
}

const adminToken = await readAdminToken();
const blockedMutations = [];
const pageErrors = [];
const readMethods = [];
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => pageErrors.push(error.message.replaceAll(adminToken, '[redacted]')));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const path = new URL(request.url()).pathname;
    if (method !== 'GET') {
      blockedMutations.push({ method, path });
      await route.abort('blockedbyclient');
      return;
    }
    readMethods.push({ method, path });
    await route.continue();
  });
  await page.addInitScript((token) => localStorage.setItem('anomaloharis.adminToken', token), adminToken);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('heading', { name: 'System defaults' }).waitFor();
  await page.locator('.catalog-row').first().waitFor({ state: 'visible' });
  const modelCount = await page.locator('.catalog-row').count();
  assert(modelCount > 0, 'The deployed model catalog is empty.');
  const modelRows = await page.locator('.catalog-row').evaluateAll((rows) => rows.map((row) => ({
    name: row.querySelector('.catalog-row-main strong')?.textContent?.trim() || '',
    model: row.querySelector('.catalog-row-main code')?.textContent?.trim() || '',
    status: row.querySelector('.catalog-status')?.textContent?.trim() || '',
  })));
  const defaults = {};
  for (const [key, label] of [['default_model_id', 'Default model'], ['research_model_id', 'Research subagent']]) {
    const select = page.getByLabel(label);
    const id = await select.inputValue();
    const selectedLabel = await select.locator('option:checked').textContent();
    assert(id, `${label} has no current catalog binding.`);
    assert(selectedLabel?.trim(), `${label} has no selected option.`);
    defaults[key] = { id, label: selectedLabel.trim() };
  }
  await assertNoHorizontalOverflow(page, 1280, 'Model catalog');
  await assertHeaderDoesNotOverlap(page, 1280);
  await saveScreenshot(page, screenshots.modelsDesktop);

  await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
  await page.locator('.preset-agent-card-copy strong').first().waitFor({ state: 'visible' });
  const presetNames = await page.locator('.preset-agent-card-copy strong').allTextContents();
  const defaultPresetIndex = presetNames.findIndex((name) => name.trim().toLowerCase() === 'anomaloharis');
  const presetIndex = defaultPresetIndex >= 0 ? defaultPresetIndex : 0;
  const presetName = presetNames[presetIndex]?.trim();
  assert(presetName, 'No existing preset is available to inspect.');
  await page.locator('.preset-agent-card').nth(presetIndex).click();
  await page.getByLabel('Select model catalog entry').waitFor({ state: 'visible' });
  const modelSelect = page.getByLabel('Select model catalog entry');
  assert(!(await modelSelect.isDisabled()), 'The preset model selector is unavailable.');
  const presetModelId = await modelSelect.inputValue();
  const presetOption = modelSelect.locator('option:checked');
  const presetOptionLabel = (await presetOption.textContent())?.trim() || '';
  const currentProviderText = await page.locator('.preset-field-model small').filter({ hasText: 'Current provider model:' }).textContent().catch(() => '');
  const presetRefText = await page.locator('.preset-api-callout small').textContent().catch(() => '');
  assert(presetModelId, 'The existing preset has no selected catalog model ID.');
  assert(presetOptionLabel, 'The existing preset selection has no visible model value.');
  assert(currentProviderText?.includes('Current provider model:'), 'The current provider model value is not visible in the preset editor.');
  await assertNoHorizontalOverflow(page, 1280, 'Preset editor');
  await assertHeaderDoesNotOverlap(page, 1280);
  await saveScreenshot(page, screenshots.presetDesktop);

  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('heading', { name: 'System defaults' }).waitFor();
  await assertNoHorizontalOverflow(page, 375, 'Model catalog');
  await saveScreenshot(page, screenshots.modelsMobile);
  await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
  await page.locator('.preset-agent-card-copy strong').first().waitFor({ state: 'visible' });
  const mobilePresetNames = await page.locator('.preset-agent-card-copy strong').allTextContents();
  const mobilePresetIndex = mobilePresetNames.findIndex((name) => name.trim() === presetName);
  assert(mobilePresetIndex >= 0, 'The selected preset is missing from the mobile preset list.');
  await page.locator('.preset-agent-card').nth(mobilePresetIndex).click();
  await page.getByLabel('Select model catalog entry').waitFor({ state: 'visible' });
  await assertNoHorizontalOverflow(page, 375, 'Preset editor');
  await saveScreenshot(page, screenshots.presetMobile);

  assert(blockedMutations.length === 0, `Blocked non-GET API requests: ${JSON.stringify(blockedMutations)}`);
  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join('; ')}`);

  const report = {
    baseUrl,
    checks: ['model catalog count', 'current default selections', 'existing preset model selection', 'current provider model display', '1280px and 375px layouts', 'no non-GET API requests'],
    modelCount,
    models: modelRows,
    defaults,
    preset: { name: presetName, ref: presetRefText.replace(/^Model Ref:\s*/, '').trim(), modelId: presetModelId, selectedLabel: presetOptionLabel, currentProviderModel: currentProviderText.replace(/^\s*Current provider model:\s*/, '').trim() },
    viewportWidths: [1280, 375],
    apiMethods: [...new Set(readMethods.map((request) => request.method))],
    blockedMutations,
    noUncaughtBrowserErrors: true,
    screenshots,
  };
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
} catch (error) {
  const safeMessage = String(error?.message || error).replaceAll(adminToken, '[redacted]');
  console.error(`Production model catalog check failed: ${safeMessage}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
