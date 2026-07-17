import { describe, it, expect } from "vitest";
import { staleThresholdMs } from "@/lib/ingest/pipeline-health";

/**
 * Regression for the false-positive that fired the loud "N ingestion legs are broken" banner on
 * HEALTHY jobs. Two flavors:
 *   1. `auth_cleanup` runs every 24h, but the blanket 3h threshold flagged it ~21h/day — fixed with a
 *      per-cadence threshold.
 *   2. `dense` / `linear_inbound` / `graph_project` / `meeting_notes` record an `ingest_runs` row
 *      ONLY when a tick did work — a quiet pass writes nothing, so the newest row's age reflects
 *      "last time there was work", not "last poll". An age-based staleness check there cries wolf on
 *      any normal quiet window. They must be `null` (never age-stale); real failures still surface via
 *      `ok=false` on their actual runs (+ the dense retrieval-health card / graph_extract probe).
 * A leg's staleness must be judged against ITS OWN cadence — or not at all when age ≠ poll age.
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

  it("record-every-poll pollers use the 3h default and DO go stale when quiet", () => {
    // slack/plane/linear/github record a run every configured tick (scheduler.runImport "still record
    // configured sources"), so last-run age == last-poll age → age-based staleness is meaningful.
    for (const s of ["slack", "plane", "linear", "github"]) {
      expect(staleThresholdMs(s)).toBe(3 * H);
    }
  });

  it("record-only-when-active legs are never age-stale (age ≠ poll age; failures show via ok=false + probes)", () => {
    for (const s of ["dense", "linear_inbound", "graph_project", "meeting_notes"]) {
      expect(staleThresholdMs(s)).toBeNull();
    }
  });

  it("unscheduled/reactive/event-driven legs are never age-stale (real failures still show via ok=false)", () => {
    for (const s of ["llm", "scan", "pm_sync"]) {
      expect(staleThresholdMs(s)).toBeNull();
    }
  });
});
