# Buddy dashboard browser check

Start the frontend with `npm --prefix frontend run dev`, then run this Playwright script from the repository root:

```sh
playwright-cli run-code --filename scripts/qa/buddy-dashboard-playwright.mjs
```

The script mocks Buddy and unrelated Node Host API responses. It checks capability discovery, permission updates, image display, device-bound invoke payloads, and clearing a cached image when the reported device changes. It does not connect to physical hardware.

For a deployed host and an awake, connected robot, the live script checks pure
head movement, a separate camera capture, manual lighting persistence and
unchanged Agent grants:

```sh
BUDDY_BODY_AUDIT_LIVE=1 \
BUDDY_ADMIN_ENV=/path/to/private/deployment.env \
BUDDY_BASE_URL=http://your-host:8000 \
node scripts/qa/buddy-body-live.mjs
```

`BUDDY_ADMIN_ENV` supplies the existing administration token without printing it.
Set `BUDDY_PLAYWRIGHT_MODULE` to a Playwright module path when Playwright is
provided by an external installation. The script moves the head to center,
captures one image and temporarily changes lighting; it restores automatic
lighting and does not change Agent permissions. Artifacts are written under
Git-ignored `output/playwright/`.

# Model catalog browser check

## Mocked API

Start the frontend with `npm --prefix frontend run dev`, then run the browser
check from the repository root:

```sh
MODEL_CATALOG_BASE_URL=http://127.0.0.1:5173 \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROME_EXECUTABLE_PATH=/path/to/chrome \
node scripts/qa/model-catalog-playwright.mjs
```

`PLAYWRIGHT_MODULE` and `CHROME_EXECUTABLE_PATH` are optional when Playwright
and Chromium are available through the local Node environment. The script
stubs the APIs and does not call a model provider. It verifies catalog create,
edit and delete; defaults, impact preview and reference replacement; history
restore; preset binding without changing its version; conflict and API error
states; and 320/375 px layouts. Its screenshot and JSON report are written to
Git-ignored `output/playwright/`.

## Real temporary backend

For an end-to-end check against a real Node Host and temporary SQLite data,
build the host first and run:

```sh
npm --workspace apps/node-host run build
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROME_EXECUTABLE_PATH=/path/to/chrome \
node scripts/qa/model-catalog-live-playwright.mjs
```

The live script starts its own local Node Host and Vite server on ephemeral
ports, seeds synthetic model IDs, uses a fresh temporary data directory and an
ephemeral admin token, and never invokes a model provider. It exercises model
creation/editing, preset selection without a version change, defaults,
reference preview and replacement, and history restoration. It stops both
servers and retains the temporary SQLite directory for inspection. The report
and screenshot use unique paths under `output/playwright/`; set
`MODEL_CATALOG_LIVE_REPORT` or `MODEL_CATALOG_LIVE_SCREENSHOT` to choose other
non-existing paths.
