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
  /** All submitters (≥1 after a merge). Includes `submittedBy`; use this to render credit. */
  submitters: PersonRef[];
  attendees: PersonRef[];
}

export interface ExtractedTodoRef {
  taskId: string;
  rowKey: string;
  title: string;
  assignee: string;
  due: string | null;
  status: string;
  /** Set once the task has been projected into the team's primary PM tool (Linear/Plane). */
  pushed: { provider: string; url: string } | null;
}

export interface MeetingNoteDetail extends MeetingNoteSummary {
  rawText: string;
  extractedTodos: ExtractedTodoRef[];
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** The merge-owned item path for a note — `meetings/<noteId>.md` in the meeting-notes project. No
 *  connector syncs this path, so a body written here is never clobbered by an external sync. */
export function notePath(noteId: string): string {
  return `meetings/${noteId}.md`;
}

/** Re-point a meeting note at a different source item. Used by merge to move a note off a
 *  connector-owned item onto a merge-owned one (`notePath`), so the connector's next sync can't
 *  overwrite the merged transcript. Single writer for `meeting_notes.source_item_id`. */
export async function setMeetingNoteSourceItem(db: DbClient, noteId: string, sourceItemId: string): Promise<void> {
  const { error } = await db.from("meeting_notes").update({ source_item_id: sourceItemId }).eq("id", noteId);
  if (error) throw new Error(`meeting note re-point failed: ${error.message}`);
}

/**
 * Create a meeting note. Writes the transcript through `ingestItem` (kind='transcript',
 * access='team'), then records submitter/attendees/summary here. An attendee id that doesn't
 * resolve to a real member is the caller's problem to filter BEFORE calling this — this function
 * trusts its input and just links whatever ids it's given.
 */
export interface CreateMeetingNoteResult {
  noteId: string;
  /** ENFB-3 D2: false when the inline context reconcile failed or was skipped — the note is
   *  DURABLE but not yet oracle-visible; the scheduler sweep is the standing convergence.
   *  The client must not navigate to a detail that would 404 (design round 2 blocker: an
   *  ok:false on a durable write was a duplicate factory). */
  visible: boolean;
}

export async function createMeetingNote(
  admin: DbClient,
  teamId: string,
  input: CreateMeetingNoteInput
): Promise<CreateMeetingNoteResult> {
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

  // ENFB-3 D2: the gate keys on the item's MEMBERSHIP, and in-process ingestItem does not
  // reconcile context (the HTTP items route does it in after()) — without this, the uploader's
  // own meeting 404s until the ~30-min scheduler sweep. Failure is LOUD and non-fatal: the
  // write is durable, visibility converges on the sweep, and the caller gets visible:false.
  let visible = false;
  try {
    const { reconcileItemContext } = await import("@/lib/projects/context/reconcile-item");
    const rec = await reconcileItemContext(admin, teamId, ingestResult.id);
    visible = rec.ok === true && !("skipped" in rec && rec.skipped);
    if (!visible) console.error(`[meetings] inline reconcile incomplete for item ${ingestResult.id}:`, JSON.stringify(rec));
  } catch (e) {
    console.error(`[meetings] inline reconcile failed for item ${ingestResult.id}:`, e instanceof Error ? e.message : e);
  }

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

  return { noteId, visible };
}

export interface MeetingNoteFromItemInput {
  /** The already-ingested transcript `items` row this note describes. */
  sourceItemId: string;
  title: string;
  occurredAt?: string | null;
  summary?: string;
  submittedByMemberId?: string | null;
  attendeeMemberIds?: string[];
  /** Insert the note already folded into another (a `merged_into` tombstone) — atomic, so it's never
   *  briefly visible and can't be left dangling-visible by a crash before a separate hide step. */
  mergedInto?: string | null;
}

/**
 * Attach a meeting note to an EXISTING transcript item — the bridge for meetings that arrived through
 * the CLI/ingest path (`aios push`) rather than the dashboard upload button. Unlike
 * `createMeetingNote`, it does NOT ingest a new item (the transcript is already in `items`); it only
 * writes the metadata layer. Idempotent on `source_item_id` (unique): if a note already exists for
 * the item, returns it with `created:false`, so re-runs (every scheduler tick) never duplicate.
 */
export async function createMeetingNoteFromItem(
  admin: DbClient,
  teamId: string,
  input: MeetingNoteFromItemInput
): Promise<{ id: string; created: boolean }> {
  const { data: existing } = await admin
    .from("meeting_notes")
    .select("id")
    .eq("team_id", teamId)
    .eq("source_item_id", input.sourceItemId)
    .maybeSingle();
  if (existing) return { id: (existing as { id: string }).id, created: false };

  const title = input.title.trim() || "Meeting";
  const noteId = randomUUID();
  const { error } = await admin.from("meeting_notes").insert({
    id: noteId,
    team_id: teamId,
    source_item_id: input.sourceItemId,
    submitted_by: input.submittedByMemberId ?? null,
    title,
    summary: (input.summary ?? "").trim(),
    occurred_at: input.occurredAt || null,
    merged_into: input.mergedInto ?? null,
  });
  if (error) throw new Error(`meeting note (from item) insert failed: ${error.message}`);

  const attendeeIds = [...new Set(input.attendeeMemberIds ?? [])];
  if (attendeeIds.length) {
    const { error: attErr } = await admin
      .from("meeting_note_attendees")
      .insert(attendeeIds.map((memberId) => ({ meeting_note_id: noteId, member_id: memberId })));
    if (attErr) throw new Error(`meeting note attendees insert failed: ${attErr.message}`);
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: "system",
    member_id: input.submittedByMemberId ?? null,
    action: "meeting_note.created",
    target_type: "meeting_note",
    target_id: noteId,
    meta: { title, attendees: attendeeIds.length, from_item: input.sourceItemId },
  });

  return { id: noteId, created: true };
}

/** Add submitters to a note (idempotent) — used by the merge path to credit both uploaders. */
export async function addMeetingNoteSubmitters(admin: DbClient, noteId: string, memberIds: string[]): Promise<void> {
  const ids = [...new Set(memberIds.filter(Boolean))];
  if (!ids.length) return;
  const { error } = await admin
    .from("meeting_note_submitters")
    .upsert(ids.map((member_id) => ({ meeting_note_id: noteId, member_id })), { onConflict: "meeting_note_id,member_id" });
  if (error) throw new Error(`meeting note submitters insert failed: ${error.message}`);
}

/** Add attendees to a note (idempotent) — used by the merge path to union both transcripts' rosters. */
export async function addMeetingNoteAttendees(admin: DbClient, noteId: string, memberIds: string[]): Promise<void> {
  const ids = [...new Set(memberIds.filter(Boolean))];
  if (!ids.length) return;
  const { error } = await admin
    .from("meeting_note_attendees")
    .upsert(ids.map((member_id) => ({ meeting_note_id: noteId, member_id })), { onConflict: "meeting_note_id,member_id" });
  if (error) throw new Error(`meeting note attendees insert failed: ${error.message}`);
}

/** Point a duplicate note at the survivor it was merged into (hides it from the list). */
export async function setMeetingNoteMergedInto(admin: DbClient, noteId: string, targetNoteId: string): Promise<void> {
  const { error } = await admin.from("meeting_notes").update({ merged_into: targetNoteId }).eq("id", noteId);
  if (error) throw new Error(`meeting note merged_into update failed: ${error.message}`);
}

/** Replace a note's summary (e.g. after a "regenerate summary" pass). Single writer for the column. */
export async function updateMeetingSummary(
  admin: DbClient,
  teamId: string,
  noteId: string,
  summary: string
): Promise<void> {
  const { error } = await admin
    .from("meeting_notes")
    .update({ summary: summary.trim() })
    .eq("team_id", teamId)
    .eq("id", noteId);
  if (error) throw new Error(`meeting summary update failed: ${error.message}`);
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

/**
 * The meetings LIST read (ENFB-3): posture stays the coarse wall, and the MEMBERSHIP oracle
 * bounds the rows — a note's restriction axis is its source transcript item, so the list
 * intersects `source_item_id` with the viewer's visible set IN-QUERY, before the cap (the
 * ENFB-2 starvation discipline). The viewer is a PRINCIPAL, not a caller-supplied tier alone
 * — a tier-shaped parameter is one refactor from being passed a constant.
 * Fail directions: external posture → [] (unchanged); oracle resolution ERROR → throws (the
 * layout surfaces the error boundary — an empty meetings list must mean empty, not broken).
 */
export async function listMeetingNotesForTeam(
  db: DbClient,
  teamId: string,
  viewer: { memberId: string; tier: ViewerTier }
): Promise<MeetingNoteSummary[]> {
  if (!canSeeMeetingNotes(viewer.tier)) return [];
  const { visibleItemIds } = await import("@/lib/access/enforce");
  const vis = await visibleItemIds(db, { teamId, memberId: viewer.memberId });
  if (vis.error) throw new Error("meeting visibility resolution failed");
  // Scaling note (Fable diff L2): this materializes the viewer's whole visible-item set and
  // compiles a bind-per-id IN list — the documented enforce.ts deferral (>65k ids errors →
  // the error boundary, fail closed). The in-query SQL predicate is the lever when it bites.

  const { data: notes } = await db
    .from("meeting_notes")
    .select("id, source_item_id, submitted_by, title, summary, occurred_at, created_at")
    .eq("team_id", teamId)
    .is("merged_into", null) // hide notes that were merged into another (deduped)
    .in("source_item_id", [...vis.ids])
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (notes ?? []) as NoteRow[];
  if (!rows.length) return [];

  const noteIds = rows.map((r) => r.id);
  const [{ data: attendeeRows }, { data: submitterRows }] = await Promise.all([
    db.from("meeting_note_attendees").select("meeting_note_id, member_id").in("meeting_note_id", noteIds),
    db.from("meeting_note_submitters").select("meeting_note_id, member_id").in("meeting_note_id", noteIds),
  ]);
  const groupByNote = (arr: { meeting_note_id: string; member_id: string }[]) => {
    const m = new Map<string, string[]>();
    for (const a of arr) m.set(a.meeting_note_id, [...(m.get(a.meeting_note_id) ?? []), a.member_id]);
    return m;
  };
  const attendeesByNote = groupByNote((attendeeRows ?? []) as { meeting_note_id: string; member_id: string }[]);
  const submittersByNote = groupByNote((submitterRows ?? []) as { meeting_note_id: string; member_id: string }[]);

  const allMemberIds = [
    ...new Set([
      ...rows.flatMap((r) => (r.submitted_by ? [r.submitted_by] : [])),
      ...[...attendeesByNote.values()].flat(),
      ...[...submittersByNote.values()].flat(),
    ]),
  ];
  const people = await loadPeople(db, teamId, allMemberIds);

  return rows.map((r) => {
    // Submitters = the primary submitted_by plus any recorded via a merge, deduped, submitter first.
    const submitterIds = [...new Set([...(r.submitted_by ? [r.submitted_by] : []), ...(submittersByNote.get(r.id) ?? [])])];
    return {
      id: r.id,
      title: r.title,
      summary: r.summary,
      occurredAt: r.occurred_at,
      createdAt: r.created_at,
      submittedBy: r.submitted_by ? (people.get(r.submitted_by) ?? null) : null,
      submitters: submitterIds.map((id) => people.get(id)).filter((p): p is PersonRef => !!p),
      attendees: (attendeesByNote.get(r.id) ?? []).map((id) => people.get(id)).filter((p): p is PersonRef => !!p),
    };
  });
}

/**
 * The meetings DETAIL read (ENFB-3): serves the FULL transcript body — the same bytes the
 * library item page gates behind `canSeeItem` — so it takes the by-id probe here too (the
 * two surfaces must 404 on the same condition, or differencing them leaks the visibility
 * state). Tombstones (merged_into) refuse: "which ids exist" equals "which ids the list
 * shows" — the merge survivor is the one canonical note (D4). Null for denied ≡ null for
 * unknown (§5.7). The list and this probe share the ENFB-1 predicate (canSeeItem ≡
 * visibleItemIds.has, dm-pinned there), so list-membership ≡ detail-200 by construction.
 */
export async function getMeetingNote(
  db: DbClient,
  teamId: string,
  id: string,
  viewer: { memberId: string; tier: ViewerTier }
): Promise<MeetingNoteDetail | null> {
  if (!canSeeMeetingNotes(viewer.tier)) return null;

  const { data: note } = await db
    .from("meeting_notes")
    .select("id, source_item_id, submitted_by, title, summary, occurred_at, created_at, merged_into")
    .eq("team_id", teamId)
    .eq("id", id)
    .maybeSingle();
  const row = note as (NoteRow & { merged_into: string | null }) | null;
  if (!row) return null;
  if (row.merged_into) return null; // D4: a tombstone serves nobody — the survivor is canonical
  const { canSeeItem } = await import("@/lib/access/enforce");
  if (!(await canSeeItem(db, { teamId, memberId: viewer.memberId }, row.source_item_id))) return null;

  const [{ data: item }, { data: attendeeRows }, { data: submitterRows }] = await Promise.all([
    db.from("items").select("body").eq("id", row.source_item_id).maybeSingle(),
    db.from("meeting_note_attendees").select("member_id").eq("meeting_note_id", row.id),
    db.from("meeting_note_submitters").select("member_id").eq("meeting_note_id", row.id),
  ]);
  const attendeeIds = ((attendeeRows ?? []) as { member_id: string }[]).map((a) => a.member_id);
  const submitterIds = [
    ...new Set([
      ...(row.submitted_by ? [row.submitted_by] : []),
      ...((submitterRows ?? []) as { member_id: string }[]).map((s) => s.member_id),
    ]),
  ];
  const people = await loadPeople(db, teamId, [...new Set([...attendeeIds, ...submitterIds])]);

  // Extracted todos: tasks materialized from this note's item (lib/meetings/extract-todos), in the
  // shared "Extracted from Meetings" project — so the UI can link straight to where each landed.
  const { data: todoTasks } = await db
    .from("tasks")
    .select("id, title, status, assignee, due_date, row_key, source_item_id, projects(slug)")
    .eq("team_id", teamId)
    .eq("source_item_id", row.source_item_id)
    .order("created_at", { ascending: true });
  type TodoTaskRow = {
    id: string;
    title: string;
    status: string;
    assignee: string | null;
    due_date: string | null;
    row_key: string | null;
    projects?: { slug?: string } | null;
  };
  const meetingTodos = ((todoTasks ?? []) as TodoTaskRow[]).filter(
    (t) => t.projects?.slug === MEETING_TODO_PROJECT_SLUG
  );

  // Which of those tasks have already been projected into the primary PM tool (task_pm_links carries
  // the provider URL) — so the UI can mark them "pushed" and not offer to push again.
  const pushedByTask = new Map<string, { provider: string; url: string }>();
  if (meetingTodos.length) {
    const { data: links } = await db
      .from("task_pm_links")
      .select("task_id, provider, provider_url")
      .eq("team_id", teamId)
      .in(
        "task_id",
        meetingTodos.map((t) => t.id)
      );
    for (const l of (links ?? []) as { task_id: string; provider: string; provider_url: string }[]) {
      if (l.task_id && l.provider_url) pushedByTask.set(l.task_id, { provider: l.provider, url: l.provider_url });
    }
  }

  const extractedTodos: ExtractedTodoRef[] = meetingTodos.map((t) => ({
    taskId: t.id,
    rowKey: t.row_key ?? "",
    title: t.title,
    assignee: t.assignee ?? "",
    due: t.due_date,
    status: t.status,
    pushed: pushedByTask.get(t.id) ?? null,
  }));

  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    submittedBy: row.submitted_by ? (people.get(row.submitted_by) ?? null) : null,
    submitters: submitterIds.map((id) => people.get(id)).filter((p): p is PersonRef => !!p),
    attendees: attendeeIds.map((mid) => people.get(mid)).filter((p): p is PersonRef => !!p),
    rawText: (item as { body: string } | null)?.body ?? "",
    extractedTodos,
  };
}
