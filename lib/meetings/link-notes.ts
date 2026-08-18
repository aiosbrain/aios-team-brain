import "server-only";
import type { DbClient } from "@/lib/db/types";
import { eventIdentity } from "./event-identity";
import { plan, type LinkCandidate, type LinkPlan, type RefusalReason } from "./identity-link";
import { addMeetingNoteAttendees, addMeetingNoteSubmitters, setMeetingNoteMergedInto } from "./notes";

/**
 * Apply the identity link (MTGATT-3): fold each bodyless push of a meeting into the note that has the
 * content, and carry its attendance and submitter credit across.
 *
 * The DECISIONS live in `./identity-link` (pure, unit-tested). This module is the I/O around them —
 * deliberately, because the failure modes here are different in kind: a correct plan written in the
 * wrong ORDER still loses credit.
 *
 * WRITE ORDER IS A SAFETY PROPERTY, not an implementation detail. Attendance and submitters are
 * written to the survivor BEFORE the folded note is hidden. A crash in between leaves a visible
 * duplicate meeting — annoying, and fixable on the next tick — whereas the reverse order would leave
 * a note hidden with its credit never transferred, which nothing would ever report.
 *
 * ⚠️ AND WRITE ORDER ALONE IS NOT ENOUGH, which is what the first version of this file got wrong. The
 * pg adapter RETURNS errors rather than throwing (`lib/db/pg/query-builder.ts` catches and returns
 * `{data: null, error}`), so a read that fails looks exactly like a read that found nothing:
 * `addMeetingNoteAttendees([])` no-ops, and `setMeetingNoteMergedInto` — which does throw on ITS own
 * failure — then succeeds. The note ends up hidden with its credit never transferred, permanently,
 * because the next tick excludes `merged_into` notes. A failed BODY read is worse still: every
 * candidate reads as bodyless, the component takes the earliest-created branch, and a transcript can
 * be folded behind a blank invite — MTGATT-1's exact outcome, silent and uncounted.
 *
 * So every read here checks `error` and REFUSES rather than proceeding on an empty-looking result.
 * Refusing costs one tick; proceeding costs a meeting.
 */

/** Newest live notes considered per run. An unbounded per-tick scan is how TICKSTALL-1 starved the chain. */
const NOTE_SCAN_LIMIT = 500;

export interface LinkSummary {
  /** Notes folded into a survivor. */
  linked: number;
  /** Components refused, by reason — see `identity-link.RefusalReason`. */
  refusals: Record<RefusalReason, number>;
}

type NoteRow = { id: string; source_item_id: string; occurred_at: string | null; created_at: string };
type ItemMeta = { id: string; frontmatter: Record<string, unknown> | null };

/** Frozen: it is returned by reference on every early exit and used as an initial value. */
export const EMPTY_LINK_SUMMARY: LinkSummary = Object.freeze({
  linked: 0,
  refusals: Object.freeze({ "two-bodies": 0, "dates-too-far-apart": 0, "unknown-date": 0 }),
}) as LinkSummary;

/**
 * Link this team's live meeting notes that share an event identifier.
 *
 * Cost is shaped so the common case is nearly free: two metadata reads, and bodies fetched ONLY for
 * the notes that actually carry an identity key. In production today zero items carry one, so this
 * returns after the second query having loaded no transcript text at all.
 */
export async function linkMeetingNotesByIdentity(admin: DbClient, teamId: string): Promise<LinkSummary> {
  const { data: noteRows, error: noteErr } = await admin
    .from("meeting_notes")
    .select("id, source_item_id, occurred_at, created_at")
    .eq("team_id", teamId)
    .is("merged_into", null)
    .order("created_at", { ascending: false })
    .limit(NOTE_SCAN_LIMIT);
  // Belt-and-braces only, and said so rather than left looking load-bearing: a failed read yields
  // `notes = []`, which the `< 2` guard below already turns into the same early return. No mutation
  // can redden this line; it is here so the intent survives a future refactor of that guard.
  if (noteErr) return EMPTY_LINK_SUMMARY;
  const notes = (noteRows ?? []) as NoteRow[];
  if (notes.length < 2) return EMPTY_LINK_SUMMARY;

  const { data: itemRows, error: itemErr } = await admin
    .from("items")
    .select("id, frontmatter")
    .in("id", notes.map((n) => n.source_item_id));
  if (itemErr) return EMPTY_LINK_SUMMARY;
  const fmByItem = new Map(((itemRows ?? []) as ItemMeta[]).map((i) => [i.id, i.frontmatter]));

  // Only notes carrying an identity key can be linked, so only their bodies are worth reading.
  const keyed = notes
    .map((n) => ({ note: n, keys: eventIdentity(fmByItem.get(n.source_item_id)).eventKeys }))
    .filter((n) => n.keys.length > 0);
  if (keyed.length < 2) return EMPTY_LINK_SUMMARY;

  // A FAILED BODY READ MUST NOT BE READ AS "nothing has a body" — that flips the survivor rule.
  const { data: bodyRows, error: bodyErr } = await admin
    .from("items")
    .select("id, body")
    .in("id", keyed.map((k) => k.note.source_item_id));
  if (bodyErr) return EMPTY_LINK_SUMMARY;
  const bodyByItem = new Map(((bodyRows ?? []) as { id: string; body: string | null }[]).map((i) => [i.id, i.body ?? ""]));

  const candidates: LinkCandidate[] = keyed.map(({ note, keys }) => ({
    noteId: note.id,
    eventKeys: keys,
    // Whitespace is not content. A producer emitting "\n" for an invite must not outrank a transcript.
    hasBody: (bodyByItem.get(note.source_item_id) ?? "").trim().length > 0,
    occurredAt: note.occurred_at,
    createdAt: note.created_at,
  }));

  const linkPlan: LinkPlan = plan(candidates);
  let linked = 0;

  for (const group of linkPlan.groups) {
    try {
      const { data: att, error: attErr } = await admin
        .from("meeting_note_attendees")
        .select("member_id")
        .in("meeting_note_id", group.foldedIds);
      const { data: subs, error: subsErr } = await admin
        .from("meeting_note_submitters")
        .select("member_id")
        .in("meeting_note_id", group.foldedIds);
      const { data: folded, error: foldedErr } = await admin
        .from("meeting_notes")
        .select("id, submitted_by")
        .in("id", group.foldedIds);
      // Skip the whole component rather than hide anything on partial evidence. Nothing is written,
      // so the next tick retries it — the one outcome that is NOT recoverable is a hidden note whose
      // credit never moved.
      if (attErr || subsErr || foldedErr) continue;

      const attendeeIds = ((att ?? []) as { member_id: string }[]).map((r) => r.member_id);
      const submitterIds = [
        ...((subs ?? []) as { member_id: string }[]).map((r) => r.member_id),
        ...((folded ?? []) as { submitted_by: string | null }[]).map((r) => r.submitted_by),
      ].filter((x): x is string => !!x);

      // Credit FIRST, hide second — see the module header.
      await addMeetingNoteAttendees(admin, group.survivorId, attendeeIds);
      await addMeetingNoteSubmitters(admin, group.survivorId, submitterIds);
      for (const id of group.foldedIds) {
        await setMeetingNoteMergedInto(admin, id, group.survivorId);
        linked++;
      }
    } catch {
      // One bad component never fails the rest — the next tick retries it, because nothing was hidden.
    }
  }

  return { linked, refusals: linkPlan.refusals };
}
