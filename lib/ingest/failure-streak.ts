/**
 * CONFIRMED vs UNCONFIRMED failure — the pure half of BANNERFLAP-1 / AIO-866.
 *
 * THE BUG. Every alarm surface in this repo used to read exactly ONE `ingest_runs` row per source and
 * treat it as the leg's verdict. On 2026-08-11 a single arc-synthesis failure at 19:48Z painted
 * "2 ingestion legs are broken — the brain isn't getting fresh data" across Pulse and Admin; the very
 * next run, at 01:36Z, succeeded. Nothing was down in between, and the banner was already stale when
 * it was read. One event, two legs (`arcs` and `llm` both record on the same failure), ~5h48m red.
 *
 * WHY A STREAK OF TWO, MEASURED RATHER THAN CHOSEN (60d of prod, read 2026-08-12):
 *
 *   leg             failures   healed on the NEXT run   median gap
 *   arcs                   3            3 of 3              5.80h
 *   llm                   10            6 of 10             3.65h
 *   github                20           18 of 20             0.53h
 *   dense                 47            2 of 47             0.50h
 *   graph_project         25            6 of 25             0.46h
 *
 * Transient-and-healing dominates on exactly the legs that flapped the banner. And the confirmation
 * latency a two-failure rule actually delivers, measured the same way: ~0.5h on the high-cadence legs,
 * 2.64h median on `llm`. So a streak of two is quiet on blips and loud on outages within one cadence.
 *
 * WHY THERE IS NO TIME-BASED ESCALATION — the first design had one and it was wrong twice:
 *   • It did not fix the incident. A 2h grace turns the 19:48Z failure red at 21:48Z and holds it red
 *     until 01:36Z — 3h48m of the exact banner this exists to remove.
 *   • No safe value exists. The healing gap on `arcs`/`llm` reaches ~20h, so a grace that stops the
 *     flap has to exceed that, at which point it announces nothing.
 * And it is largely redundant: for a leg with a non-null `staleThresholdMs` AND a scheduler heartbeat,
 * `stale` already fires when a failure is never superseded. See `docs/design/
 * pipeline-banner-failure-confirmation.md` §3a for the one case where it does not, which is accepted
 * and pinned by its own test rather than patched.
 *
 * Pure and exported so every branch — including the refusals — is testable without Postgres.
 */

/** How many consecutive failures make a failure loud. Not a tunable: see the measurement above. */
export const FAILURES_TO_CONFIRM = 2;

export type FailureClass = "ok" | "unconfirmed" | "confirmed";

/**
 * One source's current run state, as the streak query returns it.
 *
 * `streakLength` counts the CURRENT unbroken run of failures ending at the newest row — `0` when the
 * newest row succeeded. `failingSince` is the OLDEST run in that streak, which is why it cannot be
 * derived from a fixed two-row window: the graph projector 422'ing for weeks is ~144 rows at a 30m
 * cadence, and a two-row read would report "failing for 30 minutes" about a three-day outage — the
 * same lying-duration defect this field exists to fix, inverted.
 */
export interface RunStreak {
  ok: boolean;
  streakLength: number;
  /** ISO instant of the oldest failure in the current streak; null when the newest run succeeded. */
  failingSince: string | null;
}

/**
 * Is this leg's failure standing evidence, or a sample of size one?
 *
 * A streak of exactly 1 is `unconfirmed` — real, recorded, shown quietly, never in the loud banner.
 * That INCLUDES a leg whose first-ever run failed: there is no earlier run to corroborate it, and the
 * classification table has to say so rather than leaving a builder to pick between "default confirmed"
 * (re-manufactures the flap for every new leg's first hiccup) and "default ok" (a silent gap).
 */
export function classifyFailure(streak: RunStreak): FailureClass {
  if (streak.ok) return "ok";
  return streak.streakLength >= FAILURES_TO_CONFIRM ? "confirmed" : "unconfirmed";
}

/** One raw run row, newest-first within its partition. */
export interface StreakRow {
  ok: boolean;
  finishedAt: string;
}

/**
 * Fold newest-first rows for ONE partition into its streak summary.
 *
 * Exported and pure because the SQL that feeds it is the part that cannot be unit-tested, and this is
 * the part that decides the verdict. Callers MUST pass rows for a single `(source, team_id)`
 * partition, newest first — see `pipeline-health` for why the partition is not just `source`:
 * `access_bootstrap` writes a per-team failure row for each team that failed, plus an unconditional
 * instance-wide heartbeat row every tick (`lib/ingest/scheduler.ts`), so a source-level streak is
 * broken by global heartbeats that say nothing about that team. (Only the heartbeat is every-tick —
 * an earlier draft of this comment said both were, which the repo's own grep-before-claiming rule
 * exists to catch.)
 *
 * An empty input is `ok` with no streak: "nothing has ever run" is not a failure, and the surfaces
 * that care about never-ran already say so through other signals.
 */
export function foldStreak(rowsNewestFirst: readonly StreakRow[]): RunStreak {
  const newest = rowsNewestFirst[0];
  if (!newest || newest.ok) return { ok: true, streakLength: 0, failingSince: null };
  let streakLength = 0;
  let failingSince = newest.finishedAt;
  for (const row of rowsNewestFirst) {
    if (row.ok) break;
    streakLength += 1;
    // Rows arrive newest-first, so the LAST failure we walk is the oldest one in the streak.
    failingSince = row.finishedAt;
  }
  return { ok: false, streakLength, failingSince };
}
