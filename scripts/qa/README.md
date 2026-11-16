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
