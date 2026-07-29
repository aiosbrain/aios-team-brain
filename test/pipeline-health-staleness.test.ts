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
    // slack/plane/linear/github record every configured tick (scheduler.runImport "still record
    // configured sources"); meeting_notes records unconditionally per team every tick (scheduler.ts:222).
    // Last-run age == last-poll age → age-based staleness is meaningful (a wedged scheduler flags in 3h).
    for (const s of ["slack", "plane", "linear", "github", "meeting_notes"]) {
      expect(staleThresholdMs(s)).toBe(3 * H);
    }
  });

  it("record-only-when-active legs are never age-stale (age ≠ poll age; failures show via ok=false + probes)", () => {
    for (const s of ["dense", "linear_inbound", "graph_project"]) {
      expect(staleThresholdMs(s)).toBeNull();
    }
  });

  it("unscheduled/reactive/event-driven legs are never age-stale (real failures still show via ok=false)", () => {
    for (const s of ["llm", "scan", "pm_sync"]) {
      expect(staleThresholdMs(s)).toBeNull();
    }
  });

  it("doc_task_infer is never age-stale — five of its outcomes write no row at all", () => {
    // Observed in prod: the banner said "1 ingestion leg is broken — the brain isn't getting fresh
    // data · doc_task_infer, last successful run 10h ago". The leg had never failed. Its four runs sat
    // on a 12.2h / 12.4h / 12.1h cadence — because `COOLDOWN_MS` defaults to 12h — so a 3h threshold
    // marked a perfectly healthy job broken for 9 of every 12 hours.
    //
    // It is NOT that the leg might go untriggered: the scheduler polls it every tick for every team.
    // It is that `cooldown`, `no-llm`, `no-candidates`, `nothing-to-score` and `unchanged` all return
    // BEFORE `record()` — so on a quiet corpus a healthy leg polled every 30 minutes still writes
    // nothing for days. Its newest row's age is therefore unbounded at ANY threshold, which is why the
    // answer is `null` rather than "12h + grace". Same criterion that nulls dense/linear_inbound/
    // graph_project, just more decisive here.
    //
    // Real failures still surface: the model-null and thrown-error paths DO record, with `ok=false`.
    expect(staleThresholdMs("doc_task_infer")).toBeNull();
  });

  it("the default is only applied to legs that actually record every poll", () => {
    // Guards the SHAPE of the mistake rather than one more instance of it. Every source that keeps the
    // 3h default must be one whose last-row age equals its last-POLL age; anything else has to be
    // listed explicitly. A new leg added without a threshold silently inherits 3h — which is how both
    // auth_cleanup and doc_task_infer became false alarms.
    const RECORDS_EVERY_POLL = new Set(["slack", "plane", "linear", "github", "meeting_notes"]);
    for (const s of RECORDS_EVERY_POLL) expect(staleThresholdMs(s)).toBe(3 * H);
    // …and every leg observed in prod's `ingest_runs` is accounted for — either listed with its own
    // threshold, or a record-every-poll poller. (`graph_extract` is deliberately absent: nothing writes
    // it to `ingest_runs`. It is the SYNTHETIC leg `getPipelineHealth` appends with `stale: false`
    // hardcoded, so it never reaches `staleThresholdMs`. If that ever starts recording real rows it
    // must be added here, or it silently inherits the 3h default.)
    const PROD_SOURCES = [
      "slack", "linear", "linear_inbound", "github", "meeting_notes", "graph_project",
      "dense", "doc_task_infer", "auth_cleanup", "llm", "pm_sync", "scan",
    ];
    const unlisted = PROD_SOURCES.filter((s) => staleThresholdMs(s) === 3 * H && !RECORDS_EVERY_POLL.has(s));
    expect(
      unlisted,
      `these legs silently inherited the 3h default — give each its own cadence or null:\n${unlisted.join("\n")}`
    ).toEqual([]);
  });
});
