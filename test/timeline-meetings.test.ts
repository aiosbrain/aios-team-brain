import { describe, it, expect } from "vitest";
import { groupTimeline, summaryPromptFor, type EvidenceWithMember, type TimelineMember } from "@/lib/dashboard/timeline-group";
import { isBareDate } from "@/lib/dashboard/timeline-group";
import { classifyWork } from "@/lib/dashboard/work-classification";
import { PAYLOAD_VERSION, MIN_SALVAGEABLE_VERSION } from "@/lib/dashboard/timeline-cache";

/**
 * Spec: `docs/specs/meeting-participation-as-work-v1.md` — the pure half.
 *
 * A meeting a person sat in is WORK on their card. These cover the grouping/counting rules and the
 * two invariants the spec review turned up; the per-attendee fan-out and tier gate are persistence +
 * access questions and live in the data-mechanics tier.
 */

const MEMBERS = new Map<string, TimelineMember>([
  ["m1", { name: "Alice", handle: "alice", avatarUrl: null }],
  ["m2", { name: "Bob", handle: "bob", avatarUrl: null }],
]);

function meeting(id: string, memberId: string, over: Partial<EvidenceWithMember> = {}): EvidenceWithMember {
  return {
    id,
    memberId,
    title: "1-1 with Chetan",
    url: "/t/acme/meetings/n1",
    source: "meetings",
    kind: "meeting",
    at: "2026-08-04", // bare date — a meeting has no clock time (spec §2)
    ...over,
  };
}

function commit(id: string, memberId: string): EvidenceWithMember {
  return { id, memberId, title: "fix: a thing", source: "github", kind: "commit", at: "2026-08-04T09:00:00Z" };
}

const day = (evidence: EvidenceWithMember[]) =>
  groupTimeline(evidence, new Map(), MEMBERS, "2026-08-04")[0]?.people ?? [];

describe("meetings on the person card (spec: meeting-participation-as-work-v1)", () => {
  it("counts a meeting as WORK — it reaches `total`, not `signals`", () => {
    // Criterion 3. The product reversal in one assertion: the prior design put meetings in the
    // Context lane, which is explicitly "never counted as work".
    const [p] = day([meeting("n1:m1", "m1")]);
    expect(p.total).toBe(1);
    expect(p.signals).toEqual([]);
    expect(p.other.find((g) => g.source === "meetings")?.count).toBe(1);
  });

  it("does NOT inflate `unlinked` — that metric measures doc→task coverage, not meetings", () => {
    // Criterion 3, second half. `unlinked` decides when omitting `other[]` is safe; meetings are
    // permanently unlinkable in V1, so counting them would corrupt the metric forever (16
    // meetings/14d for one person on prod would swamp it).
    const [p] = day([meeting("n1:m1", "m1"), meeting("n2:m1", "m1"), commit("c1", "m1")]);
    expect(p.total).toBe(3); // all three are work
    expect(p.unlinked).toBe(1); // …but only the commit is unlinked-and-linkable
  });

  it("gives every attendee their own card entry for the same meeting", () => {
    // Criterion 1, at the grouping layer: two evidence rows, same meeting, different people.
    const people = day([meeting("n1:m1", "m1"), meeting("n1:m2", "m2")]);
    expect(people.map((p) => p.name).sort()).toEqual(["Alice", "Bob"]);
    for (const p of people) expect(p.total).toBe(1);
  });

  it("carries `via` through the grouper into the payload", () => {
    // Criterion 9. `groupTimeline` copies evidence fields EXPLICITLY, so a new key that isn't added
    // to that copy is silently dropped between builder and payload — the "pin the call site, not
    // just the type" failure. Mutation-checked by deleting `via` from the copy.
    const [p] = day([meeting("n1:m1", "m1", { via: "submitter" })]);
    const item = p.other.find((g) => g.source === "meetings")?.items[0];
    expect(item?.via).toBe("submitter");
  });

  it("omits `via` when the credit came from real attendance", () => {
    // The control: if `via` were hardcoded the assertion above would pass on a broken build.
    const [p] = day([meeting("n1:m1", "m1")]);
    expect(p.other.find((g) => g.source === "meetings")?.items[0]?.via).toBeUndefined();
  });

  it("describes meetings in the individual update prompt", () => {
    // Criterion 7. `summaryPromptFor`'s own rule is "the prompt describes what the card shows" — a
    // day of calls otherwise yields a synopsis omitting the day's main activity.
    const [p] = day([meeting("n1:m1", "m1")]);
    const prompt = summaryPromptFor(p, "Today");
    expect(prompt).toContain("1-1 with Chetan");
    expect(prompt).toContain("meetings");
  });

  it("keeps `classifyWork` saying SIGNAL for meeting transcripts — on purpose", () => {
    // Criterion 11, and the reason is attached so a later "cleanup" can't quietly undo it.
    //
    // `classifyWork`'s only other consumer is `doc-task-infer-run.ts`, where `=== "work"` is the ONLY
    // thing keeping meeting transcripts out of the LLM doc→task pass (`isScoreableSource("granola")`
    // is true). Flipping it to "work" for consistency with the timeline would send large transcripts
    // to the model on every background rebuild and write task_evidence rows keyed to transcript ids
    // that nothing renders — the meetings leg uses synthetic `${noteId}:${memberId}` ids.
    //
    // Two questions hide under one word. This one means "is it a scoreable authored document?", and
    // for a meeting the answer is no — exactly as for Slack.
    expect(classifyWork("transcript", "granola")).toBe("signal");
    expect(classifyWork("transcript", "zoom")).toBe("signal");
    // …while Slack, a conversation that IS timeline work, is excluded from scoring by a different
    // mechanism (CONVERSATIONAL_SOURCES) — the precedent meetings follow.
    expect(classifyWork("transcript", "slack")).toBe("work");
  });

  it("renders no time for a bare date, and a time for a real timestamp", () => {
    // A meeting is dated from `occurred_at`, a `date` column with no clock time. `Date.parse` reads a
    // bare date as UTC midnight, so rendering it produced a confident, wrong "12:00 AM" shifted by the
    // viewer's timezone. Extracted from the card so the rule is pinned without rendering.
    expect(isBareDate("2026-07-22")).toBe(true);
    expect(isBareDate(" 2026-07-22 ")).toBe(true); // the card passes payload strings through unchanged
    expect(isBareDate("2026-07-22T09:00:00Z")).toBe(false); // a commit keeps its time
    expect(isBareDate("")).toBe(false);
  });

  it("pins the payload version constants", () => {
    // The shape guard alone does NOT catch a revert: v11 is still pinned in SHAPE_BY_VERSION, so
    // dropping the bump back to 11 sails straight through it — which is the v8 incident class the
    // guard's own comment records. MIN_SALVAGEABLE_VERSION must NOT follow the bump: raising it blanks
    // every person-day summary, a regression reported twice as "we've lost the summaries".
    expect(PAYLOAD_VERSION).toBe(12);
    expect(MIN_SALVAGEABLE_VERSION).toBe(11);
    expect(MIN_SALVAGEABLE_VERSION).toBeLessThan(PAYLOAD_VERSION);
  });
});
