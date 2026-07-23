import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { ingestItem } from "@/lib/ingest";
import { audit } from "@/lib/api/audit";
import { completeTextOrNull } from "@/lib/llm/complete";
import { extractFromTranscript, type ProviderKeys, type RosterPerson } from "./llm-extract";
import { extractAndStoreActionItems } from "./action-items";
import { remapMeetingTodoSourceItem } from "./extract-todos";
import { canLlmMerge, mergeTranscripts, transcriptOverlap } from "./merge-format";
import {
  MEETING_NOTES_PROJECT_SLUG,
  addMeetingNoteAttendees,
  addMeetingNoteSubmitters,
  createMeetingNoteFromItem,
  notePath,
  setMeetingNoteMergedInto,
  setMeetingNoteSourceItem,
  updateMeetingSummary,
} from "./notes";

const MERGE_SYSTEM =
  "You are given two transcripts of the SAME meeting, captured by different note-takers. They " +
  "overlap heavily, but each may contain passages the other missed. Produce ONE clean, complete " +
  "merged transcript that combines BOTH: keep every unique statement, remove duplicated/overlapping " +
  "passages, and preserve chronological + speaker structure where discernible. Do NOT summarize, " +
  "shorten, or omit substance — this is a MERGE, not a summary. Output ONLY the merged transcript " +
  "text, with no preamble or commentary.";

/**
 * LLM-merge two overlapping transcripts of the same meeting into one clean transcript, via the
 * settings-aware completion primitive (honors the team's answering provider). Best-effort: returns
 * null when no LLM is configured, when the transcripts are too long for a single pass (caller falls
 * back to the lossless deterministic union), or when the model degrades to a summary (much shorter
 * than the longer input) — so a bad result never silently drops content.
 */
export async function mergeTranscriptsLLM(a: string, b: string, keys: ProviderKeys): Promise<string | null> {
  const hasLlm = !!(
    keys.openaiKey ||
    keys.anthropicKey ||
    keys.openrouterKey ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.LLM_BASE_URL
  );
  if (!hasLlm || !canLlmMerge(a, b)) return null;

  const prompt = `Transcript A:\n\n${a}\n\n=====\n\nTranscript B:\n\n${b}`;
  const raw = await completeTextOrNull({ system: MERGE_SYSTEM, prompt }, { keys, jsonObject: false, maxTokens: 8192 });
  const text = raw?.trim();
  if (!text) return null;
  // A merge should be at least as long as the longer source; a much shorter result means the model
  // summarized instead of merging — reject so the deterministic union is used instead.
  if (text.length < Math.max(a.length, b.length) * 0.6) return null;
  return text;
}

/**
 * Duplicate-meeting detection + merge (Meetings merge). When someone uploads a meeting that already
 * exists (same date + enough content overlap — one transcriber may have missed parts), we merge the
 * transcripts into the EXISTING note instead of creating a second one, credit both people as
 * submitters, union the attendees, and re-summarize + re-extract action items on the merged text.
 * Best-effort on the LLM steps (they degrade to empty); the transcript merge + submitter credit are
 * the guaranteed outcomes.
 */

/** Default: at least half of the smaller transcript's content must appear in the other. */
export const DEFAULT_MERGE_THRESHOLD = 0.5;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface DuplicateMatch {
  noteId: string;
  sourceItemId: string;
  itemPath: string;
  itemProject: string;
  itemAccess: "team" | "external";
  title: string;
  existingRawText: string;
  primarySubmitterId: string | null;
  overlap: number;
}

/**
 * Find an existing same-date meeting note whose transcript overlaps `rawText` enough to be the same
 * meeting. Returns the best match ≥ threshold, or null (also null when `occurredAt` is unknown —
 * without a date we don't auto-merge). Reads only.
 */
export async function findDuplicateMeeting(
  admin: DbClient,
  teamId: string,
  occurredAt: string | null,
  rawText: string,
  threshold = DEFAULT_MERGE_THRESHOLD
): Promise<DuplicateMatch | null> {
  if (!occurredAt) return null;

  const { data: notes } = await admin
    .from("meeting_notes")
    .select("id, source_item_id, submitted_by, title")
    .eq("team_id", teamId)
    .eq("occurred_at", occurredAt)
    // Never match a note that's already been folded away (`merged_into` set) — merging into a hidden
    // note makes the upload vanish (it inherits the tombstone and never shows on the Meetings page).
    .is("merged_into", null);
  const noteRows = (notes ?? []) as { id: string; source_item_id: string; submitted_by: string | null; title: string }[];
  if (!noteRows.length) return null;

  const { data: items } = await admin
    .from("items")
    .select("id, path, access, body, projects(slug)")
    .in("id", noteRows.map((n) => n.source_item_id));
  const itemById = new Map(
    ((items ?? []) as { id: string; path: string; access: "team" | "external"; body: string; projects?: { slug?: string } }[]).map(
      (i) => [i.id, i]
    )
  );

  let best: DuplicateMatch | null = null;
  for (const n of noteRows) {
    const item = itemById.get(n.source_item_id);
    if (!item?.body) continue;
    const overlap = transcriptOverlap(rawText, item.body);
    if (overlap >= threshold && (!best || overlap > best.overlap)) {
      best = {
        noteId: n.id,
        sourceItemId: n.source_item_id,
        itemPath: item.path,
        itemProject: item.projects?.slug ?? "meeting-notes",
        itemAccess: item.access,
        title: n.title,
        existingRawText: item.body,
        primarySubmitterId: n.submitted_by,
        overlap,
      };
    }
  }
  return best;
}

export interface MergeInput {
  newRawText: string;
  /** The incoming upload's submitter to credit (null for a CLI-imported note with no submitter). */
  newSubmitterId: string | null;
  /** The incoming upload's tier. The merged body is floored to the MOST RESTRICTIVE of this and the
   *  existing item's access, so a team-tier upload can't be widened to external by the merge. GUI
   *  uploads are always "team"; defaults to "team" (fail-safe — never widens). */
  newAccess?: "team" | "external";
  newAttendeeIds?: string[];
  roster: RosterPerson[];
  keys: ProviderKeys;
  /** A valid member to attribute the re-ingest to when neither note has a submitter (e.g. backfill). */
  authorFallbackMemberId?: string | null;
  /** Injectable merge (tests). Defaults to LLM merge with a deterministic union fallback. */
  mergeTranscript?: (existing: string, incoming: string) => Promise<string>;
}

/**
 * Merge a new upload into an existing note: union the transcripts (re-ingested into the existing
 * item), credit both submitters, union attendees, and refresh the summary + action items. Returns
 * the surviving note id.
 */
export async function mergeIntoMeetingNote(
  admin: DbClient,
  teamId: string,
  match: DuplicateMatch,
  input: MergeInput
): Promise<string> {
  // Resolve the attribution FIRST — before the (possibly LLM-backed) transcript merge — so an
  // unattributable pair fails cheaply instead of burning a merge call that's then discarded. On the
  // automatic ingest path both submitters can be null (e.g. a member was deleted → `submitted_by` set
  // null); the caller supplies `authorFallbackMemberId` (an active member) so those still merge.
  const author = match.primarySubmitterId ?? input.newSubmitterId ?? input.authorFallbackMemberId ?? null;
  if (!author) throw new Error("mergeIntoMeetingNote: no member to attribute the merged transcript to");

  // Intelligent merge: LLM-combine the overlapping transcripts (dedupes overlaps, keeps unique
  // content), falling back to the lossless deterministic union if the LLM is unavailable/too long.
  const merged = input.mergeTranscript
    ? await input.mergeTranscript(match.existingRawText, input.newRawText)
    : (await mergeTranscriptsLLM(match.existingRawText, input.newRawText, input.keys).catch(() => null)) ??
      mergeTranscripts(match.existingRawText, input.newRawText);

  // Tier floor (M1): the merged body is only as widely visible as its MOST RESTRICTIVE source —
  // "team" is more restrictive than "external", so if either side is team-tier the result is team.
  // A team-tier upload folded into an external item must not become externally readable.
  const newAccess = input.newAccess ?? "team";
  const mergedAccess: "team" | "external" =
    match.itemAccess === "team" || newAccess === "team" ? "team" : "external";

  // Write the merged transcript to a MERGE-OWNED item (C1): `meetings/<noteId>.md`, the same synthetic
  // path GUI notes use. NEVER back into the matched item's path — if that item is connector-owned
  // (a CLI/GitHub-synced transcript), the next sync re-pushes the ORIGINAL file, its sha != the merged
  // body's, and the merge is silently overwritten. Keying on the surviving note id makes re-merges
  // upsert the same item.
  const mergedPath = notePath(match.noteId);
  const mergedItem = await ingestItem(
    admin,
    { teamId, memberId: author, apiKeyId: randomUUID() },
    {
      project: MEETING_NOTES_PROJECT_SLUG,
      path: mergedPath,
      kind: "transcript",
      content_sha256: sha256(merged),
      actor: "meeting-notes-merge",
      access: mergedAccess,
      frontmatter: { title: match.title },
      body: merged,
    },
    mergedAccess,
    { authorMemberId: author }
  );

  // If the survivor was pointing at a foreign (connector-owned) item, move it onto the merge-owned
  // item and RETIRE the old one with a hidden tombstone note — otherwise the meetings backfill, which
  // notes every un-noted transcript item, would resurrect the original as a separate meeting.
  if (mergedItem.id !== match.sourceItemId) {
    await setMeetingNoteSourceItem(admin, match.noteId, mergedItem.id);
    // Move already-extracted action items onto the new item's namespace (H1) so re-extraction upserts
    // over them (no duplicates / no broken PM links) and the note still shows them.
    await remapMeetingTodoSourceItem(admin, teamId, match.sourceItemId, mergedItem.id);
    // Retire the old item with a note that's hidden ATOMICALLY (inserted with merged_into set) — so it's
    // never briefly visible and a crash can't leave a dangling-visible duplicate — keeping the meetings
    // backfill (which notes every un-noted transcript item) from resurrecting it as a separate meeting.
    await createMeetingNoteFromItem(admin, teamId, {
      sourceItemId: match.sourceItemId,
      title: match.title,
      occurredAt: null,
      summary: "",
      submittedByMemberId: match.primarySubmitterId,
      attendeeMemberIds: [],
      mergedInto: match.noteId,
    });
  }

  // Credit both submitters + union attendees from the new upload.
  await addMeetingNoteSubmitters(admin, match.noteId, [match.primarySubmitterId, input.newSubmitterId].filter((x): x is string => !!x));
  if (input.newAttendeeIds?.length) await addMeetingNoteAttendees(admin, match.noteId, input.newAttendeeIds);

  // Refresh summary + attendees + action items on the merged text — best-effort (never fail merge).
  try {
    const ex = await extractFromTranscript(merged, input.roster, input.keys);
    if (ex.summary.trim()) await updateMeetingSummary(admin, teamId, match.noteId, ex.summary);
    if (ex.attendeeMemberIds.length) await addMeetingNoteAttendees(admin, match.noteId, ex.attendeeMemberIds);
  } catch {
    // summary refresh is a bonus
  }
  try {
    await extractAndStoreActionItems(
      admin,
      teamId,
      { id: mergedItem.id, path: mergedPath, access: mergedAccess },
      merged,
      input.roster,
      input.keys
    );
  } catch {
    // action-item refresh is a bonus
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: "member",
    member_id: input.newSubmitterId,
    action: "meeting_note.merged",
    target_type: "meeting_note",
    target_id: match.noteId,
    meta: {
      overlap: Math.round(match.overlap * 100) / 100,
      merged_from_item: match.sourceItemId,
      merged_item: mergedItem.id,
      // Set only when the note was moved off a foreign (connector-owned) item and it was retired.
      retired_item: mergedItem.id !== match.sourceItemId ? match.sourceItemId : null,
    },
  });

  return match.noteId;
}

/** Build a fresh DuplicateMatch for a note by re-reading its (possibly just-merged) transcript. */
async function loadMatchForNote(admin: DbClient, teamId: string, noteId: string): Promise<DuplicateMatch | null> {
  const { data: n } = await admin
    .from("meeting_notes")
    .select("id, source_item_id, submitted_by, title")
    .eq("team_id", teamId)
    .eq("id", noteId)
    .maybeSingle();
  const note = n as { id: string; source_item_id: string; submitted_by: string | null; title: string } | null;
  if (!note) return null;
  const { data: item } = await admin
    .from("items")
    .select("id, path, access, body, projects(slug)")
    .eq("id", note.source_item_id)
    .maybeSingle();
  const it = item as { path: string; access: "team" | "external"; body: string; projects?: { slug?: string } } | null;
  if (!it?.body) return null;
  return {
    noteId: note.id,
    sourceItemId: note.source_item_id,
    itemPath: it.path,
    itemProject: it.projects?.slug ?? "meeting-notes",
    itemAccess: it.access,
    title: note.title,
    existingRawText: it.body,
    primarySubmitterId: note.submitted_by,
    overlap: 1,
  };
}

export interface BackfillMergeSummary {
  scanned: number;
  clusters: number;
  merged: number;
}

/**
 * Find already-created duplicate meeting notes (same date + overlapping transcripts) and merge each
 * cluster into its EARLIEST note, crediting all submitters and hiding the folded-away copies
 * (`merged_into`). Runs on EVERY ingest tick (via `backfillMeetingNotesFromItems`) — cheap when there
 * are no same-date pairs (metadata-only scan, no bodies loaded). Uses the same LLM merge as the live
 * upload path. Bounded, best-effort per cluster. `actorMemberId` attributes the re-ingest when a note
 * has no submitter — OPTIONAL: the automatic path passes none, falling back to an active member.
 */
export async function backfillMergeDuplicateMeetings(
  admin: DbClient,
  teamId: string,
  opts: { keys: ProviderKeys; actorMemberId?: string | null; threshold?: number }
): Promise<BackfillMergeSummary> {
  const threshold = opts.threshold ?? DEFAULT_MERGE_THRESHOLD;
  const summary: BackfillMergeSummary = { scanned: 0, clusters: 0, merged: 0 };

  const { data: notes } = await admin
    .from("meeting_notes")
    .select("id, source_item_id, submitted_by, occurred_at, created_at")
    .eq("team_id", teamId)
    .is("merged_into", null);
  type Row = { id: string; source_item_id: string; submitted_by: string | null; occurred_at: string | null; created_at: string };
  const rows = ((notes ?? []) as Row[]).filter((r) => r.occurred_at);
  summary.scanned = rows.length;
  if (rows.length < 2) return summary;

  // Group by date on the CHEAP metadata FIRST — only a date with ≥2 notes can hold a duplicate. This
  // runs every scheduler tick, so we must NOT load transcript bodies for the whole corpus each time:
  // at steady state (all distinct dates), there are no dup-dates and we return here having loaded zero
  // bodies. Bodies (+ roster) are fetched below ONLY for the candidate dates.
  const byDate = new Map<string, Row[]>();
  for (const r of rows) byDate.set(r.occurred_at!, [...(byDate.get(r.occurred_at!) ?? []), r]);
  const dupDateGroups = [...byDate.values()].filter((g) => g.length >= 2);
  if (dupDateGroups.length === 0) return summary;

  const candidateItemIds = dupDateGroups.flatMap((g) => g.map((r) => r.source_item_id));
  const { data: items } = await admin.from("items").select("id, body, access").in("id", candidateItemIds);
  const itemRows = (items ?? []) as { id: string; body: string; access: "team" | "external" }[];
  const bodyById = new Map(itemRows.map((i) => [i.id, i.body ?? ""]));
  const accessById = new Map(itemRows.map((i) => [i.id, i.access]));

  const roster: RosterPerson[] = await admin
    .from("members")
    .select("id, display_name")
    .eq("team_id", teamId)
    .eq("status", "active")
    .order("created_at", { ascending: true }) // deterministic: roster[0] is the earliest active member (authorless-pair fallback)
    .then(({ data }) => ((data ?? []) as { id: string; display_name: string }[]).map((m) => ({ id: m.id, displayName: m.display_name })));

  for (const group of dupDateGroups) {
    group.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

    // Greedy cluster by overlap against each cluster's (earliest) primary.
    const clusters: Row[][] = [];
    for (const note of group) {
      const body = bodyById.get(note.source_item_id) ?? "";
      if (!body.trim()) continue;
      const target = clusters.find((cl) => transcriptOverlap(body, bodyById.get(cl[0].source_item_id) ?? "") >= threshold);
      if (target) target.push(note);
      else clusters.push([note]);
    }

    for (const cl of clusters) {
      if (cl.length < 2) continue;
      summary.clusters++;
      const primary = cl[0];
      for (const dup of cl.slice(1)) {
        const match = await loadMatchForNote(admin, teamId, primary.id);
        if (!match) continue;
        const { data: att } = await admin.from("meeting_note_attendees").select("member_id").eq("meeting_note_id", dup.id);
        try {
          await mergeIntoMeetingNote(admin, teamId, match, {
            newRawText: bodyById.get(dup.source_item_id) ?? "",
            newSubmitterId: dup.submitted_by,
            newAccess: accessById.get(dup.source_item_id) ?? "team",
            newAttendeeIds: ((att ?? []) as { member_id: string }[]).map((a) => a.member_id),
            roster,
            keys: opts.keys,
            // Automatic path has no human actor; fall back to an active member so a pair whose
            // submitters are both null (deleted members) still merges instead of retrying forever.
            authorFallbackMemberId: opts.actorMemberId ?? roster[0]?.id ?? null,
          });
          await setMeetingNoteMergedInto(admin, dup.id, primary.id);
          summary.merged++;
        } catch {
          // one bad cluster member never fails the whole backfill
        }
      }
    }
  }
  return summary;
}
