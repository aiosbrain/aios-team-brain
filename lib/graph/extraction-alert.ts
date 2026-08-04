import "server-only";
import type { DbClient } from "@/lib/db/types";
import { sendOpsAlert, mailerConfigured } from "@/lib/auth/mailer";
import { dedupeSignals, deriveDedupePollution, type DedupePollution } from "@/lib/graph/extraction-health";
import { recordIngestRun } from "@/lib/ingest/runs";

/**
 * Email admins when graph extraction TRANSITIONS into/out of dedupe pollution — the delivery half of
 * the AIO-693 alarm, copying `lib/query/retrieval-alert`'s shape (the one alert path in this repo
 * that has actually reached a human).
 *
 * WHY DELIVERY IS THE FEATURE, not the detector: the 2026-07-30 incident was DETECTED on every tier
 * that existed — cost per episode rose, calls per episode rose, the Costs page would have shown both —
 * and still ran for four days, because every surface was a page render waiting for a visit. The plan
 * review's blocking finding on this design was exactly that `getGraphExtractionHealth` had no
 * scheduled caller. This module is that caller, driven from the ingest scheduler tick.
 *
 * STATE LIVES IN `ingest_runs` (`source: "graph_health"`), like the dense leg's — no new table, and
 * the Admin panel's run list doubles as the alarm's audit trail. Rows are written ONLY on a
 * transition, so a four-day incident is two rows (degraded, recovered), not 384 tick rows drowning
 * the panel.
 *
 * The debounce contract, shared with retrieval-alert: one mail on ok→polluted, one on polluted→ok,
 * silence in between. `unknown` (Neo4j unreadable, sample too small) changes NOTHING — it neither
 * fires nor clears, because an alarm that recovers during an outage teaches people to ignore the
 * recovery mail too.
 */

/** The run-ledger source this alarm records its transitions under. */
export const GRAPH_HEALTH_SOURCE = "graph_health";

export type DedupeAlertAction = "alert" | "recover" | "none";

/**
 * The edge detector, pure: prior state (was the last recorded transition a failure?) + this tick's
 * verdict → what to do. `judgeable` is false when the pollution verdict came from an unreadable or
 * too-small sample — those ticks are a no-op in BOTH directions.
 */
export function decideDedupeAlert(
  priorPolluted: boolean,
  pollution: Pick<DedupePollution, "polluted" | "recentShare" | "baselineShare">
): DedupeAlertAction {
  const judgeable = pollution.recentShare !== null && pollution.baselineShare !== null;
  if (!judgeable) return "none";
  if (pollution.polluted && !priorPolluted) return "alert";
  if (!pollution.polluted && priorPolluted) return "recover";
  return "none";
}

/** Was the most recent recorded graph-health transition a failure? (false when there are none.) */
export async function lastGraphHealthFailed(db: DbClient): Promise<boolean> {
  const { data } = await db
    .from("ingest_runs")
    .select("ok")
    .eq("source", GRAPH_HEALTH_SOURCE)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return !!data && (data as { ok: boolean }).ok === false;
}

async function activeAdminEmails(db: DbClient): Promise<string[]> {
  const { data } = await db
    .from("members")
    .select("email")
    .eq("role", "admin")
    .eq("status", "active");
  const emails = (data ?? [])
    .map((m) => (m as { email: string | null }).email)
    .filter((e): e is string => !!e && e.includes("@"));
  return [...new Set(emails.map((e) => e.toLowerCase()))];
}

const pct = (n: number | null) => (n === null ? "?" : `${Math.round(n * 100)}%`);

/**
 * One scheduler-tick evaluation: read the graph's dedupe signals, compare against the recorded prior
 * state, and on a transition record the run row + email every active admin. Best-effort throughout —
 * nothing here may fail the ingest tick. Returns the action taken, for the tick's log line.
 */
export async function runDedupePollutionCheck(db: DbClient, nowMs = Date.now()): Promise<DedupeAlertAction> {
  try {
    const startedAt = Date.now();
    const pollution = deriveDedupePollution(await dedupeSignals(nowMs));
    const priorPolluted = await lastGraphHealthFailed(db).catch(() => false);
    const action = decideDedupeAlert(priorPolluted, pollution);
    if (action === "none") return "none";

    const shares = { recentShare: pollution.recentShare, baselineShare: pollution.baselineShare };
    await recordIngestRun(db, {
      source: GRAPH_HEALTH_SOURCE,
      trigger: "scheduler",
      ok: action === "recover",
      errors: action === "alert" && pollution.reason ? [pollution.reason] : [],
      meta: shares,
      startedAt,
    });

    if (!mailerConfigured()) return action; // transition is still recorded — state must not depend on mail
    const admins = await activeAdminEmails(db);
    if (admins.length === 0) return action;
    const where = process.env.APP_URL
      ? `${process.env.APP_URL.replace(/\/$/, "")} → Admin → Integrations`
      : "Admin → Integrations";

    if (action === "alert") {
      const text =
        `The graph extraction model is producing duplicate entities: ${pct(pollution.recentShare)} of the ` +
        `last 24h of graph edges are duplicate-of records, against ${pct(pollution.baselineShare)} for this ` +
        `graph's own baseline.\n\nThat is the signature of an extraction model resolving entity identity ` +
        `badly — the same failure that silently degraded the graph for four days on 2026-07-30. It passes ` +
        `every static model check, so this rate alarm is the only thing that catches it.\n\n` +
        `Likely cause: the Extraction model (or the answering model, if no extraction model is set) was ` +
        `recently changed. Check Admin → Integrations and consider reverting the pick.\n\n` +
        `See the pipeline banner at ${where}. You'll get one more email when it recovers.`;
      for (const to of admins) await sendOpsAlert(to, "⚠️ AIOS Team Brain — graph extraction degraded", text);
    } else {
      const text =
        `Graph extraction has recovered: duplicate-entity records are back to ${pct(pollution.recentShare)} ` +
        `of recent edges (baseline ${pct(pollution.baselineShare)}). No action needed.\n\n` +
        `Note: entities created while it was degraded may remain duplicated in the graph until a cleanup ` +
        `re-projection.`;
      for (const to of admins) await sendOpsAlert(to, "✅ AIOS Team Brain — graph extraction recovered", text);
    }
    return action;
  } catch {
    return "none"; // best-effort — the ingest tick must never pay for the alarm
  }
}
