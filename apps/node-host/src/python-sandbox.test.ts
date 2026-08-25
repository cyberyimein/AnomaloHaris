import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PythonSandboxRuntime, PYTHON_SANDBOX_TOOL_NAME } from "./python-sandbox.js";
import type { ToolContext } from "./types.js";

const context: ToolContext = {
  sessionId: "python-session",
  runId: "python-run",
  searchMode: "diy",
  model: "replay",
  activeSkills: new Set(),
  activeMcpServers: new Set(),
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PythonSandboxRuntime", () => {
  it("lists the tool only when the external FruitSpy service is ready", async () => {
    const runtime = new PythonSandboxRuntime({
      baseUrl: "http://fruitspy.test",
      token: "secret",
      fetchImpl: async () => new Response(JSON.stringify({ ready: true, state: "ready" }), { status: 200 }),
    });

    expect((await runtime.list(context)).map((tool) => tool.name)).toEqual([PYTHON_SANDBOX_TOOL_NAME]);
    expect((await runtime.status(context))[0]).toMatchObject({ provider: "fruitspy-python", available: true });
  });

  it("checks readiness and executes Python through FruitSpy with an idempotency key", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = new PythonSandboxRuntime({
      baseUrl: "http://fruitspy.test",
      token: "secret",
      defaultTimeoutMs: 5_000,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/api/v1/tools/python")) {
          return new Response(JSON.stringify({ ready: true, state: "ready" }), { status: 200 });
        }
        return new Response(JSON.stringify({
          ok: true,
          status: "completed",
          exit_code: 0,
          stdout: "2",
          stderr: "",
          content: "2",
          execution_id: "exec_1",
        }), { status: 200 });
      },
    });

    const result = await runtime.call(
      { id: "python-call", name: PYTHON_SANDBOX_TOOL_NAME, arguments: { code: "print(1 + 1)", timeout_ms: 3_000 } },
      context,
      new AbortController().signal,
    );

    expect(result).toMatchObject({ name: PYTHON_SANDBOX_TOOL_NAME, ok: true, content: "2" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("http://fruitspy.test/api/v1/tools/python");
    expect(requests[1]?.url).toBe("http://fruitspy.test/api/v1/tools/python/executions");
    expect(requests[1]?.init?.headers).toMatchObject({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
    expect(requests[1]?.init?.headers).toHaveProperty("Idempotency-Key");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ code: "print(1 + 1)", timeout_ms: 3_000 });
  });

  it("caches bounded artifacts outside the container and exposes a local URL", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "anomaloharis-python-artifacts-"));
    temporaryDirectories.push(artifactsDir);
    const runtime = new PythonSandboxRuntime({
      baseUrl: "http://fruitspy.test",
      token: "secret",
      artifactsDir,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/api/v1/tools/python")) {
          return new Response(JSON.stringify({ ready: true }), { status: 200 });
        }
        if (String(url).endsWith("/artifacts/plot.png")) {
          return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
        }
        return new Response(JSON.stringify({
          ok: true,
          stdout: "plot ready",
          execution_id: "exec_2",
          artifacts: [{ name: "plot.png", media_type: "image/png", download_url: "/api/v1/tools/python/executions/exec_2/artifacts/plot.png" }],
        }), { status: 200 });
      },
    });

    const result = await runtime.call(
      { id: "python-call", name: PYTHON_SANDBOX_TOOL_NAME, arguments: { code: "make_plot()", artifacts: [{ path: "plot.png" }] } },
      context,
      new AbortController().signal,
    );

    const artifactUrl = String((result.data as { artifacts: Array<{ url: string }> }).artifacts[0]?.url);
    expect(artifactUrl).toMatch(/^\/api\/artifacts\/python\/exec_2\/plot\.png\?session_id=python-session&artifact_token=.+$/);
    expect(readFileSync(join(artifactsDir, "python", "exec_2", "plot.png"))).toEqual(Buffer.from([1, 2, 3]));
    const url = new URL(`http://anomaloharis.test${artifactUrl}`);
    expect(runtime.readArtifact("exec_2", "plot.png", "wrong-session", url.searchParams.get("artifact_token")!)).toBeUndefined();
    expect(runtime.readArtifact("exec_2", "plot.png", "python-session", url.searchParams.get("artifact_token")!)).toMatchObject({ mediaType: "image/png" });
  });

  it("downgrades active or unknown artifact media types to inert downloads", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "anomaloharis-python-artifacts-media-"));
    temporaryDirectories.push(artifactsDir);
    const runtime = new PythonSandboxRuntime({
      baseUrl: "http://fruitspy.test",
      token: "secret",
      artifactsDir,
      artifactAccessSecret: "stable-secret",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/api/v1/tools/python")) return new Response(JSON.stringify({ ready: true }), { status: 200 });
        if (String(url).endsWith("/artifacts/report.html")) return new Response("<script>alert(1)</script>", { status: 200 });
        return new Response(JSON.stringify({
          ok: true,
          execution_id: "exec_media",
          artifacts: [{ name: "report.html", media_type: "text/html", download_url: "/api/v1/tools/python/executions/exec_media/artifacts/report.html" }],
        }), { status: 200 });
      },
    });

    const result = await runtime.call(
      { id: "python-media-call", name: PYTHON_SANDBOX_TOOL_NAME, arguments: { code: "print(1)", artifacts: [{ path: "report.html" }] } },
      context,
      new AbortController().signal,
    );

    expect(result.data).toMatchObject({ artifacts: [{ media_type: "application/octet-stream" }] });
    const artifactUrl = String((result.data as { artifacts: Array<{ url: string }> }).artifacts[0]?.url);
    const url = new URL(`http://anomaloharis.test${artifactUrl}`);
    expect(runtime.readArtifact("exec_media", "report.html", "python-session", url.searchParams.get("artifact_token")!)).toMatchObject({ mediaType: "application/octet-stream" });
  });
});
