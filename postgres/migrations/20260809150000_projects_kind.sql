-- Access bootstrap, Phase A slice 3 (spec §11): `projects.kind`.
--   'source'     — ingestion-created container (every existing row; the column default)
--   'system'     — the two §11 built-in projects: general, external-shared
--   'initiative' — human-facing project (dashboard-created; arrives with the Part II substrate,
--                  listed NOW so the CHECK never needs a narrowing replay later)
-- Named drop-and-re-add CHECK per postgres/migrations/README.md (replay-repairable; the
-- integrations_type_check lesson). Widening later = update THIS list to the complete set.

alter table projects add column if not exists kind text not null default 'source';

do $$
begin
  alter table projects drop constraint if exists projects_kind_check;
  alter table projects add constraint projects_kind_check
    check (kind in ('initiative','source','system'));
end $$;
