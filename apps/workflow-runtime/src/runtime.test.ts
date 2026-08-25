import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { WorkflowDefinition, WorkflowPresetModelCapability } from "@anomaloharis/contracts";

import { WorkflowCapabilityCatalog } from "./capability-catalog.js";
import { WorkflowRuntime, WorkflowRuntimeError } from "./index.js";

const presetModel: WorkflowPresetModelCapability = {
  ref: "reviewer@1",
  description: "A deterministic test model.",
  compiled_hash: hash("reviewer-compiled"),
  plugin_lock_hash: hash("reviewer-plugins"),
};

describe("WorkflowCapabilityCatalog", () => {
  it("keeps the capability hash stable when generated_at changes", () => {
    let timestamp = "2026-08-25T00:00:00.000Z";
    const catalog = new WorkflowCapabilityCatalog({ now: () => timestamp });
    const first = catalog.manifest();
    timestamp = "2026-08-25T00:01:00.000Z";
    const second = catalog.manifest();

    expect(first.manifest_hash).toBe(second.manifest_hash);
    expect(first.generated_at).not.toBe(second.generated_at);
    expect(first.node_types).toHaveLength(7);
    expect(first.plugin_operations).toEqual([]);
  });
});

describe("WorkflowRuntime", () => {
  it("validates without writing, imports idempotently, and persists lifecycle state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "anomaloharis-workflow-runtime-"));
    const databasePath = join(directory, "workflows.sqlite3");
    const runtime = createRuntime(databasePath);
    const definition = workflowDefinition();

    const report = await runtime.validate(definition);
    expect(report.valid).toBe(true);
    expect(await runtime.list()).toEqual([]);

    const created = await runtime.importDraft(definition);
    expect(created.idempotent).toBe(false);
    expect(created.workflow.status).toBe("draft");
    expect(created.validation.compiled_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const repeated = await runtime.importDraft(definition);
    expect(repeated.idempotent).toBe(true);
    expect(repeated.workflow.compiled_hash).toBe(created.workflow.compiled_hash);

    const published = await runtime.publish(created.workflow.ref);
    expect(published.status).toBe("published");
    await expect(runtime.deleteDraft(created.workflow.ref)).rejects.toMatchObject({ errorCode: "workflow_lifecycle_invalid" });

    const retired = await runtime.retire(created.workflow.ref);
    expect(retired.status).toBe("retired");
    expect((await runtime.exportDefinition(created.workflow.ref)).metadata.name).toBe("daily-review");

    runtime.close();
    const restarted = createRuntime(databasePath);
    expect((await restarted.get(created.workflow.ref, { allowRetired: true })).compiled_hash).toBe(published.compiled_hash);
    restarted.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects exact-ref conflicts and missing dependencies", async () => {
    const runtime = createRuntime(":memory:");
    const definition = workflowDefinition();
    await runtime.importDraft(definition);
    const secondVersion = await runtime.importDraft({
      ...definition,
      metadata: { ...definition.metadata, version: 2, description: "The second version." },
    });
    expect(secondVersion.workflow.ref).toBe("daily-review@2");
    expect((await runtime.list()).map((workflow) => workflow.ref)).toEqual(["daily-review@2", "daily-review@1"]);
    await expect(runtime.importDraft({ ...definition, metadata: { ...definition.metadata, description: "different" } })).rejects.toMatchObject({ errorCode: "workflow_version_conflict" });

    const missing = workflowDefinition("missing@2");
    await expect(runtime.importDraft(missing)).rejects.toSatisfy((error: unknown) => (
      error instanceof WorkflowRuntimeError
      && error.errorCode === "workflow_validation_failed"
      && error.validation?.errors.some((item) => item.code === "WORKFLOW_PRESET_MODEL_NOT_FOUND") === true
    ));
    expect(await runtime.list()).toHaveLength(2);
    runtime.close();
  });

  it("returns validation reports for missing and falsey JSON definitions", async () => {
    const runtime = createRuntime(":memory:");

    const missing = await runtime.validate(undefined);
    expect(missing.errors[0]).toMatchObject({
      code: "WORKFLOW_INVALID_JSON",
      message: "Workflow Definition cannot be serialized as JSON.",
    });

    const falsey = await runtime.validate("0");
    expect(falsey.errors[0]?.code).toBe("WORKFLOW_SCHEMA_INVALID");

    runtime.close();
  });
});

function createRuntime(databasePath: string): WorkflowRuntime {
  return new WorkflowRuntime({
    databasePath,
    presetModels: {
      listPublished: () => [presetModel],
      resolve: (ref) => ref === presetModel.ref ? presetModel : undefined,
    },
  });
}

function workflowDefinition(modelRef = presetModel.ref): WorkflowDefinition {
  return {
    api_version: "anomaloharis.dev/workflow/v1",
    kind: "Workflow",
    metadata: { name: "daily-review", version: 1, description: "Review one message." },
    spec: {
      input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
      output_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
      nodes: [
        { id: "input", type: "input", type_version: 1, config: {} },
        { id: "review", type: "preset_model", type_version: 1, config: { model_ref: modelRef, input_mode: "message", session_mode: "isolated" } },
        { id: "output", type: "output", type_version: 1, config: {} },
      ],
      edges: [
        { from: { node: "input", port: "data" }, to: { node: "review", port: "input" } },
        { from: { node: "review", port: "output" }, to: { node: "output", port: "result" } },
      ],
      policy: { timeout_seconds: 30, max_parallelism: 2, failure_mode: "fail_fast" },
    },
  };
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${value.padEnd(64, "0").slice(0, 64)}`;
}
