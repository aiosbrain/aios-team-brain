import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { SMALL_ELIGIBLE_KINDS } from "./graph-call-kind";

/**
 * IS THE SMALL MODEL ACTUALLY SERVING ANYTHING? — the evidence half of AIO-983.
 *
 * `describeSmallExtraction` answers "is it configured and does its backend resolve", which is what
 * the admin surface reported. That is not the same question as "is it working", and the gap between
 * them was invisible: with a configured small model whose backend resolved, the panel read
 * `enabled: true, inert: false` while ZERO calls were routed to it, because the graph service and
 * the brain disagreed about which model name marks a cheap call. Nothing errored, no indicator
 * moved, and the only symptom was a bill. A lever with no evidence of firing has to say so.
 *
 * WHY THIS READS THE LEDGER RATHER THAN THE CONFIG. Every proxied graph call is metered into
 * `llm_usage` with its `call_kind` and the model that actually SERVED it, so the ledger is the one
 * place that records what happened rather than what was intended. It therefore catches every cause
 * of non-routing, including the ones the sentinel does not fix — a reworded upstream prompt that
 * classifies `unknown`, a `SMALL_ELIGIBLE_KINDS` table that has drifted from the deployed image, a
 * proxy that isn't in the path at all.
 *
 * IT MUST NOT ACCUSE WITHOUT STANDING EVIDENCE. That rule is the repo's, learned twice already
 * (AIO-876: a probe that conflated novelty with liveness cried wolf on a healthy extractor;
 * AIO-912: an age gate, so a fresh install's quiet start is not read as failure). So the return is
 * DISCRIMINATED and carries an explicit can't-tell:
 *
 *   • `no_traffic`     — no eligible calls at all. Says nothing; a quiet team is not a broken one.
 *   • `inconclusive`   — some eligible calls, but too few to distinguish "not routing" from the
 *                        window right after someone enabled the setting, when the recent rows are
 *                        legitimately pre-enable history. Bounded by VOLUME, not time, so it clears
 *                        as soon as real traffic arrives rather than after a fixed wait.
 *   • `not_routing`    — enough eligible calls, and NONE served by the small model. This is the
 *                        drift, and it is the only state that accuses.
 *   • `routing`        — working, with the count as the evidence.
 *
 * Scoped to ONE team: `extraction_small_model` is per-team config, so another team's traffic must
 * never be evidence about this team's setting.
 */

/** How many recent eligible calls to judge on, and the floor below which we refuse to conclude. */
const SAMPLE = 50;
const MIN_TO_JUDGE = 10;

export type SmallRoutingEvidence =
  | { state: "no_traffic" }
  | { state: "inconclusive"; eligible: number }
  | { state: "not_routing"; eligible: number }
  | { state: "routing"; servedSmall: number; eligible: number };

export async function smallRoutingEvidence(
  teamId: string,
  smallModel: string,
  opts: { sample?: number; minToJudge?: number } = {}
): Promise<SmallRoutingEvidence> {
  const sample = opts.sample ?? SAMPLE;
  const minToJudge = opts.minToJudge ?? MIN_TO_JUDGE;
  if (!smallModel.trim()) return { state: "no_traffic" };

  // The most recent eligible calls, newest first. A VOLUME window rather than a time window: right
  // after the setting is enabled the recent rows are pre-enable history and would read as
  // "not routing", and a volume window ages that out as soon as the traffic it is judging exists.
  // `call_kind` is three-valued — '' is pre-metering history and 'unknown' is prompt drift — and
  // `= any(...)` counts neither, which is the required behaviour: no read may coalesce them.
  // COUNTED IN SQL, not by fetching rows and counting here. `llm_usage` is the money ledger and the
  // repo guards it (test/guards/llm-usage-exact-aggregate.test.ts) after two surfaces silently
  // summed capped subsets and reported three different totals for one window. This read is a
  // SAMPLE and not a spend figure, so that specific bug cannot occur here — but the guard is
  // deliberately scoped to the whole table rather than to money columns, and aggregating is the
  // better implementation anyway: two integers over the wire instead of fifty rows.
  const res = await runSql<{ eligible: number; served_small: number }>(
    `select count(*)::int as eligible,
            count(*) filter (where model = $3)::int as served_small
       from (select model from llm_usage
              where team_id = $1 and source = 'graph' and call_kind = any($2)
              order by created_at desc
              limit $4) recent`,
    [teamId, [...SMALL_ELIGIBLE_KINDS], smallModel, sample]
  );

  const eligible = res.rows[0]?.eligible ?? 0;
  if (eligible === 0) return { state: "no_traffic" };

  const servedSmall = res.rows[0]?.served_small ?? 0;
  if (servedSmall > 0) return { state: "routing", servedSmall, eligible };
  // Zero served small. Only an accusation once there is enough to be one.
  return eligible >= minToJudge ? { state: "not_routing", eligible } : { state: "inconclusive", eligible };
}
