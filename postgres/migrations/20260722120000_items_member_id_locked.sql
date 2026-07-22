-- Durable attribution authority marker. An item whose `member_id` was set by a DELIBERATE admin action
-- (the NL correction box / "Re-attribute content") is LOCKED, so automatic re-attribution
-- (`reattributeItems`) and the unchanged-repush attribution heal (`lib/ingest`) leave it alone — a
-- routine sync or an unrelated mapping edit can never silently revert a correction (or refill a
-- "correct-to-nobody"). See docs/design/attribution-propagation.md.
alter table items add column if not exists member_id_locked boolean not null default false;
