-- Soft-hide merged-away duplicate meeting notes (Meetings merge backfill). When two already-created
-- notes turn out to be the same meeting, their content is merged into one and the other is pointed
-- at the survivor via `merged_into`; readers hide notes with `merged_into` set. Keeping the row (vs
-- deleting the item) means the CLI import path never resurfaces it. Sole writer: lib/meetings/notes.ts.
-- Additive + idempotent; mirrored into schema.sql for from-zero.

alter table meeting_notes add column if not exists merged_into uuid references meeting_notes(id) on delete set null;
create index if not exists meeting_notes_merged_into_idx on meeting_notes (merged_into);
