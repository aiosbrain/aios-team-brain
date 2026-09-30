import { describe, expect, it } from "vitest";
import { salvageSummaries, attachSalvagedSummaries, PAYLOAD_VERSION } from "@/lib/dashboard/timeline-cache";
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
const G = { dataGeneration: "0", identityGeneration: "0", presentationGeneration: "0" };
const ITEMS = "a".repeat(64);
const payload = (v: number, people: { memberId: string; summary?: string }[]) => ({
  v,
  generations: G,
  itemFingerprint: ITEMS,
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
    // was deleting the synopsis on each deploy. This version is foreign AND above the content floor
    // (a row written by a newer build, then rolled back onto this one).
    const got = salvageSummaries(payload(PAYLOAD_VERSION + 1, [{ memberId: "m1", summary: "Shipped X." }]), NOW - 1000, NOW, G);
    expect(got.get("2026-07-27|m1")).toBe("Shipped X.");
  });

  it("keys on person AND day together", () => {
    const got = salvageSummaries(
      payload(PAYLOAD_VERSION + 1, [
        { memberId: "m1", summary: "Alice's day." },
        { memberId: "m2", summary: "Bob's day." },
      ]),
      NOW - 1000,
      NOW,
      G
    );
    expect(got.get("2026-07-27|m1")).toBe("Alice's day.");
    expect(got.get("2026-07-27|m2")).toBe("Bob's day.");
    expect(got.size).toBe(2);
  });

  it("refuses an ancient row — a salvaged sentence is a bridge, not an archive", () => {
    // The foreign version is deliberately ABOVE the content floor so AGE is the only thing under test. With a
    // pre-floor version here this would go green for the wrong reason and stop testing age at all.
    const old = salvageSummaries(payload(PAYLOAD_VERSION + 1, [{ memberId: "m1", summary: "Last week." }]), NOW - 8 * 24 * 3600_000, NOW, G);
    expect(old.size).toBe(0);
  });

  it("refuses pre-v15 prose even when fresh — those sentences can carry the Slack misattribution", () => {
    // The new contribution-day and attribution contract invalidates older sentences even if the
    // stored person/day key happens to match the rebuilt one.
    const stale = salvageSummaries(payload(PAYLOAD_VERSION - 1, [{ memberId: "m1", summary: "Shared two sizzle reels." }]), NOW - 1000, NOW, G);
    expect(stale.size).toBe(0);
    // …and the floor is a floor, not an equality check: the CURRENT version still salvages.
    const current = salvageSummaries(payload(PAYLOAD_VERSION, [{ memberId: "m1", summary: "Reviewed the rollout." }]), NOW - 1000, NOW, G);
    expect(current.get("2026-07-27|m1")).toBe("Reviewed the rollout.");
  });

  it("refuses a payload with no readable version — unprovable prose is not carried", () => {
    const noVersion = salvageSummaries({ days: [{ date: "2026-07-27", people: [{ memberId: "m1", summary: "?" }] }] }, NOW - 1000, NOW, G);
    expect(noVersion.size).toBe(0);
  });

  it("survives junk instead of throwing — a lost synopsis must never fail the panel", () => {
    for (const junk of [null, undefined, {}, { days: "nope" }, { days: [{ people: 3 }] }, { days: [{ date: 1 }] }, { v: NaN, days: [{ date: "2026-07-27", people: [{ memberId: "m1", summary: "x" }] }] }]) {
      expect(salvageSummaries(junk, NOW - 1000, NOW, G).size).toBe(0);
    }
    // A person-day with no summary contributes nothing rather than an empty string. The foreign version is
    // ABOVE the content floor on purpose: at a pre-floor version the gate rejects the payload first and
    // these two go green without ever reaching the empty-summary check they exist to cover.
    expect(salvageSummaries(payload(PAYLOAD_VERSION + 1, [{ memberId: "m1" }]), NOW - 1000, NOW, G).size).toBe(0);
    expect(salvageSummaries(payload(PAYLOAD_VERSION + 1, [{ memberId: "m1", summary: "" }]), NOW - 1000, NOW, G).size).toBe(0);
  });

  it("refuses unstamped and changed data, identity or presentation revisions", () => {
    const stamped = payload(PAYLOAD_VERSION, [{ memberId: "m1", summary: "Old claim." }]);
    expect(salvageSummaries({ ...stamped, generations: undefined }, NOW - 1000, NOW, G).size).toBe(0);
    for (const field of ["dataGeneration", "identityGeneration", "presentationGeneration"] as const) {
      expect(salvageSummaries(stamped, NOW - 1000, NOW, { ...G, [field]: "1" }).size).toBe(0);
    }
  });

  it("refuses a synopsis after same-project-set item visibility changes", () => {
    const stamped = payload(PAYLOAD_VERSION, [{ memberId: "m1", summary: "Revoked title." }]);
    expect(salvageSummaries(stamped, NOW - 1000, NOW, G, ITEMS).size).toBe(1);
    expect(salvageSummaries(stamped, NOW - 1000, NOW, G, "b".repeat(64)).size).toBe(0);
    expect(salvageSummaries({ ...stamped, itemFingerprint: undefined }, NOW - 1000, NOW, G, ITEMS).size)
      .toBe(0);
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
