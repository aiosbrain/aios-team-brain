import "server-only";
import type { DbClient } from "@/lib/db/types";
import { armProjectsForPrincipal, readyPartitions } from "./arming";
import { resolvePositiveInt } from "@/lib/util/env";
import { runSql } from "@/lib/db/pg/pool";

/**
 * The enforced team-tier graph READ set (PCCC-6, design §2.3 + spec's expansion budget): which
 * partitions a principal's graph legs may search, and what to disclose about the cap.
 *
 * - ARMS the principal's visible initiatives as a side effect (first query arms-and-omits).
 * - Built-ins (General/external-shared) are always ready — their partitions ARE the legacy graphs.
 * - Initiatives participate only once their read-ready latch is set (lib/graph/arming).
 * - SUPPRESSION (self-purge only): a partition with rows owing a purge of THEIR OWN group —
 *   restriction-moves, redaction, fan-out untag — is omitted until reconcile confirms; narrowing
 *   fails closed. CROSS-purges (a tier-flip row pointing at its OLD group) deliberately do NOT
 *   suppress: the lingering old-tier episodes are content a team-tier reader may see anyway
 *   (canSeeAccess spans both tiers), and suppressing General for routine tier-flip hygiene would
 *   blank the leg constantly. This discriminator is the load-bearing design decision here.
 * - K-CAP (spec ~592-606): the graph stage covers General + the top-(K-1) other eligible
 *   partitions by recency prior (projects.last_synced_at — the router's correctness never matters:
 *   FTS/dense stay complete, beyond-cap partitions lose only graph-flavored recall). K default 8,
 *   configuration not constant. The cap is DISCLOSED (covered/total) — the spec's deliberate
 *   own-scope exception to §5.7.
 */
export const GRAPH_EXPANSION_K = resolvePositiveInt(process.env.GRAPH_EXPANSION_K, 8);

export interface EnforcedGraphScope {
  groups: string[];
  /** Eligible partitions actually searched vs the principal's total visible project count —
   *  the disclosure pair ("graph expansion covered N of M projects"). */
  covered: number;
  total: number;
}

export async function selectEnforcedGraphPartitions(
  db: DbClient,
  args: { teamId: string; visibleProjectIds: readonly string[]; k?: number; arm?: boolean }
): Promise<EnforcedGraphScope> {
  const k = args.k ?? GRAPH_EXPANSION_K;
  if (args.visibleProjectIds.length === 0) return { groups: [], covered: 0, total: 0 };

  const { data, error } = await db
    .from("projects")
    .select("id, slug, kind, graph_group_id")
    .eq("team_id", args.teamId)
    .in("id", [...args.visibleProjectIds])
    .not("graph_group_id", "is", null)
    // ONLY the two system built-ins and initiatives have graph partitions with content behind
    // them (review High 4a): a SOURCE project's minted partition is empty BY CONSTRUCTION —
    // fan-out targets initiatives, source items home to the tier groups — so admitting them as
    // "always ready" would fill the K-cap with empty partitions and evict the ready initiatives
    // holding restriction-moved content.
    .in("kind", ["system", "initiative"]);
  if (error) throw new Error(`partition read: project load failed: ${error.message}`);
  type Row = { id: string; slug: string; kind: string; graph_group_id: string };
  const projects = (data ?? []) as Row[];
  // The disclosure denominator counts only COVERABLE projects — a source project can never be
  // covered, and counting it would systematically understate coverage (review Low 12).
  const total = projects.length;

  const initiatives = projects.filter((p) => p.kind === "initiative");
  // arm defaults ON (an enforcing principal read IS the arming trigger); the permissive union path
  // passes arm:false — no reader-signal there, and cold initiatives must never extract for it.
  if (args.arm !== false) {
    await armProjectsForPrincipal(db, { teamId: args.teamId, projectIds: initiatives.map((p) => p.id) });
  }
  const state = await readyPartitions(db, {
    teamId: args.teamId,
    projects: projects.map((p) => ({ id: p.id, group: p.graph_group_id })),
  });

  const eligible = projects.filter((p) => {
    // Suppression applies to INITIATIVE partitions only (review-2 High 4): a self-purge in a
    // built-in is ROUTINE — every redaction, item deletion, and restriction move-out flags a
    // General row for >= the cleanup grace (an hour-scale floor) — so suppressing built-ins
    // blanked the whole enforced leg's primary partition near-constantly. The narrowing that
    // suppression exists for (untag) lives in initiative partitions; General's residual is the
    // BOUNDED restriction-purge window (<= ~2 reconcile cycles, shortened by arm-on-restrict),
    // named in the design as an accepted residual with restrictionMovesPending as its measure.
    if (p.kind !== "initiative") return true; // built-ins: always eligible
    if (state.suppressed.has(p.id)) return false; // self-purge outstanding — fail closed
    return state.ready.has(p.id);
  });

  // General FIRST and always (spec), then the recency prior — from the PARTITION's own latest
  // real push (max projected_at over sha<>'' ledger rows), because projects.last_synced_at is
  // written only by the INGEST upsert and is perpetually null for initiatives — ranking on it
  // made the router inert for exactly the population it exists to rank (review High 4b).
  // Deterministic tiebreak by group id.
  const recency = new Map<string, number>();
  if (eligible.length > 0) {
    const rec = await runSql<{ group_id: string; mx: string | null }>(
      `select group_id, max(projected_at) filter (where content_sha256 <> '') as mx
         from graph_episodes where team_id = $1 and group_id = any($2) group by group_id`,
      [args.teamId, eligible.map((p) => p.graph_group_id)]
    );
    for (const r of rec.rows) recency.set(r.group_id, r.mx ? new Date(r.mx).getTime() : 0);
  }
  const general = eligible.filter((p) => p.kind === "system" && p.slug === "general");
  const rest = eligible
    .filter((p) => !(p.kind === "system" && p.slug === "general"))
    .sort(
      (a, b) =>
        (recency.get(b.graph_group_id) ?? 0) - (recency.get(a.graph_group_id) ?? 0) ||
        a.graph_group_id.localeCompare(b.graph_group_id)
    );
  const picked = [...general, ...rest].slice(0, Math.max(1, k));

  return { groups: picked.map((p) => p.graph_group_id), covered: picked.length, total };
}
