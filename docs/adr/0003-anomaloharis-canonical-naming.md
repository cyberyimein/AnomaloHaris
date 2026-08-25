# ADR-0003: AnomaloHaris canonical naming and one-time compatibility seam

- Status: Accepted
- Date: 2026-08-25
- Extends: ADR-0002
- Applies from: Stage 0
- Compatibility removal target: before `0.3.0` (or before the first stable release, whichever comes first)

## Context

The repository previously used several forms of the same identity: `Anomalo`,
`anomalo`, `@anomalo/*`, `anomalo.dev`, `ANOMALO_*`, `X-Anomalo-*`, and
`anomalo@1`. Workflow is a new peer Runtime Module, so allowing it to choose a
second naming convention would make package resolution, persisted references,
public protocols, and Luna implementation guidance diverge.

The migration must also preserve existing local installations. A caller may
still send an old environment variable or management/service header during the
compatibility window, but that legacy value must not enter a business Module or
be written back to a database, response, event, manifest, or log field.

## Decision

AnomaloHaris has one canonical identity at every current boundary:

| Boundary | Canonical value | Legacy value handled only by the adapter/migration |
| --- | --- | --- |
| Product and human-readable display | `AnomaloHaris` | `Anomalo` |
| Machine namespace and workspace root | `anomaloharis` | `anomalo` |
| npm package scope | `@anomaloharis/*` | `@anomalo/*` |
| Public Schema URI namespace | `anomaloharis.dev/*` | `anomalo.dev/*` |
| Environment variables | `ANOMALOHARIS_*` | `ANOMALO_*` |
| HTTP headers | `X-AnomaloHaris-*` | `X-Anomalo-*` |
| Built-in Preset Model | `anomaloharis@1` | `anomalo@1` |

The following rules are mandatory:

1. New code, package metadata, schemas, database writes, logs, exports,
   fixtures, and documentation use canonical values only.
2. `LegacyNamingAdapter` is the single compatibility Seam. It gives canonical
   input precedence, reads a legacy environment variable/header only when its
   canonical counterpart is absent, immediately returns the canonical internal
   field, and records only a low-cardinality deprecated-read counter. It never
   records secrets or caller-provided values.
3. `migrate-anomaloharis-naming` is the single persisted-data migration entry
   point. It backs up each changed SQLite file, migrates identities and active
   references transactionally, and recompiles Preset Model snapshots so hashes
   match the canonical identity and current plugin locks.
4. Compatibility is read-only. Responses, response headers, newly persisted
   JSON, plugin locks, capability manifests, and exported workflow definitions
   must never emit the legacy form.
5. The naming CI Gate scans tracked and non-ignored working-tree files. Legacy
   matches are accepted only in the compatibility/deployment adapter, migration
   implementation/tests, explicit migration fixtures, and historical/superseded
   documents. A new product or Workflow Module may not add a local alias.
6. The adapter and its allowlist are removed in the target release above. The
   removal is a separate reviewable change after known callers have switched and
   the deprecated-read counter is zero for the agreed observation window.

## Migration invariants

- Canonical values win if old and new inputs are supplied together.
- The migration is idempotent: a second run finds no legacy identity or active
  reference and performs no write.
- There must never be both `anomalo` and `anomaloharis` rows for the built-in
  identity after migration.
- A failed transaction leaves the source database usable; a failed recompile
  restores the pre-migration backup before reporting failure.
- Existing API route shapes are not renamed as part of this ADR. Only identity,
  headers, environment variables, schemas, package names, persisted references,
  and integration configuration are migrated.

## Consequences

The naming decision reduces ambiguity for the peer Agent Runtime and Workflow
Runtime Modules and gives future plugins one stable package and protocol
namespace. It adds a temporary Adapter and migration command, plus a release
obligation to remove them. A historical document may still quote the old
identity, but it must be explicitly allowlisted and must not be treated as a
current implementation contract.

## Stage 0 verification

The Stage 0 Gate is satisfied only when all of the following are true:

- `npm run check:naming` passes.
- Workspace package scope, schemas, headers, environment templates, default
  Preset Model references, Docker/deployment files, and Urus configuration use
  canonical names.
- The persisted migration dry-run is clean after an apply, its second apply is
  a no-op, and migrated compiled hashes/plugin locks are internally consistent.
- Legacy input compatibility tests pass while response/output assertions remain
  canonical.
