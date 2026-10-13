# Browser demo

Published showcase: https://anomaloharis-demo.cyberyimein.chatgpt.site

The `codex/demo` branch adds a browser-only project showcase. The demo uses a
separate Vue entry selected by Vite's `demo` mode. The normal application remains
available using the existing development and build commands.

## Local commands

```sh
npm --prefix frontend run dev:demo
npm --prefix frontend run build:demo
npm --prefix frontend run preview:demo
node scripts/demo-smoke.mjs
```

The preview runs on port 4174. Set `DEMO_URL` to test a different URL and
`PLAYWRIGHT_MODULE` when using a bundled Playwright installation.

## Hosting

Static output goes to `sites/anomaloharis-demo/dist`. The Site identity is stored
in `sites/anomaloharis-demo/.openai/hosting.json`; reuse it for updates.
Run `node scripts/prepare-demo-site.mjs` after the demo build to export only the
demo source into the Site directory. The Sites workflow helper synchronizes that
separate source repository and packages its static output. It does not push the
main repository or its history to Sites. Never put credentials in this directory.
The Site directory is a separate, ignored Git checkout. Keep it for subsequent
publishes; its identity and source history are also retained by Sites.

The six views contain illustrative data, preset replies and browser-local state.
All showcase copy is in English. Agent demonstrates the complete tool-calling
loop with expandable search, reading, Python and memory calls. Bot presents the
24/7 standby AI experience, including ongoing goals and example check-ins.
There are no real model requests, backend requests or hardware connections.
The 24/7 positioning describes the product experience; this static demo does not
run background jobs or deliver reminders.
Refreshing clears the interactive state. Public visitors can inspect all shipped
assets; redirects from another domain do not hide the target Site URL.
