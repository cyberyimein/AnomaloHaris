import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentCore } from "./core.js";
import { buildNodeHost } from "./host.js";
import { OpenAICompatibleAdapter, type ModelAdapter, type ModelStreamEvent } from "./model.js";
import { SqliteSessionAdapter } from "./sqlite.js";
import { RunController } from "./controller.js";
import { DeterministicToolRuntime } from "./tools.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const dataDir = resolve(process.env.ANOMALO_DATA_DIR ?? join(repoRoot, "data"));
const databasePath = process.env.ANOMALO_SESSION_DB_PATH ?? join(dataDir, "sessions.sqlite3");
const modelName = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const apiKey = process.env.OPENROUTER_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
const staticDir = process.env.ANOMALO_FRONTEND_DIR ?? join(repoRoot, "agent-backend", "app", "frontend");

class StaticFallbackModel implements ModelAdapter {
  constructor(readonly model: string) {}

  async *stream(_request: Parameters<ModelAdapter["stream"]>[0], signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    if (signal.aborted) return;
    yield { type: "text.delta", text: "Node Host is running, but no model API key is configured." };
    yield { type: "done" };
  }

  async complete(_request: Parameters<ModelAdapter["complete"]>[0], signal: AbortSignal): Promise<string> {
    if (signal.aborted) return "";
    return "Node Host is running, but no model API key is configured.";
  }
}

const model = createModel(modelName, baseUrl, apiKey);
const tools = new DeterministicToolRuntime([]);
const sessions = new SqliteSessionAdapter(databasePath);
const core = new AgentCore({ model, tools, sessions });
const controller = new RunController(core);
const app = await buildNodeHost({
  controller,
  sessions,
  model: modelName,
  promptProfile: process.env.ANOMALO_AGENT_PROMPT_PROFILE ?? "agent",
  searchMode: process.env.ANOMALO_SEARCH_MODE ?? "diy",
  runtimeImpl: "node",
  sessionSchema: 2,
  ...(existsSync(join(staticDir, "index.html")) ? { staticDir } : {}),
  logger: process.env.ANOMALO_ENV !== "test",
});

const port = Number(process.env.PORT ?? "8000");
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });

async function shutdown(): Promise<void> {
  sessions.close();
  await app.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function createModel(modelName: string, baseUrl: string, apiKey: string | undefined): ModelAdapter {
  if (apiKey) {
    return new OpenAICompatibleAdapter({ model: modelName, baseUrl, apiKey });
  }
  return new StaticFallbackModel(modelName);
}
