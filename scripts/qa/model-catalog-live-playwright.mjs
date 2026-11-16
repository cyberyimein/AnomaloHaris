import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '../..');
const playwrightPath = process.env.PLAYWRIGHT_MODULE || process.env.BUDDY_PLAYWRIGHT_MODULE;
const { chromium } = playwrightPath ? await import(playwrightPath) : await import('playwright');
const testDirectory = await mkdtemp(join(tmpdir(), 'anomaloharis-model-catalog-qa-'));
const adminToken = `qa-${randomBytes(24).toString('hex')}`;
const backendPort = await reservePort();
const frontendPort = await reservePort();
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const backendEntry = join(repositoryRoot, 'apps/node-host/dist/main.js');
const viteEntry = join(repositoryRoot, 'node_modules/vite/bin/vite.js');
const backendOutput = [];
const viteOutput = [];
const mutationRequests = [];
const reportBase = `output/playwright/model-catalog-live-${Date.now()}`;
let backendProcess;
let viteProcess;
let browser;

function rememberOutput(target, chunk) {
  target.push(String(chunk));
  if (target.join('').length > 12000) target.splice(0, target.length - 3);
}

function startProcess(command, args, options, output) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => rememberOutput(output, chunk));
  child.stderr.on('data', (chunk) => rememberOutput(output, chunk));
  return child;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port.');
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitForHttp(url, child, output, label) {
  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before becoming ready.\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${label} did not become ready: ${lastError || 'timeout'}\n${output.join('')}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  const timeout = new Promise((resolvePromise) => setTimeout(() => resolvePromise('timeout'), 6000));
  if (await Promise.race([exited, timeout]) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${backendUrl}${path}`, {
    ...options,
    headers: {
      'X-AnomaloHaris-Admin-Token': adminToken,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} returned ${response.status}: ${payload.error || text}`);
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  backendProcess = startProcess(process.execPath, [backendEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(backendPort),
      ANOMALOHARIS_ENV: 'test',
      ANOMALOHARIS_DATA_DIR: testDirectory,
      ANOMALOHARIS_SESSION_DB_PATH: join(testDirectory, 'sessions.sqlite3'),
      ANOMALOHARIS_PRESET_MODEL_DB_PATH: join(testDirectory, 'preset-models.sqlite3'),
      ANOMALOHARIS_COMPUTE_DB_PATH: join(testDirectory, 'compute.sqlite3'),
      ANOMALOHARIS_WORKFLOW_DB_PATH: join(testDirectory, 'workflows.sqlite3'),
      ANOMALOHARIS_ADMIN_TOKEN: adminToken,
      ANOMALOHARIS_PI_EXTENSIONS_ENABLED: 'false',
      ANOMALOHARIS_BUDDY_SERVICE_URL: '',
      ANOMALOHARIS_BUDDY_SERVICE_TOKEN: '',
      BUDDY_ADMIN_TOKEN: '',
      ANOMALOHARIS_SERVICE_TOKENS: '[]',
      ANOMALOHARIS_SERVICE_TOKEN: '',
      ANOMALOHARIS_FRONTEND_DIR: '',
      ANOMALOHARIS_ARTIFACT_SECRET: '',
      FRUITSPY_PYTHON_TOOL_BASE_URL: '',
      FRUITSPY_PYTHON_TOOL_TOKEN: '',
      PYTHON_SANDBOX_ENABLED: 'false',
      WEB_TOOLS_ENABLED: 'false',
      OPENROUTER_MODEL: 'qa-provider/default-v1',
      WEB_RESEARCH_SUBAGENT_MODEL: 'qa-provider/research-v1',
      OPENROUTER_API_KEY: '',
      OPENROUTER_MANAGEMENT_API_KEY: '',
      OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
    },
  }, backendOutput);
  await waitForHttp(`${backendUrl}/health`, backendProcess, backendOutput, 'Node Host');

  viteProcess = startProcess(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
    cwd: join(repositoryRoot, 'frontend'),
    env: { ...process.env, ANOMALOHARIS_BACKEND_URL: backendUrl },
  }, viteOutput);
  await waitForHttp(frontendUrl, viteProcess, viteOutput, 'Vite');

  const catalogBefore = await api('/api/manage/model-catalog');
  const defaultsBefore = catalogBefore.defaults;
  assert(catalogBefore.models.length >= 2, 'Synthetic startup should seed default and research catalog entries.');
  assert(catalogBefore.models.some((model) => model.id === defaultsBefore.default_model_id), 'Default model ID does not resolve in the real catalog.');
  const presetData = await api('/api/manage/preset-models');
  const defaultPreset = presetData.preset_models.find((model) => model.ref === 'anomaloharis@1');
  assert(defaultPreset?.status === 'published', 'The seeded default preset is missing or not published.');

  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/manage/model-catalog') || request.url().includes('/api/manage/preset-models')) {
      let body = {};
      try { body = request.postDataJSON() || {}; } catch { /* Read-only request. */ }
      mutationRequests.push({ method: request.method(), url: request.url(), body });
    }
  });
  await page.addInitScript((token) => localStorage.setItem('anomaloharis.adminToken', token), adminToken);
  await page.goto(frontendUrl, { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('heading', { name: 'System defaults' }).waitFor();
  await page.getByRole('button', { name: 'Add model' }).click();
  await page.getByLabel('Stable ID').fill('qa-catalog-source');
  await page.getByLabel('Display name').fill('QA Catalog Source');
  await page.getByLabel('Actual model ID').fill('qa-provider/source-v1');
  await page.getByRole('button', { name: 'Create model' }).click();
  await page.getByText('Created QA Catalog Source.', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Add model' }).click();
  await page.getByLabel('Stable ID').fill('qa-catalog-target');
  await page.getByLabel('Display name').fill('QA Catalog Target');
  await page.getByLabel('Actual model ID').fill('qa-provider/target-v1');
  await page.getByRole('button', { name: 'Create model' }).click();
  await page.getByText('Created QA Catalog Target.', { exact: true }).waitFor();

  const sourceRows = await api('/api/manage/model-catalog');
  const sourceModel = sourceRows.models.find((model) => model.id === 'qa-catalog-source');
  await page.getByLabel('Default model').selectOption('qa-catalog-source');
  await page.getByRole('button', { name: 'Save defaults' }).click();
  await page.getByText('System defaults saved.', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Preset Models', exact: true }).click();
  await page.locator('.preset-agent-card-copy strong').first().waitFor({ state: 'visible' });
  const presetNames = await page.locator('.preset-agent-card-copy strong').allTextContents();
  const presetIndex = presetNames.findIndex((name) => name.trim() === defaultPreset.name);
  assert(presetIndex >= 0, `Could not find the seeded preset card named ${defaultPreset.name}.`);
  await page.locator('.preset-agent-card').nth(presetIndex).click();
  await page.getByLabel('Filter model catalog').fill('QA Catalog Source');
  await page.getByLabel('Select model catalog entry').selectOption('qa-catalog-source');
  const presetSaveButton = page.getByRole('button', { name: 'Save model', exact: true });
  const presetSaveDisabled = await presetSaveButton.isDisabled();
  const presetSaveResponsePromise = page.waitForResponse((response) => (
    response.url().includes('/api/manage/preset-models/anomaloharis/versions/1') && response.request().method() === 'PUT'
  ), { timeout: 8000 }).catch(() => null);
  await presetSaveButton.click();
  const presetSaveResponse = await presetSaveResponsePromise;
  const presetSaveStatus = presetSaveResponse?.status() ?? null;
  const presetSavePayload = presetSaveResponse ? await presetSaveResponse.text() : '';
  await page.locator('.preset-notice').waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  const presetNotice = page.locator('.preset-notice');
  const presetSaveNotice = await presetNotice.count() ? (await presetNotice.first().textContent())?.trim() : '';
  assert(!presetSaveDisabled && presetSaveResponse && presetSaveResponse.ok() && presetSaveNotice === 'Saved anomaloharis@1.', `Preset binding save failed: disabled=${presetSaveDisabled}; notice=${presetSaveNotice || 'none'}; response=${presetSaveStatus} ${presetSavePayload}; page=${(await page.locator('body').innerText()).slice(-1200)}`);

  const changedPreset = (await api('/api/manage/preset-models')).preset_models.find((model) => model.ref === 'anomaloharis@1');
  assert(changedPreset.provider_model_id === 'qa-catalog-source', 'Preset selection did not persist the catalog ID.');
  assert(changedPreset.version === defaultPreset.version, 'Changing the preset model binding changed its version.');
  assert(changedPreset.provider_model === 'qa-provider/source-v1', 'Preset response did not resolve the current catalog model.');
  assert(changedPreset.compiled_hash === defaultPreset.compiled_hash, 'Changing the preset catalog binding changed its compiled hash.');

  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('heading', { name: 'System defaults' }).waitFor();
  await page.getByRole('button', { name: /QA Catalog Source/ }).click();

  const impact = await api('/api/manage/model-catalog/qa-catalog-source/impact');
  assert(impact.preset_refs.includes('anomaloharis@1'), 'Impact preview omitted the preset reference.');
  assert(impact.default_keys.includes('default_model_id'), 'Impact preview omitted the system default reference.');
  const defaultsWrite = mutationRequests.findLast((request) => request.method === 'PUT' && request.url.endsWith('/model-catalog/defaults'));
  assert(defaultsWrite?.body.expected_revision === defaultsBefore.revision, 'Defaults save omitted the expected revision.');

  await page.getByRole('button', { name: 'Replace references…' }).click();
  await page.getByRole('heading', { name: 'Replace QA Catalog Source' }).waitFor();
  await page.getByLabel('Move to').selectOption('qa-catalog-target');
  const referenceChecks = page.locator('.catalog-modal .catalog-check input[type="checkbox"]');
  assert(await referenceChecks.count() === 2, 'Replacement preview should show the preset and system default references.');
  await page.getByRole('button', { name: 'Apply replacement' }).click();
  await page.getByText('References replaced. Preset versions were preserved.', { exact: true }).waitFor();
  const replacement = mutationRequests.findLast((request) => request.method === 'POST' && request.url.endsWith('/qa-catalog-source/replace'));
  assert(replacement?.body.expected_revision === sourceModel.revision, 'Reference replacement omitted the source expected revision.');
  assert(replacement?.body.preset_refs?.includes('anomaloharis@1') && replacement.body.include_defaults === true, 'Replacement did not send the previewed references.');

  const sourceImpactAfter = await api('/api/manage/model-catalog/qa-catalog-source/impact');
  const targetImpactAfter = await api('/api/manage/model-catalog/qa-catalog-target/impact');
  const defaultsAfter = (await api('/api/manage/model-catalog')).defaults;
  const presetAfterReplacement = (await api('/api/manage/preset-models')).preset_models.find((model) => model.ref === 'anomaloharis@1');
  assert(!sourceImpactAfter.preset_refs.length && !sourceImpactAfter.default_keys.length, 'Replacement left references on the source model.');
  assert(targetImpactAfter.preset_refs.includes('anomaloharis@1') && targetImpactAfter.default_keys.includes('default_model_id'), 'Replacement did not move references to the target model.');
  assert(defaultsAfter.default_model_id === 'qa-catalog-target', 'Default selection did not follow replacement.');
  assert(presetAfterReplacement.provider_model_id === 'qa-catalog-target' && presetAfterReplacement.version === defaultPreset.version && presetAfterReplacement.compiled_hash === defaultPreset.compiled_hash, 'Preset binding, version, or compiled hash changed after replacement.');

  await page.getByRole('textbox', { name: 'Actual model ID' }).fill('qa-provider/source-v2');
  await page.getByRole('button', { name: 'Save model', exact: true }).click();
  await page.getByText('Model updated. New runs will use this configuration.', { exact: true }).waitFor();
  const currentSource = (await api('/api/manage/model-catalog')).models.find((model) => model.id === 'qa-catalog-source');
  assert(currentSource.model === 'qa-provider/source-v2' && currentSource.revision === 2, 'Catalog edit did not persist or increment its revision.');
  await page.locator('.catalog-history-row').filter({ hasText: 'Revision 1' }).getByRole('button', { name: 'Restore' }).click();
  await page.getByText('Restored revision 1 as a new model revision.', { exact: true }).waitFor();
  const restoredSource = (await api('/api/manage/model-catalog')).models.find((model) => model.id === 'qa-catalog-source');
  assert(restoredSource.model === 'qa-provider/source-v1' && restoredSource.revision === 3, 'Restoration did not create a new revision with historical configuration.');
  const restoreRequest = mutationRequests.findLast((request) => request.method === 'POST' && request.url.endsWith('/qa-catalog-source/restore'));
  assert(restoreRequest?.body.revision === 1 && restoreRequest.body.expected_revision === 2, 'Restore omitted its historical and expected revisions.');

  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join('; ')}`);
  const reportPath = process.env.MODEL_CATALOG_LIVE_REPORT || `${reportBase}.json`;
  const screenshotPath = process.env.MODEL_CATALOG_LIVE_SCREENSHOT || `${reportBase}.png`;
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await mkdir(dirname(resolve(screenshotPath)), { recursive: true });
  const screenshot = await page.screenshot({ fullPage: true });
  await writeFile(screenshotPath, screenshot, { flag: 'wx' });
  const report = {
    checks: ['real temporary SQLite catalog', 'model create and edit', 'impact preview', 'defaults update with expected revision', 'existing builtin preset dropdown save', 'preset version and compiled hash preserved', 'reference replacement', 'history restore as new revision'],
    preset: defaultPreset.ref,
    finalSourceRevision: restoredSource.revision,
    finalDefaultModelId: defaultsAfter.default_model_id,
    temporaryDataDir: testDirectory,
    screenshot: screenshotPath,
    noProviderCalls: true,
    noUncaughtBrowserErrors: true,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
} finally {
  await browser?.close();
  await stopProcess(viteProcess);
  await stopProcess(backendProcess);
  console.log(`Temporary SQLite fixture retained at ${testDirectory}`);
}
