/**
 * Calendar events as meetings — the receiving half of "a meeting you attended is your work".
 *
 * A person's workspace pushes the calendar events they CHOOSE to share (personal events never leave
 * the machine; selection happens at the source, not here). This module turns such an item into the
 * team's meeting ledger so the per-attendee timeline leg credits everyone who was in it.
 *
 * WHY IT IS NOT THE TRANSCRIPT PATH. `lib/meetings/from-items` derives attendees by asking an LLM to
 * read a transcript and then name-matching its answers against the roster — lossy by construction
 * (measured 1.4 attendees/meeting on prod, and any name it cannot match is dropped leaving no trace).
 * A calendar event needs none of that: Google already says who was invited, by EMAIL. So attendance is
 * resolved EXACTLY here, by address, and no model is involved. That also means a calendar event needs
 * no body — which the transcript path requires and would otherwise skip it for.
 *
 * Pure parsing lives here (no DB, no server-only) so the accepted shapes are testable directly.
 */

/** `frontmatter.source` values that mean "this item is a calendar event". */
export const CALENDAR_SOURCES = new Set(["calendar", "gcal", "google_calendar", "googlecalendar"]);

/**
 * True when an item is a calendar event, whatever its `kind`. Pure.
 *
 * Deliberately NOT keyed on `kind`. A calendar event has no natural kind in the closed item enum — a
 * producer may reasonably send `artifact` (a record of something that happened) or `transcript` (to
 * ride the meeting path). The SOURCE is the unambiguous signal, so keying on it means the brain
 * accepts the event either way instead of silently dropping it over a vocabulary choice.
 *
 * MATCHES EXACTLY — no trimming, no case folding — because this same set is used as a SQL `IN (…)`
 * filter when selecting candidates, and SQL compares the stored bytes. If this were tolerant and the
 * query were not, a `"Calendar"` item would be EXCLUDED from the timeline's raw-items lane (this
 * function) while never becoming a meeting note (the query) — visible nowhere at all. The two layers
 * agreeing means a non-conforming source degrades to "shows as an ordinary item, credited to the
 * pusher": worse attribution, but never a disappearance. Every `frontmatter.source` in prod is
 * lowercase (`github`, `granola`, `slack`, …), so lowercase is the contract, not a hardship.
 */
export function isCalendarEvent(source: string | null | undefined): boolean {
  return !!source && CALENDAR_SOURCES.has(source);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One attendee as the brain understands it: an email we can resolve, and the display name if given. */
export interface CalendarAttendee {
  email: string;
  display: string | null;
  /**
   * The invitee's RSVP, lowercased, or null when the producer sent none (MTGATT-2).
   *
   * Only `"declined"` is ever acted on, and only for the person who PUSHED the event — see
   * `calendarSelfAttendance`. Every other value, including one this codebase has never seen, is
   * carried through unjudged: a missing RSVP is the overwhelmingly common shape (Granola's nested
   * event carries none at all), so treating "not recognised" as "not present" would empty the
   * attendee list of nearly every event and look exactly like a broken feature.
   */
  rsvp: string | null;
}

/** RSVP spellings a producer might reasonably send. Google's own key is `responseStatus`. */
const RSVP_KEYS = ["responseStatus", "response_status", "rsvp", "status"] as const;

/**
 * Attendee emails from a calendar item's frontmatter, deduped, lowercased, in source order.
 *
 * LIBERAL IN WHAT IT ACCEPTS, on purpose. This is a cross-repo boundary: the producer lives in the
 * workspace repo, and pinning one exact shape here means a reasonable producer choice silently yields
 * an unattributed meeting — the failure this whole feature exists to remove. So all of these work:
 *
 *   attendees:    ["a@x.com", "b@x.com"]
 *   attendees:    [{ email: "a@x.com", display: "Alice" }]
 *   participants: [{ id: "a@x.com", display: "Alice", role: "organizer" }]   ← the gog puller's shape
 *   attendees:    "a@x.com, b@x.com"
 *
 * Anything without a parseable email is DROPPED rather than guessed at: a display name with no address
 * is exactly the ambiguity that made transcript attendee-matching lossy, and re-introducing it here
 * would trade the one advantage a calendar event has. `organizer` is not treated specially — the
 * organizer attended too, and the timeline credits attendance, not authorship.
 */
export function calendarAttendees(fm: Record<string, unknown> | null | undefined): CalendarAttendee[] {
  if (!fm) return [];
  const raw = fm.attendees ?? fm.participants ?? fm.invitees;
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,;]/)
      : [];

  const out: CalendarAttendee[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    let email: string | null = null;
    let display: string | null = null;
    let rsvp: string | null = null;
    if (typeof e === "string") {
      email = e.trim();
    } else if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      // `id` last: the gog puller falls back to a DISPLAY NAME in `id` when an attendee has no email,
      // so a real `email`/`emailAddress` field must win over it.
      for (const k of ["email", "emailAddress", "address", "id"]) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) {
          email = v.trim();
          break;
        }
      }
      for (const k of ["display", "displayName", "name"]) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) {
          display = v.trim();
          break;
        }
      }
      for (const k of RSVP_KEYS) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) {
          rsvp = v.trim().toLowerCase();
          break;
        }
      }
    }
    if (!email) continue;
    const lower = email.toLowerCase();
    if (!EMAIL_RE.test(lower) || seen.has(lower)) continue; // a bare display name is not an identity
    seen.add(lower);
    out.push({ email: lower, display, rsvp });
  }
  return out;
}

/**
 * The invitees who did not say no — everyone except an explicit `declined` (MTGATT-2). Pure.
 *
 * WHAT THIS DOES AND DOES NOT CHANGE. The shipped rule is that a shared calendar event credits every
 * member attendee, and that is deliberate: the point of the feature is that a meeting Bob only
 * attended is still a record of Bob's work (`test/datamechanics/calendar-meetings.datamechanics.test.ts`).
 * This does not touch that. It removes the one case where the invite itself says the person was NOT
 * going to be there — a declined RSVP is the invitee's own statement about themselves, and crediting
 * a meeting to someone who declined it is the same shape of error as MTGATT-1's invented attendees,
 * with better paperwork attached.
 *
 * ONLY `declined`, deliberately. `needsAction`, `tentative` and a missing RSVP all count as present,
 * because "no RSVP" is the overwhelmingly common shape — Granola's nested event carries none at all,
 * and the gog puller's `{id, display, role}` shape has no RSVP field either. Excluding on "not
 * accepted" would empty the attendee list of nearly every event and be indistinguishable from a
 * broken feature.
 *
 * An unrecognised value is treated as "no RSVP" (present), never as a decline: the tolerant direction
 * here is the one that keeps a real attendee rather than the one that drops them.
 */
export function attendingAttendees(attendees: CalendarAttendee[]): CalendarAttendee[] {
  return attendees.filter((a) => a.rsvp !== "declined");
}

/**
 * The event's title, from the fields a calendar naturally carries. Pure.
 *
 * `summary` is Google Calendar's own name for the event title (not a description), which is why it is
 * checked first and why it must not be confused with the meeting NOTE's summary field.
 */
export function calendarTitle(fm: Record<string, unknown> | null | undefined, path: string): string {
  for (const k of ["title", "summary", "event_title", "name"]) {
    const v = fm?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const base = path.split("/").pop() ?? "";
  const cleaned = base.replace(/\.md$/i, "").replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]+/g, " ").trim();
  return cleaned || "Meeting";
}
