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
    // was deleting the synopsis on each deploy.
    const got = salvageSummaries(payload(3, [{ memberId: "m1", summary: "Shipped X." }]), NOW - 1000, NOW);
    expect(got.get("2026-07-27|m1")).toBe("Shipped X.");
  });

  it("keys on person AND day together", () => {
    const got = salvageSummaries(
      payload(9, [
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
    const old = salvageSummaries(payload(9, [{ memberId: "m1", summary: "Last week." }]), NOW - 8 * 24 * 3600_000, NOW);
    expect(old.size).toBe(0);
  });

  it("survives junk instead of throwing — a lost synopsis must never fail the panel", () => {
    for (const junk of [null, undefined, {}, { days: "nope" }, { days: [{ people: 3 }] }, { days: [{ date: 1 }] }]) {
      expect(salvageSummaries(junk, NOW - 1000, NOW).size).toBe(0);
    }
    // A person-day with no summary contributes nothing rather than an empty string.
    expect(salvageSummaries(payload(9, [{ memberId: "m1" }]), NOW - 1000, NOW).size).toBe(0);
    expect(salvageSummaries(payload(9, [{ memberId: "m1", summary: "" }]), NOW - 1000, NOW).size).toBe(0);
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
