import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseParticipantNames, resolveAttendance } from "@/lib/meetings/attendance";
import type { RosterPerson } from "@/lib/meetings/llm-extract";

/**
 * MTGATT-1 / AIO-962 — attendance comes from what the producer asserted, and a model is the LAST
 * resort rather than the default.
 *
 * The bug this pins: "Content creation strategy session" (2026-08-11) recorded Abe Isleem and Fatma
 * as attendees. Both appear in the transcript only in the third person and explicitly as ABSENT,
 * while the item's own frontmatter said `participants: "[John Ellison]"`.
 *
 * The roster below is prod's real one, because the failure depends on it: every false attendee was a
 * real teammate, and a third (Stefan/Stephan) was avoided only by a spelling difference.
 */
const ROSTER: RosterPerson[] = [
  { id: "m-john", displayName: "John Ellison" },
  { id: "m-abe", displayName: "Abe Isleem" },
  { id: "m-fatma", displayName: "Fatma" },
  { id: "m-chetan", displayName: "Chetan" },
  { id: "m-stephan", displayName: "Stephan Ledain" },
];

describe("parseParticipantNames — the shapes that actually occur in prod", () => {
  it("AC3: the granola single-name shape, a bracketed STRING and not JSON", () => {
    // The real stored value for the meeting in the bug report. A `JSON.parse` would throw here.
    expect(parseParticipantNames("[John Ellison]")).toEqual(["John Ellison"]);
  });

  it("parses the multi-name granola shape", () => {
    expect(parseParticipantNames("[John Ellison, Chetan, Stephan Ledain, Fatma Ghedira]")).toEqual([
      "John Ellison",
      "Chetan",
      "Stephan Ledain",
      "Fatma Ghedira",
    ]);
  });

  it("keeps a name containing an apostrophe intact", () => {
    // `Michael 'Porch' Contreras` occurs in prod — the only intra-name punctuation there is.
    expect(parseParticipantNames("[John Ellison, Pete Longworth, Jana, Michael 'Porch' Contreras]")).toEqual([
      "John Ellison",
      "Pete Longworth",
      "Jana",
      "Michael 'Porch' Contreras",
    ]);
  });

  it("returns NOTHING for Slack's shape — objects carrying an id and no name", () => {
    // 19 prod rows look like this. Coercing them would feed `U0B92140SHJ` to a name matcher, and a
    // matcher fed garbage is one first-name collision away from inventing an attendee.
    const slack = [{ author_id: "U0B92140SHJ", first_ts: "2026-06-08T07:09:46.960Z", last_ts: "2026-06-08T07:09:46.960Z" }];
    expect(parseParticipantNames(slack)).toEqual([]);
  });

  it("accepts an array of plain strings — the obvious future producer shape", () => {
    expect(parseParticipantNames(["Ada Lovelace", "Alan Turing"])).toEqual(["Ada Lovelace", "Alan Turing"]);
  });

  it("accepts objects that DO carry a name", () => {
    expect(parseParticipantNames([{ name: "Ada Lovelace" }, { display: "Alan Turing" }])).toEqual([
      "Ada Lovelace",
      "Alan Turing",
    ]);
  });

  it("dedupes case-insensitively and drops blanks", () => {
    expect(parseParticipantNames("[John Ellison, john ellison, , John Ellison]")).toEqual(["John Ellison"]);
  });

  it("returns [] for absent/empty/unusable values rather than guessing", () => {
    for (const v of [undefined, null, "", "   ", "[]", 42, {}]) {
      expect(parseParticipantNames(v)).toEqual([]);
    }
  });
});

describe("resolveAttendance — precedence, and the model as a last resort", () => {
  it("AC5: THE REPORTED BUG — participants win over anything a model would say", async () => {
    // The exact shape of the 2026-08-11 meeting. The LLM here returns the hallucination that shipped.
    const llm = vi.fn(async () => ["m-john", "m-abe", "m-fatma"]);
    const out = await resolveAttendance({
      participants: "[John Ellison]",
      roster: ROSTER,
      llm,
    });
    expect(out.memberIds).toEqual(["m-john"]);
    expect(out.source).toBe("participants");
    // …and the model is never even consulted, so it cannot contribute a name.
    expect(llm).not.toHaveBeenCalled();
  });

  it("AC1: a calendar event outranks participants and the model", async () => {
    const llm = vi.fn(async () => ["m-abe"]);
    const out = await resolveAttendance({
      isCalendar: true,
      calendarMemberIds: ["m-john", "m-chetan"],
      participants: "[Someone Else]",
      roster: ROSTER,
      llm,
    });
    expect(out.memberIds).toEqual(["m-john", "m-chetan"]);
    expect(out.source).toBe("calendar");
    expect(llm).not.toHaveBeenCalled();
  });

  it("AC1: with neither structured source, the model IS used", async () => {
    const llm = vi.fn(async () => ["m-john"]);
    const out = await resolveAttendance({ roster: ROSTER, llm });
    expect(out.memberIds).toEqual(["m-john"]);
    expect(out.source).toBe("llm");
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("AC2: a structured list resolving to NOBODY does not fall through to the model", async () => {
    // Granola's `[John Ellison, Pete Longworth]` with Pete not on the team. The tempting behaviour is
    // "we got nothing useful, ask the model" — which re-opens the original bug precisely on the
    // meetings with the most outside names lying around to mistake for attendees.
    const llm = vi.fn(async () => ["m-abe", "m-fatma"]);
    const out = await resolveAttendance({ participants: "[Pete Longworth]", roster: ROSTER, llm });
    expect(out.memberIds).toEqual([]);
    expect(out.source).toBe("participants");
    expect(llm).not.toHaveBeenCalled();
  });

  it("AC2: names that resolved to nobody are REPORTED, not silently dropped", async () => {
    const out = await resolveAttendance({
      participants: "[John Ellison, Pete Longworth, Rob White]",
      roster: ROSTER,
      llm: async () => [],
    });
    expect(out.memberIds).toEqual(["m-john"]);
    expect(out.unresolved).toEqual(["Pete Longworth", "Rob White"]);
  });

  it("resolves granola's fuller name against a shorter roster entry, and vice versa", async () => {
    // Prod says `Chetan Nandakumar` / `Fatma Ghedira`; the roster says `Chetan` / `Fatma`.
    const out = await resolveAttendance({
      participants: "[Chetan Nandakumar, Fatma Ghedira]",
      roster: ROSTER,
      llm: async () => [],
    });
    expect(out.memberIds.sort()).toEqual(["m-chetan", "m-fatma"]);
    expect(out.unresolved).toEqual([]);
  });

  it("a calendar event with NO resolvable attendees stays empty — it does not fall back", async () => {
    // `isCalendar` distinguishes "an event whose invitees are all external" from "not a calendar
    // event at all". Without that flag an empty list would look like absence of data and fall through.
    const llm = vi.fn(async () => ["m-abe"]);
    const out = await resolveAttendance({ isCalendar: true, calendarMemberIds: [], roster: ROSTER, llm });
    expect(out.memberIds).toEqual([]);
    expect(out.source).toBe("calendar");
    expect(llm).not.toHaveBeenCalled();
  });

  it("with no model injected and nothing asserted, reports `none` rather than throwing", async () => {
    const out = await resolveAttendance({ roster: ROSTER });
    expect(out).toEqual({ memberIds: [], source: "none", unresolved: [] });
  });
});

/**
 * AC4 — the FALLBACK prompt, reached only when the producer asserted nothing.
 *
 * Pinned as text because it is the only place the "present vs mentioned" distinction can live for a
 * transcript with no structured list, and because the failure it fixes was a prompt that said
 * "attended OR SPOKEN" and offered no exclusion at all.
 */
describe("AC4: the fallback prompt distinguishes present from mentioned", () => {
  const src = readFileSync(join(process.cwd(), "lib/meetings/llm-extract.ts"), "utf8");

  it("asks for people who were PRESENT, not people who 'appear to have attended or spoken'", () => {
    expect(src).toContain("who were PRESENT");
    expect(src).not.toContain("appears to have attended or spoken");
  });

  it("explicitly excludes third-person mentions, absent people and future meetings", () => {
    expect(src).toMatch(/DO NOT list someone merely because they are MENTIONED/);
    expect(src).toMatch(/third \" \+\n\s*\"person, named as absent or elsewhere, or proposed for a FUTURE meeting/);
  });

  it("carries a negative example of the exact shape that produced the bug", () => {
    // "one day to get Abe, who's in Germany… can we get him on Zoom?" — generalised, not name-specific.
    expect(src).toMatch(/can we get him on Zoom\?.*Sam is NOT present/s);
  });

  it("the roster hint is scoped to SPELLING, not to deciding attendance", () => {
    // The old hint said "Known team members (for reference, not exhaustive)" immediately after asking
    // who attended — which primes the model to answer with roster names, and is why every false
    // attendee was a real teammate.
    expect(src).toContain("NOT a list of who attended this meeting");
    expect(src).not.toContain("Known team members (for reference, not exhaustive)");
  });
});
