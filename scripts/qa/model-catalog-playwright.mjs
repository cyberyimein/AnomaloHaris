import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const playwrightPath = process.env.PLAYWRIGHT_MODULE || process.env.BUDDY_PLAYWRIGHT_MODULE;
const { chromium } = playwrightPath ? await import(playwrightPath) : await import('playwright');
const baseUrl = process.env.MODEL_CATALOG_BASE_URL || 'http://127.0.0.1:5173';
const runStamp = Date.now();
const outputPath = process.env.MODEL_CATALOG_REPORT || `output/playwright/model-catalog-report-${runStamp}.json`;
const desktopScreenshotPath = process.env.MODEL_CATALOG_SCREENSHOT || `output/playwright/model-catalog-desktop-${runStamp}.png`;
const embeddedScreenshotPath = `output/playwright/model-catalog-embedded-${runStamp}.png`;
const defaultDropdownScreenshotPath = `output/playwright/model-catalog-default-dropdown-${runStamp}.png`;
const mobileDropdownScreenshotPath = `output/playwright/model-catalog-mobile-dropdown-${runStamp}.png`;

const models = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash', adapter: 'openai-compatible', model: 'deepseek/deepseek-v4.1-flash-1017', credential_ref: 'openrouter-primary', tool_protocol: 'auto', active: true, revision: 1, usage_count: 2, created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' },
  { id: 'research-model', name: 'Research Model', adapter: 'openai-compatible', model: 'deepseek/deepseek-v4-flash-0731', credential_ref: 'openrouter-primary', tool_protocol: 'auto', active: true, revision: 3, usage_count: 1, created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' },
  { id: 'unused-model', name: 'provider/unused', adapter: 'openai-compatible', model: 'provider/unused', active: true, revision: 1, usage_count: 0, created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' },
  { id: 'disabled-model', name: 'Disabled Model', adapter: 'openai-compatible', model: 'provider/disabled', active: false, revision: 1, usage_count: 0, created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' },
];
let defaults = { default_model_id: 'deepseek-flash', research_model_id: 'disabled-model', revision: 2 };
let catalogUnavailable = false;
let forceRevisionConflict = false;
let delayedImpact = null;
const calls = [];
const preset = {
  ref: 'anomaloharis@1',
  name: 'anomaloharis',
  version: 1,
  description: 'Default assistant',
  status: 'published',
  provider_model_id: 'deepseek-flash',
  provider_model: models[0].model,
  definition: {
    name: 'anomaloharis', version: 1, description: 'Default assistant',
    provider: { adapter: 'openai-compatible', model: models[0].model, credential_ref: 'openrouter-primary', tool_protocol: 'auto' },
    prompt: { profile: 'agent', system: 'Be useful.' },
    plugins: { fixed: ['host-core'], allowed_tools: [], bootstrap_tools: [] },
    policy: { temperature: 0.4, search_mode: 'diy' },
    metadata: { ghost: '👻' },
  },
  tool_catalog: [], allowed_tools: [], bootstrap_tools: [], fixed_plugins: ['host-core'],
  skills: [], policy: { search_mode: 'diy' },
};

const json = (body) => ({ contentType: 'application/json', body: JSON.stringify(body) });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function itemFor(pathname) {
  const match = pathname.match(/^\/api\/manage\/model-catalog\/([^/]+)$/);
  return match ? models.find((model) => model.id === decodeURIComponent(match[1])) : null;
}
function impactFor(id) {
  return {
    model_id: id,
    preset_refs: preset.provider_model_id === id ? [preset.ref] : [],
    default_keys: Object.entries(defaults).filter(([key, value]) => key !== 'revision' && value === id).map(([key]) => key),
  };
}
function deferImpact(id, status) {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const response = new Promise((resolve) => { release = resolve; });
  delayedImpact = { id, status, markStarted, response };
  return { started, release };
}

await page.route('**/api/**', async (route) => {
  const request = route.request();
  const { pathname, searchParams } = new URL(request.url());
  const method = request.method();
  let body = {};
  try { body = request.postDataJSON() || {}; } catch { /* Request has no JSON body. */ }
  calls.push({ method, pathname, body: clone(body) });

  if (pathname === '/api/runtime') return route.fulfill(json({ runtime: 'node', model: models[0].model, default_preset_model: 'anomaloharis@1' }));
  if (pathname === '/api/preset-models' && method === 'GET') return route.fulfill(json({ preset_models: [clone(preset)], default_preset_model: 'anomaloharis@1' }));
  if (pathname === '/api/tools') return route.fulfill(json({ tools: [], providers: [] }));
  if (pathname === '/api/manage/preset-models' && method === 'GET') return route.fulfill(json({ preset_models: [clone(preset)] }));
  if (pathname === '/api/manage/preset-models/anomaloharis/versions/1' && method === 'PUT') {
    preset.definition = clone(body);
    delete preset.definition.provider_model_id;
    preset.provider_model_id = body.provider_model_id;
    preset.provider_model = models.find((model) => model.id === body.provider_model_id)?.model || body.provider.model;
    return route.fulfill(json({ preset_model: clone(preset) }));
  }
  if (pathname === '/api/manage/model-catalog' && method === 'GET') {
    if (catalogUnavailable) return route.fulfill({ status: 503, ...json({ error: 'Catalog temporarily unavailable.' }) });
    return route.fulfill(json({ models: clone(models), defaults: clone(defaults) }));
  }
  if (pathname === '/api/manage/model-catalog' && method === 'POST') {
    if (models.some((model) => model.id === body.id)) return route.fulfill({ status: 409, ...json({ error: 'Model identifier already exists.', error_code: 'model_catalog_id_conflict' }) });
    const created = { ...body, active: true, revision: 1, usage_count: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    models.push(created);
    return route.fulfill({ status: 201, ...json({ model: clone(created) }) });
  }
  if (pathname === '/api/manage/model-catalog/defaults' && method === 'PUT') {
    if (forceRevisionConflict) {
      forceRevisionConflict = false;
      return route.fulfill({ status: 409, ...json({ error: 'Model catalog revision conflict.', error_code: 'model_catalog_revision_conflict' }) });
    }
    defaults = { ...body, revision: defaults.revision + 1 };
    delete defaults.expected_revision;
    return route.fulfill(json({ defaults: clone(defaults) }));
  }
  const impactMatch = pathname.match(/^\/api\/manage\/model-catalog\/([^/]+)\/impact$/);
  if (impactMatch && method === 'GET') {
    const id = decodeURIComponent(impactMatch[1]);
    const delay = delayedImpact?.id === id ? delayedImpact : null;
    if (delay) {
      delayedImpact = null;
      delay.markStarted();
      await delay.response;
      if (delay.status !== 200) return route.fulfill({ status: delay.status, ...json({ error: 'Delayed impact lookup failed.' }) });
    }
    return route.fulfill(json(impactFor(id)));
  }
  const historyMatch = pathname.match(/^\/api\/manage\/model-catalog\/([^/]+)\/history$/);
  if (historyMatch && method === 'GET') {
    const model = models.find((entry) => entry.id === decodeURIComponent(historyMatch[1]));
    return route.fulfill(json({ history: model ? [{ ...clone(model), revision: 0, model: 'deepseek/deepseek-v4-flash-0731' }] : [] }));
  }
  const restoreMatch = pathname.match(/^\/api\/manage\/model-catalog\/([^/]+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    const model = models.find((entry) => entry.id === decodeURIComponent(restoreMatch[1]));
    model.model = 'deepseek/deepseek-v4-flash-0731';
    model.revision += 1;
    return route.fulfill(json({ model: clone(model) }));
  }
  const replaceMatch = pathname.match(/^\/api\/manage\/model-catalog\/([^/]+)\/replace$/);
  if (replaceMatch && method === 'POST') {
    const source = models.find((entry) => entry.id === decodeURIComponent(replaceMatch[1]));
    const target = models.find((entry) => entry.id === body.target_model_id);
    const updatedPresetRefs = body.preset_refs || [];
    if (updatedPresetRefs.includes(preset.ref)) {
      preset.provider_model_id = target.id;
      preset.provider_model = target.model;
    }
    if (body.include_defaults) {
      for (const key of impactFor(source.id).default_keys) defaults[key] = target.id;
      defaults.revision += 1;
    }
    source.usage_count = 0;
    target.usage_count += updatedPresetRefs.length + (body.include_defaults ? impactFor(source.id).default_keys.length : 0);
    return route.fulfill(json({ source_model_id: source.id, target_model_id: target.id, updated_preset_refs: updatedPresetRefs, updated_default_keys: body.include_defaults ? impactFor(source.id).default_keys : [] }));
  }
  const deactivateMatch = pathname.match(/^\/api\/manage\/model-catalog\/([^/]+)\/(activate|deactivate)$/);
  if (deactivateMatch && method === 'POST') {
    const model = models.find((entry) => entry.id === decodeURIComponent(deactivateMatch[1]));
    model.active = deactivateMatch[2] === 'activate';
    model.revision += 1;
    return route.fulfill(json({ model: clone(model) }));
  }
  const model = itemFor(pathname);
  if (model && method === 'PUT') {
    if (forceRevisionConflict) {
      forceRevisionConflict = false;
      return route.fulfill({ status: 409, ...json({ error: 'Model catalog revision conflict.', error_code: 'model_catalog_revision_conflict' }) });
    }
    const id = model.id;
    Object.assign(model, body);
    model.id = id;
    delete model.expected_revision;
    model.revision += 1;
    return route.fulfill(json({ model: clone(model) }));
  }
  if (model && method === 'DELETE') {
    if (model.usage_count) return route.fulfill({ status: 409, ...json({ error: 'Move all references before deleting this model.', error_code: 'model_catalog_referenced' }) });
    models.splice(models.indexOf(model), 1);
    return route.fulfill(json({ deleted: true }));
  }
  if (pathname.startsWith('/api/sessions/')) {
    if (pathname.endsWith('/search-mode')) return route.fulfill(json({ mode: 'diy', modes: [] }));
    return route.fulfill(json({ session: {}, sessions: [], skills: [], active_skills: [], servers: [], active_servers: [] }));
  }
  if (pathname === '/api/sessions') return route.fulfill(json({ sessions: [] }));
  if (pathname === '/api/prompts') return route.fulfill(json({ profile: 'agent', content: 'Be useful.' }));
  if (pathname === '/api/memory') return route.fulfill(json({ content: '', memories: [] }));
  if (pathname === '/api/skills') return route.fulfill(json({ skills: [] }));
  if (pathname === '/api/mcp') return route.fulfill(json({ servers: [] }));
  if (pathname === '/api/openrouter/credits') return route.fulfill(json({ status: 'ready', configured: true, remaining_credits: 20 }));
  return route.fulfill({ status: 404, ...json({ error: `Mock route not found: ${method} ${pathname}` }) });
});

async function assertNoHorizontalOverflow(width) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  if (dimensions.document > dimensions.viewport || dimensions.body > dimensions.viewport) {
    throw new Error(`Model catalog overflows at ${width}px: ${JSON.stringify(dimensions)}`);
  }
}

async function assertHeaderNoOverlap(width) {
  const layout = await page.evaluate(() => {
    const nav = document.querySelector('.app-nav')?.getBoundingClientRect();
    const actions = document.querySelector('.header-actions')?.getBoundingClientRect();
    return nav && actions
      ? { nav: { left: nav.left, right: nav.right, top: nav.top, bottom: nav.bottom }, actions: { left: actions.left, right: actions.right, top: actions.top, bottom: actions.bottom } }
      : null;
  });
  const overlaps = layout && layout.nav.right > layout.actions.left && layout.nav.left < layout.actions.right
    && layout.nav.bottom > layout.actions.top && layout.nav.top < layout.actions.bottom;
  if (!layout || overlaps) {
    throw new Error(`Header navigation overlaps its actions at ${width}px: ${JSON.stringify(layout)}`);
  }
}

function modelOption(page, id) {
  const escapedId = id.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return page.locator(`[role="option"][data-model-id="${escapedId}"]`);
}

async function chooseByKeyboard(page, label, id, searchText = id) {
  const combobox = page.getByRole('combobox', { name: label, exact: true });
  await combobox.click();
  const search = page.getByRole('searchbox', { name: 'Filter models', exact: true });
  await search.fill(searchText);
  const option = modelOption(page, id);
  await option.waitFor({ state: 'visible' });
  await search.press('ArrowDown');
  await search.press('Enter');
  const disabledListbox = page.getByRole('listbox');
  if (await disabledListbox.isVisible()) await search.press('Escape');
  await disabledListbox.waitFor({ state: 'hidden' });
  return combobox;
}

async function assertNoNativeSelects(panel, label) {
  const count = await panel.locator('select').count();
  if (count) throw new Error(`${label} still contains ${count} native select control(s).`);
}

async function assertPopupAnchored(page, trigger, width, label) {
  const triggerBox = await trigger.boundingBox();
  const popupBox = await page.locator('.search-select-popup').boundingBox();
  if (!triggerBox || !popupBox) throw new Error(`${label} trigger or popup is not visible at ${width}px.`);
  const gapBelow = popupBox.y - (triggerBox.y + triggerBox.height);
  const gapAbove = triggerBox.y - (popupBox.y + popupBox.height);
  const isBelow = gapBelow >= 0;
  const gap = isBelow ? gapBelow : gapAbove;
  if (gap < 0 || gap > 12) {
    throw new Error(`${label} popup is detached from its trigger at ${width}px: ${JSON.stringify({ triggerBox, popupBox, gapBelow, gapAbove })}`);
  }
  return { side: isBelow ? 'below' : 'above', gapPx: Math.round(gap * 100) / 100 };
}

async function openModelCatalog(page) {
  await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
  const topNavModels = page.locator('.app-nav').getByRole('button', { name: 'Models', exact: true });
  if (await topNavModels.count()) throw new Error('Model catalog still has a separate Models top-level tab.');
  const tab = page.getByRole('tab', { name: 'Model catalog', exact: true });
  await tab.click();
  if (await tab.getAttribute('aria-selected') !== 'true') throw new Error('The Model catalog subtab did not become active.');
  await page.getByRole('heading', { name: 'System defaults' }).waitFor();
}

async function openPresets(page) {
  await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
  const tab = page.getByRole('tab', { name: 'Presets', exact: true });
  await tab.click();
  if (await tab.getAttribute('aria-selected') !== 'true') throw new Error('The Presets subtab did not become active.');
}

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await openModelCatalog(page);
  const catalogPanel = page.getByRole('tabpanel', { name: 'Model catalog', exact: true });
  await assertNoNativeSelects(catalogPanel, 'Model catalog');
  await page.getByRole('button', { name: /DeepSeek Flash/ }).waitFor();
  await page.getByRole('button', { name: 'Save defaults' }).waitFor();

  const duplicateNameRow = page.locator('[data-model-catalog-row][data-model-id="unused-model"]');
  const duplicateNameText = await duplicateNameRow.innerText();
  if ((duplicateNameText.match(/provider\/unused/g) || []).length !== 1) {
    throw new Error(`A model with identical name and actual ID should be shown once: ${duplicateNameText}`);
  }
  await mkdir('output/playwright', { recursive: true });
  await writeFile(embeddedScreenshotPath, await page.screenshot({ fullPage: true }), { flag: 'wx' });

  const defaultCombo = page.getByRole('combobox', { name: 'Default model', exact: true });
  await defaultCombo.click();
  let search = page.getByRole('searchbox', { name: 'Filter models', exact: true });
  await search.fill('provider/unused');
  await modelOption(page, 'unused-model').waitFor({ state: 'visible' });
  await writeFile(defaultDropdownScreenshotPath, await page.screenshot(), { flag: 'wx' });
  await search.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });

  await defaultCombo.click();
  search = page.getByRole('searchbox', { name: 'Filter models', exact: true });
  await search.fill('Research Model');
  if (await page.getByRole('listbox').getByRole('option').count() !== 1) {
    throw new Error('Model search did not filter the list to the matching option.');
  }
  await search.press('ArrowDown');
  await search.press('Enter');
  const disabledListbox = page.getByRole('listbox');
  if (await disabledListbox.isVisible()) await search.press('Escape');
  await disabledListbox.waitFor({ state: 'hidden' });

  const researchCombo = page.getByRole('combobox', { name: 'Research subagent', exact: true });
  await researchCombo.click();
  search = page.getByRole('searchbox', { name: 'Filter models', exact: true });
  await search.fill('Disabled Model');
  const disabledOption = modelOption(page, 'disabled-model');
  await disabledOption.waitFor({ state: 'visible' });
  const disabledOptionAria = await disabledOption.getAttribute('aria-disabled');
  if (disabledOptionAria !== 'true' && !(await disabledOption.isDisabled())) {
    throw new Error('An inactive model is not marked disabled in the searchable dropdown.');
  }
  await search.press('ArrowDown');
  await search.press('Enter');
  const inactiveListbox = page.getByRole('listbox');
  if (await inactiveListbox.isVisible()) await search.press('Escape');
  await inactiveListbox.waitFor({ state: 'hidden' });
  if (!(await researchCombo.innerText()).includes('Disabled Model')) {
    throw new Error('Keyboard selection accepted an inactive model.');
  }

  await defaultCombo.click();
  search = page.getByRole('searchbox', { name: 'Filter models', exact: true });
  await search.fill('Research');
  await search.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await defaultCombo.click();
  search = page.getByRole('searchbox', { name: 'Filter models', exact: true });
  await search.fill('Research');
  await page.getByRole('heading', { name: 'System defaults' }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: /DeepSeek Flash/ }).click();
  for (const label of ['Provider', 'Tool protocol']) {
    await page.getByRole('combobox', { name: label, exact: true }).waitFor({ state: 'visible' });
  }
  if (!(await page.getByRole('button', { name: 'Delete', exact: true }).isDisabled())) {
    throw new Error('Referenced catalog entries must not be deletable.');
  }
  await page.getByRole('textbox', { name: 'Actual model ID' }).fill('deepseek/deepseek-v4.2-flash');
  await page.getByRole('button', { name: 'Save model' }).click();
  await page.getByText('Model updated. New runs will use this configuration.', { exact: true }).waitFor();
  const modelSave = calls.findLast((call) => call.method === 'PUT' && call.pathname.endsWith('/deepseek-flash'));
  if (modelSave?.body.expected_revision !== 1 || modelSave.body.model !== 'deepseek/deepseek-v4.2-flash' || 'id' in modelSave.body) {
    throw new Error('Model edit did not preserve the stable ID or include the expected revision.');
  }

  await page.getByRole('button', { name: 'Replace references…' }).click();
  await page.getByRole('heading', { name: 'Replace DeepSeek Flash' }).waitFor();
  await chooseByKeyboard(page, 'Move to', 'research-model', 'Research Model');
  await page.getByRole('button', { name: 'Apply replacement' }).click();
  await page.getByText('References replaced. Preset versions were preserved.', { exact: true }).waitFor();
  const replacement = calls.findLast((call) => call.method === 'POST' && call.pathname.endsWith('/deepseek-flash/replace'));
  if (replacement?.body.preset_refs?.[0] !== 'anomaloharis@1' || replacement.body.include_defaults !== true) {
    throw new Error('Replacement did not include the selected preset/defaults.');
  }

  await chooseByKeyboard(page, 'Default model', 'deepseek-flash', 'DeepSeek Flash');
  await page.getByRole('button', { name: 'Save defaults' }).click();
  await page.getByText('System defaults saved.', { exact: true }).waitFor();
  const defaultSave = calls.findLast((call) => call.method === 'PUT' && call.pathname.endsWith('/model-catalog/defaults'));
  if (defaultSave?.body.expected_revision !== 3 || defaultSave.body.default_model_id !== 'deepseek-flash') {
    throw new Error('Default change did not send its expected revision and selected catalog ID.');
  }

  await page.getByRole('button', { name: 'Restore' }).click();
  await page.getByText('Restored revision 0 as a new model revision.', { exact: true }).waitFor();
  const restore = calls.findLast((call) => call.method === 'POST' && call.pathname.endsWith('/deepseek-flash/restore'));
  if (restore?.body.revision !== 0 || restore.body.expected_revision !== 2) throw new Error('Restore did not use its history revision and current revision.');

  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.getByText('Model disabled. Existing references are preserved.', { exact: true }).waitFor();
  if (!(await page.getByRole('button', { name: /DeepSeek Flash/ }).getAttribute('class')).includes('inactive')) {
    throw new Error('Disabled catalog entries are not visibly marked.');
  }

  await openPresets(page);
  const presetsPanel = page.getByRole('tabpanel', { name: 'Presets', exact: true });
  await assertNoNativeSelects(presetsPanel, 'Preset model editor');
  await page.getByRole('button', { name: /Default assistant/ }).waitFor();
  await page.getByRole('button', { name: /Default assistant/ }).click();
  const presetModelCombo = page.getByRole('combobox', { name: 'Model', exact: true });
  await presetModelCombo.waitFor({ state: 'visible' });
  await presetModelCombo.click();
  search = page.getByRole('searchbox', { name: 'Filter models', exact: true });
  await search.fill('provider/unused');
  const duplicateNameOption = modelOption(page, 'unused-model');
  await duplicateNameOption.waitFor({ state: 'visible' });
  const duplicateOptionText = await duplicateNameOption.innerText();
  if ((duplicateOptionText.match(/provider\/unused/g) || []).length !== 1) {
    throw new Error(`A model whose display and actual names match was repeated in the dropdown: ${duplicateOptionText}`);
  }
  await search.press('ArrowDown');
  await search.press('Enter');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Save model', exact: true }).click();
  await page.getByText('Saved anomaloharis@1.', { exact: true }).waitFor();
  const presetSave = calls.findLast((call) => call.method === 'PUT' && call.pathname.endsWith('/versions/1'));
  if (presetSave?.body.version !== 1 || presetSave.body.provider_model_id !== 'unused-model' || presetSave.body.provider.model !== 'deepseek/deepseek-v4.1-flash-1017') {
    throw new Error('Preset dropdown did not save the catalog ID and actual model while preserving its version.');
  }
  if (preset.provider_model !== models.find((model) => model.id === 'unused-model').model) throw new Error('Preset response did not resolve the new catalog model.');

  await openModelCatalog(page);
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertNoHorizontalOverflow(width);
  }
  await page.setViewportSize({ width: 375, height: 667 });
  await defaultCombo.click();
  const mobileListbox = page.getByRole('listbox');
  await mobileListbox.waitFor({ state: 'visible' });
  const mobilePopupAnchor = await assertPopupAnchored(page, defaultCombo, 375, 'Default model');
  const mobileListboxBounds = await mobileListbox.evaluate((element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom, viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight };
  });
  if (mobileListboxBounds.left < 0 || mobileListboxBounds.right > mobileListboxBounds.viewportWidth
      || mobileListboxBounds.top < 0 || mobileListboxBounds.bottom > mobileListboxBounds.viewportHeight) {
    throw new Error(`The searchable model listbox overflows the mobile viewport: ${JSON.stringify(mobileListboxBounds)}`);
  }
  await writeFile(mobileDropdownScreenshotPath, await page.screenshot(), { flag: 'wx' });
  await page.getByRole('searchbox', { name: 'Filter models', exact: true }).press('Escape');
  await mobileListbox.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertHeaderNoOverlap(1280);
  await mkdir(dirname(resolve(desktopScreenshotPath)), { recursive: true });
  await writeFile(desktopScreenshotPath, await page.screenshot({ fullPage: true }), { flag: 'wx' });

  await page.setViewportSize({ width: 1024, height: 900 });
  await assertHeaderNoOverlap(1024);
  await page.setViewportSize({ width: 1280, height: 900 });

  forceRevisionConflict = true;
  await page.getByRole('button', { name: /DeepSeek Flash/ }).click();
  await page.getByRole('textbox', { name: 'Display name' }).fill('Conflicting edit');
  await page.getByRole('button', { name: 'Save model' }).click();
  await page.getByText('This model changed elsewhere. Refresh and review the latest configuration.', { exact: true }).waitFor();

  catalogUnavailable = true;
  await page.getByRole('button', { name: /Refresh.*model catalog/ }).click();
  await page.getByText(/Catalog temporarily unavailable/).waitFor();
  if (!(await page.getByRole('button', { name: 'Add model' }).isDisabled())) throw new Error('Create remained enabled while the catalog was unavailable.');
  await assertNoHorizontalOverflow(320);

  catalogUnavailable = false;
  await page.getByRole('button', { name: /Refresh.*model catalog/ }).click();
  await page.getByRole('button', { name: 'Add model' }).click();
  await page.getByLabel('Stable ID').fill('temporary-model');
  await page.getByLabel('Display name').fill('Temporary Model');
  await page.getByLabel('Actual model ID').fill('provider/temporary-v1');
  await page.getByRole('button', { name: 'Create model' }).click();
  await page.getByText('Created Temporary Model.', { exact: true }).waitFor();
  const create = calls.findLast((call) => call.method === 'POST' && call.pathname === '/api/manage/model-catalog');
  if (create?.body.id !== 'temporary-model' || create.body.model !== 'provider/temporary-v1') throw new Error('Catalog entry was not created with the requested stable and provider IDs.');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('Model deleted.', { exact: true }).waitFor();
  if (models.some((model) => model.id === 'temporary-model')) throw new Error('Unused catalog entry was not deleted.');

  const delayed = deferImpact('deepseek-flash', 503);
  await page.getByRole('button', { name: /DeepSeek Flash/ }).click();
  await delayed.started;
  await page.getByRole('button', { name: /Disabled Model/ }).click();
  await page.getByText('1 reference use this model', { exact: true }).waitFor();
  delayed.release();
  await page.waitForTimeout(80);
  if (await page.locator('.catalog-inline-error').count() !== 0) throw new Error('A delayed failure for the previous model contaminated the new model preview.');

  if (pageErrors.length) throw new Error(`Uncaught browser errors: ${pageErrors.join('; ')}`);
  const report = {
    checks: ['no Models top-level tab', 'model catalog embedded in Preset Models', 'model catalog and preset editors have no native selects', 'search and keyboard selection', 'Escape and outside-click close', 'inactive option stays disabled', 'matching display and actual model names shown once', 'mobile listbox viewport bounds', 'catalog CRUD', 'expected revisions', 'impact preview', 'reference replacement', 'history restore', 'preset versions preserved', 'catalog unavailable state', '320px and 375px layouts', 'desktop and tablet header spacing', 'stale impact response guard'],
    calls: calls.length,
    noHorizontalOverflowAt: [320, 375],
    noUncaughtBrowserErrors: true,
    screenshot: desktopScreenshotPath,
    screenshots: {
      embeddedCatalog: embeddedScreenshotPath,
      duplicateNameDefaultDropdown: defaultDropdownScreenshotPath,
      mobileDropdown: mobileDropdownScreenshotPath,
    },
    mobilePopupAnchor,
  };
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
