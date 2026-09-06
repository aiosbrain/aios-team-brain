-- PRET-6 (docs/design/pret6-retirement.md §2.1): retire the permissive model — drop
-- teams.access_enforcement and teams.autoflip_hold, guarded by a REFUSING precondition.
--
-- REPLAY SHAPE (the #251/#495 class, and this file's own cold-read H1): pg-load-schema
-- replays every migration on every deploy with no applied-ledger, so:
--   * the MARKER refusal runs UNCONDITIONALLY (diff-review HIGH: a pre-flag-era fleet — one
--     installed before 20260811160000 existed — never had the column, so a column-gated
--     marker check would skip it and the whole corpus would go dark at cutover). Replay-safe:
--     the marker is never deleted in production, a from-zero fleet has no teams at its first
--     preDeploy, and the boot materialization stamps the marker (even on a zero-team fleet)
--     before any team can exist for the second;
--   * the COLUMN-gated block keys on the column's EXISTENCE — after the drop, every replay
--     takes the false branch (a clean no-op; a bare permissive-scan would error
--     undefined_column);
--   * the two migrations that CREATED these columns are neutered to comment-only files in
--     this same change (they would otherwise re-create the column with default 'permissive'
--     on the next deploy and wedge this guard forever);
--   * a from-zero load never creates the column (schema.sql amended in this change), so that
--     branch is false there too;
--   * the existence gate is schema-qualified (diff-review LOW: an operator's `backup.teams`
--     copy carrying the old column must not flip the gate true after the drop and wedge
--     every later deploy on undefined_column).
--
-- THE PRECONDITION (H-VANISH made mechanical): a fleet holding any permissive team, or any
-- teams at all without the PRET-4 builtin materialization marker, REFUSES — the raise aborts
-- pg:schema, Railway's preDeploy halts the release, and the old code keeps serving. The fix
-- is in the release notes (docs/RELEASE-NOTES-pret6.md): upgrade through the prior release,
-- let auto-flip converge, flip warned teams manually, verify zero permissive teams remain.
-- (A restored-from-backup fleet whose app is ALREADY RUNNING this release self-heals: the
-- scheduler materialization slot re-stamps the marker within a tick, after which deploys pass.
-- CORRECTED 2026-09-05, STAGINGMARK-1 — this used to say "a restored fleet on THIS release
-- self-heals" without that qualifier, and it is false for the case that actually bites: a fleet
-- that has teams and has NEVER booted this release cannot self-heal at all, because the refusal
-- below stops the deploy, so the code that would stamp the marker never runs. Staging deploy
-- 2e67246e died in exactly that loop. Recovery is `npm run admin -- materialize-builtins`
-- (docs/OPS.md §11) or booting the prior release once. COMMENT ONLY — no behaviour is changed
-- by this edit; the guard below is byte-for-byte what shipped.)
do $$ begin
  if exists (select 1 from teams)
     and not exists (select 1 from migration_markers where name = 'pret4_builtin_materialize') then
    raise exception 'PRET-6 refused: the PRET-4 builtin materialization has not completed on this fleet — upgrade through the prior release first (see docs/RELEASE-NOTES-pret6.md)';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = current_schema() and table_name = 'teams' and column_name = 'access_enforcement') then
    if exists (select 1 from teams where access_enforcement = 'permissive') then
      raise exception 'PRET-6 refused: permissive team(s) remain — flip them first (see docs/RELEASE-NOTES-pret6.md)';
    end if;
    alter table teams drop column access_enforcement;
    alter table teams drop column if exists autoflip_hold;
  end if;
end $$;
