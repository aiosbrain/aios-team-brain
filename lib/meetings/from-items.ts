import "server-only";
import type { DbClient } from "@/lib/db/types";
import { extractFromTranscript, type ProviderKeys, type RosterPerson } from "./llm-extract";
import { resolveAttendance } from "./attendance";
import { extractAndStoreActionItems } from "./action-items";
import type { ExtractedTodo } from "./extract-todos";
import { createMeetingNoteFromItem } from "./notes";
import { backfillMergeDuplicateMeetings } from "./merge";
import { EMPTY_LINK_SUMMARY, linkMeetingNotesByIdentity, type LinkSummary } from "./link-notes";
import { buildIdentityMap } from "@/lib/identity/resolve";
import { CALENDAR_SOURCES, attendingAttendees, calendarAttendees, calendarTitle, isCalendarEvent } from "./from-calendar";

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
  // A CALENDAR EVENT is dated by when it HAPPENS, and that is not `created`. Workspace frontmatter
  // routinely carries `created` (the file's creation / push day), so with the generic order below an
  // event pushed Tuesday for Thursday's meeting would log as Tuesday's work — and a batch of shared
  // events would all pile onto the sync day. Google's own start-time fields are checked first, and
  // only for calendar items so the transcript path's tuned order is untouched.
  if (isCalendarEvent(typeof fm.source === "string" ? fm.source : null)) {
    for (const key of ["start", "start_time", "startTime", "occurred_at", "source_ts", "date"]) {
      const v = fm[key];
      if (typeof v === "string") {
        const m = v.match(/^\d{4}-\d{2}-\d{2}/);
        if (m) return m[0];
      }
    }
  }
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
  /** Selected now that the query is no longer filtered on it — a transcript takes the LLM path, a
   *  calendar event (recognised by SOURCE) takes the structured-attendee path. */
  kind: string | null;
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
  /**
   * Names the producer ASSERTED as participants that resolve to nobody on this team (MTGATT-1).
   *
   * Counted rather than ignored because it is the honest size of a known gap: attendance rows are a
   * NOT NULL FK to `members`, so an external guest cannot be recorded at all. Prod examples: Pete
   * Longworth, Anusheel Bhushan, Rob White. A rising number here means real attendees are being lost
   * — invisible if nobody counts it.
   */
  unresolvedAttendees: number;
  /**
   * Calendar invitees dropped because their RSVP said `declined` (MTGATT-2).
   *
   * Counted for the same reason as `unresolvedAttendees`: this is the one place attendance is
   * deliberately REMOVED, and a removal nobody can see is indistinguishable from a parser that
   * silently stopped matching. A rising number with no declines in the real calendars would mean the
   * RSVP field is being misread — which only a count makes visible.
   */
  calendarDeclined: number;
  /** Identity-link outcome (MTGATT-3): what folded, and what was refused and why. */
  link: LinkSummary;
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
  const summary: BackfillSummary = {
    scanned: 0,
    created: 0,
    skipped: 0,
    merged: 0,
    unresolvedAttendees: 0,
    calendarDeclined: 0,
    link: EMPTY_LINK_SUMMARY,
  };

  // Which transcript items already have a note — exclude them.
  const { data: noted } = await admin.from("meeting_notes").select("source_item_id").eq("team_id", teamId);
  const hasNote = new Set(((noted ?? []) as { source_item_id: string }[]).map((r) => r.source_item_id));

  // Candidate metadata only (no bodies — transcripts can be large). Filter to meeting sources here.
  //
  // TWO shapes of meeting arrive here, and they need different treatment, so the query is deliberately
  // NOT filtered on `kind` any more:
  //   • a TRANSCRIPT (granola/zoom/…) — has a body, attendees are inferred from it by an LLM;
  //   • a CALENDAR EVENT — has structured attendee EMAILS and typically no body at all.
  // Keying calendar events on `kind` would drop them over a vocabulary choice the producer is free to
  // make (`artifact` and `transcript` are both defensible for an event), so they are keyed on SOURCE.
  // TWO windows, unioned — NOT one widened window. Dropping the `kind='transcript'` filter to let
  // calendar events through would have made this "the 500 newest rows of ANY kind", so a bulk sync
  // (a github backfill, a new connector) could push a real meeting transcript below the cap and it
  // would NEVER be noted — silently, permanently, since the window only moves forward. Each shape
  // gets its own bounded window instead, so neither can starve the other.
  const [transcriptRes, calendarRes] = await Promise.all([
    admin
      .from("items")
      .select("id, kind, path, access, member_id, frontmatter")
      .eq("team_id", teamId)
      .eq("kind", "transcript")
      .order("synced_at", { ascending: false })
      .limit(500),
    admin
      .from("items")
      .select("id, kind, path, access, member_id, frontmatter")
      .eq("team_id", teamId)
      .in("frontmatter->>source", [...CALENDAR_SOURCES])
      .order("synced_at", { ascending: false })
      .limit(500),
  ]);
  const byId = new Map<string, CandidateMeta>();
  for (const r of [...((transcriptRes.data ?? []) as CandidateMeta[]), ...((calendarRes.data ?? []) as CandidateMeta[])]) {
    byId.set(r.id, r); // an item matching both windows is one candidate
  }
  const candidates = [...byId.values()].filter((r) => {
    if (hasNote.has(r.id)) return false;
    const source = (r.frontmatter?.source as string) ?? null;
    return isMeetingTranscript(r.kind ?? "", source) || isCalendarEvent(source);
  });

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
    ((rawText: string, r: RosterPerson[]) =>
      extractFromTranscript(rawText, r, opts.keys ?? {}, undefined, { db: admin, teamId }));

  // Email -> member, built ONCE for the batch. Calendar attendance is resolved EXACTLY by address —
  // no model, no name-matching — which is the whole reason a shared calendar event attributes better
  // than a transcript does. Built lazily: a batch with no calendar events pays nothing.
  let byEmail: Map<string, string> | null = null;
  const resolveEmails = async (emails: string[]): Promise<string[]> => {
    if (!byEmail) byEmail = (await buildIdentityMap(admin, teamId)).byEmail;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const e of emails) {
      const id = byEmail.get(e);
      // An attendee who is not a member of THIS team (an external guest, a client) is not credited —
      // there is no person here to attribute the work to. Their presence is not lost: the event, its
      // title and its own attendee list remain on the item.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };

  for (const c of candidates.slice(0, limit)) {
    summary.scanned++;
    try {
      const calendar = isCalendarEvent((c.frontmatter?.source as string) ?? null);
      const { data: item } = await admin.from("items").select("body").eq("id", c.id).maybeSingle();
      const body = (item as { body: string } | null)?.body ?? "";
      // A transcript with no body has nothing to extract from. A CALENDAR EVENT legitimately has no
      // body — its content is the invite — so requiring one here is what would silently drop it.
      if (!calendar && !body.trim()) {
        summary.skipped++;
        continue;
      }
      // SUMMARY and ATTENDANCE are resolved separately on purpose (MTGATT-1). A transcript still
      // needs the model for its summary; what it must NOT need the model for is WHO WAS THERE when
      // the producer already said. Blending the two is how the old code came to prefer a guess over
      // `frontmatter.participants` — it asked one function for both and took the whole answer.
      const summaryOnly = calendar
        ? { summary: "", attendeeMemberIds: [] as string[] }
        : await extract(body, roster).catch(() => ({ summary: "", attendeeMemberIds: [] }));

      // A DECLINED invitee is not an attendee (MTGATT-2). Filtered here, at the one site that turns an
      // event's invite list into attendance. The COUNT is taken below, only once the note is actually
      // written: an item that throws or is skipped removed nobody, and counting it there would let a
      // persistently failing item add the same declines on every tick.
      const invited = calendar ? calendarAttendees(c.frontmatter) : [];
      const attending = attendingAttendees(invited);

      const attendance = await resolveAttendance({
        isCalendar: calendar,
        calendarMemberIds: calendar ? await resolveEmails(attending.map((a) => a.email)) : null,
        participants: c.frontmatter?.participants,
        roster,
        // Rank 3. Reached only when nothing was asserted — and it reuses the summary pass's answer
        // rather than making a second call, so the fallback costs nothing extra.
        llm: async () => summaryOnly.attendeeMemberIds,
      });
      if (attendance.unresolved.length) {
        // Named attendees who are not members of this team. Reported rather than dropped silently —
        // they are the reason real participants appear to "vanish", and the schema (a NOT NULL FK to
        // `members`) is why they cannot be recorded. Deliberately out of this slice's scope.
        summary.unresolvedAttendees += attendance.unresolved.length;
      }
      const ex = { summary: summaryOnly.summary, attendeeMemberIds: attendance.memberIds };
      const res = await createMeetingNoteFromItem(admin, teamId, {
        sourceItemId: c.id,
        title: calendar ? calendarTitle(c.frontmatter, c.path) : deriveMeetingTitle(body, c.path),
        occurredAt: deriveOccurredAt(c.frontmatter, c.path),
        summary: ex.summary,
        submittedByMemberId: c.member_id,
        attendeeMemberIds: ex.attendeeMemberIds,
      });
      if (res.created) {
        summary.created++;
        summary.calendarDeclined += invited.length - attending.length;
        // Pre-compute action items so a pushed meeting opens with its todos already filled in
        // (not empty until someone clicks "extract"). Best-effort — never fail the note over it.
        //
        // SKIPPED for a body-less calendar event. `extractActionItems` has no empty-input guard, so it
        // would POST "Transcript:\n\n" plus a roster hint to the model for every event: real spend for
        // certain, and a hallucinated todo would materialize as a REAL task in "Extracted from
        // Meetings" — pushable to Linear. An invite has no commitments in it to extract.
        if (body.trim()) try {
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

  // IDENTITY LINK (MTGATT-3) — before the overlap merge, so a calendar event that belongs to a
  // transcript is already folded and cannot be reconsidered by a comparator that reads bodies.
  try {
    summary.link = await linkMeetingNotesByIdentity(admin, teamId);
  } catch {
    // best-effort, like every other leg here: a link hiccup must not cost the notes just created
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
