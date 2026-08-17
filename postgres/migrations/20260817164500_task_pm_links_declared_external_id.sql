-- ADOPTDECL-1 — record that a HUMAN named this issue, so the projector can stop guessing.
--
-- `provider_external_id` cannot carry that fact: `ensureLink` (lib/pm-sync/project.ts) defaults it to
-- `row_key`, and the task ingest writes a human declaration into the same column. Two writers with
-- opposite meanings share it, which is why two earlier designs for the adopt rung were both wrong —
-- one missed real declarations, the other would have adopted a stranger's issue.
--
-- Nullable and never defaulted: NULL means "nobody declared anything", which is the predicate the
-- adopt-or-create chain needs. Written only by `lib/ingest/tasks.ts` (guarded by
-- `test/guards/declared-external-id-single-writer.test.ts`).
--
-- NOT SHIPPED HERE, deliberately: a partial unique index on
-- `(team_id, provider, provider_resource_id) where provider_resource_id is not null`, which the spec
-- proposed as the DB backstop for two rows adopting one issue. The prod pre-check the spec required
-- found a live violation — three `TT1` link rows in three different projects all pointing at Linear
-- issue AIO-444 — so the index would abort the release (the #251 replay class). It ships in a
-- follow-up once those rows are reconciled; until then the adopt-time ownership check is the only
-- guard and the check-then-act race is accepted and stated.
alter table if exists task_pm_links
  add column if not exists declared_external_id text;
