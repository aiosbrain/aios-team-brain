import "server-only";
import type { DbClient } from "@/lib/db/types";
import { extractFromTranscript, type ProviderKeys, type RosterPerson } from "./llm-extract";
import { extractAndStoreActionItems } from "./action-items";
import { updateMeetingSummary, addMeetingNoteAttendees } from "./notes";

/**
 * Re-run the upload-time extraction (summary + attendees + action items) over meeting notes that
 * ALREADY exist — the healing counterpart to `backfillMeetingNotesFromItems` (which only creates
 * notes for un-noted items and never touches existing ones). Needed because notes uploaded while a
 * parser bug dropped array-shaped model summaries (see `normalizeSummaryField`) were saved blank;
 * this makes them "show up as if they'd just been uploaded" without re-uploading.
 *
 * Uses the same single-writer writers as the live path (`updateMeetingSummary`,
 * `addMeetingNoteAttendees`, `extractAndStoreActionItems`), so there's no second write path to keep
 * in sync. Idempotent (summary is replaced, attendees/action-items upsert) and best-effort per note:
 * one bad note never fails the batch. Never touches merged-away notes (`merged_into is not null`).
 */

interface NoteMeta {
  id: string;
  source_item_id: string;
  summary: string;
}

interface ItemMeta {
  id: string;
  path: string;
  access: "team" | "external";
}

export interface RefreshOptions {
  keys?: ProviderKeys;
  /** Max notes to process this run (default: all candidates). */
  limit?: number;
  /** Only heal notes whose summary is currently blank; skip ones that already have one. Default false
   *  (a full refresh — every note re-extracted, matching "as if just uploaded"). */
  onlyBlank?: boolean;
  /** Override the per-note LLM timeout (default: the meetings 60s). A backfill over a slow network
   *  can raise it so a genuinely-slow-but-successful model response isn't aborted. */
  timeoutMs?: number;
  /** Inject the summary/attendee extractor (tests avoid a real LLM). */
  extract?: (rawText: string, roster: RosterPerson[]) => Promise<{ summary: string; attendeeMemberIds: string[] }>;
  /** Inject the action-item extractor (tests avoid a real LLM). */
  extractActionItems?: Parameters<typeof extractAndStoreActionItems>[6];
}

export interface RefreshResult {
  scanned: number;
  /** Notes whose summary was (re)written to a non-empty value. */
  summarized: number;
  /** Total action-item tasks materialized across all processed notes. */
  actionItems: number;
  /** Notes skipped (empty transcript body, no source item, or extraction yielded no summary). */
  skipped: number;
}

export async function refreshMeetingNoteExtraction(
  admin: DbClient,
  teamId: string,
  opts: RefreshOptions = {}
): Promise<RefreshResult> {
  const result: RefreshResult = { scanned: 0, summarized: 0, actionItems: 0, skipped: 0 };

  // Live meeting notes for this team (never the merged-away duplicates).
  const { data: noteRows } = await admin
    .from("meeting_notes")
    .select("id, source_item_id, summary")
    .eq("team_id", teamId)
    .is("merged_into", null)
    .order("created_at", { ascending: false });
  let notes = (noteRows ?? []) as NoteMeta[];
  if (opts.onlyBlank) notes = notes.filter((n) => !n.summary?.trim());
  if (typeof opts.limit === "number") notes = notes.slice(0, opts.limit);
  if (notes.length === 0) return result;

  // Source-item metadata (path/access) for the notes' items, in one read.
  const itemIds = [...new Set(notes.map((n) => n.source_item_id))];
  const { data: itemRows } = await admin
    .from("items")
    .select("id, path, access")
    .eq("team_id", teamId)
    .in("id", itemIds);
  const itemById = new Map(((itemRows ?? []) as ItemMeta[]).map((i) => [i.id, i]));

  const { data: rosterRows } = await admin
    .from("members")
    .select("id, display_name")
    .eq("team_id", teamId)
    .eq("status", "active");
  const roster: RosterPerson[] = ((rosterRows ?? []) as { id: string; display_name: string }[]).map((m) => ({
    id: m.id,
    displayName: m.display_name,
  }));

  const extract =
    opts.extract ??
    ((rawText: string, r: RosterPerson[]) => extractFromTranscript(rawText, r, opts.keys ?? {}, opts.timeoutMs));

  for (const note of notes) {
    result.scanned++;
    try {
      const item = itemById.get(note.source_item_id);
      if (!item) {
        result.skipped++;
        continue;
      }
      const { data: bodyRow } = await admin.from("items").select("body").eq("id", item.id).maybeSingle();
      const body = (bodyRow as { body: string } | null)?.body ?? "";
      if (!body.trim()) {
        result.skipped++;
        continue;
      }

      const ex = await extract(body, roster).catch(() => ({ summary: "", attendeeMemberIds: [] }));
      if (ex.summary.trim()) {
        await updateMeetingSummary(admin, teamId, note.id, ex.summary);
        await addMeetingNoteAttendees(admin, note.id, ex.attendeeMemberIds);
        result.summarized++;
      } else {
        result.skipped++;
      }

      // Action items are idempotent (upsert on a stable row_key) — safe to (re)compute every run.
      try {
        result.actionItems += await extractAndStoreActionItems(
          admin,
          teamId,
          item,
          body,
          roster,
          opts.keys ?? {},
          opts.extractActionItems,
          opts.timeoutMs
        );
      } catch {
        // action-item extraction is a bonus on top of the refreshed summary
      }
    } catch {
      result.skipped++; // best-effort — one bad note never fails the batch
    }
  }
  return result;
}
