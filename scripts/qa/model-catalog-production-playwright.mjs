import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const baseUrl = (process.env.MODEL_CATALOG_BASE_URL || 'http://192.168.31.31:8000').replace(/\/$/, '');
const adminEnvPath = process.env.MODEL_CATALOG_ADMIN_ENV;
const playwrightPath = process.env.PLAYWRIGHT_MODULE || process.env.BUDDY_PLAYWRIGHT_MODULE;
const { chromium } = playwrightPath ? await import(playwrightPath) : await import('playwright');
const outputBase = `output/playwright/model-catalog-production-${Date.now()}`;
const reportPath = process.env.MODEL_CATALOG_PRODUCTION_REPORT || `${outputBase}.json`;
const screenshots = {
  catalogDesktop: process.env.MODEL_CATALOG_PRODUCTION_CATALOG_SCREENSHOT || `${outputBase}-catalog-desktop.png`,
  presetDesktop: process.env.MODEL_CATALOG_PRODUCTION_PRESET_SCREENSHOT || `${outputBase}-preset-desktop.png`,
  catalogMobile: process.env.MODEL_CATALOG_PRODUCTION_CATALOG_MOBILE_SCREENSHOT || `${outputBase}-catalog-mobile.png`,
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

async function openModelCatalog(page) {
  await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
  const topNavModels = page.locator('.app-nav').getByText('Models', { exact: true });
  assert(await topNavModels.count() === 0, 'The deployed UI still has a Models top-level navigation item.');
  const tab = page.getByRole('tab', { name: 'Model catalog', exact: true });
  await tab.click();
  assert(await tab.getAttribute('aria-selected') === 'true', 'The Model catalog subtab did not become active.');
  await page.getByRole('heading', { name: 'System defaults' }).waitFor();
}

async function openPresets(page) {
  await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
  const tab = page.getByRole('tab', { name: 'Presets', exact: true });
  await tab.click();
  assert(await tab.getAttribute('aria-selected') === 'true', 'The Presets subtab did not become active.');
}

async function assertNoNativeSelects(panel, label) {
  const count = await panel.locator('select').count();
  assert(count === 0, `${label} contains ${count} native select control(s).`);
}

async function assertListboxFitsViewport(page, width, label) {
  const bounds = await page.getByRole('listbox').evaluate((element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom, viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight };
  });
  assert(bounds.left >= 0 && bounds.right <= bounds.viewportWidth && bounds.top >= 0 && bounds.bottom <= bounds.viewportHeight, `${label} listbox overflows at ${width}px: ${JSON.stringify(bounds)}`);
}

async function assertPopupAnchored(page, trigger, width, label) {
  const triggerBox = await trigger.boundingBox();
  const popupBox = await page.locator('.search-select-popup').boundingBox();
  assert(triggerBox && popupBox, `${label} trigger or popup is not visible at ${width}px.`);
  const gapBelow = popupBox.y - (triggerBox.y + triggerBox.height);
  const gapAbove = triggerBox.y - (popupBox.y + popupBox.height);
  const gap = gapBelow >= 0 ? gapBelow : gapAbove;
  assert(gap >= 0 && gap <= 12, `${label} popup is detached from its trigger at ${width}px: ${JSON.stringify({ triggerBox, popupBox, gapBelow, gapAbove })}`);
  return { side: gapBelow >= 0 ? 'below' : 'above', gapPx: Math.round(gap * 100) / 100 };
}

async function openSearchableCombobox(page, label, filterText) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Filter models', exact: true });
  await search.fill(filterText);
  const options = page.getByRole('listbox').getByRole('option');
  assert(await options.count() > 0, `${label} returned no result for its filter.`);
  return { search, options };
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
  let resolveCatalogModels;
  const catalogModelsPromise = new Promise((resolvePromise) => { resolveCatalogModels = resolvePromise; });
  page.on('response', (response) => {
    const request = response.request();
    if (request.method() !== 'GET' || new URL(response.url()).pathname !== '/api/manage/model-catalog') return;
    response.json().then((payload) => resolveCatalogModels(payload.models || [])).catch(() => resolveCatalogModels([]));
  });
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

  await openModelCatalog(page);
  const catalogApiModels = await catalogModelsPromise;
  const catalogPanel = page.getByRole('tabpanel', { name: 'Model catalog', exact: true });
  await assertNoNativeSelects(catalogPanel, 'Model catalog');
  await page.locator('.catalog-row').first().waitFor({ state: 'visible' });
  const modelCount = await page.locator('.catalog-row').count();
  assert(modelCount > 0, 'The deployed model catalog is empty.');
  const renderedRows = await page.locator('[data-model-catalog-row][data-model-id]').evaluateAll((rows) => rows.map((row) => ({
    id: row.getAttribute('data-model-id') || '',
    status: row.querySelector('.catalog-status')?.textContent?.trim() || '',
    text: row.innerText,
  })));
  const catalogModelById = new Map(catalogApiModels.map((model) => [model.id, model]));
  const modelRows = renderedRows.map((row) => {
    const model = catalogModelById.get(row.id);
    return { ...row, name: model?.name || '', model: model?.model || '' };
  });
  assert(modelRows.length === modelCount && modelRows.every((row) => row.name && row.model), 'Not every catalog row resolves to a model from its read-only API response.');
  for (const row of modelRows.filter((entry) => entry.name && entry.name === entry.model)) {
    const occurrences = row.text.split(row.name).length - 1;
    assert(occurrences === 1, `The matching display and actual model names repeat in catalog row ${row.id}.`);
  }
  const defaults = {};
  for (const [key, label] of [['default_model_id', 'Default model'], ['research_model_id', 'Research subagent']]) {
    const combobox = page.getByRole('combobox', { name: label, exact: true });
    const display = (await combobox.innerText()).trim();
    assert(display, `${label} has no visible current catalog binding.`);
    const { search, options } = await openSearchableCombobox(page, label, '');
    await assertListboxFitsViewport(page, 1280, label);
    const selectedOption = page.locator('[role="option"][aria-selected="true"]');
    const id = await selectedOption.getAttribute('data-model-id').catch(() => null);
    assert(await options.count() > 0, `${label} dropdown has no model options.`);
    await search.press('Escape');
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    defaults[key] = { id: id || '', label: display };
  }
  await page.locator('.catalog-row').first().click();
  for (const label of ['Provider', 'Tool protocol']) {
    await page.getByRole('combobox', { name: label, exact: true }).waitFor({ state: 'visible' });
  }
  await assertNoHorizontalOverflow(page, 1280, 'Model catalog');
  await assertHeaderDoesNotOverlap(page, 1280);
  await saveScreenshot(page, screenshots.catalogDesktop);

  await openPresets(page);
  const presetsPanel = page.getByRole('tabpanel', { name: 'Presets', exact: true });
  await assertNoNativeSelects(presetsPanel, 'Preset editor');
  await page.locator('.preset-agent-card-copy strong').first().waitFor({ state: 'visible' });
  const presetNames = await page.locator('.preset-agent-card-copy strong').allTextContents();
  const defaultPresetIndex = presetNames.findIndex((name) => name.trim().toLowerCase() === 'anomaloharis');
  const presetIndex = defaultPresetIndex >= 0 ? defaultPresetIndex : 0;
  const presetName = presetNames[presetIndex]?.trim();
  assert(presetName, 'No existing preset is available to inspect.');
  await page.locator('.preset-agent-card').nth(presetIndex).click();
  await page.getByRole('combobox', { name: 'Model', exact: true }).waitFor({ state: 'visible' });
  const modelCombo = page.getByRole('combobox', { name: 'Model', exact: true });
  await modelCombo.waitFor({ state: 'visible' });
  assert(!(await modelCombo.isDisabled()), 'The preset model selector is unavailable.');
  const presetOptionLabel = (await modelCombo.innerText()).trim();
  const { search: presetSearch } = await openSearchableCombobox(page, 'Model', '');
  await assertListboxFitsViewport(page, 1280, 'Preset model');
  const selectedPresetOption = page.locator('[role="option"][aria-selected="true"]');
  const presetModelId = await selectedPresetOption.getAttribute('data-model-id').catch(() => null) || '';
  await presetSearch.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  const currentProviderText = await page.locator('.preset-field-model small').filter({ hasText: 'Current provider model:' }).textContent().catch(() => '');
  const presetRefText = await page.locator('.preset-api-callout small').textContent().catch(() => '');
  assert(presetOptionLabel, 'The existing preset has no visible selected catalog model.');
  assert(presetOptionLabel, 'The existing preset selection has no visible model value.');
  assert(currentProviderText?.includes('Current provider model:'), 'The current provider model value is not visible in the preset editor.');
  const matchingNameModel = modelRows.find((row) => row.name === row.model);
  if (matchingNameModel) {
    await modelCombo.click();
    await presetSearch.fill(matchingNameModel.model);
    const matchingOption = page.locator(`[role="option"][data-model-id="${matchingNameModel.id}"]`);
    await matchingOption.waitFor({ state: 'visible' });
    const matchingOptionText = await matchingOption.innerText();
    const occurrences = matchingOptionText.split(matchingNameModel.model).length - 1;
    assert(occurrences === 1, `The matching name and actual ID repeat in preset option ${matchingNameModel.id}.`);
    await presetSearch.press('Escape');
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
  }
  await assertNoHorizontalOverflow(page, 1280, 'Preset editor');
  await assertHeaderDoesNotOverlap(page, 1280);
  await saveScreenshot(page, screenshots.presetDesktop);

  await page.setViewportSize({ width: 375, height: 667 });
  await openModelCatalog(page);
  const mobileCatalogCombo = page.getByRole('combobox', { name: 'Default model', exact: true });
  await mobileCatalogCombo.click();
  await page.getByRole('listbox').waitFor({ state: 'visible' });
  const mobileCatalogAnchor = await assertPopupAnchored(page, mobileCatalogCombo, 375, 'Default model');
  await assertListboxFitsViewport(page, 375, 'Model catalog');
  await page.getByRole('searchbox', { name: 'Filter models', exact: true }).press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await assertNoHorizontalOverflow(page, 375, 'Model catalog');
  await saveScreenshot(page, screenshots.catalogMobile);
  await openPresets(page);
  await page.locator('.preset-agent-card-copy strong').first().waitFor({ state: 'visible' });
  const mobilePresetNames = await page.locator('.preset-agent-card-copy strong').allTextContents();
  const mobilePresetIndex = mobilePresetNames.findIndex((name) => name.trim() === presetName);
  assert(mobilePresetIndex >= 0, 'The selected preset is missing from the mobile preset list.');
  await page.locator('.preset-agent-card').nth(mobilePresetIndex).click();
  const mobilePresetCombo = page.getByRole('combobox', { name: 'Model', exact: true });
  await mobilePresetCombo.waitFor({ state: 'visible' });
  await mobilePresetCombo.click();
  await page.getByRole('listbox').waitFor({ state: 'visible' });
  const mobilePresetAnchor = await assertPopupAnchored(page, mobilePresetCombo, 375, 'Preset model');
  await assertListboxFitsViewport(page, 375, 'Preset model');
  await page.getByRole('searchbox', { name: 'Filter models', exact: true }).press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await assertNoHorizontalOverflow(page, 375, 'Preset editor');
  await saveScreenshot(page, screenshots.presetMobile);

  assert(blockedMutations.length === 0, `Blocked non-GET API requests: ${JSON.stringify(blockedMutations)}`);
  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join('; ')}`);

  const report = {
    baseUrl,
    checks: ['no Models top-level tab', 'model catalog embedded in Preset Models', 'catalog and preset pages have no native selects', 'searchable model controls and selected values', 'equal display/actual names shown once when present', 'desktop and mobile listbox viewport bounds', 'current default selections', 'existing preset model selection', 'current provider model display', '1280px and 375px layouts', 'no non-GET API requests'],
    modelCount,
    models: modelRows,
    defaults,
    preset: { name: presetName, ref: presetRefText.replace(/^Model Ref:\s*/, '').trim(), modelId: presetModelId, selectedLabel: presetOptionLabel, currentProviderModel: currentProviderText.replace(/^\s*Current provider model:\s*/, '').trim() },
    viewportWidths: [1280, 375],
    mobilePopupAnchors: { modelCatalog: mobileCatalogAnchor, presetModel: mobilePresetAnchor },
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
