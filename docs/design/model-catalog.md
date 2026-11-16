# Shared model catalog

The model catalog gives deployed operators one place to upgrade provider models.
Presets, the system default, and retrieval subagents select stable catalog entries.
Editing an entry changes the actual model used by subsequent runs without changing
preset names or versions or requiring an image rebuild.

## Behavior

- Each entry has a stable ID, display name, provider model ID, credential reference,
  enabled state, revision, and modification history. Secrets remain in deployment
  configuration; the catalog stores credential references only.
- An operator previews affected presets and system selections before applying an
  edit. Concurrent edits must fail explicitly rather than silently overwrite.
- Referenced entries cannot be deleted. Disabling an entry preserves references
  and history and prevents new invocations from silently falling back elsewhere.
- Bulk replacement can move all or selected references to another catalog entry.
- Restoring a previous configuration creates a new revision and preserves history.
- Published preset versions keep their identities, prompts, skills, tools, and
  policies. Retired historical versions retain their historical configuration.
- Existing active presets are migrated idempotently, deduplicating by actual
  provider configuration. Existing workflow dependency hashes must remain valid.
- Each invocation freezes its resolved provider configuration. Later catalog edits
  must not alter an in-progress loop or a paused invocation when resumed. Stored
  run events identify the actual model and catalog revision used.
- Catalog changes and system selections persist on the deployed data volume.

## Acceptance

Backend checks cover migration/restart, duplicate grouping, authorization, affected
references, revision conflicts, referenced deletion, disabling, replacement,
restoration, workflow hashes, and invocation/checkpoint model snapshots.

Playwright checks cover catalog navigation, creating/editing an entry, searchable
preset selection, default and retrieval selections, impact preview, replacement,
restoration, error states, and narrow-screen layout. No UI unit tests are added.

Production rollout retains a stopped rollback container and backs up persistent
databases before the catalog migration. Final production checks use read-only
catalog, preset, runtime, and static resource requests. Real provider calls are
unnecessary for this configuration feature.
