-- AIO-1167: per-attempt ownership of Admin/manual Google Drive run requests. Every claim stores a
-- fresh opaque token; only the attempt holding the current token may complete or defer the request,
-- so a late report from an attempt that was recovered and re-claimed cannot touch its successor.
-- Additive: existing pending and finished rows keep a null token (none is owed).
alter table gdrive_run_requests add column if not exists attempt_token uuid;

-- A request already running when this lands was claimed by a connector that never received a token.
-- It gets one nobody holds: its late report is stale, and the row stays recoverable by age once its
-- Drive execution lease is no longer live, exactly like any interrupted attempt.
update gdrive_run_requests set attempt_token = gen_random_uuid()
 where status = 'running' and attempt_token is null;

alter table gdrive_run_requests drop constraint if exists gdrive_run_requests_running_attempt_check;
alter table gdrive_run_requests add constraint gdrive_run_requests_running_attempt_check
  check (status <> 'running' or attempt_token is not null);
