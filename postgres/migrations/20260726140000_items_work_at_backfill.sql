-- Backfill `work_at` from the frontmatter for rows that already carry a source date.
--
-- #395 added the column and deliberately backfilled every existing row to `created_at` /
-- `work_at_from_source = false`, relying on the unchanged-re-push heal to converge each row on its
-- source's next tick. That was fine while nothing READ the flag. It stops being fine the moment the
-- timeline gates on it (this PR): straight after the deploy EVERY row reads not-from-source, so the
-- ledger would be blank until each connector's next 30-minute tick — and PERMANENTLY blank for content
-- from a source that has since been disconnected, or pushed once and never again (a hand-pushed
-- decision log, meeting notes), because nothing will ever re-push it to trigger the heal.
--
-- So the convergence argument needed a floor under it, and this is that floor.
--
-- WHY A FUNCTION RATHER THAN A REGEX GUARD: frontmatter is source-controlled text. A regex that
-- accepts "looks like a date" still admits `2026-13-45` and `2026-01-01T99:99`, and a failed
-- `::timestamptz` inside a migration aborts the transaction — i.e. fails the deploy, on data we do not
-- control. Catching the cast is the only way to be certain one bad row can't take the release down.
create or replace function _aios_try_ts(v text) returns timestamptz as $$
begin
  return v::timestamptz;
exception when others then
  return null;   -- unparseable → treat as "the source didn't date it" (the heal may still fix it later)
end $$ language plpgsql stable;

-- Key priority mirrors lib/ingest/work-time's list: an explicit "when it happened" beats an edit time,
-- which beats a creation time. Only the exact spellings our own producers emit are covered — the
-- resolver's spelling-tolerant slow path is TS-side, and anything it alone would catch still converges
-- via the heal. Touches only rows that haven't already been resolved.
update items set
  work_at = coalesce(
    _aios_try_ts(frontmatter->>'committed_at'),
    _aios_try_ts(frontmatter->>'source_ts'),
    _aios_try_ts(frontmatter->>'occurred_at'),
    _aios_try_ts(frontmatter->>'last_edited_time'),
    _aios_try_ts(frontmatter->>'modifiedTime'),
    _aios_try_ts(frontmatter->>'updated'),
    _aios_try_ts(frontmatter->>'date'),
    _aios_try_ts(frontmatter->>'created')
  ),
  work_at_from_source = true
where work_at_from_source = false
  and coalesce(
    _aios_try_ts(frontmatter->>'committed_at'),
    _aios_try_ts(frontmatter->>'source_ts'),
    _aios_try_ts(frontmatter->>'occurred_at'),
    _aios_try_ts(frontmatter->>'last_edited_time'),
    _aios_try_ts(frontmatter->>'modifiedTime'),
    _aios_try_ts(frontmatter->>'updated'),
    _aios_try_ts(frontmatter->>'date'),
    _aios_try_ts(frontmatter->>'created')
  ) is not null;

drop function if exists _aios_try_ts(text);
