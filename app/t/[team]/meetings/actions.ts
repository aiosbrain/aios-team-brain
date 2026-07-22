"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { currentMember, requireTeamAdmin } from "@/lib/auth/guard";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import {
  createMeetingNote,
  canSeeMeetingNotes,
  getMeetingNote,
  updateMeetingSummary,
  type ExtractedTodoRef,
} from "@/lib/meetings/notes";
import { extractFromTranscript, type RosterPerson } from "@/lib/meetings/llm-extract";
import { extractAndStoreActionItems } from "@/lib/meetings/action-items";
import { MEETING_TODO_PROJECT_SLUG } from "@/lib/meetings/extract-todos";
import { MEETING_TASK_STATUSES, type MeetingTaskStatus } from "@/lib/meetings/target-status";
import { findDuplicateMeeting, mergeIntoMeetingNote, backfillMergeDuplicateMeetings } from "@/lib/meetings/merge";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import {
  projectRows,
  resolvePrimaryProvider,
  PROJECTION_TASK_COLS,
  type ProjectionTaskRow,
} from "@/lib/pm-sync/project";

const uploadSchema = z.object({
  teamSlug: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  rawText: z.string().trim().min(1).max(200_000),
  occurredAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

async function resolveTeam(teamSlug: string): Promise<{ id: string; slug: string } | null> {
  const db = await serverClient();
  const { data: team } = await db.from("teams").select("id, slug").eq("slug", teamSlug).maybeSingle();
  return (team as { id: string; slug: string } | null) ?? null;
}

/**
 * Upload a meeting transcript: resolves the submitter + team roster, runs the LLM
 * summary/attendee pass (best-effort — never blocks the upload, see lib/meetings/llm-extract),
 * writes the note via the single writer, then auto-extracts action items with the SAME LLM-first
 * extractor the CLI/import path uses (`extractAndStoreActionItems`) — so prose commitments ("Alex
 * will send the deck Friday") are caught, not just checkbox-style todos. Team-tier only.
 */
export async function uploadMeetingNoteAction(
  input: z.input<typeof uploadSchema>
): Promise<{ ok: boolean; error?: string; id?: string; merged?: boolean }> {
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid upload" };

  const team = await resolveTeam(parsed.data.teamSlug);
  if (!team) return { ok: false, error: "team not found" };

  const me = await currentMember(team.id);
  if (!me) return { ok: false, error: "not a member of this team" };
  if (!canSeeMeetingNotes(me.tier)) return { ok: false, error: "team-tier membership required" };

  const admin = adminClient();
  const [{ data: rosterRows }, keys] = await Promise.all([
    admin.from("members").select("id, display_name").eq("team_id", team.id).eq("status", "active"),
    resolveAnsweringKeys(admin, team.id),
  ]);
  const roster: RosterPerson[] = ((rosterRows ?? []) as { id: string; display_name: string }[]).map((m) => ({
    id: m.id,
    displayName: m.display_name,
  }));

  const extraction = await extractFromTranscript(parsed.data.rawText, roster, keys);

  // Duplicate detection: if this is the same meeting someone already uploaded (same date + enough
  // content overlap), merge the transcripts into that note and credit both submitters instead of
  // creating a second copy.
  const dup = await findDuplicateMeeting(admin, team.id, parsed.data.occurredAt ?? null, parsed.data.rawText);
  if (dup) {
    try {
      const mergedNoteId = await mergeIntoMeetingNote(admin, team.id, dup, {
        newRawText: parsed.data.rawText,
        newSubmitterId: me.id,
        newAccess: "team", // GUI uploads are always team-tier (createMeetingNote hard-codes it)
        newAttendeeIds: extraction.attendeeMemberIds,
        roster,
        keys,
      });
      revalidatePath(`/t/${team.slug}/meetings`);
      return { ok: true, id: mergedNoteId, merged: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "could not merge into the existing meeting" };
    }
  }

  let noteId: string;
  try {
    noteId = await createMeetingNote(admin, team.id, {
      title: parsed.data.title,
      rawText: parsed.data.rawText,
      submittedByMemberId: me.id,
      occurredAt: parsed.data.occurredAt ?? null,
      summary: extraction.summary,
      attendeeMemberIds: extraction.attendeeMemberIds,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save the meeting note" };
  }

  try {
    // Resolve the just-ingested transcript item so we can materialize its action items (LLM-first,
    // same as the CLI import path). Best-effort — the note itself already saved.
    const { data: nr } = await admin
      .from("meeting_notes")
      .select("source_item_id")
      .eq("team_id", team.id)
      .eq("id", noteId)
      .maybeSingle();
    const sourceItemId = (nr as { source_item_id: string } | null)?.source_item_id;
    if (sourceItemId) {
      const { data: item } = await admin.from("items").select("id, path, access").eq("id", sourceItemId).maybeSingle();
      const itemRow = item as { id: string; path: string; access: "team" | "external" } | null;
      if (itemRow) {
        await extractAndStoreActionItems(admin, team.id, itemRow, parsed.data.rawText, roster, keys);
      }
    }
  } catch {
    // Action-item extraction is best-effort — the note itself already saved successfully.
  }

  revalidatePath(`/t/${team.slug}/meetings`);
  return { ok: true, id: noteId };
}

/**
 * One-time cleanup: merge already-created duplicate meetings (same date + overlapping transcripts)
 * into one note each, crediting all submitters and hiding the folded-away copies. Admin-only (it's a
 * bulk, content-mutating operation). Uses the same LLM merge as the live upload path.
 */
export async function mergeDuplicateMeetingsAction(
  teamSlug: string
): Promise<{ ok: boolean; merged?: number; clusters?: number; error?: string }> {
  const ctx = await requireTeamAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const admin = adminClient();
  const keys = await resolveAnsweringKeys(admin, ctx.teamId);
  try {
    const s = await backfillMergeDuplicateMeetings(admin, ctx.teamId, { keys, actorMemberId: ctx.memberId });
    revalidatePath(`/t/${teamSlug}/meetings`);
    return { ok: true, merged: s.merged, clusters: s.clusters };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "merge failed" };
  }
}

/**
 * Import meetings that arrived via the CLI/ingest (`aios push`) into the Meetings page. Scans this
 * team's meeting-source transcript `items` that don't yet have a note and creates one for each
 * (summary/attendees extracted, idempotent). Team-tier only, matching `canSeeMeetingNotes`.
 */
export async function importPushedMeetingsAction(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; created?: number; scanned?: number }> {
  const team = await resolveTeam(teamSlug);
  if (!team) return { ok: false, error: "team not found" };

  const me = await currentMember(team.id);
  if (!me) return { ok: false, error: "not a member of this team" };
  if (!canSeeMeetingNotes(me.tier)) return { ok: false, error: "team-tier membership required" };

  const admin = adminClient();
  const keys = await resolveAnsweringKeys(admin, team.id);
  try {
    const s = await backfillMeetingNotesFromItems(admin, team.id, { keys });
    revalidatePath(`/t/${team.slug}/meetings`);
    return { ok: true, created: s.created, scanned: s.scanned };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "import failed" };
  }
}

/**
 * Pull action items out of a single meeting note's transcript and materialize them as tasks (LLM
 * pass with a markdown-scanner fallback — see lib/meetings/action-items). On-demand because the
 * CLI/ingest import path (`aios push`) never extracted todos, so a pushed meeting shows none until
 * this runs. Idempotent (tasks upsert on a stable row_key), team-tier only.
 */
export async function extractMeetingActionItemsAction(
  teamSlug: string,
  noteId: string
): Promise<{ ok: boolean; error?: string; extracted?: number; items?: ExtractedTodoRef[] }> {
  const team = await resolveTeam(teamSlug);
  if (!team) return { ok: false, error: "team not found" };

  const me = await currentMember(team.id);
  if (!me) return { ok: false, error: "not a member of this team" };
  if (!canSeeMeetingNotes(me.tier)) return { ok: false, error: "team-tier membership required" };

  const admin = adminClient();

  // Resolve the note → its transcript item (id/path/access + body). getMeetingNote enforces the
  // team-tier gate and confirms the note belongs to this team.
  const note = await getMeetingNote(admin, team.id, noteId, me.tier);
  if (!note) return { ok: false, error: "meeting note not found" };

  const { data: noteRow } = await admin
    .from("meeting_notes")
    .select("source_item_id")
    .eq("team_id", team.id)
    .eq("id", noteId)
    .maybeSingle();
  const sourceItemId = (noteRow as { source_item_id: string } | null)?.source_item_id;
  if (!sourceItemId) return { ok: false, error: "meeting note not found" };

  // tier-ok: meeting notes are team-tier-only content (canSeeMeetingNotes) and this action is gated
  // on it above; the item id is resolved from a meeting_note the viewer can already see, and only
  // its path/access are read (to derive stable todo row_keys) — never surfaced to an external tier.
  const { data: item } = await admin
    .from("items")
    .select("id, path, access")
    .eq("id", sourceItemId)
    .maybeSingle();
  const itemRow = item as { id: string; path: string; access: "team" | "external" } | null;
  if (!itemRow) return { ok: false, error: "transcript item not found" };

  const [{ data: rosterRows }, keys] = await Promise.all([
    admin.from("members").select("id, display_name").eq("team_id", team.id).eq("status", "active"),
    resolveAnsweringKeys(admin, team.id),
  ]);
  const roster: RosterPerson[] = ((rosterRows ?? []) as { id: string; display_name: string }[]).map((m) => ({
    id: m.id,
    displayName: m.display_name,
  }));

  try {
    const extracted = await extractAndStoreActionItems(
      admin,
      team.id,
      itemRow,
      note.rawText,
      roster,
      keys,
      undefined,
      undefined,
      // Deliberate re-extract: reconcile this transcript's todos (prune stale, un-pushed ones).
      { reconcile: true }
    );
    // Revalidate so a later navigation shows fresh data, AND return the freshly-stored items so the
    // client can render them in place — no router.refresh() / full-route reload on the current view.
    revalidatePath(`/t/${team.slug}/meetings/${noteId}`);
    const fresh = await getMeetingNote(admin, team.id, noteId, me.tier);
    return { ok: true, extracted, items: fresh?.extractedTodos ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "extraction failed" };
  }
}

/**
 * Re-run the LLM summary pass on an existing note and replace its summary — so older meetings with a
 * prose paragraph can be refreshed to the new detailed bulleted format. Team-tier only; best-effort
 * (a failed LLM call leaves the existing summary untouched).
 */
export async function regenerateMeetingSummaryAction(
  teamSlug: string,
  noteId: string
): Promise<{ ok: boolean; error?: string }> {
  const team = await resolveTeam(teamSlug);
  if (!team) return { ok: false, error: "team not found" };

  const me = await currentMember(team.id);
  if (!me) return { ok: false, error: "not a member of this team" };
  if (!canSeeMeetingNotes(me.tier)) return { ok: false, error: "team-tier membership required" };

  const admin = adminClient();
  const note = await getMeetingNote(admin, team.id, noteId, me.tier);
  if (!note) return { ok: false, error: "meeting note not found" };

  const [{ data: rosterRows }, keys] = await Promise.all([
    admin.from("members").select("id, display_name").eq("team_id", team.id).eq("status", "active"),
    resolveAnsweringKeys(admin, team.id),
  ]);
  const roster: RosterPerson[] = ((rosterRows ?? []) as { id: string; display_name: string }[]).map((m) => ({
    id: m.id,
    displayName: m.display_name,
  }));

  const ex = await extractFromTranscript(note.rawText, roster, keys);
  if (!ex.summary.trim()) {
    // The model may be unreachable OR may have answered in a shape we couldn't read — don't assert
    // "unavailable" (misleading: it often IS available; see normalizeSummaryField). Server logs carry
    // the specific transport/parse reason.
    return { ok: false, error: "could not regenerate summary — the model returned an empty or unreadable response" };
  }

  try {
    await updateMeetingSummary(admin, team.id, noteId, ex.summary);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save summary" };
  }
  revalidatePath(`/t/${team.slug}/meetings/${noteId}`);
  return { ok: true };
}

export interface PushTaskResult {
  taskId: string;
  status: "synced" | "skipped" | "failed";
  url?: string;
  error?: string;
}

/**
 * Project the selected meeting-extracted tasks into the team's primary PM tool (Linear/Plane) via
 * the shared projection engine (brain-wins; creates/updates the provider work item and records the
 * task_pm_links row). Only tasks in the "Extracted from Meetings" project that belong to THIS note's
 * transcript are eligible — the ids are re-validated server-side, never trusted from the client.
 */
export async function pushMeetingTasksAction(
  teamSlug: string,
  noteId: string,
  taskIds: string[],
  // Optional per-meeting override of the target category (else each task's current status is used).
  targetStatus?: MeetingTaskStatus
): Promise<{ ok: boolean; error?: string; provider?: string; results?: PushTaskResult[] }> {
  const team = await resolveTeam(teamSlug);
  if (!team) return { ok: false, error: "team not found" };

  const me = await currentMember(team.id);
  if (!me) return { ok: false, error: "not a member of this team" };
  if (!canSeeMeetingNotes(me.tier)) return { ok: false, error: "team-tier membership required" };

  const ids = [...new Set(taskIds)].filter((id) => typeof id === "string" && id.length > 0);
  if (!ids.length) return { ok: false, error: "no tasks selected" };

  const admin = adminClient();

  const primary = await resolvePrimaryProvider(admin, team.id);
  if (primary.provider === null) {
    return { ok: false, error: primary.reason };
  }
  if (primary.integration === null) {
    return { ok: false, provider: primary.provider, error: primary.reason };
  }

  // Resolve the note's transcript item so we can bind eligible tasks to THIS meeting.
  const { data: noteRow } = await admin
    .from("meeting_notes")
    .select("source_item_id")
    .eq("team_id", team.id)
    .eq("id", noteId)
    .maybeSingle();
  const sourceItemId = (noteRow as { source_item_id: string } | null)?.source_item_id;
  if (!sourceItemId) return { ok: false, error: "meeting note not found" };

  // Load only the requested tasks that are genuinely meeting-extracted tasks for this note.
  const { data: taskRows } = await admin
    .from("tasks")
    .select(`${PROJECTION_TASK_COLS}, source_item_id, projects(slug)`)
    .eq("team_id", team.id)
    .in("id", ids);
  const eligible = ((taskRows ?? []) as (ProjectionTaskRow & {
    source_item_id: string | null;
    projects?: { slug?: string } | null;
  })[]).filter((t) => t.source_item_id === sourceItemId && t.projects?.slug === MEETING_TODO_PROJECT_SLUG && t.row_key);
  if (!eligible.length) return { ok: false, provider: primary.provider, error: "no eligible tasks to push" };

  // Per-meeting category override: persist the chosen status on the tasks (so the brain + a later
  // status re-sync stay consistent) and project with it. Falls through to each task's current status.
  const applied = (MEETING_TASK_STATUSES as readonly string[]).includes(targetStatus ?? "")
    ? (targetStatus as MeetingTaskStatus)
    : null;
  if (applied) {
    await admin.from("tasks").update({ status: applied }).eq("team_id", team.id).in("id", eligible.map((t) => t.id));
  }

  const rows: ProjectionTaskRow[] = eligible.map((t) => ({
    id: t.id,
    team_id: t.team_id,
    project_id: t.project_id,
    row_key: t.row_key,
    title: t.title,
    status: applied ?? t.status,
    sprint: t.sprint,
    priority: t.priority,
    labels: t.labels,
    body: t.body,
    parent_row_key: t.parent_row_key,
    assignee: t.assignee,
  }));

  const reports = await projectRows(admin, primary, rows);

  // Reload the links to surface each task's provider URL (the report carries status, not the URL).
  const { data: links } = await admin
    .from("task_pm_links")
    .select("task_id, provider_url, last_error")
    .eq("team_id", team.id)
    .in(
      "task_id",
      eligible.map((t) => t.id)
    );
  const linkByTask = new Map(
    ((links ?? []) as { task_id: string; provider_url: string; last_error: string | null }[]).map((l) => [l.task_id, l])
  );
  const reportByRowKey = new Map(reports.map((r) => [r.row_key, r]));

  const results: PushTaskResult[] = eligible.map((t) => {
    const report = reportByRowKey.get(t.row_key);
    const link = linkByTask.get(t.id);
    const status: PushTaskResult["status"] =
      report?.status === "synced" || report?.status === "skipped" ? report.status : "failed";
    return {
      taskId: t.id,
      status,
      url: link?.provider_url || undefined,
      error: status === "failed" ? report?.error ?? link?.last_error ?? "push failed" : undefined,
    };
  });

  revalidatePath(`/t/${team.slug}/meetings/${noteId}`);
  return { ok: true, provider: primary.provider, results };
}
