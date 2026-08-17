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
    // configured sources"); access_bootstrap writes an unconditional instance-wide heartbeat.
    // Last-run age == last-poll age → age-based staleness is meaningful (a wedged scheduler flags in 3h).
    // Their measured worst gaps are 30–96 min, comfortably inside the bar. (meeting_notes and
    // context_backfill[_all] record every tick too, but sit at the SLOW end of the tick chain — see
    // the fitted-threshold test below.)
    for (const s of ["slack", "plane", "linear", "github", "access_bootstrap"]) {
      expect(staleThresholdMs(s)).toBe(3 * H);
    }
  });

  it("the three slow-chain heartbeats are FITTED to measured cadence, not left on the 3h default", () => {
    // BANNERFLAP-2. Measured on prod over 7 days, scheduler-triggered rows only (the same filter the
    // staleness clock uses — pooling `trigger='api'` rows in was the first pass's mistake, since
    // meeting_notes also runs on every `aios push`):
    //   meeting_notes         worst gap 293 min (4.9h), p95 78 min, 4 gaps over the 3h default
    //   context_backfill      worst gap 235 min (3.9h), p95 41 min, 2 gaps over
    //   context_backfill_all  identical by construction — same invocation, milliseconds later
    // ~6 false "N ingestion legs are broken" alarms and ~5h of red per week, on legs that had not
    // failed at all. Each threshold must exceed its OWN measured worst gap, or the banner keeps
    // flapping; the literal values are pinned so a future edit has to face the measurement.
    expect(staleThresholdMs("meeting_notes")).toBe(6 * H);
    expect(staleThresholdMs("context_backfill")).toBe(5 * H);
    expect(staleThresholdMs("context_backfill_all")).toBe(5 * H);
    // The property, stated independently of the constants above: each bar clears its measured tail.
    const WORST_GAP_MIN: Record<string, number> = {
      meeting_notes: 293,
      context_backfill: 235,
      context_backfill_all: 235,
    };
    for (const [source, worstMin] of Object.entries(WORST_GAP_MIN)) {
      expect(staleThresholdMs(source)!).toBeGreaterThan(worstMin * 60 * 1000);
    }
    // …and stays an ALARM, not a formality: a dead scheduler is still caught within 6h on a leg that
    // ticks every ~30 min. Widening past a day would be the dangerous direction (going silent).
    for (const s of Object.keys(WORST_GAP_MIN)) expect(staleThresholdMs(s)!).toBeLessThan(24 * H);
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

  it("auto_flip is never age-stale — it records only when it flips, defers or errors", () => {
    // A LATENT recurrence, pinned before it can fire. `runAutoFlip` (`lib/ingest/scheduler.ts`,
    // PRET-2) returns before `recordIngestRun` on a quiet pass, so its newest-row age is "last time a
    // team flipped", not "last poll". It has zero rows today — so it is absent from the leg set
    // entirely and nothing is firing — but the first row it ever writes would age past the 3h default
    // it would otherwise inherit and pin the banner red forever. Same shape as doc_task_infer, caught
    // one line earlier this time.
    expect(staleThresholdMs("auto_flip")).toBeNull();
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
    //
    // Note this asserts the DEFAULT still reaches an unlisted leg — `slack` is the witness. It is
    // deliberately phrased as "these named legs are on the default", NOT "every unlisted leg is on the
    // default": the latter would have PINNED `auto_flip` to the 3h bar that makes it a fossil.
    const RECORDS_EVERY_POLL = new Set(["slack", "plane", "linear", "github", "access_bootstrap"]);
    for (const s of RECORDS_EVERY_POLL) expect(staleThresholdMs(s)).toBe(3 * H);
    // …and every leg observed in prod's `ingest_runs` is accounted for — either listed with its own
    // threshold, or a record-every-poll poller. (`graph_extract` is deliberately absent: nothing writes
    // it to `ingest_runs`. It is the SYNTHETIC leg `getPipelineHealth` appends with `stale: false`
    // hardcoded, so it never reaches `staleThresholdMs`. If that ever starts recording real rows it
    // must be added here, or it silently inherits the 3h default.)
    // The FULL audited leg universe: every `source` that has ever recorded an `ingest_runs` row in
    // prod, re-derived for BANNERFLAP-2 rather than carried forward. The earlier hand-picked list is
    // exactly how `context_backfill`/`context_backfill_all`/`access_bootstrap` stayed invisible to
    // this guard while one of them was flapping. `auto_flip` has no rows yet and is listed anyway —
    // the point of the guard is to catch a leg BEFORE its first row inherits the wrong bar.
    const PROD_SOURCES = [
      "access_bootstrap", "arcs", "auth_cleanup", "auto_flip", "context_backfill",
      "context_backfill_all", "dense", "doc_task_infer", "github", "graph_project", "linear",
      "linear_inbound", "llm", "meeting_notes", "plane", "pm_sync", "scan", "slack",
    ];
    const unlisted = PROD_SOURCES.filter((s) => staleThresholdMs(s) === 3 * H && !RECORDS_EVERY_POLL.has(s));
    expect(
      unlisted,
      `these legs silently inherited the 3h default — give each its own cadence or null:\n${unlisted.join("\n")}`
    ).toEqual([]);
  });
});
