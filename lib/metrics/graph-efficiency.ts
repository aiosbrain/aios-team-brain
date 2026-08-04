import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { QueryLogViewer } from "@/lib/auth/visibility";
import { getGraphUsageDaily, type GraphUsageDay } from "./llm-spend";
import { rangeDays, type Range } from "./range";

/**
 * GRAPH EFFICIENCY — calls per episode, the metric that catches a bad extraction model.
 *
 * WHY THIS EXISTS. Cost per CALL is the number a model's price list gives you, and it is the wrong
 * one. On 2026-07-30 the extraction model was switched to a model 10x cheaper per call; over the next
 * three days calls per episode climbed 18.9 → 28.1 → 39.8 → 49.4 and cost per episode went with it,
 * $0.027 → $0.055 and still rising. The per-call saving was real and irrelevant: the model was making
 * enough extra calls to eat it, and the trend was compounding rather than flat.
 *
 * The mechanism is the one the design doc warned about and nobody measured: entity extraction that
 * dedupes poorly creates duplicate nodes, each new episode is then resolved against a larger node set,
 * and the work per episode grows with the graph. A flat overhead would be a tax; a rising one is a
 * leak, and only the RATIO shows the difference. Total spend hides it completely — spend fell over the
 * same period, because episode volume fell faster than the ratio rose.
 *
 * THE DENOMINATOR IS `ingest_runs.meta.episodes`, and getting there took three wrong answers:
 *
 *   1. `graph_episodes` row count — WRONG on two axes. A row is one ITEM, not one episode
 *      (`lib/graph/project` chunks an item into up to `MAX_EPISODE_CHUNKS`), and `projected_at` is
 *      LAST-TOUCHED, so the projector bumps it on re-touch and a ratio built on it changes
 *      retroactively: the same window measured twice gives different answers.
 *   2. `ingest_runs.created` — append-only, which fixes the drift, but it is `summary.projected`,
 *      which increments once per ITEM (`project.ts`, and the admin action says "Projected N item(s)").
 *      Same wrong unit, better provenance. Shipped in review as if it were episodes; it is not.
 *   3. `ingest_runs.meta.episodes` — what this uses. `summary.episodes` accumulates `episodes.length`
 *      per item, so it is the count actually pushed to Graphiti, and it lives in an append-only row.
 *
 * Why the unit matters rather than being pedantry: a ratio over ITEMS moves with the corpus's chunk
 * mix, so a week of long transcripts raises it with a perfectly healthy model — and a shift to short
 * Slack threads lowers it while a real regression is underway. The metric would report content, not
 * extraction.
 *
 * CONSEQUENCE: runs recorded before this shipped carry no `meta.episodes`, so their denominator is
 * UNKNOWN and those days are excluded rather than back-filled with the item count. A shorter honest
 * history beats a longer one in mixed units.
 */

/**
 * Graphiti's canonical work per episode is four LLM calls — extract nodes, dedupe nodes, extract
 * edges, dedupe edges — plus per-node summaries on dense episodes. Eight is that with headroom.
 * It is a ceiling for "obviously fine", not a measured mean: the flag also requires RISING, so this
 * constant only decides when a rise is worth mentioning.
 */
export const HEALTHY_CALLS_PER_EPISODE = 8;

/** A rise smaller than this is noise, not a trend. */
const RISING_MARGIN = 1.25;
/** Row cap on the `ingest_runs` denominator fetch; exceeded → `truncated`, price consumers withhold. */
const RUN_FETCH_CAP = 20_000;
/** Below this many measured days, "first half vs second half" is one day against one day. */
const MIN_DAYS_FOR_TREND = 3;

export interface GraphEfficiencyDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  episodes: number;
  calls: number;
  costUsd: number;
  /** null when no episodes were pushed that day — a ratio over zero is not "0", it is unknown. */
  callsPerEpisode: number | null;
  costPerEpisode: number | null;
}

export interface GraphEfficiency {
  days: GraphEfficiencyDay[];
  /** Whole-window ratio, or null when the window pushed no episodes. */
  callsPerEpisode: number | null;
  costPerEpisode: number | null;
  /**
   * True when the ratio is above healthy AND rising by more than a noise margin across at least
   * `MIN_DAYS_FOR_TREND` measured days. Rising is the signal: a constant overhead is a property of the
   * model, a climbing one means work per episode grows with the graph and compounds. Without the
   * margin this reduced to `second > first` by any epsilon — which fires on half of all page loads for
   * a stable model, the exact nagging the "requires rising" rule was supposed to prevent.
   */
  degrading: boolean;
  /**
   * True when the `ingest_runs` fetch hit its row cap, so the EPISODE DENOMINATOR is incomplete and
   * `costPerEpisode` is an OVERSTATEMENT — while `callsPerEpisode` per missing-run day reads low.
   * Set deliberately rather than silently truncating (the cap binds first in exactly the degraded
   * regime): consumers that gate money on this number (the repo-import estimator, AIO-798) withhold
   * the price instead of showing a wrong one.
   */
  truncated: boolean;
}

interface DayBucket {
  episodes: number;
  calls: number;
  costUsd: number;
}

const utcDay = (v: string | Date): string =>
  (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10);

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/**
 * Fold exact daily usage aggregates and raw projector runs into per-day buckets. Pure, so the
 * arithmetic — especially the divide-by-zero and the "rising" comparison — is testable without a
 * database.
 */
export function foldGraphEfficiency(
  usageDays: GraphUsageDay[],
  /** `meta.episodes` is the denominator; a run without it predates the counter and is SKIPPED. */
  runRows: { started_at: string | Date; meta: unknown }[],
  truncated = false
): GraphEfficiency {
  const buckets = new Map<string, DayBucket>();
  const at = (day: string): DayBucket => {
    const cur = buckets.get(day) ?? { episodes: 0, calls: 0, costUsd: 0 };
    buckets.set(day, cur);
    return cur;
  };
  for (const r of usageDays) {
    const b = at(r.day);
    b.calls += r.calls;
    b.costUsd += r.costUsd;
  }
  for (const r of runRows) {
    const n = (r.meta as { episodes?: unknown } | null)?.episodes;
    // Skip, don't zero: a run with no episode count is an UNKNOWN denominator, and adding 0 would
    // silently inflate that day's ratio by counting its calls against the other runs' episodes.
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    at(utcDay(r.started_at)).episodes += n;
  }

  const days: GraphEfficiencyDay[] = [...buckets.entries()]
    .map(([day, b]) => ({
      day,
      episodes: b.episodes,
      calls: b.calls,
      costUsd: b.costUsd,
      callsPerEpisode: ratio(b.calls, b.episodes),
      costPerEpisode: ratio(b.costUsd, b.episodes),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const totalCalls = days.reduce((s, d) => s + d.calls, 0);
  const totalEpisodes = days.reduce((s, d) => s + d.episodes, 0);
  const totalCost = days.reduce((s, d) => s + d.costUsd, 0);

  // Compare halves over the days that actually pushed episodes — an idle day carries no ratio, and
  // letting it read as zero would fake an improvement (or, on the other side, a collapse).
  const measured = days.filter((d) => d.callsPerEpisode !== null);
  const mid = Math.floor(measured.length / 2);
  const mean = (xs: GraphEfficiencyDay[]): number | null =>
    xs.length ? xs.reduce((s, d) => s + (d.callsPerEpisode ?? 0), 0) / xs.length : null;
  const first = mean(measured.slice(0, mid));
  const second = mean(measured.slice(mid));
  const overall = ratio(totalCalls, totalEpisodes);
  const rising =
    measured.length >= MIN_DAYS_FOR_TREND &&
    first !== null &&
    second !== null &&
    first > 0 &&
    second > first * RISING_MARGIN;

  return {
    days,
    callsPerEpisode: overall,
    costPerEpisode: ratio(totalCost, totalEpisodes),
    degrading: overall !== null && overall > HEALTHY_CALLS_PER_EPISODE && rising,
    truncated,
  };
}

/** What a non-admin gets: no rows, and — critically — a NULL ratio rather than a zero. */
const EMPTY: GraphEfficiency = {
  days: [],
  callsPerEpisode: null,
  costPerEpisode: null,
  degrading: false,
  truncated: false,
};

/**
 * Graph extraction's work-per-episode over the window. ADMIN ONLY, enforced here.
 *
 * llm-usage-scope-ok: this read is admin-gated INSIDE the function rather than filtered by member, and
 * that is deliberate. Graph extraction is entirely system-initiated (`member_id` is always null), so
 * `scopeLlmUsage` for a member returns zero rows — and a ratio of "0 calls over N episodes" renders as
 * a perfectly efficient 0, which is the opposite of the truth and worse than showing nothing. The
 * viewer check therefore lives here, where it cannot be forgotten, instead of in the one caller that
 * happens to remember it today.
 */
export async function getGraphEfficiency(
  db: DbClient,
  teamId: string,
  range: Range,
  viewer: QueryLogViewer
): Promise<GraphEfficiency> {
  if (!viewer.isAdmin) return EMPTY;
  const windowStart = new Date(Date.now() - rangeDays(range) * 86_400_000).toISOString();
  const [usageDays, runsRes] = await Promise.all([
    getGraphUsageDaily(db, teamId, windowStart, viewer),
    db
      .from("ingest_runs")
      .select("started_at, meta")
      .eq("team_id", teamId)
      .eq("source", "graph_project")
      .gte("started_at", windowStart)
      // One past the cap, so hitting it is DETECTED rather than silently clipping the denominator.
      .limit(RUN_FETCH_CAP + 1),
  ]);
  const runRows = (runsRes.data ?? []) as { started_at: string | Date; meta: unknown }[];
  return foldGraphEfficiency(usageDays, runRows.slice(0, RUN_FETCH_CAP), runRows.length > RUN_FETCH_CAP);
}
