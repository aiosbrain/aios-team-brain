import { describe, expect, it } from "vitest";
import { timelineExpansionReducer, type TimelineExpansionState } from "@/components/dashboard/timeline-expansion-state";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";

const day = (date: string, label: string): TimelineDay => ({ date, label, people: [] });
const initial: TimelineExpansionState = {
  days: [day("2026-09-19", "Old evidence")],
  windowDays: 7,
  loading: false,
  failed: false,
  activeRequestId: null,
};

describe("timeline window expansion state", () => {
  it("keeps visible days while loading and replaces the whole snapshot, including a corrected same-date day", () => {
    const loading = timelineExpansionReducer(initial, { type: "start", requestId: 1 });
    expect(loading.days).toBe(initial.days);
    expect(loading.windowDays).toBe(7);
    const fresh = [day("2026-09-19", "Corrected evidence"), day("2026-09-12", "Older work")];
    const expanded = timelineExpansionReducer(loading, {
      type: "success", requestId: 1, days: fresh, windowDays: 14,
    });
    expect(expanded.days).toEqual(fresh);
    expect(expanded.days.map((entry) => entry.date)).toEqual(["2026-09-19", "2026-09-12"]);
    expect(expanded.days[0].label).toBe("Corrected evidence");
    expect(expanded.windowDays).toBe(14);
    expect(expanded.loading).toBe(false);
  });

  it("keeps the old snapshot on failure and ignores late results from another request", () => {
    const loading = timelineExpansionReducer(initial, { type: "start", requestId: 2 });
    const stale = timelineExpansionReducer(loading, {
      type: "success", requestId: 1, days: [], windowDays: 14,
    });
    expect(stale).toBe(loading);
    const failed = timelineExpansionReducer(stale, { type: "failure", requestId: 2 });
    expect(failed.days).toBe(initial.days);
    expect(failed.windowDays).toBe(7);
    expect(failed.failed).toBe(true);
    expect(failed.loading).toBe(false);
    expect(timelineExpansionReducer(failed, {
      type: "success", requestId: 2, days: [], windowDays: 14,
    })).toBe(failed);
  });

  it("can expand an empty initial window", () => {
    const empty = { ...initial, days: [] };
    const loading = timelineExpansionReducer(empty, { type: "start", requestId: 3 });
    const expanded = timelineExpansionReducer(loading, {
      type: "success", requestId: 3, days: [day("2026-09-10", "Older work")], windowDays: 14,
    });
    expect(expanded.days).toHaveLength(1);
    expect(expanded.windowDays).toBe(14);
  });
});
