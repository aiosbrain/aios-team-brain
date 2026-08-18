-- PRET-6 (docs/design/pret6-retirement.md §2.1): retire the permissive model — drop
-- teams.access_enforcement and teams.autoflip_hold, guarded by a REFUSING precondition.
--
-- REPLAY SHAPE (the #251/#495 class, and this file's own cold-read H1): pg-load-schema
-- replays every migration on every deploy with no applied-ledger, so:
--   * the OUTER gate keys on the COLUMN'S EXISTENCE — after the drop, every replay takes the
--     false branch (a clean no-op; a bare permissive-scan would error undefined_column);
--   * the two migrations that CREATED these columns are neutered to comment-only files in
--     this same change (they would otherwise re-create the column with default 'permissive'
--     on the next deploy and wedge this guard forever);
--   * a from-zero load never creates the column (schema.sql amended in this change), so the
--     branch is false there too.
--
-- THE PRECONDITION (H-VANISH made mechanical): a fleet holding any permissive team, or any
-- teams at all without the PRET-4 builtin materialization marker, REFUSES — the raise aborts
-- pg:schema, Railway's preDeploy halts the release, and the old code keeps serving. The fix
-- is in the release notes (docs/RELEASE-NOTES-pret6.md): upgrade through the prior release,
-- let auto-flip converge, flip warned teams manually, verify zero permissive teams remain.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_name = 'teams' and column_name = 'access_enforcement') then
    if exists (select 1 from teams where access_enforcement = 'permissive') then
      raise exception 'PRET-6 refused: permissive team(s) remain — flip them first (see docs/RELEASE-NOTES-pret6.md)';
    end if;
    if exists (select 1 from teams)
       and not exists (select 1 from migration_markers where name = 'pret4_builtin_materialize') then
      raise exception 'PRET-6 refused: the PRET-4 builtin materialization has not completed on this fleet — upgrade through the prior release first (see docs/RELEASE-NOTES-pret6.md)';
    end if;
    alter table teams drop column access_enforcement;
    alter table teams drop column if exists autoflip_hold;
  end if;
end $$;
