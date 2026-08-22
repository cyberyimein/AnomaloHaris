import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacyDatabase, SqliteSessionAdapter } from "./sqlite.js";
import type { EntryId, SessionCheckpoint, SessionId, RunId } from "./types.js";

const sessionId = "sqlite-session" as SessionId;
const runId = "sqlite-run" as RunId;
const clock = { now: () => "2026-08-22T00:00:00.000Z" };
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteSessionAdapter", () => {
  it("persists entry chains, resources, traces, and resumable checkpoints", async () => {
    const adapter = new SqliteSessionAdapter(":memory:", { clock });
    await adapter.open(sessionId);
    await adapter.setResources(sessionId, ["zeta", "zeta"], ["mcp-a"]);
    await adapter.beginRun({
      runId,
      sessionId,
      status: "active",
      config: { model: "replay" },
      startedAt: clock.now(),
    });
    await adapter.append([
      {
        entryId: "entry-user" as EntryId,
        sessionId,
        runId,
        kind: "message",
        role: "user",
        payload: { content: "Hello" },
        createdAt: clock.now(),
      },
      {
        entryId: "entry-assistant" as EntryId,
        sessionId,
        parentEntryId: "entry-user" as EntryId,
        runId,
        kind: "message",
        role: "assistant",
        payload: { content: "Hi" },
        createdAt: clock.now(),
      },
    ]);
    await adapter.appendWebTrace(sessionId, { id: "trace-1", run_id: runId, content: "ok" });
    const checkpoint: SessionCheckpoint = {
      runId,
      sessionId,
      reason: "stopped",
      iteration: 1,
      state: {
        promptProfile: "agent",
        originalUserContent: "Hello",
        currentUserMessage: { role: "user", content: "Hello" },
        assistantText: "",
        pendingToolCalls: [],
        completedToolCallIds: [],
        loopMessages: [],
        bootstrapContext: [],
        model: "replay",
        searchMode: "diy",
      },
      createdAt: clock.now(),
      updatedAt: clock.now(),
    };
    await adapter.checkpoint(checkpoint);

    const snapshot = await adapter.open(sessionId);
    expect(snapshot.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    expect(snapshot.activeSkills).toEqual(["zeta"]);
    expect(snapshot.webTraces).toEqual([{ id: "trace-1", run_id: runId, content: "ok", timestamp: clock.now() }]);
    expect((await adapter.resume(sessionId)).checkpoint.state.originalUserContent).toBe("Hello");
    expect((await adapter.list()).at(0)).toMatchObject({ sessionId, title: "Hello", canResume: true });

    await adapter.finishRun({ runId, sessionId, lastEntryId: "entry-assistant" as EntryId, endedAt: clock.now() });
    expect((await adapter.getCheckpoint(sessionId))).toBeUndefined();
    adapter.close();
  });

  it("lazily migrates a legacy session row", async () => {
    const directory = mkdtempSync(join(tmpdir(), "anomalo-session-v2-"));
    tempDirectories.push(directory);
    const dbPath = join(directory, "sessions.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        active_skills_json TEXT NOT NULL,
        active_mcp_servers_json TEXT NOT NULL,
        web_traces_json TEXT NOT NULL,
        checkpoint_json TEXT,
        search_mode TEXT NOT NULL,
        title TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy.prepare(`
      INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      "legacy-session",
      JSON.stringify([{ role: "user", content: "Migrated" }]),
      JSON.stringify(["skill-a"]),
      "[]",
      "[]",
      "diy",
      "Migrated",
      1,
      clock.now(),
    );
    legacy.close();

    const adapter = new SqliteSessionAdapter(dbPath, { clock });
    const snapshot = await adapter.open("legacy-session" as SessionId);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.messages).toEqual([{ role: "user", content: "Migrated" }]);
    expect(snapshot.activeSkills).toEqual(["skill-a"]);
    adapter.close();
  });

  it("normalizes Python v2 checkpoint fields for Node resume", async () => {
    const adapter = new SqliteSessionAdapter(":memory:", { clock });
    await adapter.open("python-checkpoint" as SessionId);
    adapter.db.prepare(
      "INSERT INTO runs(run_id, session_id, status, config_json, started_at) VALUES (?, ?, 'paused', '{}', ?)",
    ).run("python-run", "python-checkpoint", clock.now());
    adapter.db.prepare(
      `INSERT INTO run_checkpoints(
        run_id, session_id, reason, iteration, state_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "python-run",
      "python-checkpoint",
      "user_stop",
      2,
      JSON.stringify({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "partial" },
        ],
        prompt_profile: "agent",
        user_content: "hello",
        response_format: { type: "json_object" },
        bootstrap_context: [{ key: "time", result: "now" }],
      }),
      clock.now(),
      clock.now(),
    );

    const checkpoint = (await adapter.resume("python-checkpoint" as SessionId)).checkpoint;
    expect(checkpoint.state.promptProfile).toBe("agent");
    expect(checkpoint.state.originalUserContent).toBe("hello");
    expect(checkpoint.state.responseFormat).toEqual({ type: "json_object" });
    expect(checkpoint.state.bootstrapContext).toEqual([{ key: "time", result: "now" }]);
    expect(checkpoint.state.loopMessages).toEqual([{ role: "assistant", content: "partial" }]);
    adapter.close();
  });

  it("reports malformed legacy JSON without creating a migrated session", () => {
    const directory = mkdtempSync(join(tmpdir(), "anomalo-session-v2-invalid-"));
    tempDirectories.push(directory);
    const dbPath = join(directory, "sessions.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        active_skills_json TEXT NOT NULL,
        active_mcp_servers_json TEXT NOT NULL,
        web_traces_json TEXT NOT NULL,
        checkpoint_json TEXT,
        search_mode TEXT NOT NULL,
        title TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)").run(
      "invalid-session",
      "{not-json",
      "[]",
      "[]",
      "[]",
      "diy",
      "Invalid",
      1,
      clock.now(),
    );
    legacy.close();

    const dryRun = migrateLegacyDatabase(dbPath, { dryRun: true, clock });
    expect(dryRun.errors).toEqual([{ sessionId: "invalid-session", error: expect.stringContaining("messages_json") }]);
    const report = migrateLegacyDatabase(dbPath, { clock });
    expect(report.errors).toEqual([{ sessionId: "invalid-session", error: expect.stringContaining("messages_json") }]);
    const verify = new DatabaseSync(dbPath);
    expect(verify.prepare("SELECT 1 FROM agent_sessions WHERE session_id = ?").get("invalid-session")).toBeUndefined();
    verify.close();
  });

  it("reports a non-mutating dry run before migrating legacy rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "anomalo-session-v2-dry-"));
    tempDirectories.push(directory);
    const dbPath = join(directory, "sessions.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, messages_json TEXT, updated_at TEXT)");
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("dry-session", "[]", clock.now());
    db.close();

    const report = migrateLegacyDatabase(dbPath, { dryRun: true, clock });
    expect(report).toMatchObject({ dryRun: true, legacySessions: 1, migratedSessions: 0, skippedSessions: 0 });
    const verify = new DatabaseSync(dbPath);
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_sessions'").get()).toBeUndefined();
    verify.close();
  });
});
