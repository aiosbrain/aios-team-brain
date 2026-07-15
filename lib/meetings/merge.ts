import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { ingestItem } from "@/lib/ingest";
import { audit } from "@/lib/api/audit";
import { completeTextOrNull } from "@/lib/llm/complete";
import { extractFromTranscript, type ProviderKeys, type RosterPerson } from "./llm-extract";
import { extractAndStoreActionItems } from "./action-items";
import { canLlmMerge, mergeTranscripts, transcriptOverlap } from "./merge-format";
import { addMeetingNoteAttendees, addMeetingNoteSubmitters, updateMeetingSummary } from "./notes";

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
    .eq("occurred_at", occurredAt);
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
  newSubmitterId: string;
  newAttendeeIds?: string[];
  roster: RosterPerson[];
  keys: ProviderKeys;
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
  // Intelligent merge: LLM-combine the overlapping transcripts (dedupes overlaps, keeps unique
  // content), falling back to the lossless deterministic union if the LLM is unavailable/too long.
  const merged = input.mergeTranscript
    ? await input.mergeTranscript(match.existingRawText, input.newRawText)
    : (await mergeTranscriptsLLM(match.existingRawText, input.newRawText, input.keys).catch(() => null)) ??
      mergeTranscripts(match.existingRawText, input.newRawText);
  const author = match.primarySubmitterId ?? input.newSubmitterId;

  // Re-ingest the merged transcript into the SAME item (team+project+path upsert → new sha/body).
  await ingestItem(
    admin,
    { teamId, memberId: author, apiKeyId: randomUUID() },
    {
      project: match.itemProject,
      path: match.itemPath,
      kind: "transcript",
      content_sha256: sha256(merged),
      actor: "meeting-notes-merge",
      access: match.itemAccess,
      frontmatter: { title: match.title },
      body: merged,
    },
    match.itemAccess,
    { authorMemberId: author }
  );

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
      { id: match.sourceItemId, path: match.itemPath, access: match.itemAccess },
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
    meta: { overlap: Math.round(match.overlap * 100) / 100, merged_from_item: match.sourceItemId },
  });

  return match.noteId;
}
