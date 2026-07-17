import { describe, it, expect } from "vitest";
import { staleThresholdMs } from "@/lib/ingest/pipeline-health";

/**
 * Regression for the false-positive that fired the loud "1 ingestion leg is broken" banner on a
 * HEALTHY job: `auth_cleanup` runs every 24h, but the blanket 3h staleness threshold flagged it as
 * broken ~21h/day. A leg's staleness must be judged against ITS OWN cadence.
 */
describe("staleThresholdMs — per-source staleness cadence", () => {
  const H = 60 * 60 * 1000;

  it("auth_cleanup (24h job) is NOT stale at 3h — its threshold is well past 24h", () => {
    const t = staleThresholdMs("auth_cleanup");
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(24 * H); // must clear a normal 24h cycle
    // Concretely: a run 7h ago (what fired the banner) is NOT stale.
    expect(7 * H > t!).toBe(false);
  });

  it("frequent pollers use the 3h default and DO go stale when quiet", () => {
    for (const s of ["slack", "linear", "github", "dense", "graph_project", "meeting_notes"]) {
      expect(staleThresholdMs(s)).toBe(3 * H);
    }
  });

  it("unscheduled/reactive/event-driven legs are never age-stale (real failures still show via ok=false)", () => {
    for (const s of ["llm", "scan", "pm_sync"]) {
      expect(staleThresholdMs(s)).toBeNull();
    }
  });
});
