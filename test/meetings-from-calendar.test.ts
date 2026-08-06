import { describe, it, expect } from "vitest";
import { calendarAttendees, calendarTitle, isCalendarEvent } from "@/lib/meetings/from-calendar";

/**
 * A calendar event a person chose to share must be RECEIVED, LOGGED and ASSOCIATED WITH THE PERSON.
 * This file covers the receiving contract — the boundary where a cross-repo producer meets the brain.
 *
 * The shapes below are not invented: `{id, display, role}` is exactly what the workspace's existing
 * `gog calendar events` normalizer emits today. The others are the forms a reasonable producer would
 * reach for. Being strict here would mean a real shared meeting silently lands on nobody, which is the
 * failure this feature exists to remove.
 */

describe("calendar events are recognised by SOURCE, not kind", () => {
  it("accepts the calendar source spellings — EXACTLY, matching the SQL filter", () => {
    for (const s of ["calendar", "gcal", "google_calendar", "googlecalendar"]) {
      expect(isCalendarEvent(s), s).toBe(true);
    }
  });

  it("does NOT case-fold or trim — because the same set is a SQL IN() filter", () => {
    // If this were tolerant while the candidate query is not, a `"Calendar"` item would be excluded
    // from the timeline's raw-items lane AND never become a meeting note: visible nowhere. The two
    // layers agreeing means a non-conforming source degrades to "ordinary item, credited to the
    // pusher" — worse attribution, never a disappearance.
    for (const s of ["Calendar", " calendar ", "GoogleCalendar", "GCAL"]) {
      expect(isCalendarEvent(s), s).toBe(false);
    }
  });

  it("does not claim other sources", () => {
    // granola/zoom keep the TRANSCRIPT path — they have a body and an LLM extractor. A calendar event
    // has structured attendees and no body; conflating them would send each down the wrong pipeline.
    for (const s of ["granola", "zoom", "slack", "github", "", null, undefined]) {
      expect(isCalendarEvent(s), String(s)).toBe(false);
    }
  });
});

describe("attendee resolution — exact, by email", () => {
  it("reads the gog puller's real shape (id + display + role)", () => {
    // The producer that exists today. `role: organizer` is NOT special-cased: the organizer attended
    // too, and the timeline credits attendance rather than authorship.
    const fm = {
      participants: [
        { id: "alice@acme.com", display: "Alice", role: "organizer" },
        { id: "bob@acme.com", display: "Bob", role: "attendee" },
      ],
    };
    expect(calendarAttendees(fm)).toEqual([
      { email: "alice@acme.com", display: "Alice" },
      { email: "bob@acme.com", display: "Bob" },
    ]);
  });

  it("reads plain strings, objects, and a comma-separated string", () => {
    expect(calendarAttendees({ attendees: ["A@Acme.com", "b@acme.com"] }).map((a) => a.email)).toEqual([
      "a@acme.com",
      "b@acme.com",
    ]);
    expect(calendarAttendees({ attendees: [{ email: "c@acme.com", displayName: "Cee" }] })).toEqual([
      { email: "c@acme.com", display: "Cee" },
    ]);
    expect(calendarAttendees({ attendees: "d@acme.com, e@acme.com" }).map((a) => a.email)).toEqual([
      "d@acme.com",
      "e@acme.com",
    ]);
  });

  it("prefers a real email field over `id` when both are present", () => {
    // The gog puller puts a DISPLAY NAME in `id` when an attendee has no email, so `id` must lose to
    // an explicit address or a named-but-addressed attendee resolves to nothing.
    expect(calendarAttendees({ participants: [{ id: "Alice Smith", email: "alice@acme.com" }] })).toEqual([
      { email: "alice@acme.com", display: null },
    ]);
  });

  it("DROPS an attendee with no parseable email rather than guessing", () => {
    // A display name with no address is exactly the ambiguity that makes transcript attendee-matching
    // lossy (1.4/meeting on prod). A calendar event's whole advantage is that it carries addresses;
    // falling back to name-matching here would trade it away.
    expect(calendarAttendees({ participants: [{ id: "Alice Smith", display: "Alice Smith" }] })).toEqual([]);
    expect(calendarAttendees({ attendees: ["not-an-email", "", "   "] })).toEqual([]);
  });

  it("dedupes case-insensitively and keeps source order", () => {
    const got = calendarAttendees({ attendees: ["A@x.com", "a@X.com", "b@x.com"] });
    expect(got.map((a) => a.email)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns [] for a non-calendar or attendee-less item rather than throwing", () => {
    for (const fm of [null, undefined, {}, { attendees: 42 }, { attendees: {} }]) {
      expect(calendarAttendees(fm as Record<string, unknown>)).toEqual([]);
    }
  });
});

describe("title", () => {
  it("prefers explicit title, then Google's `summary` (which IS the event title)", () => {
    expect(calendarTitle({ title: "Weekly sync" }, "x.md")).toBe("Weekly sync");
    expect(calendarTitle({ summary: "1-1 with Chetan" }, "x.md")).toBe("1-1 with Chetan");
    // …and `title` wins, so a producer sending both doesn't get the description as its name.
    expect(calendarTitle({ title: "Real title", summary: "other" }, "x.md")).toBe("Real title");
  });

  it("falls back to a de-slugified filename, minus a leading date", () => {
    expect(calendarTitle({}, "1-inbox/calendar/2026-08-04-design-review.md")).toBe("design review");
    expect(calendarTitle({}, "")).toBe("Meeting");
  });
});
