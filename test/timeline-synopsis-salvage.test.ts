import { describe, expect, it } from "vitest";
import { salvageSummaries, attachSalvagedSummaries } from "@/lib/dashboard/timeline-cache";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";

/**
 * The pure half of "a version bump must not blank the synopsis".
 *
 * The per-person-day summary is attached only on the background refresh path, so every
 * `PAYLOAD_VERSION` bump makes the stored row read as a miss and the next viewer gets a
 * summary-less timeline — twice reported as "we've lost the summaries at the top of each
 * person's day". A summary describes what a person DID ON A DAY; a change to the payload's
 * shape doesn't make that sentence untrue, so it bridges the gap until the background pass
 * recomputes it.
 */

const NOW = Date.parse("2026-07-28T00:00:00Z");
const payload = (v: number, people: { memberId: string; summary?: string }[]) => ({
  v,
  days: [{ date: "2026-07-27", label: "Today", people }],
});

const day = (people: { memberId: string; summary?: string }[]): TimelineDay =>
  ({
    date: "2026-07-27",
    label: "Today",
    people: people.map((p) => ({
      memberId: p.memberId,
      name: p.memberId,
      handle: p.memberId,
      total: 1,
      tasks: [],
      other: [],
      unlinked: 0,
      signals: [],
      ...(p.summary ? { summary: p.summary } : {}),
    })),
  }) as TimelineDay;

describe("salvageSummaries — a sentence about a day outlives the shape that held it", () => {
  it("reads summaries out of a FOREIGN payload version", () => {
    // The whole point: every other reader rejects a version mismatch, and that rejection is what
    // was deleting the synopsis on each deploy. `12` is foreign AND at-or-above the content floor
    // (a row written by a newer build, then rolled back onto this one).
    const got = salvageSummaries(payload(12, [{ memberId: "m1", summary: "Shipped X." }]), NOW - 1000, NOW);
    expect(got.get("2026-07-27|m1")).toBe("Shipped X.");
  });

  it("keys on person AND day together", () => {
    const got = salvageSummaries(
      payload(12, [
        { memberId: "m1", summary: "Alice's day." },
        { memberId: "m2", summary: "Bob's day." },
      ]),
      NOW - 1000,
      NOW
    );
    expect(got.get("2026-07-27|m1")).toBe("Alice's day.");
    expect(got.get("2026-07-27|m2")).toBe("Bob's day.");
    expect(got.size).toBe(2);
  });

  it("refuses an ancient row — a salvaged sentence is a bridge, not an archive", () => {
    // Version 12 is deliberately ABOVE the content floor so AGE is the only thing under test. With a
    // pre-floor version here this would go green for the wrong reason and stop testing age at all.
    const old = salvageSummaries(payload(12, [{ memberId: "m1", summary: "Last week." }]), NOW - 8 * 24 * 3600_000, NOW);
    expect(old.size).toBe(0);
  });

  it("refuses PRE-v11 prose even when fresh — those sentences can carry the Slack misattribution", () => {
    // The second-order half of the v11 authorship fix. A v10 summary was written from a prompt in which
    // a Slack replier's evidence carried the thread ROOT author's words, so it can assert in prose the
    // exact thing v11 removed from the titles. A cold miss IS the version bump, and that path
    // re-persists whatever it salvages — so carrying v10 prose would launder the old claim into the new
    // row, bounded only by the next COMPLETED background LLM pass (unbounded if the provider is down).
    const stale = salvageSummaries(payload(10, [{ memberId: "m1", summary: "Shared two sizzle reels." }]), NOW - 1000, NOW);
    expect(stale.size).toBe(0);
    // …and the floor is a floor, not an equality check: the CURRENT version still salvages.
    const current = salvageSummaries(payload(11, [{ memberId: "m1", summary: "Reviewed the rollout." }]), NOW - 1000, NOW);
    expect(current.get("2026-07-27|m1")).toBe("Reviewed the rollout.");
  });

  it("refuses a payload with no readable version — unprovable prose is not carried", () => {
    const noVersion = salvageSummaries({ days: [{ date: "2026-07-27", people: [{ memberId: "m1", summary: "?" }] }] }, NOW - 1000, NOW);
    expect(noVersion.size).toBe(0);
  });

  it("survives junk instead of throwing — a lost synopsis must never fail the panel", () => {
    for (const junk of [null, undefined, {}, { days: "nope" }, { days: [{ people: 3 }] }, { days: [{ date: 1 }] }, { v: NaN, days: [{ date: "2026-07-27", people: [{ memberId: "m1", summary: "x" }] }] }]) {
      expect(salvageSummaries(junk, NOW - 1000, NOW).size).toBe(0);
    }
    // A person-day with no summary contributes nothing rather than an empty string. Version 12 is
    // ABOVE the content floor on purpose: at a pre-floor version the gate rejects the payload first and
    // these two go green without ever reaching the empty-summary check they exist to cover.
    expect(salvageSummaries(payload(12, [{ memberId: "m1" }]), NOW - 1000, NOW).size).toBe(0);
    expect(salvageSummaries(payload(12, [{ memberId: "m1", summary: "" }]), NOW - 1000, NOW).size).toBe(0);
  });
});

describe("attachSalvagedSummaries — fills the gap, never overwrites", () => {
  it("a FRESHLY COMPUTED summary always wins over a salvaged one", () => {
    // Otherwise the bridge would outlive its purpose and pin yesterday's sentence on today's work.
    const days = [day([{ memberId: "m1", summary: "Fresh." }])];
    const out = attachSalvagedSummaries(days, new Map([["2026-07-27|m1", "Salvaged."]]));
    expect(out[0].people[0].summary).toBe("Fresh.");
  });

  it("fills only the person-day it belongs to", () => {
    const days = [day([{ memberId: "m1" }, { memberId: "m2" }])];
    const out = attachSalvagedSummaries(days, new Map([["2026-07-27|m2", "Bob's day."]]));
    expect(out[0].people[0].summary).toBeUndefined();
    expect(out[0].people[1].summary).toBe("Bob's day.");
  });

  it("does not mutate the input", () => {
    const days = [day([{ memberId: "m1" }])];
    attachSalvagedSummaries(days, new Map([["2026-07-27|m1", "Salvaged."]]));
    expect(days[0].people[0].summary).toBeUndefined();
  });

  it("is a no-op with nothing to salvage", () => {
    const days = [day([{ memberId: "m1" }])];
    expect(attachSalvagedSummaries(days, new Map())).toBe(days);
  });
});
