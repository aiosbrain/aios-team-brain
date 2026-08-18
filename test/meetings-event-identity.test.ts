import { describe, expect, it } from "vitest";
import { eventIdentity } from "@/lib/meetings/event-identity";

/**
 * Spec (MTGATT-2 §2): the identity a calendar event and its transcript can SHARE, normalised.
 *
 * Nothing joins on these yet — they are emitted by the producer and counted by
 * `scripts/meeting-pairing-report.ts`, so MTGATT-3's matching rule is fitted to measured pairs. That
 * makes these tests the ONLY thing standing between a mis-normalisation and a silently wrong
 * measurement, which is why the false-join cases are pinned as hard as the true-match ones.
 */

describe("eventIdentity — the shapes a producer might send", () => {
  it("finds the key in every accepted flat spelling", () => {
    for (const key of ["calendar_event_id", "calendarEventId", "event_id", "gcal_event_id"]) {
      expect(eventIdentity({ [key]: "6f3k9q2n1m8h5s7d" }).eventKeys, key).toEqual(["eid:6f3k9q2n1m8h5s7d"]);
    }
  });

  it("finds the key inside the nested google_calendar_event object", () => {
    const id = eventIdentity({
      google_calendar_event: { id: "6f3k9q2n1m8h5s7d", iCalUID: "6f3k9q2n1m8h5s7d@google.com" },
    });
    expect(id.eventKeys.sort()).toEqual(["eid:6f3k9q2n1m8h5s7d", "uid:6f3k9q2n1m8h5s7d@google.com"]);
  });

  it("a UID yields its bare event id too — Google's documented derivation, as an EXPLICIT extra key", () => {
    // The flat and nested producers can each send only one of the two; this is what lets them line up
    // without a normaliser silently rewriting a UID into something it is not.
    expect(eventIdentity({ ical_uid: "abc12345@google.com" }).eventKeys.sort()).toEqual([
      "eid:abc12345",
      "uid:abc12345@google.com",
    ]);
  });

  it("qualifies keys by kind, so an event id can never collide with a UID", () => {
    // The un-qualified version of this normaliser made `Foo@google.com` and a bare `foo` the same
    // string — a second, unproven merge rule hidden inside the first.
    const uid = eventIdentity({ ical_uid: "shared01@zoom.us" }).eventKeys;
    const eid = eventIdentity({ calendar_event_id: "shared01@zoom.us" }).eventKeys;
    expect(uid).toEqual(["uid:shared01@zoom.us"]);
    expect(eid).toEqual(["eid:shared01@zoom.us"]);
    expect(uid.some((k) => eid.includes(k))).toBe(false);
  });

  it("KEEPS a recurring instance suffix — two weeks of one series are two meetings", () => {
    const week1 = eventIdentity({ calendar_event_id: "base0abc_20260811T090000Z" }).eventKeys;
    const week2 = eventIdentity({ calendar_event_id: "base0abc_20260818T090000Z" }).eventKeys;
    expect(week1).not.toEqual(week2);
  });

  it("two copies of ONE event normalise equal despite case and whitespace", () => {
    const mine = eventIdentity({ calendar_event_id: "  6F3K9Q2N1M8H5S7D  " }).eventKeys;
    const theirs = eventIdentity({ google_calendar_event: { id: "6f3k9q2n1m8h5s7d" } }).eventKeys;
    expect(mine).toEqual(theirs);
  });

  it("discards a placeholder a producer sends for 'nothing to put here'", () => {
    for (const junk of ["", "-", "none", "n/a", "   ", "null", "unknown", "undefined", "TBD"]) {
      expect(eventIdentity({ calendar_event_id: junk }).eventKeys, junk).toEqual([]);
    }
  });

  it("discards `false`/`undefined` even though Google's charset allows them — the deliberate trade", () => {
    // Both are legal Google ids (charset a-v + 0-9), so this is a real, if vanishing, false negative.
    // It is chosen: a missed key undercounts a diagnostic, a placeholder key would fuse two unrelated
    // meetings. Asserted so the trade is visible and cannot be "fixed" without meeting this comment.
    expect(eventIdentity({ calendar_event_id: "false" }).eventKeys).toEqual([]);
    expect(eventIdentity({ calendar_event_id: "undefined" }).eventKeys).toEqual([]);
  });

  it("KEEPS a valid short Google id — the floor must not discard real ids (review fold)", () => {
    // Google documents an event id as 5–1024 characters. An 8-char floor silently dropped valid
    // short ids, which would have made the pairing report undercount and a later join miss them,
    // with nothing to show it had happened.
    expect(eventIdentity({ calendar_event_id: "abcde" }).eventKeys).toEqual(["eid:abcde"]);
    expect(eventIdentity({ calendar_event_id: "abcd" }).eventKeys, "4 chars is below Google's own minimum").toEqual([]);
  });

  it("yields nothing at all for an item with no calendar fields", () => {
    expect(eventIdentity({ source: "granola", participants: "[John Ellison]" })).toEqual({
      eventKeys: [],
      conferenceKey: null,
    });
    expect(eventIdentity(null)).toEqual({ eventKeys: [], conferenceKey: null });
  });
});

describe("eventIdentity — the conference link (diagnostic only)", () => {
  it("normalises away the per-person query string and trailing slash", () => {
    const a = eventIdentity({ conference_url: "https://meet.google.com/abc-defg-hij?authuser=1" }).conferenceKey;
    const b = eventIdentity({ hangoutLink: "https://Meet.Google.com/abc-defg-hij/" }).conferenceKey;
    expect(a).toBe("meet.google.com/abc-defg-hij");
    expect(b).toBe(a);
  });

  it("reads Google's conferenceData.entryPoints[].uri when there is no hangoutLink", () => {
    const key = eventIdentity({
      google_calendar_event: { conferenceData: { entryPoints: [{ uri: "https://meet.google.com/xyz-1234-abc" }] } },
    }).conferenceKey;
    expect(key).toBe("meet.google.com/xyz-1234-abc");
  });

  it("two different rooms stay different, and a Zoom PMI stays a single key", () => {
    // The PMI case is exactly WHY this is never a join key: one person's personal room serves every
    // meeting they host, so this key being stable across unrelated meetings is the expected behaviour
    // — it is the JOIN that would be wrong, not the normalisation.
    expect(eventIdentity({ conference_url: "https://meet.google.com/aaa-bbbb-ccc" }).conferenceKey).not.toBe(
      eventIdentity({ conference_url: "https://meet.google.com/ddd-eeee-fff" }).conferenceKey
    );
    expect(eventIdentity({ conference_url: "https://zoom.us/j/1234567890" }).conferenceKey).toBe("zoom.us/j/1234567890");
  });

  it("a conference link never becomes an event key", () => {
    const id = eventIdentity({ conference_url: "https://meet.google.com/abc-defg-hij" });
    expect(id.eventKeys).toEqual([]);
  });

  it("garbage that is not a URL yields null rather than a key", () => {
    expect(eventIdentity({ conference_url: "not a url at all::" }).conferenceKey).toBeNull();
  });
});
