import { DatabaseSync } from "node:sqlite";

import {
  type WorkflowCapabilityManifest,
  type WorkflowDefinition,
  type WorkflowImportResult,
  type WorkflowRef,
  type WorkflowSummary,
  type WorkflowValidationReport,
} from "@anomaloharis/contracts";

import { WorkflowCapabilityCatalog, type WorkflowCapabilityCatalogOptions } from "./capability-catalog.js";
import { WorkflowRuntimeError } from "./errors.js";
import { SqliteWorkflowRegistry, type StoredWorkflow, type WorkflowListOptions, type WorkflowResolveOptions } from "./registry.js";
import { WorkflowValidator } from "./validator.js";

export interface WorkflowManagement {
  capabilities(): WorkflowCapabilityManifest;
  validate(definition: unknown): Promise<WorkflowValidationReport>;
  importDraft(definition: unknown): Promise<WorkflowImportResult>;
  list(options?: WorkflowListOptions): Promise<WorkflowSummary[]>;
  get(ref: WorkflowRef, options?: WorkflowResolveOptions): Promise<StoredWorkflow>;
  exportDefinition(ref: WorkflowRef): Promise<WorkflowDefinition>;
  publish(ref: WorkflowRef): Promise<StoredWorkflow>;
  retire(ref: WorkflowRef): Promise<StoredWorkflow>;
  deleteDraft(ref: WorkflowRef): Promise<void>;
}

export type WorkflowRuntimeOptions = WorkflowCapabilityCatalogOptions & {
  database?: DatabaseSync;
  databasePath?: string;
  now?: () => string;
};

export class WorkflowRuntime implements WorkflowManagement {
  readonly identity = "workflow-runtime" as const;
  readonly catalog: WorkflowCapabilityCatalog;
  readonly registry: SqliteWorkflowRegistry;
  private readonly validator: WorkflowValidator;

  constructor(options: WorkflowRuntimeOptions = {}) {
    this.catalog = new WorkflowCapabilityCatalog(options);
    this.registry = new SqliteWorkflowRegistry(options.databasePath ?? ":memory:", {
      ...(options.database ? { database: options.database } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.validator = new WorkflowValidator(this.catalog);
  }

  capabilities(): WorkflowCapabilityManifest {
    return this.catalog.manifest();
  }

  async validate(definition: unknown): Promise<WorkflowValidationReport> {
    return this.validator.validate(definition);
  }

  async importDraft(definition: unknown): Promise<WorkflowImportResult> {
    const result = this.validator.validateAndCompile(definition);
    if (!result.report.valid || !result.definition || !result.compiled) {
      throw new WorkflowRuntimeError("workflow_validation_failed", "Workflow Definition validation failed.", 400, result.report);
    }
    const stored = this.registry.insertDraft({ definition: result.definition, report: result.report, compiled: result.compiled });
    return { workflow: summaryOf(stored.workflow), validation: stored.workflow.validation, idempotent: stored.idempotent };
  }

  async list(options?: WorkflowListOptions): Promise<WorkflowSummary[]> {
    return this.registry.list(options).map(summaryOf);
  }

  async get(ref: WorkflowRef, options?: WorkflowResolveOptions): Promise<StoredWorkflow> {
    return this.registry.get(ref, options);
  }

  async exportDefinition(ref: WorkflowRef): Promise<WorkflowDefinition> {
    return structuredClone((await this.registry.get(ref, { allowDraft: true, allowRetired: true })).definition);
  }

  async publish(ref: WorkflowRef): Promise<StoredWorkflow> {
    const current = this.registry.get(ref, { allowDraft: true, allowRetired: true });
    if (current.status === "retired") throw new WorkflowRuntimeError("workflow_lifecycle_invalid", "A retired Workflow cannot be published again.", 409);
    if (current.status === "published") return current;
    const result = this.validator.validateAndCompile(current.definition);
    if (!result.report.valid || !result.compiled) {
      throw new WorkflowRuntimeError("workflow_validation_failed", "Workflow Definition validation failed during publish.", 409, result.report);
    }
    return this.registry.updatePublished({ ref, report: result.report, compiled: result.compiled });
  }

  async retire(ref: WorkflowRef): Promise<StoredWorkflow> {
    return this.registry.retire(ref);
  }

  async deleteDraft(ref: WorkflowRef): Promise<void> {
    this.registry.deleteDraft(ref);
  }

  close(): void {
    this.registry.close();
  }
}

function summaryOf(stored: StoredWorkflow): WorkflowSummary {
  const {
    definition: _definition,
    compiled: _compiled,
    dependency_locks: _locks,
    validation: _validation,
    ...summary
  } = structuredClone(stored);
  return summary;
}
