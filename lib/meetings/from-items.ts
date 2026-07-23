import "server-only";
import type { DbClient } from "@/lib/db/types";
import { extractFromTranscript, type ProviderKeys, type RosterPerson } from "./llm-extract";
import { extractAndStoreActionItems } from "./action-items";
import type { ExtractedTodo } from "./extract-todos";
import { createMeetingNoteFromItem } from "./notes";
import { backfillMergeDuplicateMeetings } from "./merge";

/**
 * Bridge: turn transcript `items` that arrived through the CLI/ingest path (`aios push`) into
 * `meeting_notes` rows, so pushed meetings show up on the Meetings page — not only the ones uploaded
 * through that page's button. Reconciliation-style (like the graph projector): scan meeting-source
 * transcript items lacking a note, run the same summary/attendee extraction, and create the note.
 * Idempotent (one note per source item, unique constraint), best-effort per item, bounded per run.
 *
 * IMPORTANT — only *meeting* transcripts, not Slack threads. `kind='transcript'` covers both Slack
 * threads (source `slack`) and real meetings (source `granola`, etc.). We bridge only the recognized
 * meeting sources, so the Meetings page never fills up with chat threads.
 */

/** Transcript `frontmatter.source` values that represent an actual meeting (NOT `slack`). */
export const MEETING_TRANSCRIPT_SOURCES = new Set([
  "granola",
  "zoom",
  "fireflies",
  "otter",
  "fathom",
  "meet",
  "teams",
  "gong",
]);

/** True when a transcript item is a meeting (by source), so it should get a meeting note. Pure. */
export function isMeetingTranscript(kind: string, source: string | null | undefined): boolean {
  return kind === "transcript" && !!source && MEETING_TRANSCRIPT_SOURCES.has(source.trim().toLowerCase());
}

/** Derive a human title: the transcript's first markdown H1, else the de-slugified filename (minus a
 *  leading date), else "Meeting". Pure. */
export function deriveMeetingTitle(body: string, path: string): string {
  const h1 = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^#\s+\S/.test(l));
  if (h1) return h1.replace(/^#\s+/, "").trim().slice(0, 200);
  const base = (path.split("/").pop() ?? path)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return base || "Meeting";
}

/** Derive the meeting date (YYYY-MM-DD) from frontmatter, else a date prefix on the filename, else
 *  null (the note defaults to its created_at). Pure. */
export function deriveOccurredAt(frontmatter: Record<string, unknown> | null | undefined, path: string): string | null {
  const fm = frontmatter ?? {};
  for (const key of ["created", "source_ts", "date", "occurred_at"]) {
    const v = fm[key];
    if (typeof v === "string") {
      const m = v.match(/^\d{4}-\d{2}-\d{2}/);
      if (m) return m[0];
    }
  }
  const m = (path.split("/").pop() ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

interface CandidateMeta {
  id: string;
  path: string;
  access: "team" | "external";
  member_id: string | null;
  frontmatter: Record<string, unknown> | null;
}

export interface BackfillOptions {
  keys?: ProviderKeys;
  /** Max items to process this run (default 50). */
  limit?: number;
  /** Inject the summary/attendee extractor (tests avoid a real LLM). */
  extract?: (rawText: string, roster: RosterPerson[]) => Promise<{ summary: string; attendeeMemberIds: string[] }>;
  /** Inject the action-item extractor (tests avoid a real LLM). */
  extractActionItems?: (rawText: string, roster: RosterPerson[], keys: ProviderKeys) => Promise<ExtractedTodo[]>;
}

export interface BackfillSummary {
  scanned: number;
  created: number;
  skipped: number;
  /** Same-day duplicate meetings auto-merged after creation (see backfillMergeDuplicateMeetings). */
  merged: number;
}

/**
 * Create meeting notes for this team's un-noted meeting-source transcript items. Loads candidate
 * metadata (no bodies) first, filters to meeting sources that lack a note, then per candidate loads
 * the body, extracts summary/attendees, and writes the note. Best-effort: an item that fails is
 * skipped, never fatal.
 */
export async function backfillMeetingNotesFromItems(
  admin: DbClient,
  teamId: string,
  opts: BackfillOptions = {}
): Promise<BackfillSummary> {
  const limit = opts.limit ?? 50;
  const summary: BackfillSummary = { scanned: 0, created: 0, skipped: 0, merged: 0 };

  // Which transcript items already have a note — exclude them.
  const { data: noted } = await admin.from("meeting_notes").select("source_item_id").eq("team_id", teamId);
  const hasNote = new Set(((noted ?? []) as { source_item_id: string }[]).map((r) => r.source_item_id));

  // Candidate metadata only (no bodies — transcripts can be large). Filter to meeting sources here.
  const { data: rows } = await admin
    .from("items")
    .select("id, path, access, member_id, frontmatter")
    .eq("team_id", teamId)
    .eq("kind", "transcript")
    .order("synced_at", { ascending: false })
    .limit(500);
  const candidates = ((rows ?? []) as CandidateMeta[]).filter(
    (r) => isMeetingTranscript("transcript", (r.frontmatter?.source as string) ?? null) && !hasNote.has(r.id)
  );

  // NOTE: no early-return on an empty candidate set — the create loop below no-ops, and the
  // auto-merge at the end still runs so pre-existing duplicates get cleaned up each tick.
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
    ((rawText: string, r: RosterPerson[]) => extractFromTranscript(rawText, r, opts.keys ?? {}));

  for (const c of candidates.slice(0, limit)) {
    summary.scanned++;
    try {
      const { data: item } = await admin.from("items").select("body").eq("id", c.id).maybeSingle();
      const body = (item as { body: string } | null)?.body ?? "";
      if (!body.trim()) {
        summary.skipped++;
        continue;
      }
      const ex = await extract(body, roster).catch(() => ({ summary: "", attendeeMemberIds: [] }));
      const res = await createMeetingNoteFromItem(admin, teamId, {
        sourceItemId: c.id,
        title: deriveMeetingTitle(body, c.path),
        occurredAt: deriveOccurredAt(c.frontmatter, c.path),
        summary: ex.summary,
        submittedByMemberId: c.member_id,
        attendeeMemberIds: ex.attendeeMemberIds,
      });
      if (res.created) {
        summary.created++;
        // Pre-compute action items so a pushed meeting opens with its todos already filled in
        // (not empty until someone clicks "extract"). Best-effort — never fail the note over it.
        try {
          await extractAndStoreActionItems(
            admin,
            teamId,
            { id: c.id, path: c.path, access: c.access },
            body,
            roster,
            opts.keys ?? {},
            opts.extractActionItems
          );
        } catch {
          // action-item extraction is a bonus on top of the saved note
        }
      } else summary.skipped++;
    } catch {
      summary.skipped++; // best-effort — one bad item never fails the batch
    }
  }

  // Auto-merge same-day duplicate meetings — a re-record / re-push creates a second note for the same
  // meeting. Runs the SAME merge as the live-upload path, now on the CLI/ingest path too, so duplicates
  // never accumulate and no manual "Merge duplicates" button is needed. No human actor here — the merge
  // falls back to an active member for attribution. Best-effort; a merge hiccup never fails note creation.
  try {
    const m = await backfillMergeDuplicateMeetings(admin, teamId, { keys: opts.keys ?? {} });
    summary.merged = m.merged;
  } catch {
    // merge is a cleanup on top of the created notes
  }
  return summary;
}
