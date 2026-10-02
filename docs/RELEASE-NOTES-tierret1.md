# Release notes — TIERRET-1: membership is the only member content read rule

Ticket AIO-1045 (brain row TIERRET-1). Spec: `docs/design/tierret1-membership-only.md`.

## What changes for readers

- **An admitted member reads exactly what its group grants serve, whatever the content's label.** An
  external collaborator granted a project now receives that project's `team`-labelled items, the
  tasks/decisions sourced from them, its meeting notes (transcript membership), grounding, OKF default
  export, timeline evidence and project cards — the same as a team-posture member with the same grant.
- **Hand-entered rows** (`created_by` set, no source item): an oracle-accepted Everyone human still sees
  all of them (unchanged); every other admitted member sees those in its **granted** projects only; a
  grantless member sees none.
- **Unchanged:** delegated `aiosd_` tokens (effective-project attenuation, external delegation still
  refused, graph/organization mirror legs still omitted); legacy connector/offroster API keys (they gain
  nothing and lose nothing — including their pre-existing hand-entered rows at Everyone posture and their
  organization-structure legs); every WRITE privilege (create destinations, uploads, meeting actions,
  admin commands); push coercion (an external key still cannot overwrite a team item and a fresh
  external push is still stored `external`); explicit `?tier=external` OKF export narrowing and link
  redaction; people identity context; codebase/maturity telemetry; social admin gating and
  publication ceilings.
- Grants take effect **immediately on deploy** — there is no migration, no re-ingest, no data rewrite.

## REQUIRED before rollout (each instance)

1. **Census must be clean.** For every team run the existing protected health read and confirm ZERO
   unsanctioned protected-target grants (General AND external-shared):

   ```bash
   npm run admin -- access-health <team-slug>
   ```

   Any `unsanctioned edge(s) on system projects` blocker must be repaired through the existing
   sanctioned procedure (`npm run admin -- repair-system-edge <group-slug> <project-slug> --actor
   <admin-email>`, AUDITFIX-21) BEFORE
   deploying. This release does not perform any repair.
   **Why it is now mandatory:** the replacement placement gate (`system-integrity`) refuses to place
   content into a protected project that holds an unsanctioned grant, in BOTH directions — a corrupted
   **external-shared** now stops a team→external (widening) push, and a corrupted **General** stops a
   narrowing push or a backfill, rolling the item's transaction back. That is intentional (the old gate
   let a forbidden General edge silently publish team content), but it can interrupt ingestion until the
   edge is repaired.
2. **Review the new drift blocker.** The same health read now reports `active external-tier human
   member(s) are in the builtin Everyone group`. Everyone grants General, so each listed person reads all
   team content. Resolve each deliberately (remove from Everyone, or set tier to team). This detects a
   persisted tier/membership MISMATCH only; a contractor deliberately added to Everyone through the
   groups writer has tier mirrored to `team` and is not detectable here.

## Timeline cache — rollback and roll-forward

- Rows now live under a NEW key namespace `adm:<class>:<tier>:<hash>` at payload version **16** (15 is
  reserved by the pending Slack-semantics change). Previous code reads only `vis:<tier>:<hash>` rows, so
  **rolling back cannot serve or salvage the wider new rows** — no purge is needed for rollback safety.
  The old `vis:` rows are never read by the new code and may be deleted at leisure for space.
- **MANDATORY before rolling FORWARD again after any rollback:** the old code cannot maintain `adm:` rows
  (a reclassification during the rollback window leaves them stale), so delete them before the new build
  serves requests:

  ```sql
  delete from work_timeline_cache where group_key like 'adm:%';
  ```

  (Code equivalent: `lib/dashboard/timeline-cache.purgeAdmissionTimelineNamespace`, which also drops the
  process-local copies; a fresh deploy starts with empty process caches.) Do not rely on TTL or on the
  payload version for this.
- A code rollback restores the old restrictive member filters and the old placement gate. It does not
  retract content already read, and it may hide intentionally granted content again. Grants, labels and
  memberships are untouched either way.

## Clients — re-pull to receive OLDER newly admitted rows

Task/decision timestamps and OKF cursors do **not** move when access changes, so rows that become
visible now are older than every existing client cursor. To receive them, each workspace should:

1. Back up its workspace state file `.aios/state.json` (operator state outside this repository).
2. Reset ONLY these cursor keys to the epoch `1970-01-01T00:00:00Z` (or remove them), preserving push
   hashes and every other key: `last_pull`, `last_tasks_pull`, `last_sync_tasks_pull`,
   `last_decisions_pull`.
3. Run `aios pull`. (There is no `--full` flag.) Repeated pulls merge by row key, so re-pulling is
   idempotent.

OKF consumers must discard their own cursor and request from the epoch. Previously downloaded local data
is **not** revoked by later server-side grant changes.

## Known composition, stated

An authorized reader can copy content it may read into a new workspace push; the server already permits
this for membership-visible item bodies and is not a transitive information-flow control. This release
adds no writer capability and does not change either writer rule above.
