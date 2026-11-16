async (page) => {
  function objectSchema(properties, required = []) {
    return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
  }

  function card(page, capability) {
    return page.locator(`.buddy-capability[data-capability="${capability}"]`);
  }

  async function runCapability(page, capability, label) {
    await card(page, capability).getByRole("button", { name: label }).click();
    await page.waitForFunction(([name, actionLabel]) => {
      const article = document.querySelector(`.buddy-capability[data-capability="${name}"]`);
      const button = [...(article?.querySelectorAll("button") || [])].find((item) => item.textContent.trim() === actionLabel);
      return button && !button.disabled;
    }, [capability, label]);
  }

  async function runScopedButton(page, selector, label) {
    const scope = page.locator(selector);
    await scope.getByRole("button", { name: label, exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"),
    );
  }

  async function runLightingButton(page, button, capability) {
    const previousCount = await page.evaluate(() => window.__buddyInvocations.length);
    await button.click();
    await page.waitForFunction(([count, name]) => {
      const calls = window.__buddyInvocations || [];
      return calls.length > count && calls.at(-1)?.capability === name;
    }, [previousCount, capability]);
    await page.waitForFunction(() =>
      document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"),
    );
  }

  async function waitForMode(page, expectedMode) {
    await page.waitForFunction((mode) => {
      return document.querySelector(".buddy-mode-state strong")?.textContent.trim() === mode;
    }, expectedMode);
  }

  async function assertSelectedTab(page, tabId) {
    const tab = page.locator(`#buddy-tab-${tabId}`);
    if (await tab.getAttribute("tabindex") !== "0" || await tab.getAttribute("aria-selected") !== "true") {
      throw new Error(`Tab ${tabId} should be selected and be the only tab stop.`);
    }
    const tabStates = await page.locator('[role="tablist"] [role="tab"]').evaluateAll((tabs) =>
      tabs.map((item) => ({ tabindex: item.getAttribute("tabindex"), selected: item.getAttribute("aria-selected") })),
    );
    if (tabStates.filter((item) => item.tabindex === "0").length !== 1
      || tabStates.filter((item) => item.selected === "true").length !== 1) {
      throw new Error("Buddy tabs should expose one selected tab and one keyboard tab stop.");
    }
    const controlsId = await tab.getAttribute("aria-controls");
    if (controlsId !== "buddy-tab-panel") throw new Error(`Tab ${tabId} did not reference the shared tab panel.`);
    const tabControls = await page.locator('[role="tablist"] [role="tab"]').evaluateAll((tabs) =>
      tabs.map((item) => item.getAttribute("aria-controls")),
    );
    if (tabControls.some((item) => item !== "buddy-tab-panel") || await page.locator("#buddy-tab-panel").count() !== 1) {
      throw new Error("Every Buddy tab should reference the single active tab panel in the DOM.");
    }
    const panel = page.getByRole("tabpanel");
    if (await panel.getAttribute("id") !== controlsId || await panel.getAttribute("aria-labelledby") !== `buddy-tab-${tabId}`) {
      throw new Error(`Tab ${tabId} and its panel did not expose matching ARIA relationships.`);
    }
    if (!(await tab.evaluate((item) => document.activeElement === item))) {
      throw new Error(`Keyboard navigation did not move focus to tab ${tabId}.`);
    }
  }

  async function assertNoHorizontalOverflow(page, label) {
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      bodyViewport: document.body.clientWidth,
      body: document.body.scrollWidth,
    }));
    if (dimensions.document > dimensions.viewport || dimensions.body > dimensions.bodyViewport) {
      throw new Error(`The ${label} view overflows horizontally at 320px: ${JSON.stringify(dimensions)}.`);
    }
  }

  function assertInvocation(invocations, capability, args, deviceId) {
    const actual = invocations.at(-1);
    if (actual?.deviceId !== deviceId || actual?.capability !== capability || JSON.stringify(actual.args) !== JSON.stringify(args)) {
      throw new Error(`Invoke mismatch for ${capability}: ${JSON.stringify(actual)}`);
    }
  }

  let deviceId = "stackchan-room";
  let connected = true;
  let statusUnavailable = false;
  let delayNextStatusResponse = false;
  let delayedStatusStarted = null;
  let delayedStatusRelease = null;
  let delayedStatusCompleted = null;
  let agentEnabled = false;
  let mode = "ready";
  let guiding = false;
  let headPose = { pan: 0, tilt: 45 };
  let lastInteraction = null;
  let actionInProgress = false;
  let activeAction = null;
  let latestObservation = null;
  let deviceFaults = [];
  let lastInvocationError = null;
  let lastPermission = null;
  const permissionChanges = [];
  let lastAgentRequest = null;
  let lighting = {
    source: "lifecycle",
    pattern: "ready",
    emotion: null,
    remainingMs: 0,
    intensity: 0.5,
    strips: [
      [[0, 56, 32], [0, 72, 40], [0, 88, 48], [0, 72, 40], [0, 56, 32], [0, 40, 24]],
      [[0, 40, 24], [0, 56, 32], [0, 72, 40], [0, 88, 48], [0, 72, 40], [0, 56, 32]],
    ],
  };
  const invocations = [];
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p3sAAAAASUVORK5CYII=";
  const capabilities = [
    { name: "head.move", description: "Move the pan and tilt servos within calibrated safe limits.", allowed: false, effectiveAllowed: false, inputSchema: { type: "object", properties: { pan: { type: "number", minimum: -90, maximum: 90 }, tilt: { type: "number", minimum: 5, maximum: 85 }, moveTimeMs: { type: "integer", minimum: 250, maximum: 3000, default: 800 }, speed: { type: "integer", minimum: 0, maximum: 100, default: 20 } }, additionalProperties: false, anyOf: [{ required: ["pan"] }, { required: ["tilt"] }] } },
    { name: "head.home", description: "Return the head to its home position.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "head.release", description: "Release the head for hand guidance.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "head.hold", description: "Hold the current measured head position.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "led.set", description: "Set the StackChan RGB light bar color.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({ color: { type: "integer", minimum: 0, maximum: 16777215 }, strip: { type: "integer", enum: [0, 1] }, index: { type: "integer", minimum: 0, maximum: 5 } }, ["color"]) },
    { name: "led.express", description: "Show an Agent emotion on the rear light bars.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({ emotion: { type: "string", enum: ["happy", "curious", "thinking", "listening", "speaking", "concerned", "calm"] }, intensity: { type: "number", minimum: 0.1, maximum: 1, default: 0.5 }, durationMs: { type: "integer", minimum: 1000, maximum: 60000, default: 8000 } }, ["emotion"]) },
    { name: "led.resume", description: "Resume automatic lifecycle lighting.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "touch.read", description: "Read touch zones.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({ zone: { type: "integer", enum: [0, 1, 2] } }) },
    { name: "power.read", description: "Read battery voltage, current, and power.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "camera.capture", description: "Capture a fresh image.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "head.observe", description: "Turn toward a direction and capture an image.", requires: ["head.move", "camera.capture"], allowed: false, effectiveAllowed: false, inputSchema: objectSchema({ direction: { type: "string", enum: ["left", "center", "right"] }, tilt: { type: "number", minimum: 5, maximum: 85, default: 45 }, settleMs: { type: "integer", minimum: 0, maximum: 2000, default: 250 } }, ["direction"]) },
    { name: "infrared.send", description: "Transmit an 8-bit NEC address and data value.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({ address: { type: "integer", minimum: 0, maximum: 255 }, data: { type: "integer", minimum: 0, maximum: 255 } }, ["address", "data"]) },
    { name: "infrared.read", description: "Read the latest received NEC code.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "nfc.detect", description: "Detect a nearby NFC tag.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "speaker.tone", description: "Play a short tone.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({ frequency: { type: "integer", minimum: 200, maximum: 4000, default: 880 }, durationMs: { type: "integer", minimum: 1, maximum: 500, default: 100 } }) },
    { name: "display.text", description: "Show text on the StackChan display.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({ text: { type: "string", minLength: 1, maxLength: 240 }, color: { type: "integer", minimum: 0, maximum: 16777215, default: 16777215 } }, ["text"]) },
    { name: "ambient.read", description: "Read the ambient light sensor.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "imu.read", description: "Read accelerometer and gyroscope values.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "device.wake", description: "Wake Buddy from software standby.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "device.sleep", description: "Enter software standby while keeping Wi-Fi connected.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "device.shutdown", description: "Power off Buddy; use the physical power button to start it again.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({}) },
    { name: "module.custom", description: "Example add-on with a manifest-defined form.", allowed: false, effectiveAllowed: false, inputSchema: objectSchema({ enabled: { type: "boolean" }, mode: { type: "string", enum: ["eco", "turbo"] }, duty: { type: "number", minimum: 0, maximum: 1 } }, ["enabled", "mode", "duty"]) },
  ];
  const json = (body) => ({ contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/buddy/status") {
      await page.evaluate(() => window.__buddyStatusRequests.push(Date.now()));
      if (delayNextStatusResponse) {
        delayNextStatusResponse = false;
        delayedStatusStarted?.();
        await new Promise((resolve) => { delayedStatusRelease = resolve; });
        try {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Delayed Buddy status failure." }),
          });
        } finally {
          delayedStatusCompleted?.();
        }
        return;
      }
      if (statusUnavailable) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Buddy status temporarily unavailable." }),
        });
        return;
      }
      await route.fulfill(json({
        connected,
        deviceId,
        agentEnabled,
        state: { action: "idle", status: mode, mode, guiding, head: { ...headPose }, lastInteraction, faults: structuredClone(deviceFaults), lighting: structuredClone(lighting) },
        lastInvocationError,
        actionInProgress,
        activeAction,
        capabilities: structuredClone(capabilities),
      }));
      return;
    }
    if (pathname === "/api/buddy/observation") {
      await route.fulfill(json({ observation: latestObservation }));
      return;
    }
    if (pathname === "/api/buddy/agent") {
      lastAgentRequest = request.postDataJSON();
      agentEnabled = lastAgentRequest.enabled;
      await route.fulfill(json({ agentEnabled }));
      return;
    }
    if (pathname === "/api/buddy/permissions") {
      lastPermission = request.postDataJSON();
      permissionChanges.push({ ...lastPermission });
      await page.evaluate((change) => window.__buddyPermissionChanges.push(change), lastPermission);
      const capability = capabilities.find((item) => item.name === lastPermission.capability);
      capability.allowed = lastPermission.allowed;
      capability.effectiveAllowed = capability.allowed && (capability.requires || []).every((name) => {
        const dependency = capabilities.find((item) => item.name === name);
        return dependency?.allowed === true;
      });
      if (!capability.allowed && ["camera.capture", "head.observe"].includes(capability.name)) {
        latestObservation = null;
      } else if (!capability.allowed && capability.name === "head.move" && latestObservation?.capability === "head.observe") {
        latestObservation = null;
      }
      await route.fulfill(json({ deviceId: lastPermission.deviceId, capabilities: structuredClone(capabilities) }));
      return;
    }
    if (pathname === "/api/buddy/invoke") {
      const invocation = request.postDataJSON();
      invocations.push(invocation);
      await page.evaluate((call) => window.__buddyInvocations.push(call), invocation);
      if (invocation.capability === "device.sleep") {
        mode = "sleeping";
        guiding = false;
      }
      if (invocation.capability === "device.wake") mode = "ready";
      if (invocation.capability === "device.shutdown") mode = "shutting_down";
      if (invocation.capability === "head.release") guiding = true;
      if (invocation.capability === "head.hold") guiding = false;
      if (invocation.capability === "head.move") {
        headPose = {
          pan: invocation.args.pan ?? headPose.pan,
          tilt: invocation.args.tilt ?? headPose.tilt,
        };
      }
      if (invocation.capability === "led.express") {
        const colorByEmotion = {
          happy: [255, 184, 48],
          curious: [64, 176, 232],
          thinking: [168, 112, 232],
          listening: [64, 200, 160],
          speaking: [72, 144, 255],
          concerned: [248, 112, 96],
          calm: [112, 176, 152],
        };
        const color = colorByEmotion[invocation.args.emotion];
        lighting = {
          ...lighting,
          source: "emotion",
          pattern: invocation.args.emotion,
          emotion: invocation.args.emotion,
          intensity: invocation.args.intensity,
          remainingMs: invocation.args.durationMs,
          strips: [Array.from({ length: 6 }, () => [...color]), Array.from({ length: 6 }, () => [...color])],
        };
      }
      if (invocation.capability === "led.resume") {
        lighting = { ...lighting, source: "lifecycle", pattern: "ready", emotion: null, remainingMs: 0 };
      }
      if (invocation.capability === "led.set") {
        const color = [(invocation.args.color >> 16) & 255, (invocation.args.color >> 8) & 255, invocation.args.color & 255];
        const strips = lighting.strips.map((strip) => strip.map((pixel) => [...pixel]));
        const targetStrips = invocation.args.strip === undefined ? [0, 1] : [invocation.args.strip];
        for (const stripIndex of targetStrips) {
          if (invocation.args.index === undefined) strips[stripIndex] = Array.from({ length: 6 }, () => [...color]);
          else strips[stripIndex][invocation.args.index] = [...color];
        }
        lighting = { ...lighting, source: "manual", pattern: "manual", strips };
      }
      const result = invocation.capability === "head.observe"
        ? { direction: invocation.args.direction, image: { mimeType: "image/png", data: imageData, width: 1, height: 1, capturedAtMs: 1234, captureClock: "device_monotonic" } }
        : invocation.capability === "camera.capture"
          ? { image: { mimeType: "image/png", data: imageData, width: 1, height: 1, capturedAtMs: 1234, captureClock: "device_monotonic" } }
          : { ok: true, ...invocation.args };
      if (result.image) {
        latestObservation = {
          deviceId,
          requestId: `observe-${invocations.length}`,
          capability: invocation.capability,
          capturedAt: null,
          receivedAt: "2026-11-14T00:00:00.000Z",
          processedAt: "2026-11-14T00:00:00.100Z",
          result,
        };
      }
      await route.fulfill(json({ requestId: `request-${invocations.length}`, result }));
      return;
    }
    if (pathname === "/api/runtime") {
      await route.fulfill(json({ runtime: "node", model: "replay-model", default_preset_model: "anomaloharis@1" }));
      return;
    }
    await route.fulfill(json({}));
  });
  await page.route("**/fonts/local.css", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  await page.addInitScript(() => {
    window.__buddyInvocations = [];
    window.__buddyPermissionChanges = [];
    window.__buddyStatusRequests = [];
  });

  await page.goto("http://127.0.0.1:5173/");
  await page.getByRole("button", { name: "Buddy", exact: true }).click();
  await page.getByRole("tab", { name: /Overview/ }).waitFor();
  await waitForMode(page, "Ready");
  if (!(await page.locator(".buddy-connect-state").textContent()).includes("Online")) {
    throw new Error("Buddy should show online separately from its standby mode.");
  }

  const overviewTab = page.getByRole("tab", { name: /Overview/ });
  await overviewTab.focus();
  await assertSelectedTab(page, "overview");
  await overviewTab.press("ArrowRight");
  await assertSelectedTab(page, "lighting");
  await page.locator("#buddy-tab-lighting").press("ArrowLeft");
  await assertSelectedTab(page, "overview");
  await page.locator("#buddy-tab-overview").press("End");
  await assertSelectedTab(page, "permissions");
  await page.locator("#buddy-tab-permissions").press("Home");
  await assertSelectedTab(page, "overview");

  await page.locator(".buddy-command-group:first-child").getByRole("button", { name: "Enter standby" }).click();
  assertInvocation(invocations, "device.sleep", {}, deviceId);
  await waitForMode(page, "Sleeping");
  if (!(await page.locator(".buddy-connect-state").textContent()).includes("Online")) {
    throw new Error("Software standby should not be presented as a Wi-Fi disconnect.");
  }
  if (!(await page.getByRole("button", { name: "Wake from standby", exact: true }).isEnabled())) {
    throw new Error("Wake should remain available while Buddy is in software standby.");
  }
  if (!(await page.locator(".buddy-observation-panel").getByRole("button", { name: "Capture image" }).isDisabled())) {
    throw new Error("Camera capture should be disabled while Buddy sleeps.");
  }
  if (!(await page.locator(".buddy-head-panel").getByRole("button", { name: "Move head left" }).isDisabled())) {
    throw new Error("Head controls should be disabled while Buddy sleeps.");
  }
  if (!(await page.locator(".buddy-head-panel").getByRole("button", { name: "Guide by hand" }).isDisabled())) {
    throw new Error("Hand guidance should be disabled while Buddy sleeps.");
  }
  if (!(await page.getByRole("button", { name: "Power off", exact: true }).isEnabled())) {
    throw new Error("Power off should remain available while Buddy is in software standby.");
  }

  await runScopedButton(page, ".buddy-command-group:first-child", "Wake from standby");
  assertInvocation(invocations, "device.wake", {}, deviceId);
  await waitForMode(page, "Ready");

  await page.getByRole("button", { name: "Enable Agent", exact: true }).click();
  await page.locator(".buddy-agent-command strong").getByText("Enabled", { exact: true }).waitFor();
  if (lastAgentRequest?.enabled !== true) throw new Error("Enable Agent request payload mismatch.");
  await page.getByRole("tab", { name: /Agent permissions/ }).click();
  await card(page, "module.custom").waitFor();
  const capabilityNames = [
    "head.move", "head.home", "head.release", "head.hold", "led.set", "led.express", "led.resume", "touch.read", "power.read", "camera.capture",
    "head.observe", "infrared.send", "infrared.read", "nfc.detect", "speaker.tone",
    "display.text", "ambient.read", "imu.read", "device.wake", "device.sleep", "device.shutdown",
  ];
  for (const name of capabilityNames) {
    if (await card(page, name).count() !== 1) throw new Error("Missing Agent permission for " + name + ".");
  }
  if (await page.locator(".buddy-permission-row").count() !== 22) {
    throw new Error("Expected all 21 device capabilities plus one manifest-defined add-on.");
  }
  if (await page.locator(".buddy-permission-toggle input:checked").count() !== 0) {
    throw new Error("Enabling Agent access must not grant individual capabilities.");
  }

  await page.getByRole("button", { name: "Bot", exact: true }).click();
  await page.getByRole("button", { name: "Buddy", exact: true }).click();
  await page.getByRole("tab", { name: /Overview/ }).waitFor();
  await page.locator(".buddy-agent-command strong").getByText("Enabled", { exact: true }).waitFor();
  if (await page.getByRole("button", { name: "Disable Agent", exact: true }).count() !== 1) {
    throw new Error("Agent enablement should persist after leaving and reopening Buddy.");
  }

  actionInProgress = true;
  activeAction = { requestId: "agent-request-1", capability: "head.observe", startedAt: "2026-11-14T00:00:00.000Z" };
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.locator(".buddy-active-action").waitFor();
  if (!(await page.locator(".buddy-active-action").textContent()).includes("Agent is using Look around")) {
    throw new Error("The active remote Agent action was not shown with its capability.");
  }
  if (!(await page.locator(".buddy-observation-panel").getByRole("button", { name: "Capture image" }).isDisabled())) {
    throw new Error("Manual controls should wait while a remote Agent action is in progress.");
  }
  if (!(await page.getByRole("button", { name: "Power off", exact: true }).isDisabled())) {
    throw new Error("Power off should be disabled while another action is in progress.");
  }
  actionInProgress = false;
  activeAction = null;
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.locator(".buddy-active-action").waitFor({ state: "detached" });

  await page.locator(".buddy-command-group:first-child").getByRole("button", { name: "Enter standby" }).click();
  assertInvocation(invocations, "device.sleep", {}, deviceId);
  await waitForMode(page, "Sleeping");
  await page.getByRole("button", { name: "Wake from standby", exact: true }).click();
  assertInvocation(invocations, "device.wake", {}, deviceId);
  await waitForMode(page, "Ready");

  await page.locator(".buddy-head-panel").getByLabel("Pan angle number").fill("35");
  await page.locator(".buddy-head-panel").getByLabel("Tilt angle number").fill("60");
  headPose = { pan: 18, tilt: 52 };
  lastInteraction = { type: "touch", zones: [0, 2], atMs: 48000 };
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.getByText("Pan 18° / Tilt 52°", { exact: true }).waitFor();
  await page.getByText("Touch zones 0, 2", { exact: true }).waitFor();
  if (await page.locator(".buddy-head-panel").getByLabel("Pan angle number").inputValue() !== "35"
    || await page.locator(".buddy-head-panel").getByLabel("Tilt angle number").inputValue() !== "60") {
    throw new Error("Refreshing measured head pose overwrote the manual movement draft.");
  }
  await runScopedButton(page, ".buddy-head-panel", "Guide by hand");
  assertInvocation(invocations, "head.release", {}, deviceId);
  await page.getByText("Guiding by hand", { exact: true }).waitFor();
  await runScopedButton(page, ".buddy-head-panel", "Hold position");
  assertInvocation(invocations, "head.hold", {}, deviceId);
  await page.getByText("Holding position", { exact: true }).waitFor();
  await runScopedButton(page, ".buddy-head-panel", "Move head");
  assertInvocation(invocations, "head.move", { pan: 35, tilt: 60, moveTimeMs: 800, speed: 20 }, deviceId);

  await page.locator(".buddy-head-panel").getByRole("button", { name: "Center head" }).click();
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.includes("Updated"));
  assertInvocation(invocations, "head.home", {}, deviceId);

  await runScopedButton(page, ".buddy-observation-panel", "Capture image");
  assertInvocation(invocations, "camera.capture", {}, deviceId);
  await page.locator(".buddy-observation-image").waitFor();
  const capturedImageSource = await page.locator(".buddy-observation-image").getAttribute("src");
  if (!capturedImageSource?.startsWith("data:image/png;base64,")) {
    throw new Error("The standalone camera capture did not render its captured image.");
  }
  const observationTimestamp = await page.locator(".buddy-observation-panel header p").textContent();
  if (!observationTimestamp.trim().startsWith("Received ") || observationTimestamp.includes("Captured")) {
    throw new Error("New observations should show host receive time without presenting it as exposure time.");
  }
  await page.getByRole("tab", { name: /Agent permissions/ }).click();
  const headMovePermission = card(page, "head.move").getByRole("checkbox");
  const headMovePermissionStart = permissionChanges.length;
  await headMovePermission.check();
  await page.waitForFunction((count) => window.__buddyPermissionChanges.length >= count, headMovePermissionStart + 1);
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"));
  await card(page, "head.move").getByRole("checkbox").uncheck();
  await page.waitForFunction((count) => window.__buddyPermissionChanges.length >= count, headMovePermissionStart + 2);
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"));
  if (permissionChanges.slice(headMovePermissionStart, headMovePermissionStart + 2)
    .map((change) => `${change.capability}:${change.allowed}`).join(",") !== "head.move:true,head.move:false") {
    throw new Error("The head.move Agent permission was not granted and revoked in sequence.");
  }
  if (latestObservation?.capability !== "camera.capture") {
    throw new Error("The latest retained observation should be the standalone camera capture.");
  }
  await page.getByRole("tab", { name: /Overview/ }).click();
  await page.locator(".buddy-observation-image").waitFor();
  if (await page.locator(".buddy-observation-image").getAttribute("src") !== capturedImageSource) {
    throw new Error("Revoking head.move cleared or replaced a photo captured by camera.capture.");
  }
  const imageRequestId = latestObservation.requestId;
  const captureCountBeforeMovement = invocations.filter((call) => call.capability === "camera.capture").length;
  for (const [direction, pan] of [["left", -45], ["center", 0], ["right", 45]]) {
    await runScopedButton(page, ".buddy-head-panel", `Move head ${direction}`);
    assertInvocation(invocations, "head.move", { pan, moveTimeMs: 800, speed: 20 }, deviceId);
    if (latestObservation.requestId !== imageRequestId
      || invocations.filter((call) => call.capability === "camera.capture").length !== captureCountBeforeMovement) {
      throw new Error("Quick head movement must not capture an image or replace the latest observation.");
    }
  }
  const observeControls = page.locator(".buddy-observe-controls");
  await observeControls.locator("summary").click();
  await observeControls.getByLabel("Observation direction").selectOption("right");
  await runScopedButton(page, ".buddy-observe-controls", "Turn & capture");
  assertInvocation(invocations, "head.observe", { direction: "right", tilt: 45, settleMs: 250 }, deviceId);
  await page.getByText("Facing right", { exact: true }).waitFor();
  if (!(await page.locator(".buddy-observation-panel header p").textContent()).trim().startsWith("Received ")) {
    throw new Error("Combined observations should use the service receive timestamp.");
  }

  deviceFaults = [{ component: "camera", message: "Capture timeout", sinceMs: 1234 }];
  lastInvocationError = "Camera request timed out";
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"));
  const faultMessage = await page.getByRole("alert").textContent();
  if (!faultMessage.includes("Camera: Capture timeout") || !faultMessage.includes("Camera request timed out")) {
    throw new Error("Buddy device faults and the last invocation error should be visible in one compact alert.");
  }
  deviceFaults = [];
  lastInvocationError = null;
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"));
  if (await page.locator(".buddy-fault-state").count()) {
    throw new Error("No empty fault label should be shown when Buddy reports no faults.");
  }

  await page.getByRole("tab", { name: /Lights & display/ }).click();
  await page.getByRole("heading", { name: "Rear lightbars" }).waitFor();
  if (await page.locator(".buddy-lightbar-row").count() !== 2
    || await page.locator(".buddy-lightbar-row .buddy-light").count() !== 12) {
    throw new Error("The lighting panel must show two rear lightbars with six driver LEDs each.");
  }
  if ((await page.locator(".buddy-lightbar-label").allTextContents()).join(",") !== "A,B") {
    throw new Error("Rear lightbars should use the same A/B labels as the manual control.");
  }
  const stripOptions = await page.getByLabel("Rear lightbar").locator("option").allTextContents();
  if (!stripOptions.includes("Rear lightbar A") || !stripOptions.includes("Rear lightbar B")) {
    throw new Error("Manual RGB should identify the strips as A and B.");
  }
  if (await page.locator(".buddy-lightbar-row .buddy-light[data-driver-color]").first().getAttribute("data-driver-color") !== "#003820") {
    throw new Error("The lighting diagram did not use the reported driver colors.");
  }
  const agentExpressions = page.getByRole("checkbox", { name: "Allow Agent light expressions" });
  if (await agentExpressions.isChecked()) throw new Error("Agent light expression access must start disabled.");
  const initialLightingStatus = await page.locator(".buddy-lighting-current").textContent();
  if (!initialLightingStatus.includes("Automatic") || initialLightingStatus.includes("Lifecycle")) {
    throw new Error("Lifecycle lighting should use the friendly Automatic label.");
  }
  const firstLightingCall = invocations.length;
  await runLightingButton(page, page.getByRole("button", { name: "Curious", exact: true }), "led.express");
  assertInvocation(invocations, "led.express", { emotion: "curious", intensity: 0.5, durationMs: 8000 }, deviceId);
  const emotionStatus = await page.locator(".buddy-lighting-current").textContent();
  if (invocations.length !== firstLightingCall + 1
    || !emotionStatus.includes("Curious")
    || !emotionStatus.includes("50% · 8s")
    || emotionStatus.includes("Emotion")) {
    throw new Error("The emotion status should be friendly and show intensity and remaining time once.");
  }
  const firstPermissionChange = permissionChanges.length;
  await agentExpressions.check();
  await page.waitForFunction((count) => window.__buddyPermissionChanges.length >= count, firstPermissionChange + 2);
  if (permissionChanges.slice(-2).map((change) => `${change.capability}:${change.allowed}`).join(",") !== "led.express:true,led.resume:true") {
    throw new Error("Agent expressions should grant only led.express and led.resume.");
  }
  await page.getByLabel("Emotion intensity").evaluate((input) => {
    input.value = "0.7";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByLabel("Emotion duration (s)").fill("12");
  await runLightingButton(page, page.getByRole("button", { name: "Happy", exact: true }), "led.express");
  assertInvocation(invocations, "led.express", { emotion: "happy", intensity: 0.7, durationMs: 12000 }, deviceId);
  await runLightingButton(page, page.getByRole("button", { name: "Resume automatic", exact: true }), "led.resume");
  assertInvocation(invocations, "led.resume", {}, deviceId);
  const resumedStatus = await page.locator(".buddy-lighting-current").textContent();
  if (!resumedStatus.includes("Automatic") || resumedStatus.includes("Ready") || !resumedStatus.includes("70%")) {
    throw new Error("Automatic lifecycle lighting status was not reflected.");
  }
  const revokeStart = permissionChanges.length;
  await agentExpressions.uncheck();
  await page.waitForFunction((count) => window.__buddyPermissionChanges.length >= count, revokeStart + 2);
  if (permissionChanges.slice(-2).map((change) => `${change.capability}:${change.allowed}`).join(",") !== "led.express:false,led.resume:false") {
    throw new Error("Disabling Agent expressions should revoke both related capabilities.");
  }
  if (await card(page, "led.express").count() || await card(page, "led.resume").count()) {
    throw new Error("Agent lighting capabilities should not be duplicated as generic lighting cards.");
  }
  const manualRgb = page.locator(".buddy-manual-rgb");
  if (await manualRgb.locator(".buddy-capability").isVisible()) throw new Error("Manual RGB should remain collapsed by default.");
  await manualRgb.locator(":scope > summary").click();
  await card(page, "led.set").getByLabel("LED color").evaluate((input) => {
    input.value = "#123456";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await card(page, "led.set").getByLabel("Rear lightbar").selectOption("1");
  await card(page, "led.set").getByLabel("LED index").fill("4");
  await runCapability(page, "led.set", "Set LEDs");
  assertInvocation(invocations, "led.set", { color: 0x123456, strip: 1, index: 4 }, deviceId);
  await page.locator('.buddy-light[data-led-index="4"][data-driver-color="#123456"]').waitFor();
  if ((await page.locator(".buddy-lighting-current").textContent()).includes("Manual · Manual")
    || !(await page.locator(".buddy-lighting-current").textContent()).includes("Manual")) {
    throw new Error("Manual light state should be shown from the driver snapshot.");
  }

  await card(page, "speaker.tone").getByLabel("Frequency (Hz)").fill("1200");
  await card(page, "speaker.tone").getByLabel("Duration (ms)").fill("250");
  await runCapability(page, "speaker.tone", "Play tone");
  assertInvocation(invocations, "speaker.tone", { frequency: 1200, durationMs: 250 }, deviceId);

  await card(page, "display.text").getByLabel("Display text", { exact: true }).fill("Room ready");
  await card(page, "display.text").getByLabel("Display text color").evaluate((input) => {
    input.value = "#abcdef";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await runCapability(page, "display.text", "Display text");
  assertInvocation(invocations, "display.text", { text: "Room ready", color: 0xabcdef }, deviceId);
  await page.screenshot({ path: "output/playwright/buddy-lighting-emotions.png", fullPage: true });

  lighting = { ...lighting, source: "touch", pattern: "touch_reaction", emotion: "happy", intensity: 0.4, remainingMs: 3000, strips: null };
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.waitForFunction(() => document.querySelector(".buddy-lighting-current")?.textContent.includes("Touch"));
  const touchLightingStatus = await page.locator(".buddy-lighting-current").textContent();
  if (touchLightingStatus.includes("Happy") || !touchLightingStatus.includes("40% · 3s")) {
    throw new Error("Touch lighting should not expose the underlying emotion and should retain intensity/time.");
  }
  if (!(await page.getByText("Waiting for light status", { exact: true }).count())) {
    throw new Error("Missing driver colors should be described as waiting for light status.");
  }
  if (await page.locator(".buddy-light[data-driver-color]:not([data-driver-color=''])").count()) {
    throw new Error("Missing driver colors should not be fabricated in the strip diagram.");
  }

  await page.getByRole("tab", { name: /Sensors/ }).click();
  await card(page, "touch.read").getByRole("heading", { name: "3 touch zones" }).waitFor();
  await card(page, "touch.read").getByLabel("Touch zone (3 zones)").selectOption("2");
  await runCapability(page, "touch.read", "Read");
  assertInvocation(invocations, "touch.read", { zone: 2 }, deviceId);
  await runCapability(page, "power.read", "Read");
  assertInvocation(invocations, "power.read", {}, deviceId);
  await runCapability(page, "ambient.read", "Read");
  assertInvocation(invocations, "ambient.read", {}, deviceId);
  await runCapability(page, "imu.read", "Read");
  assertInvocation(invocations, "imu.read", {}, deviceId);
  await runCapability(page, "nfc.detect", "Read");
  assertInvocation(invocations, "nfc.detect", {}, deviceId);

  await page.getByRole("tab", { name: /Infrared/ }).click();
  await card(page, "infrared.send").getByLabel("NEC address (0–255)").fill("48");
  await card(page, "infrared.send").getByLabel("NEC data (0–255)").fill("193");
  await runCapability(page, "infrared.send", "Send NEC");
  assertInvocation(invocations, "infrared.send", { address: 48, data: 193 }, deviceId);
  await runCapability(page, "infrared.read", "Read");
  assertInvocation(invocations, "infrared.read", {}, deviceId);

  await page.getByRole("tab", { name: /Extensions/ }).click();
  if (await card(page, "head.release").count() || await card(page, "head.hold").count()) {
    throw new Error("Built-in hand guidance commands must not appear as extensions.");
  }
  await card(page, "module.custom").getByLabel("Enabled").check();
  await card(page, "module.custom").getByLabel("Mode").selectOption("turbo");
  await card(page, "module.custom").getByLabel("Duty").fill("0.75");
  await runCapability(page, "module.custom", "Run manually");
  assertInvocation(invocations, "module.custom", { enabled: true, mode: "turbo", duty: 0.75 }, deviceId);

  deviceId = "stackchan-room-2";
  await page.getByRole("tab", { name: /Overview/ }).click();
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.getByText("No image captured", { exact: true }).waitFor();
  if (await page.locator(".buddy-observation-image").count()) {
    throw new Error("A cached image from the previous device remained visible.");
  }

  await page.getByRole("tab", { name: /Agent permissions/ }).click();
  await card(page, "camera.capture").getByRole("checkbox", { name: "Allow Capture image for Agent" }).check();
  await card(page, "camera.capture").getByRole("checkbox", { name: "Revoke Capture image for Agent" }).uncheck();
  if (lastPermission?.deviceId !== deviceId || lastPermission?.allowed !== false) {
    throw new Error("Camera permission payload mismatch: " + JSON.stringify(lastPermission));
  }

  connected = false;
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.waitForFunction(() => {
    const presence = document.querySelector(".buddy-connect-state");
    return presence && !presence.classList.contains("online") && presence.textContent.includes("Offline");
  });
  const disableAgentButton = page.getByRole("button", { name: "Disable Agent", exact: true });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "Disable Agent");
    return button && !button.disabled;
  });
  if (await disableAgentButton.isDisabled()) throw new Error("Agent should remain disableable while Buddy is disconnected.");
  await disableAgentButton.click();
  await page.locator(".buddy-agent-command strong").getByText("Disabled", { exact: true }).waitFor();
  if (lastAgentRequest?.enabled !== false || await page.locator(".buddy-permission-toggle input:checked").count() !== 0) {
    throw new Error("Disabling Agent should not change individual capability grants.");
  }

  connected = true;
  mode = "ready";
  actionInProgress = false;
  activeAction = null;
  agentEnabled = false;
  latestObservation = null;
  await page.getByRole("tab", { name: /Overview/ }).click();
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await waitForMode(page, "Ready");
  await page.waitForFunction(() => document.querySelector(".buddy-connect-state")?.classList.contains("online"));

  actionInProgress = true;
  activeAction = { requestId: "agent-request-stale", capability: "head.observe", startedAt: "2026-11-14T00:00:00.000Z" };
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.locator(".buddy-active-action").waitFor();
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"));
  statusUnavailable = true;
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Refresh failed:"));
  await page.waitForFunction(() => document.querySelector(".buddy-connect-state")?.textContent.trim() === "Unknown");
  if (await page.locator(".buddy-connect-state").evaluate((item) => item.classList.contains("online"))) {
    throw new Error("A failed status response must not leave the stale Online indicator visible.");
  }
  if (await page.locator(".buddy-active-action").count()) {
    throw new Error("A failed status response must clear the stale remote-action busy indicator.");
  }
  if (!(await page.locator(".buddy-observation-panel").getByRole("button", { name: "Capture image" }).isDisabled())) {
    throw new Error("Manual actions should stay unavailable while Buddy status is stale.");
  }
  actionInProgress = false;
  activeAction = null;
  statusUnavailable = false;
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"));
  await waitForMode(page, "Ready");
  await page.waitForFunction(() => document.querySelector(".buddy-connect-state")?.classList.contains("online"));
  await page.waitForTimeout(50);
  if (await page.locator(".buddy-active-action").count()) {
    throw new Error("The old remote-action busy indicator remained after status recovered.");
  }
  if (!(await page.locator(".buddy-observation-panel").getByRole("button", { name: "Capture image" }).isEnabled())) {
    throw new Error("Manual actions should become available after Buddy status recovers.");
  }

  let signalDelayedStatusStarted;
  const delayedStatusStartedPromise = new Promise((resolve) => { signalDelayedStatusStarted = resolve; });
  let signalDelayedStatusCompleted;
  const delayedStatusCompletedPromise = new Promise((resolve) => { signalDelayedStatusCompleted = resolve; });
  delayedStatusStarted = signalDelayedStatusStarted;
  delayedStatusCompleted = signalDelayedStatusCompleted;
  const statusRequestCount = await page.evaluate(() => window.__buddyStatusRequests.length);
  delayNextStatusResponse = true;
  await page.waitForFunction((count) => window.__buddyStatusRequests.length > count, statusRequestCount, { timeout: 7000 });
  await delayedStatusStartedPromise;
  await page.getByRole("button", { name: "Refresh Buddy dashboard" }).click();
  await page.waitForTimeout(100);
  await page.waitForFunction(() => document.querySelector(".buddy-dashboard-status")?.textContent.trim().startsWith("Updated"));
  await page.waitForFunction(() => document.querySelector(".buddy-connect-state")?.classList.contains("online"));
  if (!(await page.locator(".buddy-observation-panel").getByRole("button", { name: "Capture image" }).isEnabled())) {
    throw new Error("The newer successful refresh should restore manual actions while an older poll is pending.");
  }
  delayedStatusRelease?.();
  await delayedStatusCompletedPromise;
  await page.waitForTimeout(100);
  if (!((await page.locator(".buddy-connect-state").textContent()).trim() === "Online")
    || !(await page.locator(".buddy-connect-state").evaluate((item) => item.classList.contains("online")))
    || !(await page.locator(".buddy-dashboard-status").textContent()).trim().startsWith("Updated")) {
    throw new Error("An older failed poll overwrote the newer successful Buddy refresh.");
  }
  delayedStatusStarted = null;
  delayedStatusCompleted = null;
  delayedStatusRelease = null;

  await page.getByRole("button", { name: "Power off", exact: true }).click();
  assertInvocation(invocations, "device.shutdown", {}, deviceId);
  await waitForMode(page, "Powering off");
  await page.getByText("Press the physical power button to start Buddy again.", { exact: true }).waitFor();
  if (!(await page.getByRole("button", { name: "Wake from standby", exact: true }).isDisabled())) {
    throw new Error("Software wake must not be offered after power off begins.");
  }
  await page.screenshot({ path: "output/playwright/buddy-console.png", fullPage: true });

  await page.setViewportSize({ width: 320, height: 900 });
  const narrowTabs = [
    ["overview", /Overview/],
    ["lighting", /Lights & display/],
    ["sensors", /Sensors/],
    ["infrared", /Infrared/],
    ["extensions", /Extensions/],
    ["permissions", /Agent permissions/],
  ];
  for (const [tabId, label] of narrowTabs) {
    await page.getByRole("tab", { name: label }).click();
    await page.getByRole("tabpanel").waitFor();
    await assertNoHorizontalOverflow(page, tabId);
  }

  return {
    capabilitiesRendered: capabilityNames.length,
    manualCalls: invocations.length,
    categoriesReviewed: ["overview", "lighting", "sensors", "infrared", "extensions", "permissions"],
    standbyWakeConfirmed: true,
    powerOffRequiresPhysicalRestart: true,
    handGuidanceAndMeasuredPoseConfirmed: true,
    quickDirectionControlsOnlyMoveHead: true,
    standaloneCaptureAndCombinedObservationConfirmed: true,
    receivedTimestampAndFaultDisplayConfirmed: true,
    sleepingBlocksOtherManualActions: true,
    emotionLightingAndTargetColorsConfirmed: true,
    agentEmotionAccessIsExplicitAndScoped: true,
    lightingScreenshot: "output/playwright/buddy-lighting-emotions.png",
    serviceBusyDisplayed: true,
    agentStartStopPersistsWithoutGrantingCapabilities: true,
    crossDeviceImageCleared: true,
    screenshot: "output/playwright/buddy-console.png",
    standaloneCaptureSurvivesHeadMoveRevocation: true,
    failedStatusClearsStalePresenceAndBusyState: true,
    restoredStatusReenablesManualActions: true,
    stalePollCannotOverwriteNewRefresh: true,
    keyboardTabNavigationAndAriaRelationshipsConfirmed: true,
    noHorizontalOverflowAt320px: true,
  };
}
