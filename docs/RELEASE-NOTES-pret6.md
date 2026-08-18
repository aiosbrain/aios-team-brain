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
   npx tsx scripts/admin.ts set-access-enforcement <team-slug> enforcing
   ```

3. **Verify nothing is left permissive** before upgrading:

   ```sql
   select count(*) from teams where access_enforcement = 'permissive';  -- must be 0
   ```

4. **Then take this release.** Its migration drops the columns and deletes every permissive
   branch.

## If the deploy refuses

The migration **refuses to apply** — and the release halts at preDeploy, with the old code
still serving — in exactly two cases, each named in the raised error:

- **`PRET-6 refused: permissive team(s) remain — flip them first (see docs/RELEASE-NOTES-pret6.md)`**
  A team is still permissive. Merging/deploying anyway would have flipped it without the
  readiness gate, silently hiding content from members the gate would have warned about
  (the H-VANISH hazard). Do step 2 above, then redeploy.
- **`PRET-6 refused: the PRET-4 builtin materialization has not completed on this fleet — upgrade through the prior release first (see docs/RELEASE-NOTES-pret6.md)`**
  Your database has teams but no `pret4_builtin_materialize` marker — typically a
  restored-from-backup DB or a skipped release. Boot the prior release once (its startup runs
  the materialization), then take this one.

A refused deploy is **safe**: the guard runs before the drop, nothing is half-applied, and the
running version keeps serving. Replaying the migration after a successful drop is a clean
no-op, and a from-zero install never sees the guard fire (a fresh DB has no teams).

## What changes for operators

- The `set-access-enforcement` and `auto-flip` CLI commands are gone (their job is complete).
  The readiness scan survives as the standing **access-health check** (`scripts/admin.ts
  access-health <team-slug>`): is any human blind, any agent/connector reading zero, any item
  unpartitioned.
- The permission inspector no longer reports a `mode` — visibility answers are oracle-only.
- `members.tier` remains as the **invite default** record only; explicit built-in group
  membership is the access input everywhere.
