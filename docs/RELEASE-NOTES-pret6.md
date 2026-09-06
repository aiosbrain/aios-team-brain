# Release notes — PRET-6: enforcing becomes the only behavior

This release **deletes the permissive access mode**. `teams.access_enforcement` and
`teams.autoflip_hold` are dropped; membership (the oracle) is the only thing that decides what a
member reads. There is no flag to flip back.

## The ORDERED upgrade path (self-host — do not skip steps)

You may **not** jump to this release from a pre-flip installation. The required order:

1. **Run the PRIOR release first** (the PRET-2..5 series). Its auto-flip converges every
   warning-free team to `enforcing` on the scheduler tick, and its boot materialization writes
   the explicit built-in membership rows this release requires.
2. **Flip any remaining permissive team manually** with the CLI that release still carries —
   the readiness scan will tell you exactly what blocks (a human who would go blind, an
   unfinished backfill), and connector warnings are a judgment call for you:

   ```bash
   npm run admin -- set-access-enforcement <team-slug> enforcing
   ```

3. **Verify nothing is left permissive** before upgrading:

   ```sql
   select count(*) from teams where access_enforcement = 'permissive';  -- must be 0
   ```

4. **Then take this release.** Its migration drops the columns and deletes every permissive
   branch.

## If the deploy refuses

The migration still refuses with **`PRET-6 refused: permissive team(s) remain`** when a
team has not passed the readiness/flip path. Complete the ordered steps above; marker repair
is not a substitute for readiness.

**STAGINGMARK-2 removes the missing-marker deploy loop.** A markerless fleet now creates any
absent Everyone/External groups, reconciles every member into exactly the builtin prescribed by
its tier, and stamps `pret4_builtin_materialize` during preDeploy. It also repairs pre-flag-era
fleets without the retired column. An already-marked fleet is untouched, preserving deliberate
membership edits. The single frozen SQL definition lives in `postgres/schema.sql`; the PRET-6
migration only calls it. The attended `npm run admin -- materialize-builtins` command remains
available for inspecting a target and older-release recovery (dry-run first; `docs/OPS.md` §11).

A reserved-slug squatter or a reconcile/drop error fails the deploy. The PRET-6 statement rolls
back membership, marker and drops together; earlier schema and migrations have already committed
because the loader replays files without a wrapping transaction. Correct the reported error and
retry. Never delete a materialization marker to trigger repair: replay could restore deliberately
removed memberships.

On a marker miss, five ordered SHARE ROW EXCLUSIVE locks serialize new callers, with a marker
re-read after waiting. The 15-second per-statement lock timeout allows **6 × 15 s = 90 s** across
those locks and the column-drop lock upgrade, with no total-runtime or fleet-size guarantee.
This relies on no application transaction spanning two locked tables today; old multi-statement
TypeScript materializers remain outside that serialization protocol. Details: `docs/OPS.md` §11.

## What changes for operators

- The `set-access-enforcement` and `auto-flip` CLI commands are gone (their job is complete).
  The readiness scan survives as the standing **access-health check** (`scripts/admin.ts
  access-health <team-slug>`): is any human blind, any agent/connector reading zero, any item
  unpartitioned.
- The permission inspector no longer reports a `mode` — visibility answers are oracle-only.
- `members.tier` remains as the **invite default** record only; explicit built-in group
  membership is the access input everywhere.
