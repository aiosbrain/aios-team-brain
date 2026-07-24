-- work_events.status gains 'linked': we resolved the PR's key to a real task, but deliberately did NOT
-- complete it or write back to the PM tool. This is the safe outcome for a TEAM-WIDE fallback match (the
-- project-scope resolution fix) — see docs/design/pr-task-link-propagation.md. 'applied' keeps its meaning
-- (matched in the pushed project → task completed + projected).
--
-- CHECK re-add convention (#251 replay incident): DROP then re-add with the FULL value set, never a
-- narrower re-add — an older replayed migration re-adding a narrow set breaks a deploy on live rows.
alter table work_events drop constraint if exists work_events_status_check;
alter table work_events
  add constraint work_events_status_check
  check (status in ('applied', 'unresolved', 'linked'));
