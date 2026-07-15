-- Multiple submitters per meeting note (Meetings merge). When two people upload the same meeting
-- (same date + overlapping content), the transcripts are merged into ONE note and both people are
-- credited as submitters. `meeting_notes.submitted_by` stays the original/primary; this join table
-- holds the full set. Sole writer: lib/meetings/notes.ts. Additive + idempotent; mirrored into
-- schema.sql for from-zero.

create table if not exists meeting_note_submitters (
  meeting_note_id uuid not null references meeting_notes(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  primary key (meeting_note_id, member_id)
);
create index if not exists meeting_note_submitters_member_idx on meeting_note_submitters (member_id);
