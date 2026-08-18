import { describe, expect, it } from "vitest";
import { summarisePairs, type Note } from "@/scripts/meeting-pairing-report";

/**
 * Spec (MTGATT-2 §3): the pairing report counts PAIRS OF MEETINGS, and the number it prints is the
 * one MTGATT-3's matching rule will be fitted to.
 *
 * That makes an inflated count worse than no count: a threshold fitted to a number that is twice the
 * truth is a threshold fitted to noise, and this workstream has already shipped a measurement that
 * was indistinguishable from a parser matching nothing.
 */

const note = (over: Partial<Note> & { id: string }): Note => ({
  title: "Design review",
  occurredAt: "2026-08-11",
  source: "transcript",
  startedAt: null,
  eventKeys: [],
  seriesKeys: [],
  conferenceKey: null,
  ...over,
});

describe("summarisePairs — one meeting pair is counted once", () => {
  it("counts ONE cross pair when both sides share both an eid: and a uid:", () => {
    // The normal shape, not an edge case: a UID emits its bare event id as a second key by design,
    // so nearly every real pair shares two keys.
    const keys = ["eid:abc12345", "uid:abc12345@google.com"];
    const summary = summarisePairs([
      note({ id: "cal", source: "calendar", eventKeys: keys }),
      note({ id: "tx", source: "transcript", eventKeys: keys }),
    ]);
    expect(summary.cross).toBe(1);
    expect(summary.same).toBe(0);
    expect(summary.rows).toHaveLength(1);
  });

  it("separates CROSS from same-source — the only number a calendar↔transcript join can use", () => {
    const summary = summarisePairs([
      note({ id: "t1", eventKeys: ["eid:shared01"] }),
      note({ id: "t2", eventKeys: ["eid:shared01"] }),
      note({ id: "c1", source: "calendar", eventKeys: ["eid:shared01"] }),
    ]);
    // t1↔t2 same-source; t1↔c1 and t2↔c1 cross.
    expect({ cross: summary.cross, same: summary.same }).toEqual({ cross: 2, same: 1 });
  });

  it("counts a cross pair as missed-by-date only once, even sharing two keys", () => {
    // This number decides whether MTGATT-3 may pre-filter by date at all — the timezone case where a
    // 19:00 PDT meeting is 02:00Z the next day. Double-counting it would overstate the argument.
    const keys = ["eid:abc12345", "uid:abc12345@google.com"];
    const summary = summarisePairs([
      note({ id: "cal", source: "calendar", eventKeys: keys, occurredAt: "2026-08-11" }),
      note({ id: "tx", source: "transcript", eventKeys: keys, occurredAt: "2026-08-12" }),
    ]);
    expect(summary.missedByDate).toBe(1);
  });

  it("does not count a same-date cross pair as missed-by-date", () => {
    // The inverse: if this reported every cross pair, the timezone argument would look universal.
    const summary = summarisePairs([
      note({ id: "cal", source: "calendar", eventKeys: ["eid:abc12345"], occurredAt: "2026-08-11" }),
      note({ id: "tx", eventKeys: ["eid:abc12345"], occurredAt: "2026-08-11" }),
    ]);
    expect({ cross: summary.cross, missed: summary.missedByDate }).toEqual({ cross: 1, missed: 0 });
  });

  it("finds nothing when nothing shares a key — zero is a real reading, not a failure", () => {
    const summary = summarisePairs([
      note({ id: "cal", source: "calendar", eventKeys: ["eid:aaa11111"] }),
      note({ id: "tx", eventKeys: ["eid:bbb22222"] }),
    ]);
    expect(summary).toEqual({ cross: 0, same: 0, missedByDate: 0, oversizedGroups: 0, rows: [] });
  });

  it("flags a key group holding MORE than two notes instead of silently counting pairs", () => {
    // Where this bites: every occurrence of a recurring event shares one iCalUID, so a key that is
    // really a SERIES id collects the whole series and reports C(n,2) pairs. The parser now routes
    // recurring UIDs to `seriesKeys`, but a producer sending a UID with no recurrence signal is
    // unclassifiable — so the count that MTGATT-3 gets fitted to has to say when a group is not a pair.
    const keys = ["uid:weekly@google.com"];
    const summary = summarisePairs([
      note({ id: "w1", source: "calendar", eventKeys: keys, occurredAt: "2026-08-11" }),
      note({ id: "w2", eventKeys: keys, occurredAt: "2026-08-18" }),
      note({ id: "w3", eventKeys: keys, occurredAt: "2026-08-25" }),
    ]);
    expect(summary.oversizedGroups, "3 notes on one key is not a pair").toBe(1);
  });

  it("does not flag a legitimate two-note pair as oversized", () => {
    // The inverse — otherwise the warning fires on every real pair and stops meaning anything.
    const summary = summarisePairs([
      note({ id: "cal", source: "calendar", eventKeys: ["eid:abc12345"] }),
      note({ id: "tx", eventKeys: ["eid:abc12345"] }),
    ]);
    expect(summary.oversizedGroups).toBe(0);
  });

  it("ignores notes with no keys rather than grouping them together", () => {
    // Two notes carrying `[]` must not pair on emptiness — that would report the entire corpus as
    // matched on the day the producer sends nothing.
    const summary = summarisePairs([note({ id: "a", source: "calendar" }), note({ id: "b" })]);
    expect(summary.cross).toBe(0);
  });
});
