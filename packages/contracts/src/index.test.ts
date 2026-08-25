import { describe, expect, it } from "vitest";

import fixtures from "../fixtures/agent-events.json";
import validWorkflow from "../fixtures/workflows/daily-event-review.json";
import {
  normalizeAgentEvent,
  validateWorkflowDefinition,
  validateAgentEvent,
  validateContract,
} from "./index.js";

describe("@anomaloharis/contracts", () => {
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
      validateContract("runRequest", { message: "hello", preset_model: "anomaloharis@1" }).valid,
    ).toBe(true);
    expect(
      validateContract("presetModelDefinition", {
        name: "anomaloharis",
        version: 1,
        description: "Default",
        provider: { adapter: "openai-compatible", model: "test", tool_protocol: "auto" },
        plugins: { fixed: ["host-core"] },
      }).valid,
    ).toBe(true);
    expect(
      validateContract("llmRequestEventData", {
        model_ref: "anomaloharis@1",
        provider_model: "test",
        iteration: 1,
        request: { message_count: 2, tool_count: 1, response_format: "text" },
        context: { segment_counts: { prompt: 1 }, total_message_count: 2, tool_count: 1, compiled_hash: "uncompiled" },
      }).valid,
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

  it("exports and validates the portable Workflow contracts", () => {
    expect(validateWorkflowDefinition(validWorkflow)).toBe(true);
    expect(validateContract("workflowDefinition", validWorkflow).valid).toBe(true);
    expect(validateContract("workflowDefinition", { ...validWorkflow, kind: "NotWorkflow" }).valid).toBe(false);
    expect(validateContract("workflowCapabilityManifest", {
      api_version: "anomaloharis.dev/workflow-capabilities/v1",
      engine: {
        runtime_id: "workflow-runtime",
        runtime_version: "1.0.0",
        adapter_version: "1.0.0",
        package_hash: `sha256:${"0".repeat(64)}`,
        definition_api_version: "anomaloharis.dev/workflow/v1",
      },
      limits: { graph: "dag", max_nodes: 100, max_edges: 400, max_parallelism: 8, max_duration_seconds: 3600 },
      node_types: [],
      preset_models: [],
      plugin_operations: [],
      unsupported_features: ["loop"],
      generated_at: "2026-08-25T00:00:00Z",
      manifest_hash: `sha256:${"1".repeat(64)}`,
    }).valid).toBe(true);
  });
});
