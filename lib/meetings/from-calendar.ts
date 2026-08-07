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
}

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
    }
    if (!email) continue;
    const lower = email.toLowerCase();
    if (!EMAIL_RE.test(lower) || seen.has(lower)) continue; // a bare display name is not an identity
    seen.add(lower);
    out.push({ email: lower, display });
  }
  return out;
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
