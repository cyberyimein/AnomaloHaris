import { describe, expect, it } from "vitest";

import { PythonWorkerClient, PythonWorkerProcess, PythonWorkerToolRuntime } from "./worker.js";
import type { ToolContext } from "./types.js";

const context: ToolContext = {
  sessionId: "worker-session",
  runId: "worker-run",
  toolCallId: "call-1",
  searchMode: "diy",
  model: "replay",
  activeSkills: new Set(["skill-a"]),
  activeMcpServers: new Set(["mcp-a"]),
};

describe("PythonWorkerClient", () => {
  it("uses the internal JSON protocol for tool discovery and calls", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const client = new PythonWorkerClient({
      baseUrl: "http://127.0.0.1:8849",
      token: "worker-token",
      fetchImpl: async (url, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        requests.push({ url: String(url), body });
        if (String(url).endsWith("/internal/tools/list")) {
          return new Response(JSON.stringify({ tools: [{ name: "python_echo", description: "Echo", parameters: { type: "object" }, source: "python" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: { name: "python_echo", ok: true, content: "ok", data: {} } }), { status: 200 });
      },
    });
    const runtime = new PythonWorkerToolRuntime(client);

    expect((await runtime.list(context))[0]?.name).toBe("python_echo");
    expect((await runtime.call({ id: "call-1", name: "python_echo", arguments: {} }, context, new AbortController().signal)).content).toBe("ok");
    expect(requests[0]?.body?.context).toMatchObject({ active_skills: ["skill-a"], active_mcp_servers: ["mcp-a"] });
  });

  it("normalizes a disconnected worker into a resumable tool error", async () => {
    const client = new PythonWorkerClient({
      baseUrl: "http://127.0.0.1:8849",
      timeoutMs: 10,
      fetchImpl: async () => { throw new Error("connection refused"); },
    });
    const result = await client.callTool({ id: "call-2", name: "python_echo", arguments: {} }, context, new AbortController().signal);
    expect(result).toMatchObject({ name: "python_echo", ok: false, data: { error_code: "worker_unavailable" } });
  });

  it("restarts a worker that exits after becoming healthy", async () => {
    let healthChecks = 0;
    const worker = new PythonWorkerProcess({
      client: { health: async () => { healthChecks += 1; return { status: "ok" }; } } as unknown as PythonWorkerClient,
      command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 25)"],
      restartBaseDelayMs: 100,
      restartMaxDelayMs: 100,
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await worker.stop();

    expect(healthChecks).toBeGreaterThan(1);
  });
});
