import { InProcessPluginBackend, type PluginBackendHandle, type PluginSpec } from "./plugins.js";

const backend = new InProcessPluginBackend();
let handle: PluginBackendHandle | undefined;

process.on("message", (message: unknown) => {
  void handleMessage(message);
});

async function handleMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== "object" || typeof process.send !== "function") return;
  const value = message as { id?: unknown; method?: unknown; payload?: unknown };
  const id = typeof value.id === "number" ? value.id : undefined;
  if (id === undefined || typeof value.method !== "string") return;
  try {
    const payload = isRecord(value.payload) ? value.payload : {};
    let result: unknown;
    switch (value.method) {
      case "load":
        handle = await backend.load(payload.spec as PluginSpec, 30_000);
        result = { loaded: true };
        break;
      case "unload":
        if (handle) await backend.unload(handle);
        result = { unloaded: true };
        break;
      case "tools":
        if (!handle) throw new Error("Plugin is not loaded.");
        result = { tools: await backend.tools(handle, (payload.context ?? {}) as never, 30_000) };
        break;
      case "capabilities":
        if (!handle) throw new Error("Plugin is not loaded.");
        result = { capabilities: await backend.capabilities(handle, 30_000) };
        break;
      case "callTool":
        if (!handle) throw new Error("Plugin is not loaded.");
        result = {
          result: await backend.callTool(
            handle,
            payload.call as never,
            payload.context as never,
            new AbortController().signal,
            30_000,
          ),
        };
        break;
      case "dispatch":
        if (!handle) throw new Error("Plugin is not loaded.");
        result = { result: await backend.dispatch(handle, payload.event as never, 30_000) };
        break;
      default:
        throw new Error(`Unknown plugin child method: ${value.method}`);
    }
    process.send({ id, ok: true, result });
  } catch (error) {
    process.send({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
