const { chromium } = await import(process.env.BUDDY_PLAYWRIGHT_MODULE || 'playwright');
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

// Deliberate live-hardware safety gate. Run only after root authorizes the test:
// BUDDY_BODY_AUDIT_LIVE=1 node /tmp/buddy-body-audit-live.mjs
if (process.env.BUDDY_BODY_AUDIT_LIVE !== '1') {
  throw new Error('Live Buddy audit is gated; wait for root authorization before setting BUDDY_BODY_AUDIT_LIVE=1.');
}

const baseUrl = process.env.BUDDY_BASE_URL || 'http://192.168.31.31:8000';
const tokenPath = process.env.BUDDY_ADMIN_ENV;
assert.ok(tokenPath, 'Set BUDDY_ADMIN_ENV to a protected deployment environment file.');
const envText = await readFile(tokenPath, 'utf8');
const deployEnv = Object.fromEntries(envText.split(/\r?\n/).filter(Boolean).map((line) => {
  const equals = line.indexOf('=');
  return [line.slice(0, equals), line.slice(equals + 1)];
}));
const adminToken = deployEnv.ANOMALOHARIS_ADMIN_TOKEN || deployEnv.ANOMALO_ADMIN_TOKEN; // naming-compat: legacy deployment credential
assert.ok(adminToken, 'Admin token is missing from the protected deploy environment file.');

const adminHeaders = { 'x-anomaloharis-admin-token': adminToken };
const artifactPath = path.resolve('output/playwright/buddy-body-audit-camera.png');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const uiInvocations = [];
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error));
let deviceId;
let resumeLifecycleLighting = false;

page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.pathname !== '/api/buddy/invoke' || request.method() !== 'POST') return;
  try {
    const body = request.postDataJSON();
    uiInvocations.push({
      capability: body.capability,
      args: body.args || {},
      deviceId: body.deviceId,
    });
  } catch {
    uiInvocations.push({ capability: 'unreadable-request', args: {}, deviceId: null });
  }
});

async function readStatus() {
  const response = await page.request.get(`${baseUrl}/api/buddy/status`, { headers: adminHeaders });
  assert.equal(response.status(), 200, `Buddy status returned HTTP ${response.status()}.`);
  return response.json();
}

async function waitForStatus(predicate, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await readStatus();
    if (predicate(latest)) return latest;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for Buddy ${label}.`);
}

async function invokeDirect(capability, args = {}) {
  const startedAt = performance.now();
  const response = await page.request.post(`${baseUrl}/api/buddy/invoke`, {
    headers: adminHeaders,
    data: { deviceId, capability, args },
    timeout: 30000,
  });
  assert.equal(response.status(), 200, `${capability} returned HTTP ${response.status()}.`);
  const body = await response.json();
  return { body, elapsedMs: Math.round(performance.now() - startedAt), responseBytes: Buffer.byteLength(JSON.stringify(body)) };
}

function modeOf(status) {
  return status.state?.mode || status.state?.status || status.state || 'unknown';
}

function grantSnapshot(status) {
  return status.capabilities
    .map(({ name, allowed, effectiveAllowed }) => ({ name, allowed, effectiveAllowed }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function waitForInvokeResponse(capability, timeout = 45000) {
  return page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== '/api/buddy/invoke' || response.request().method() !== 'POST') return false;
    try {
      return response.request().postDataJSON().capability === capability;
    } catch {
      return false;
    }
  }, { timeout });
}

async function readObservation() {
  const response = await page.request.get(`${baseUrl}/api/buddy/observation`, { headers: adminHeaders });
  assert.equal(response.status(), 200, `Buddy observation returned HTTP ${response.status()}.`);
  return response.json();
}

async function waitForObservation(requestId) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const payload = await readObservation();
    const observation = payload.observation;
    if (observation?.deviceId === deviceId && (!requestId || observation.requestId === requestId)) return observation;
    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for the captured Buddy observation.');
}

try {
  await page.goto(`${baseUrl}/`);
  await page.evaluate((token) => localStorage.setItem('anomaloharis.adminToken', token), adminToken);
  await page.reload();
  await page.getByRole('button', { name: 'Buddy', exact: true }).click();
  await page.locator('.buddy-connect-state.online').waitFor({ timeout: 35000 });

  const before = await readStatus();
  assert.equal(before.connected, true, 'Buddy must be online before the live audit.');
  assert.equal(before.actionInProgress, false, 'Buddy must be idle before the live audit.');
  assert.equal(modeOf(before), 'ready', 'Buddy must be awake before the live audit.');
  deviceId = before.deviceId;
  assert.ok(deviceId, 'Buddy status did not provide a deviceId.');

  const baselineGrants = grantSnapshot(before);
  const baselineAgentEnabled = before.agentEnabled;
  const capabilityNames = new Set(before.capabilities.map((capability) => capability.name));
  for (const required of ['head.move', 'camera.capture', 'touch.read', 'power.read', 'led.set', 'led.resume']) {
    assert.ok(capabilityNames.has(required), `Buddy is missing required capability ${required}.`);
  }

  const moveArgs = { pan: 0, moveTimeMs: 800, speed: 20 };
  const moveCallStart = uiInvocations.length;
  const moveStartedAt = performance.now();
  const moveResponsePromise = waitForInvokeResponse('head.move');
  await page.getByRole('button', { name: 'Move head center', exact: true }).click();
  const moveResponse = await moveResponsePromise;
  assert.equal(moveResponse.status(), 200, 'Quick center movement failed.');
  const moveElapsedMs = Math.round(performance.now() - moveStartedAt);
  const moveCalls = uiInvocations.slice(moveCallStart);
  assert.deepEqual(moveCalls, [{ capability: 'head.move', args: moveArgs, deviceId }]);
  await page.waitForTimeout(1200);
  assert.equal(uiInvocations.length - moveCallStart, 1, 'Quick center must make exactly one invoke request.');
  assert.equal(uiInvocations.slice(moveCallStart).some(({ capability }) => capability === 'camera.capture' || capability === 'head.observe'), false,
    'Quick center must not trigger camera capture or head.observe.');

  const centered = await waitForStatus((status) =>
    Number.isFinite(status.state?.head?.pan) && Math.abs(status.state.head.pan) <= 3,
  'head to center');

  const captureCallStart = uiInvocations.length;
  const captureStartedAt = performance.now();
  const captureResponsePromise = waitForInvokeResponse('camera.capture');
  await page.getByRole('button', { name: 'Capture image', exact: true }).click();
  const captureResponse = await captureResponsePromise;
  assert.equal(captureResponse.status(), 200, 'Independent camera capture failed.');
  const captureElapsedMs = Math.round(performance.now() - captureStartedAt);
  const captureBody = await captureResponse.json();
  const captureCalls = uiInvocations.slice(captureCallStart);
  assert.deepEqual(captureCalls, [{ capability: 'camera.capture', args: {}, deviceId }]);

  const image = captureBody.result?.image;
  assert.ok(image, 'camera.capture response did not include result.image.');
  assert.equal(image.mimeType, 'image/png', 'Buddy service should convert RGB565 captures to PNG.');
  assert.equal(image.width, 320, 'Expected a 320 px wide QVGA capture.');
  assert.equal(image.height, 240, 'Expected a 240 px high QVGA capture.');
  assert.ok(Number.isFinite(image.capturedAtMs), 'Device monotonic capturedAtMs was not preserved.');
  assert.equal(image.captureClock, 'device_monotonic', 'Capture clock should identify device monotonic ticks.');
  const imageBytes = Buffer.from(image.data, 'base64');
  assert.ok(imageBytes.length > 0, 'PNG image data was empty.');
  assert.deepEqual([...imageBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Capture data does not have a PNG signature.');
  assert.equal(imageBytes.readUInt32BE(16), 320, 'PNG header width did not match response metadata.');
  assert.equal(imageBytes.readUInt32BE(20), 240, 'PNG header height did not match response metadata.');
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, imageBytes);

  const observation = await waitForObservation(captureBody.requestId);
  assert.equal(observation.capturedAt, null, 'Host receive time must not be reported as camera exposure time.');
  assert.match(observation.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'receivedAt must be an ISO UTC timestamp.');
  assert.ok(Number.isFinite(Date.parse(observation.receivedAt)), 'receivedAt was not a valid timestamp.');
  assert.equal(observation.capability, 'camera.capture');
  assert.equal(observation.result?.image?.capturedAtMs, image.capturedAtMs, 'Observation lost device capturedAtMs.');
  assert.equal(observation.result?.image?.captureClock, 'device_monotonic');

  await page.locator('.buddy-observation-image').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const image = document.querySelector('.buddy-observation-image');
    return image?.complete && image.naturalWidth === 320 && image.naturalHeight === 240;
  }, undefined, { timeout: 15000 });
  const visibleTimestamp = await page.locator('.buddy-observation-panel header p').textContent();
  assert.ok(visibleTimestamp.trim().startsWith('Received '), 'Dashboard should label the service time as Received.');
  assert.ok(!visibleTimestamp.includes('Captured'), 'Dashboard must not present receivedAt as exposure time.');

  // Use a dim warm manual frame while checking that read capabilities preserve its source.
  // The finally block always resumes lifecycle lighting if this point is reached.
  resumeLifecycleLighting = true;
  const manualLed = await invokeDirect('led.set', { color: 0x241800 });
  const manualState = await waitForStatus((status) => status.state?.lighting?.source === 'manual', 'manual lighting');
  const touchRead = await invokeDirect('touch.read');
  const afterTouch = await waitForStatus((status) => !status.actionInProgress, 'touch read completion');
  assert.equal(afterTouch.state?.lighting?.source, 'manual', 'touch.read cleared the manual LED source.');
  const powerRead = await invokeDirect('power.read');
  const afterPower = await waitForStatus((status) => !status.actionInProgress, 'power read completion');
  assert.equal(afterPower.state?.lighting?.source, 'manual', 'power.read cleared the manual LED source.');

  const resume = await invokeDirect('led.resume');
  resumeLifecycleLighting = false;
  const finalStatus = await waitForStatus((status) => status.state?.lighting?.source === 'lifecycle', 'automatic lighting');
  assert.deepEqual(grantSnapshot(finalStatus), baselineGrants, 'Agent capability grants changed during the live audit.');
  assert.equal(finalStatus.agentEnabled, baselineAgentEnabled, 'Agent enabled state changed during the live audit.');
  assert.equal(modeOf(finalStatus), 'ready', 'Buddy should remain awake after the live audit.');
  assert.ok(Number.isFinite(finalStatus.state?.head?.pan) && Math.abs(finalStatus.state.head.pan) <= 3,
    'Buddy head should remain centered after the live audit.');

  const report = {
    deviceId,
    quickCenter: {
      args: moveArgs,
      elapsedMs: moveElapsedMs,
      responseStatus: moveResponse.status(),
      invokeCount: moveCalls.length,
      cameraCallsDuringMove: 0,
      finalPan: centered.state.head.pan,
    },
    capture: {
      elapsedMs: captureElapsedMs,
      responseStatus: captureResponse.status(),
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      imageBytes: imageBytes.length,
      responseJsonBytes: Buffer.byteLength(JSON.stringify(captureBody)),
      requestId: captureBody.requestId,
      receivedAt: observation.receivedAt,
      capturedAt: observation.capturedAt,
      capturedAtMs: image.capturedAtMs,
      captureClock: image.captureClock,
      savedImage: artifactPath,
    },
    readCapabilities: {
      manualSourceBeforeReads: manualState.state.lighting.source,
      sourceAfterTouchRead: afterTouch.state.lighting.source,
      touchResult: touchRead.body.result,
      sourceAfterPowerRead: afterPower.state.lighting.source,
      powerResult: powerRead.body.result,
      ledSetResponseBytes: manualLed.responseBytes,
      ledResumeResponseBytes: resume.responseBytes,
    },
    finalState: {
      mode: modeOf(finalStatus),
      lightingSource: finalStatus.state.lighting.source,
      headPan: finalStatus.state.head.pan,
      grantsUnchanged: true,
      agentEnabledUnchanged: true,
    },
  };
  assert.equal(pageErrors.length, 0, 'Buddy page must not raise uncaught JavaScript errors.');
  const screenshotPath = path.resolve('output/playwright/buddy-body-live-desktop.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  report.screenshot = screenshotPath;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (resumeLifecycleLighting) {
    try {
      await invokeDirect('led.resume');
      await waitForStatus((status) => status.state?.lighting?.source === 'lifecycle', 'automatic lighting cleanup');
    } catch {
      // Never print credentials or response bodies in cleanup errors.
      console.error('Automatic lighting cleanup did not confirm; inspect Buddy status before further testing.');
    }
  }
  await browser.close();
}
