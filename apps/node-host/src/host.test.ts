import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentCore } from "./core.js";
import { RunController } from "./controller.js";
import { ReplayModelAdapter, type ReplayStep } from "./model.js";
import { InMemorySessionAdapter } from "./session.js";
import { buildNodeHost } from "./host.js";
import { DeterministicToolRuntime } from "./tools.js";

const apps: Array<{ close(): Promise<void> }> = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Node Host", () => {
  it("serves health, chat, session, and NDJSON endpoints", async () => {
    const app = await makeApp([
      [{ type: "text.delta", text: "hello from node" }, { type: "done" }],
      [{ type: "text.delta", text: "streamed" }, { type: "done" }],
    ]);
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok", runtime: "node", session_schema: 2 });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { session_id: "host-session", message: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ session_id: "host-session", final_text: "hello from node" });

    const stream = await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      payload: { session_id: "stream-session", message: "stream" },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("application/x-ndjson");
    expect(stream.body.trim().split("\n").map((line) => JSON.parse(line).type)).toContain("run.finished");

    const sessions = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(sessions.json().sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: "host-session", title: "hello" }),
      expect.objectContaining({ session_id: "stream-session", title: "stream" }),
    ]));
  });

  it("keeps connection controls separate from run events on WebSocket", async () => {
    const app = await makeApp([[{ type: "text.delta", text: "websocket result" }, { type: "done" }]]);
    apps.push(app);
    await app.ready();
    const messages: Array<Record<string, unknown>> = [];
    const socket = await app.injectWS("/ws/chat/ws-session", {}, {
      onInit: (ws) => ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>)),
    });

    socket.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => messages.some((message) => message.type === "pong"));
    expect(messages.some((message) => message.type === "session.state")).toBe(true);

    socket.send(JSON.stringify({ type: "user.message", session_id: "ws-session", content: "hi" }));
    await waitFor(() => messages.some((message) => message.type === "run.finished"));
    expect(messages.find((message) => message.type === "run.finished")).toMatchObject({
      session_id: "ws-session",
    });
    socket.close();
  });

  it("serves the frontend shell when a static directory is configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "anomalo-node-host-"));
    tempDirectories.push(directory);
    writeFileSync(join(directory, "index.html"), "<html>node-host</html>");
    writeFileSync(join(directory, "app.js"), "console.log('asset')");
    const app = await makeApp([], directory);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("node-host");
    const asset = await app.inject({ method: "GET", url: "/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("asset");
  });
});

async function makeApp(
  steps: ReplayStep[],
  staticDir?: string,
) {
  const tools = new DeterministicToolRuntime([]);
  const model = new ReplayModelAdapter(steps);
  const sessions = new InMemorySessionAdapter();
  const core = new AgentCore({ model, tools, sessions });
  return buildNodeHost({
    controller: new RunController(core),
    sessions,
    model: "replay-model",
    ...(staticDir ? { staticDir } : {}),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for WebSocket message.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
