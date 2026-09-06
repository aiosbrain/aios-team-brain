import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * STGENV-3 / D3e — "does this team have a fan-out surface?"
 *
 * WHY A REFUSAL AND NOT A GATE. A `work_at` window that HOLDS a fan-out push wedges the partition it
 * belongs to: the armed-but-held row stays an unlanded obligation, `readyPartitions` never latches
 * (`lib/graph/arming.ts:137,153`), and readers exclude the whole initiative
 * (`lib/graph/partition-read.ts:116`) — including for items that DID land. Reconcile deliberately
 * preserves the never-pushed sentinel (`lib/graph/reconcile.ts:642`), so nothing self-heals. Rather
 * than specify that interaction against a population of zero, the run refuses and says so.
 *
 * MEASURED on prod 2026-09-06 (staging is a byte copy): 0 initiatives, 0 initiative graph groups,
 * 0 deferred rows, 0 armed fan-out rows — all 3,049 ledger rows are home rows across 2 group_ids. So
 * this never fires today. The day someone creates an initiative it fires loudly, which is the moment
 * to specify the interaction with a real population to measure.
 *
 * THE PREDICATE IS IN STORED TERMS, WITH NO NOTION OF "HOME", and that is deliberate. An earlier draft
 * asked for "any ledger row that is not a home row", which over-approximates and would refuse forever
 * on three benign states that are not spend surfaces: a PCCC-6 orphan in a deleted initiative's group,
 * the PCCC-5 rename residual (a home row under an old slug's legacy id, `project.ts:826-833`), and any
 * team whose built-ins are unpointed, where "home" would have to mean the fallback id or every row
 * reads as non-home.
 *
 *   (a) a `projects` row with `kind = 'initiative'` AND `graph_group_id IS NOT NULL`, or
 *   (b) any `graph_episodes` row for the team with `deferred = true`.
 *
 * `resolveFanoutTargets` emits targets only from `initiativeGroupByProject`, so ¬(a) ⇒ no targets ⇒ no
 * deferred inserts; and `fanoutRows` is `r.deferred || initiativeGroups.has(r.group_id)`, so
 * ¬(a) ∧ ¬(b) ⇒ `fanoutRows` is empty ⇒ the push loop never iterates. `runFanout` is then a provable
 * no-op — a state check, not a reachability argument.
 *
 * WHY (b) IS NOT REDUNDANT. For preventing EXTRACTION, (a) alone suffices: the push loop does
 * `if (r.deferred) continue`, and an armed row needs a recognised initiative group. (b) is what makes
 * `runFanout` write NOTHING: without it, an orphan deferred row (its initiative deleted) enters the
 * untag cleanup branch and issues a DELETE. "No extraction" and "no writes" are different guarantees,
 * and this claims the second.
 */
export type FanoutSurface = { ok: true; present: boolean } | { ok: false; error: string };

export async function detectFanoutSurface(db: DbClient, teamId: string): Promise<FanoutSurface> {
  try {
    const initiatives = await db
      .from("projects")
      .select("id")
      .eq("team_id", teamId)
      .eq("kind", "initiative")
      .not("graph_group_id", "is", null)
      .limit(1);
    if (initiatives.error) throw new Error(initiatives.error.message);
    if ((initiatives.data ?? []).length > 0) return { ok: true, present: true };

    const deferred = await db
      .from("graph_episodes")
      .select("source_id")
      .eq("team_id", teamId)
      .eq("deferred", true)
      .limit(1);
    if (deferred.error) throw new Error(deferred.error.message);
    return { ok: true, present: (deferred.data ?? []).length > 0 };
  } catch (e) {
    // FAIL CLOSED. An unsuccessful read cannot mean "no fan-out" — that would convert a database blip
    // into the extraction this exists to prevent.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
