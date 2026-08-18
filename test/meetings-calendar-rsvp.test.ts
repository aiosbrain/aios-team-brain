import { describe, expect, it } from "vitest";
import { attendingAttendees, calendarAttendees } from "@/lib/meetings/from-calendar";

/**
 * Spec (MTGATT-2 §1): an invitee who DECLINED is not an attendee, and nobody else is dropped.
 *
 * The shipped rule — a shared calendar event credits every member attendee — is deliberate and stays
 * (`test/datamechanics/calendar-meetings.datamechanics.test.ts`: "Bob pushed nothing… the meeting is
 * still a record of work he did"). The one case it gets wrong is the person whose own RSVP says they
 * would not be there. These tests pin BOTH halves: the decline is removed, and everything else
 * survives — a filter that dropped `needsAction` too would pass a test that only checked the first.
 */

const A = (email: string, extra: Record<string, unknown> = {}) => ({ email, display: null, ...extra });

describe("calendarAttendees — the RSVP a producer sent", () => {
  it("reads the RSVP from every accepted spelling, lowercased", () => {
    const out = calendarAttendees({
      attendees: [
        { email: "g@x.com", responseStatus: "Declined" }, // Google's own key, and its casing varies
        { email: "s@x.com", response_status: "accepted" },
        { email: "r@x.com", rsvp: "TENTATIVE" },
        { email: "t@x.com", status: "needsAction" },
      ],
    });
    expect(out.map((a) => a.rsvp)).toEqual(["declined", "accepted", "tentative", "needsaction"]);
  });

  it("an attendee with no RSVP field at all carries null — the common shape, not an error", () => {
    // The gog puller's real shape, and Granola's nested event: no RSVP anywhere.
    const out = calendarAttendees({ participants: [{ id: "a@x.com", display: "Alice", role: "organizer" }] });
    expect(out).toEqual([{ email: "a@x.com", display: "Alice", rsvp: null }]);
  });

  it("a bare-string attendee list still parses, with no RSVP", () => {
    expect(calendarAttendees({ attendees: "a@x.com, b@x.com" }).map((a) => a.rsvp)).toEqual([null, null]);
  });
});

describe("attendingAttendees — only an explicit decline is removed", () => {
  it("drops the declined invitee and keeps the rest", () => {
    const invited = [A("keep@x.com"), A("no@x.com", { rsvp: "declined" }), A("yes@x.com", { rsvp: "accepted" })];
    expect(attendingAttendees(invited).map((a) => a.email)).toEqual(["keep@x.com", "yes@x.com"]);
  });

  it("keeps tentative, needsAction, a missing RSVP, and an unrecognised value", () => {
    // The tolerant direction is the one that KEEPS a real attendee. A value this codebase has never
    // seen must never be read as "was not there" — that would silently empty attendance for a
    // producer whose only crime is a different vocabulary.
    const invited = [
      A("t@x.com", { rsvp: "tentative" }),
      A("n@x.com", { rsvp: "needsaction" }),
      A("m@x.com"),
      A("u@x.com", { rsvp: "maybe-later" }),
    ];
    expect(attendingAttendees(invited)).toHaveLength(4);
  });

  it("an all-declined event yields nobody — not a fallback to everyone", () => {
    const invited = [A("a@x.com", { rsvp: "declined" }), A("b@x.com", { rsvp: "declined" })];
    expect(attendingAttendees(invited)).toEqual([]);
  });

  it("does not treat a declined attendee's SHAPE as special — the email is still parsed", () => {
    // Guards the ordering: if the filter ran before parsing, a malformed decline would silently
    // become an attendee instead of being dropped for having no address.
    const parsed = calendarAttendees({ attendees: [{ email: "x@y.com", responseStatus: "declined" }, { display: "No Address" }] });
    expect(parsed.map((a) => a.email)).toEqual(["x@y.com"]);
    expect(attendingAttendees(parsed)).toEqual([]);
  });
});
