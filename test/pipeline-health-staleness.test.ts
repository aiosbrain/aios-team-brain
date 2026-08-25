import { describe, it, expect } from "vitest";
import { staleThresholdMs, NOT_PIPELINE_LEGS } from "@/lib/ingest/pipeline-health";
import { INGEST_LEG_SOURCES } from "@/lib/ingest/leg-ledger";

/**
 * Regression for the false-positive that fired the loud "N ingestion legs are broken" banner on
 * HEALTHY jobs. Three flavors:
 *   1. `auth_cleanup` runs every 24h, but the blanket 3h threshold flagged it ~21h/day — fixed with a
 *      per-cadence threshold.
 *   2. `dense` / `linear_inbound` / `graph_project` / `arcs` / `doc_task_infer` / `auto_flip` record
 *      an `ingest_runs` row ONLY when a tick did work — a quiet pass writes nothing, so the newest
 *      row's age reflects "last time there was work", not "last poll". An age-based staleness check
 *      there cries wolf on any normal quiet window. They must be `null` (never age-stale); real
 *      failures still surface via `ok=false` on their actual runs (+ the dense retrieval-health card /
 *      graph_extract probe).
 *   3. BANNERFLAP-2: `meeting_notes` / `context_backfill` / `context_backfill_all` DO record on every
 *      tick they reach, so they are age-judged — but they sit deep in the tick chain and share a
 *      measured 293-min tail, so the blanket 3h default made them flap. They are FITTED (6h), NOT
 *      nulled. `meeting_notes` was listed in flavor 2 above until this change, which was simply a
 *      false claim: `runMeetingNotesBackfill` records unconditionally per team.
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
    // configured sources").
    //
    // ⚠️ THIS COMMENT USED TO SAY "access_bootstrap writes an unconditional instance-wide heartbeat"
    // AND HAD BEEN FALSE SINCE AUDITFIX-22, which replaced that row with a per-team row plus an
    // instance-wide row only on a fleet-level failure (measured on prod: 51 instance-wide rows/day →
    // 0/day across the deploy). `access_bootstrap` still belongs on the 3h bar — its per-team row IS
    // written every tick — but what makes the bar meaningful for a team that has no row of its own is
    // AUDITFIX-24's `access_bootstrap_all`, which is the unconditional heartbeat this sentence
    // described.
    // Last-run age == last-poll age → age-based staleness is meaningful (a wedged scheduler flags in 3h).
    // Their measured worst gaps are 30–96 min, comfortably inside the bar. (meeting_notes and
    // context_backfill[_all] record every tick too, but sit at the SLOW end of the tick chain — see
    // the fitted-threshold test below.)
    for (const s of ["slack", "plane", "linear", "github", "access_bootstrap"]) {
      expect(staleThresholdMs(s)).toBe(3 * H);
    }
  });

  it("the three deep-chain legs are FITTED to measured cadence, uniformly, not left on the 3h default", () => {
    // BANNERFLAP-2. Measured on prod over 7 days, scheduler-triggered rows only (the same filter the
    // staleness clock uses — pooling `trigger='api'` rows in was the first pass's mistake, since
    // meeting_notes also runs on every `aios push`). All three share ONE tail: they go quiet together
    // to the second and resume together, because they sit in the deep half of a tick chain that was
    // being truncated. Worst gap 293 min, p95 78 min, for each of them.
    //
    // UNIFORM is load-bearing. An earlier fit gave context_backfill 5h from a measurement window taken
    // hours earlier that missed the largest gap — 7 minutes of grace over the real worst case, which
    // would have reproduced this ticket within days. One tail, one number.
    const DEEP_CHAIN = ["meeting_notes", "context_backfill", "context_backfill_all"];
    for (const s of DEEP_CHAIN) expect(staleThresholdMs(s)).toBe(6 * H);
    // The property, stated independently of the literal above: the bar clears the measured tail with
    // real margin — not the 7 minutes that made the first fit worthless.
    const WORST_GAP_MS = 293 * 60 * 1000;
    for (const s of DEEP_CHAIN) {
      expect(staleThresholdMs(s)! - WORST_GAP_MS).toBeGreaterThan(30 * 60 * 1000);
    }
    // …and stays an ALARM, not a formality. Widening past a day would be the dangerous direction
    // (going silent), which is the failure this whole file exists to prevent.
    for (const s of DEEP_CHAIN) expect(staleThresholdMs(s)!).toBeLessThan(24 * H);
  });

  it("record-only-when-active legs are never age-stale (age ≠ poll age; failures show via ok=false + probes)", () => {
    // `arcs` is here rather than only inside the audited-universe list below: that list can only catch
    // `arcs` drifting to the 3h default, not to some OTHER finite value, which would age a leg whose
    // rows appear only when a synthesis actually re-ran. Measured: `dense` and `doc_task_infer` run at
    // ~35h gaps while perfectly healthy, so no finite bar is correct for this family.
    for (const s of ["dense", "linear_inbound", "graph_project", "arcs"]) {
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

  it("pret3_sweep is never age-stale — it records ONLY on failure, so a row can never be superseded", () => {
    // The first leg added AFTER the BANNERFLAP-2 ledger guard shipped, and it arrived red: PR #584
    // merged 19 seconds before #585, so neither PR's CI saw the other and `main` went red on the
    // combination. The guard is what caught it.
    //
    // Not bookkeeping — a real latent bug. `runPret3BootSweep`'s caller records inside `if (s.error)`
    // and writes NOTHING on success, and the sweep is marker-guarded so it no-ops forever once it has
    // succeeded. On the 3h default its first error row would age past the bar and pin the banner red
    // permanently, because no success path exists that could write a newer row to clear it.
    expect(staleThresholdMs("pret3_sweep")).toBeNull();
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
    // WHAT THIS DOES *NOT* DO, because the comment used to overstate it: `INGEST_LEG_LEDGER` is a
    // literal list, so this can only catch a KNOWN leg drifting onto the wrong bar. It could not have
    // caught `auto_flip` (author diligence did), and it cannot catch the leg someone adds next month.
    // Discovering an unlisted leg is `test/guards/ingest-leg-ledger.test.ts`, which SCANS the
    // `recordIngestRun` call sites; the two are complementary and neither replaces the other.
    //
    // Note this asserts the DEFAULT still reaches an unlisted leg — `slack` is the witness. It is
    // deliberately phrased as "these named legs are on the default", NOT "every unlisted leg is on the
    // default": the latter would have PINNED `auto_flip` to the 3h bar that makes it a fossil.
    //
    // "…when configured", not unconditionally: `runImport` records a connector only when an enabled
    // integration of that type exists (prod `plane` has none and writes nothing), and it is
    // `isOrphanedConnector`, not this map, that keeps a connector-with-no-integration quiet.
    const RECORDS_EVERY_POLL = new Set([
      "slack",
      "plane",
      "linear",
      "github",
      "access_bootstrap",
      // AUDITFIX-24: written every tick whatever the pass did — success, fleet failure, or a throw —
      // which is exactly the property the 3h default requires. It is here rather than in
      // STALE_MS_BY_SOURCE because "on the default, deliberately" is what this set MEANS.
      "access_bootstrap_all",
    ]);
    for (const s of RECORDS_EVERY_POLL) expect(staleThresholdMs(s)).toBe(3 * H);
    // …and every leg the banner can age is accounted for — either listed with its own threshold, or a
    // record-every-poll poller. Two documented absences, both structural rather than oversights:
    //   `graph_extract` — SYNTHETIC. Nothing writes it to `ingest_runs`; `getPipelineHealth` appends it
    //     with `stale: false` hardcoded, so it never reaches `staleThresholdMs`. If it ever starts
    //     recording real rows it must be added here or it silently inherits the 3h default.
    //   `graph_health`  — DOES write `ingest_runs` (the extraction-alarm transition ledger), but is in
    //     `NOT_PIPELINE_LEGS`, so it is filtered out before any threshold is consulted. It is on the 3h
    //     default and would fail this guard if listed — correctly, since a ledger that writes only when
    //     an alarm flips must never be age-judged. Excluded here, enforced there.
    // The list itself is no longer hand-kept HERE — it is `INGEST_LEG_SOURCES`, which the scanning
    // guard diffs against the real `recordIngestRun` call sites. That is what makes this check reach a
    // leg nobody remembered: the earlier hand-picked list is how `context_backfill`/
    // `context_backfill_all`/`access_bootstrap` stayed invisible to it while one of them was flapping.
    // `NOT_PIPELINE_LEGS` is imported rather than re-listed, so the exclusion cannot drift from the
    // production filter it is quoting.
    const aged = INGEST_LEG_SOURCES.filter((s) => !NOT_PIPELINE_LEGS.has(s));
    expect(aged.length, "the ledger must not be empty — an empty list passes every check below").toBeGreaterThan(10);
    const unlisted = aged.filter((s) => staleThresholdMs(s) === 3 * H && !RECORDS_EVERY_POLL.has(s));
    expect(
      unlisted,
      `these legs silently inherited the 3h default — give each its own cadence or null:\n${unlisted.join("\n")}`
    ).toEqual([]);
  });
});
