import { describe, expect, it } from "vitest";
import { groupEventsByDay } from "@/lib/graph/timeline";
import type { GraphEvent } from "@/lib/graph/learning";

/** Spec: events group into work-day buckets, newest day first, order preserved within a day. Pure. */

const ev = (id: string, at: string): GraphEvent => ({
  id,
  itemId: null,
  source: "notion",
  title: id,
  at,
  participants: [],
  facts: [],
  factCount: 0,
});

describe("groupEventsByDay", () => {
  it("buckets by work-day, newest day first, preserving intra-day order", () => {
    const days = groupEventsByDay([
      ev("a", "2026-07-21T15:00:00Z"),
      ev("b", "2026-07-21T09:00:00Z"),
      ev("c", "2026-07-19T10:00:00Z"),
    ]);
    expect(days.map((d) => d.date)).toEqual(["2026-07-21", "2026-07-19"]); // newest day first
    expect(days[0].events.map((e) => e.id)).toEqual(["a", "b"]); // intra-day order preserved
    expect(days[1].events.map((e) => e.id)).toEqual(["c"]);
  });

  it("puts a missing-timestamp ('unknown') bucket LAST, not lexically first", () => {
    const days = groupEventsByDay([ev("x", ""), ev("y", "2026-07-20T00:00:00Z")]);
    expect(days.map((d) => d.date)).toEqual(["2026-07-20", "unknown"]); // real days first, undated last
  });

  it("returns [] for no events", () => {
    expect(groupEventsByDay([])).toEqual([]);
  });
});
