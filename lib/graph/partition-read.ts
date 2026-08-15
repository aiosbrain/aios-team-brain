import "server-only";
import type { DbClient } from "@/lib/db/types";
import { armProjectsForPrincipal, readyPartitions } from "./arming";
import { resolvePositiveInt } from "@/lib/util/env";

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
    .select("id, slug, kind, graph_group_id, last_synced_at")
    .eq("team_id", args.teamId)
    .in("id", [...args.visibleProjectIds])
    .not("graph_group_id", "is", null);
  if (error) throw new Error(`partition read: project load failed: ${error.message}`);
  type Row = { id: string; slug: string; kind: string; graph_group_id: string; last_synced_at: string | Date | null };
  const projects = (data ?? []) as Row[];
  const total = args.visibleProjectIds.length;

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
    if (state.suppressed.has(p.id)) return false; // self-purge outstanding — fail closed
    if (p.kind !== "initiative") return true; // built-ins: always ready
    return state.ready.has(p.id);
  });

  // General FIRST and always (spec), then recency prior. Deterministic tiebreak by group id.
  const ts = (v: string | Date | null): number => (v ? new Date(v).getTime() : 0);
  const general = eligible.filter((p) => p.kind === "system" && p.slug === "general");
  const rest = eligible
    .filter((p) => !(p.kind === "system" && p.slug === "general"))
    .sort((a, b) => ts(b.last_synced_at) - ts(a.last_synced_at) || a.graph_group_id.localeCompare(b.graph_group_id));
  const picked = [...general, ...rest].slice(0, Math.max(1, k));

  return { groups: picked.map((p) => p.graph_group_id), covered: picked.length, total };
}
