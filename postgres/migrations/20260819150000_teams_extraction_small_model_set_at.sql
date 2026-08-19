-- AIO-983 — an atomic observation boundary for small-model routing evidence.
--
-- `audit_log` is intentionally best-effort at the API boundary. It is useful as a human trail but
-- cannot decide correctness: a setting update may succeed while its audit insert fails, leaving an
-- older timestamp that makes pre-change ledger rows look like post-change drift. Stamp the setting
-- row itself in the same database write, including direct SQL changes outside the admin action.
alter table teams add column if not exists extraction_small_model_set_at timestamptz;

create or replace function stamp_extraction_small_model_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.extraction_small_model is not null then
      new.extraction_small_model_set_at := now();
    end if;
  elsif new.extraction_small_model is distinct from old.extraction_small_model then
    new.extraction_small_model_set_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists teams_extraction_small_model_stamp_insert on teams;
create trigger teams_extraction_small_model_stamp_insert
  before insert on teams for each row execute function stamp_extraction_small_model_change();

drop trigger if exists teams_extraction_small_model_stamp_update on teams;
create trigger teams_extraction_small_model_stamp_update
  before update of extraction_small_model on teams for each row execute function stamp_extraction_small_model_change();
