import { describe, expect, it } from "vitest";
import { plan, type LinkCandidate } from "@/lib/meetings/identity-link";

/**
 * Spec (MTGATT-3 §2): which notes fold into which, decided by an EXACT shared event key and by
 * content — never by a resemblance, and never by a date pre-filter.
 *
 * These are the rules; `test/datamechanics/meeting-identity-link.datamechanics.test.ts` proves the
 * rows they produce. Both halves are needed: a correct plan written wrongly to the DB is still a
 * hidden meeting.
 */

const note = (over: Partial<LinkCandidate> & { noteId: string }): LinkCandidate => ({
  eventKeys: [],
  hasBody: false,
  occurredAt: "2026-08-11",
  createdAt: "2026-08-11T09:00:00.000Z",
  ...over,
});

describe("plan — groups form on an exact event key and nothing else", () => {
  it("does not group notes that share no event key, however similar they look", () => {
    // Same date, same title-shaped situation, no shared identifier: this is the misassociation the
    // operator asked about at team scale, asserted as an absence.
    const p = plan([
      note({ noteId: "a", eventKeys: ["eid:aaa11111"], hasBody: true }),
      note({ noteId: "b", eventKeys: ["eid:bbb22222"] }),
    ]);
    expect(p.groups).toEqual([]);
  });

  it("does not group on an empty key set — a corpus with no identifiers must form no groups", () => {
    // The live case today: prod carries zero identifiers. If `[]` grouped, the first tick would fold
    // the entire Meetings page into one note.
    const p = plan([note({ noteId: "a", hasBody: true }), note({ noteId: "b" }), note({ noteId: "c" })]);
    expect(p.groups).toEqual([]);
  });

  it("groups a calendar event with its transcript on a shared key", () => {
    const p = plan([
      note({ noteId: "tx", eventKeys: ["eid:evt12345"], hasBody: true }),
      note({ noteId: "cal", eventKeys: ["eid:evt12345"] }),
    ]);
    expect(p.groups).toEqual([{ survivorId: "tx", foldedIds: ["cal"], keys: ["eid:evt12345"] }]);
  });
});

describe("plan — the survivor is chosen by content, not arrival order", () => {
  it("the note WITH a body survives, whichever arrived first", () => {
    // MTGATT-1 deferred this join partly because the existing merge keeps whichever note existed
    // first, so a transcript arriving second would fold into the empty note and lose its text.
    for (const [txCreated, calCreated] of [
      ["2026-08-11T09:00:00.000Z", "2026-08-11T10:00:00.000Z"],
      ["2026-08-11T10:00:00.000Z", "2026-08-11T09:00:00.000Z"],
    ]) {
      const p = plan([
        note({ noteId: "tx", eventKeys: ["eid:evt12345"], hasBody: true, createdAt: txCreated }),
        note({ noteId: "cal", eventKeys: ["eid:evt12345"], createdAt: calCreated }),
      ]);
      expect(p.groups[0].survivorId, `tx created ${txCreated}`).toBe("tx");
    }
  });

  it("with no bodies at all, the earliest-created survives — deterministically", () => {
    const p = plan([
      note({ noteId: "late", eventKeys: ["eid:evt12345"], createdAt: "2026-08-11T12:00:00.000Z" }),
      note({ noteId: "early", eventKeys: ["eid:evt12345"], createdAt: "2026-08-11T08:00:00.000Z" }),
    ]);
    expect(p.groups[0]).toEqual({ survivorId: "early", foldedIds: ["late"], keys: ["eid:evt12345"] });
  });

  it("folds N bodyless pushes of one event into the single note that has a body", () => {
    // Three people share one meeting: one recorded it, two pushed their calendars.
    const p = plan([
      note({ noteId: "tx", eventKeys: ["eid:evt12345"], hasBody: true }),
      note({ noteId: "cal1", eventKeys: ["eid:evt12345"], createdAt: "2026-08-11T09:30:00.000Z" }),
      note({ noteId: "cal2", eventKeys: ["eid:evt12345"], createdAt: "2026-08-11T09:45:00.000Z" }),
    ]);
    expect(p.groups[0].survivorId).toBe("tx");
    expect(p.groups[0].foldedIds.sort()).toEqual(["cal1", "cal2"]);
  });

  it("REFUSES a group where two notes have bodies, and counts the refusal", () => {
    const p = plan([
      note({ noteId: "tx1", eventKeys: ["eid:evt12345"], hasBody: true }),
      note({ noteId: "tx2", eventKeys: ["eid:evt12345"], hasBody: true }),
    ]);
    expect(p.groups).toEqual([]);
    expect(p.refusals["two-bodies"]).toBe(1);
  });

  it("never folds one note twice, so `merged_into` cannot chain onto a hidden note", () => {
    // A note carrying two keys appears in two groups. Readers filter `merged_into is null` and do not
    // resolve it transitively, so a chain would hide a note behind something already invisible.
    const p = plan([
      note({ noteId: "tx", eventKeys: ["eid:aaa11111"], hasBody: true }),
      note({ noteId: "cal", eventKeys: ["eid:aaa11111", "uid:bbb22222@google.com"] }),
      note({ noteId: "other", eventKeys: ["uid:bbb22222@google.com"], createdAt: "2026-08-11T07:00:00.000Z" }),
    ]);
    const foldedTwice = p.groups.flatMap((g) => g.foldedIds).filter((id, i, all) => all.indexOf(id) !== i);
    expect(foldedTwice, "no note may be folded by two groups").toEqual([]);
    const survivors = new Set(p.groups.map((g) => g.survivorId));
    const folded = new Set(p.groups.flatMap((g) => g.foldedIds));
    expect([...folded].filter((id) => survivors.has(id)), "a folded note must not also be a survivor").toEqual([]);
  });
});

describe("plan — components, not per-key groups", () => {
  it("links a THREE-note component bridged by a note carrying both keys", () => {
    // Review round 2's case, and it is the ordinary shape rather than an exotic one: a UID also emits
    // its bare event id, so a note can carry both. Grouping per key processed `eid:` first, folded the
    // bridge into a bodyless note, and left the TRANSCRIPT stranded as a separate meeting — the exact
    // outcome the survivor rule exists to make unreachable.
    const p = plan([
      note({ noteId: "A", eventKeys: ["eid:x1234567"], createdAt: "2026-08-11T08:00:00.000Z" }),
      note({ noteId: "B", eventKeys: ["eid:x1234567", "uid:x1234567@google.com"], createdAt: "2026-08-11T09:00:00.000Z" }),
      note({ noteId: "C", eventKeys: ["uid:x1234567@google.com"], hasBody: true, createdAt: "2026-08-11T10:00:00.000Z" }),
    ]);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].survivorId, "the note with the body must survive").toBe("C");
    expect(p.groups[0].foldedIds.sort()).toEqual(["A", "B"]);
  });

  it("does not bridge two components that share no key", () => {
    // The inverse: transitivity must follow shared keys, not proximity. Without it, one busy note
    // could chain unrelated meetings into a single component.
    const p = plan([
      note({ noteId: "A", eventKeys: ["eid:aaa11111"], hasBody: true }),
      note({ noteId: "B", eventKeys: ["eid:aaa11111"] }),
      note({ noteId: "C", eventKeys: ["eid:zzz99999"], hasBody: true }),
      note({ noteId: "D", eventKeys: ["eid:zzz99999"] }),
    ]);
    expect(p.groups).toHaveLength(2);
    expect(p.groups.flatMap((g) => g.foldedIds).sort()).toEqual(["B", "D"]);
  });
});

describe("plan — a whitespace body is not a body", () => {
  it("treats a whitespace-only note as bodyless so it cannot outrank the real transcript", () => {
    // `hasBody` is computed by the caller as `body.trim().length > 0`; this pins the CONSEQUENCE of
    // getting that wrong — a producer emitting "\n" for an invite would otherwise become the survivor
    // and hide the transcript.
    const p = plan([
      note({ noteId: "blank", eventKeys: ["eid:evt12345"], hasBody: false, createdAt: "2026-08-11T08:00:00.000Z" }),
      note({ noteId: "tx", eventKeys: ["eid:evt12345"], hasBody: true, createdAt: "2026-08-11T09:00:00.000Z" }),
    ]);
    expect(p.groups[0].survivorId).toBe("tx");
  });
});

describe("plan — the date veto, and the half that stops it becoming a filter", () => {
  it("links a pair a DAY apart — the timezone case a date filter would have dropped", () => {
    // A 19:00 PDT meeting is 02:00Z the next day, so the calendar's local date and the transcript's
    // UTC-derived one legitimately differ. This is the inverse half: without it, the veto could be
    // tightened to same-date and nothing else in the suite would notice.
    const p = plan([
      note({ noteId: "tx", eventKeys: ["eid:evt12345"], hasBody: true, occurredAt: "2026-08-12" }),
      note({ noteId: "cal", eventKeys: ["eid:evt12345"], occurredAt: "2026-08-11" }),
    ]);
    expect(p.groups[0].survivorId).toBe("tx");
    expect(p.refusals["dates-too-far-apart"]).toBe(0);
  });

  it("vetoes a group spanning weeks — the undetectable-series residual", () => {
    const p = plan([
      note({ noteId: "w1", eventKeys: ["uid:weekly@google.com"], hasBody: true, occurredAt: "2026-08-11" }),
      note({ noteId: "w2", eventKeys: ["uid:weekly@google.com"], occurredAt: "2026-08-18" }),
    ]);
    expect(p.groups).toEqual([]);
    expect(p.refusals["dates-too-far-apart"]).toBe(1);
  });

  it("REFUSES when a member has no date — the veto must not be switchable off by omission", () => {
    // This rule is the reverse of the first draft, and review round 2 is why: an undetectable weekly
    // series where the transcript is dated 11 Aug and the calendar event for 18 Aug carries NO date
    // would link, because skipping nulls disables the veto exactly where it is needed. Refusing is
    // the safe direction — a duplicate meeting is visible and fixable, two meetings fused are not.
    const p = plan([
      note({ noteId: "tx", eventKeys: ["eid:evt12345"], hasBody: true, occurredAt: null }),
      note({ noteId: "cal", eventKeys: ["eid:evt12345"], occurredAt: "2026-08-11" }),
    ]);
    expect(p.groups).toEqual([]);
    expect(p.refusals["unknown-date"]).toBe(1);
  });

  it("vetoes on the widest span in the group, not just the first pair", () => {
    // Three members where the first two are compatible: checking only adjacent pairs would let a
    // three-week span through on the strength of its narrowest edge.
    const p = plan([
      note({ noteId: "a", eventKeys: ["uid:weekly@google.com"], hasBody: true, occurredAt: "2026-08-11" }),
      note({ noteId: "b", eventKeys: ["uid:weekly@google.com"], occurredAt: "2026-08-12" }),
      note({ noteId: "c", eventKeys: ["uid:weekly@google.com"], occurredAt: "2026-09-01" }),
    ]);
    expect(p.groups).toEqual([]);
    expect(p.refusals["dates-too-far-apart"]).toBe(1);
  });
});
