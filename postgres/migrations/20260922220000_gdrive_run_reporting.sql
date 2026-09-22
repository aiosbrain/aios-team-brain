-- Unify scheduled/manual/retry Google Drive reporting in the durable request ledger.
alter table gdrive_run_requests drop constraint if exists gdrive_run_requests_trigger_check;
alter table gdrive_run_requests add constraint gdrive_run_requests_trigger_check
  check (trigger in ('manual','retry','scheduler'));
alter table gdrive_run_requests drop constraint if exists gdrive_run_requests_status_check;
alter table gdrive_run_requests add constraint gdrive_run_requests_status_check
  check (status in ('pending','running','complete','partial','failed','deferred','cancelled'));
