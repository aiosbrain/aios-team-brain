import "server-only";
import { randomUUID, createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { ingestItem } from "@/lib/ingest";
import { audit } from "@/lib/api/audit";
import { MEETING_TODO_PROJECT_SLUG } from "@/lib/meetings/extract-todos";

/**
 * Sole writer of `meeting_notes` / `meeting_note_attendees` (CLAUDE.md §2). The full transcript
 * text is NOT stored here — it's written as a normal `items` row through the EXISTING
 * `lib/ingest.ingestItem` single writer (kind='transcript'), so a meeting note is searchable/
 * queryable through the standard FTS/retrieve pipeline for free. This module owns only the rich
 * metadata layer `items` has no columns for: who submitted it, who attended, an LLM-written
 * summary. Guarded by test/guards/single-writer-meeting-notes.test.ts.
 *
 * Meeting notes are TEAM-TIER ONLY by design (see `canSeeMeetingNotes`) — always ingested at
 * access='team', never external. There is no UI path to make one external.
 */

export const MEETING_NOTES_PROJECT_SLUG = "meeting-notes";

export type ViewerTier = "team" | "external";

/** Meeting notes are internal-only content — mirrors lib/identity/context.canSeeMemberContext. */
export function canSeeMeetingNotes(tier: ViewerTier): boolean {
  return tier === "team";
}

export interface CreateMeetingNoteInput {
  title: string;
  rawText: string;
  submittedByMemberId: string;
  /** YYYY-MM-DD, when the meeting actually happened (defaults to today if omitted). */
  occurredAt?: string | null;
  summary?: string;
  attendeeMemberIds?: string[];
}

export interface PersonRef {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  avatarDataUrl: string | null;
}

export interface MeetingNoteSummary {
  id: string;
  title: string;
  summary: string;
  occurredAt: string | null;
  createdAt: string;
  submittedBy: PersonRef | null;
  attendees: PersonRef[];
}

export interface ExtractedTodoRef {
  taskId: string;
  title: string;
  status: string;
}

export interface MeetingNoteDetail extends MeetingNoteSummary {
  rawText: string;
  extractedTodos: ExtractedTodoRef[];
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function notePath(noteId: string): string {
  return `meetings/${noteId}.md`;
}

/**
 * Create a meeting note. Writes the transcript through `ingestItem` (kind='transcript',
 * access='team'), then records submitter/attendees/summary here. An attendee id that doesn't
 * resolve to a real member is the caller's problem to filter BEFORE calling this — this function
 * trusts its input and just links whatever ids it's given.
 */
export async function createMeetingNote(
  admin: DbClient,
  teamId: string,
  input: CreateMeetingNoteInput
): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error("meeting note title is required");
  const rawText = input.rawText.trim();
  if (!rawText) throw new Error("meeting note text is required");

  const noteId = randomUUID();
  const ingestResult = await ingestItem(
    admin,
    { teamId, memberId: input.submittedByMemberId, apiKeyId: randomUUID() },
    {
      project: MEETING_NOTES_PROJECT_SLUG,
      path: notePath(noteId),
      kind: "transcript",
      content_sha256: stableHash(rawText),
      actor: "meeting-notes-upload",
      access: "team",
      frontmatter: { title },
      body: rawText,
    },
    "team",
    { authorMemberId: input.submittedByMemberId }
  );

  const { error } = await admin.from("meeting_notes").insert({
    id: noteId,
    team_id: teamId,
    source_item_id: ingestResult.id,
    submitted_by: input.submittedByMemberId,
    title,
    summary: (input.summary ?? "").trim(),
    occurred_at: input.occurredAt || null,
  });
  if (error) throw new Error(`meeting note insert failed: ${error.message}`);

  const attendeeIds = [...new Set(input.attendeeMemberIds ?? [])];
  if (attendeeIds.length) {
    const { error: attErr } = await admin
      .from("meeting_note_attendees")
      .insert(attendeeIds.map((memberId) => ({ meeting_note_id: noteId, member_id: memberId })));
    if (attErr) throw new Error(`meeting note attendees insert failed: ${attErr.message}`);
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: "member",
    member_id: input.submittedByMemberId,
    action: "meeting_note.created",
    target_type: "meeting_note",
    target_id: noteId,
    meta: { title, attendees: attendeeIds.length },
  });

  return noteId;
}

type MemberRow = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  member_profiles?: { avatar_data_url: string | null } | null;
};

/** Load a set of members (by id) with both avatar sources resolved, keyed by id. */
async function loadPeople(db: DbClient, teamId: string, memberIds: string[]): Promise<Map<string, PersonRef>> {
  const out = new Map<string, PersonRef>();
  if (!memberIds.length) return out;
  const { data: members } = await db
    .from("members")
    .select("id, display_name, avatar_url")
    .eq("team_id", teamId)
    .in("id", memberIds);
  const { data: profiles } = await db
    .from("member_profiles")
    .select("member_id, avatar_data_url")
    .in("member_id", memberIds);
  const avatarByMember = new Map(
    ((profiles ?? []) as { member_id: string; avatar_data_url: string | null }[]).map((p) => [
      p.member_id,
      p.avatar_data_url,
    ])
  );
  for (const m of (members ?? []) as MemberRow[]) {
    out.set(m.id, {
      id: m.id,
      displayName: m.display_name,
      avatarUrl: m.avatar_url,
      avatarDataUrl: avatarByMember.get(m.id) ?? null,
    });
  }
  return out;
}

type NoteRow = {
  id: string;
  source_item_id: string;
  submitted_by: string | null;
  title: string;
  summary: string;
  occurred_at: string | null;
  created_at: string;
};

/** Team-tier only (see canSeeMeetingNotes) — returns [] for an external caller rather than erroring. */
export async function listMeetingNotesForTeam(
  db: DbClient,
  teamId: string,
  tier: ViewerTier
): Promise<MeetingNoteSummary[]> {
  if (!canSeeMeetingNotes(tier)) return [];

  const { data: notes } = await db
    .from("meeting_notes")
    .select("id, source_item_id, submitted_by, title, summary, occurred_at, created_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (notes ?? []) as NoteRow[];
  if (!rows.length) return [];

  const { data: attendeeRows } = await db
    .from("meeting_note_attendees")
    .select("meeting_note_id, member_id")
    .in(
      "meeting_note_id",
      rows.map((r) => r.id)
    );
  const attendeesByNote = new Map<string, string[]>();
  for (const a of (attendeeRows ?? []) as { meeting_note_id: string; member_id: string }[]) {
    const arr = attendeesByNote.get(a.meeting_note_id) ?? [];
    arr.push(a.member_id);
    attendeesByNote.set(a.meeting_note_id, arr);
  }

  const allMemberIds = [
    ...new Set([
      ...rows.flatMap((r) => (r.submitted_by ? [r.submitted_by] : [])),
      ...[...attendeesByNote.values()].flat(),
    ]),
  ];
  const people = await loadPeople(db, teamId, allMemberIds);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
    submittedBy: r.submitted_by ? (people.get(r.submitted_by) ?? null) : null,
    attendees: (attendeesByNote.get(r.id) ?? []).map((id) => people.get(id)).filter((p): p is PersonRef => !!p),
  }));
}

/** Team-tier only (see canSeeMeetingNotes) — returns null for an external caller or a miss. */
export async function getMeetingNote(
  db: DbClient,
  teamId: string,
  id: string,
  tier: ViewerTier
): Promise<MeetingNoteDetail | null> {
  if (!canSeeMeetingNotes(tier)) return null;

  const { data: note } = await db
    .from("meeting_notes")
    .select("id, source_item_id, submitted_by, title, summary, occurred_at, created_at")
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();
  const row = note as NoteRow | null;
  if (!row) return null;

  const [{ data: item }, { data: attendeeRows }] = await Promise.all([
    db.from("items").select("body").eq("id", row.source_item_id).maybeSingle(),
    db.from("meeting_note_attendees").select("member_id").eq("meeting_note_id", row.id),
  ]);
  const attendeeIds = ((attendeeRows ?? []) as { member_id: string }[]).map((a) => a.member_id);
  const people = await loadPeople(db, teamId, row.submitted_by ? [...attendeeIds, row.submitted_by] : attendeeIds);

  // Extracted todos: tasks materialized from this note's item (lib/meetings/extract-todos), in the
  // shared "Extracted from Meetings" project — so the UI can link straight to where each landed.
  const { data: todoTasks } = await db
    .from("tasks")
    .select("id, title, status, source_item_id, projects(slug)")
    .eq("team_id", teamId)
    .eq("source_item_id", row.source_item_id);
  const extractedTodos = ((todoTasks ?? []) as { id: string; title: string; status: string; projects?: { slug?: string } | null }[])
    .filter((t) => t.projects?.slug === MEETING_TODO_PROJECT_SLUG)
    .map((t) => ({ taskId: t.id, title: t.title, status: t.status }));

  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    submittedBy: row.submitted_by ? (people.get(row.submitted_by) ?? null) : null,
    attendees: attendeeIds.map((mid) => people.get(mid)).filter((p): p is PersonRef => !!p),
    rawText: (item as { body: string } | null)?.body ?? "",
    extractedTodos,
  };
}
