import { describe, expect, it } from "vitest";

import fixtures from "../fixtures/agent-events.json";
import {
  normalizeAgentEvent,
  validateAgentEvent,
  validateContract,
} from "./index.js";

describe("@anomalo/contracts", () => {
  it("validates the versioned golden event fixtures", () => {
    for (const event of fixtures.normal_text) {
      expect(validateAgentEvent(event)).toBe(true);
    }
    expect(validateContract("agentEvent", fixtures.legacy_python[0]).valid).toBe(true);
  });

  it("accepts legacy events while rejecting unsupported schema versions", () => {
    expect(normalizeAgentEvent(fixtures.legacy_python[0]).type).toBe("run.started");
    expect(() => normalizeAgentEvent({ type: "run.started", schema_version: 2 })).toThrow(
      "Unsupported agent event schema version",
    );
    expect(
      validateContract("agentEvent", {
        type: "session.state",
        session_id: "session-1",
        run_id: "run-1",
        data: {},
        timestamp: "2026-08-22T00:00:00Z",
      }).valid,
    ).toBe(false);
    expect(
      validateContract("webSocketControlMessage", {
        type: "session.state",
        session_id: "session-1",
        data: { can_resume: false },
      }).valid,
    ).toBe(true);
    expect(validateContract("webSocketMessage", { type: "pong" }).valid).toBe(true);
    expect(
      validateContract("webSocketMessage", {
        type: "message.delta",
        session_id: "session-1",
        run_id: "run-1",
        data: { content: "hello" },
        timestamp: "2026-08-22T00:00:00Z",
      }).valid,
    ).toBe(true);
    expect(validateContract("webSocketMessage", { type: "message.delta" }).valid).toBe(false);
  });

  it("validates tool definitions and run requests through the same registry", () => {
    expect(
      validateContract("runRequest", { message: "hello", resume: false }).valid,
    ).toBe(true);
    expect(
      validateContract("toolDefinition", {
        name: "deterministic_echo",
        description: "Echo a value.",
        parameters: { type: "object" },
        source: "test",
      }).valid,
    ).toBe(true);
  });
});
