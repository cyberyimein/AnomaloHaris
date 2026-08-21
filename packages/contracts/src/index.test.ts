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

