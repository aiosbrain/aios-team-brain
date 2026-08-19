import "server-only";
import type { DbClient } from "@/lib/db/types";
import { armProjectsForPrincipal, readyPartitions } from "./arming";
import { resolvePositiveInt } from "@/lib/util/env";
import { latestPushByGroup } from "./extraction-health";
import { generalHoldsRestrictedContent } from "@/lib/projects/context/fanout-targets";

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
 * - RESTRICTION DEBT on General (Codex code-review Blocker 1): the landed-gated move deliberately
 *   holds General's content until the initiative copy confirms — so for the whole move window the
 *   Everyone-visible partition carries facts a non-member must not receive, and Graphiti cannot
 *   filter per fact. Enforced reads therefore fail closed on General while
 *   `generalHoldsRestrictedContent` (live row OR unconfirmed self-purge for a substrate-restricted
 *   item) is true. Substrate-discriminated, so the built-in exemption for ROUTINE hygiene below
 *   stands. The permissive union is exempt: no enforcement exists there to protect, and blanking
 *   General would go dark for the default mode.
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
  /** ENFB-3: true when General was DROPPED by the restriction-debt probe — so a zero-group
   *  resolution for a member who can see General is a LEGITIMATE fail-closed empty, never a
   *  wiring fault (the feeds' loud-arm discriminator consumes this). */
  generalSuppressed: boolean;
}

export async function selectEnforcedGraphPartitions(
  db: DbClient,
  args: { teamId: string; visibleProjectIds: readonly string[]; k?: number; arm?: boolean }
): Promise<EnforcedGraphScope> {
  const k = args.k ?? GRAPH_EXPANSION_K;
  if (args.visibleProjectIds.length === 0) return { groups: [], covered: 0, total: 0, generalSuppressed: false };

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
  const generalProject = projects.find((p) => p.kind === "system" && p.slug === "general");
  // Restriction-debt probe (header: RESTRICTION DEBT) — runs for EVERY resolution (ENFB-3
  // design blocker: it was coupled to `arm`, whose false arm was the retired permissive-union
  // discriminator with ZERO live callers post-PRET-6 — an arm:false reader would have served
  // General during a restriction move that every other enforced read suppresses). The probe is
  // READ-SIDE protection; `arm` below keeps only the arming-trigger semantic.
  const generalDebtP: Promise<boolean> =
    generalProject != null
      ? generalHoldsRestrictedContent({
          teamId: args.teamId,
          generalProjectId: generalProject.id,
          generalGroupId: generalProject.graph_group_id,
        })
      : Promise.resolve(false);

  // arm defaults ON (an enforcing principal read IS the arming trigger). arm:false = a read
  // that must not be an arming heartbeat (ENFB-3: the 60s-polling graph feeds) — it changes
  // ONLY the arming side effect, never the scope or the debt suppression.
  if (args.arm !== false) {
    await armProjectsForPrincipal(db, { teamId: args.teamId, projectIds: initiatives.map((p) => p.id) });
  }
  const state = await readyPartitions(db, {
    teamId: args.teamId,
    projects: projects.map((p) => ({ id: p.id, group: p.graph_group_id })),
  });
  const generalOwesRestriction = await generalDebtP;

  const eligible = projects.filter((p) => {
    // Suppression applies to INITIATIVE partitions only (review-2 High 4): a self-purge in a
    // built-in is ROUTINE — every redaction, item deletion, and restriction move-out flags a
    // General row for >= the cleanup grace (an hour-scale floor) — so suppressing built-ins
    // blanked the whole enforced leg's primary partition near-constantly. The narrowing that
    // suppression exists for (untag) lives in initiative partitions. The ONE built-in exception is
    // General's RESTRICTION debt (substrate-discriminated — routine hygiene never trips it): while
    // a restriction move is anywhere short of purge-confirmed, General fails closed for enforced
    // readers (Codex code-review Blocker 1; the old "accepted residual" contradicted spec rule 2).
    if (p.kind !== "initiative") {
      return !(generalOwesRestriction && p.id === generalProject?.id);
    }
    if (state.suppressed.has(p.id)) return false; // self-purge outstanding — fail closed
    return state.ready.has(p.id);
  });

  // General FIRST and always (spec), then the recency prior — from the PARTITION's own latest
  // real push (max projected_at over sha<>'' ledger rows), because projects.last_synced_at is
  // written only by the INGEST upsert and is perpetually null for initiatives — ranking on it
  // made the router inert for exactly the population it exists to rank (review High 4b).
  // Deterministic tiebreak by group id.
  const recency = await latestPushByGroup(args.teamId, eligible.map((p) => p.graph_group_id));
  const general = eligible.filter((p) => p.kind === "system" && p.slug === "general");
  const rest = eligible
    .filter((p) => !(p.kind === "system" && p.slug === "general"))
    .sort(
      (a, b) =>
        (recency.get(b.graph_group_id) ?? 0) - (recency.get(a.graph_group_id) ?? 0) ||
        a.graph_group_id.localeCompare(b.graph_group_id)
    );
  const picked = [...general, ...rest].slice(0, Math.max(1, k));

  return { groups: picked.map((p) => p.graph_group_id), covered: picked.length, total, generalSuppressed: generalOwesRestriction && generalProject != null };
}

/**
 * PRET-3 (spec docs/design/pret3-arcs-unification.md §3) — THE one arcs-scope resolution, for
 * every reader class. MODE-keyed, not tier-keyed:
 *
 *   ENFORCING team  → the member's oracle scope via `selectEnforcedGraphPartitions`, arm: true,
 *                     for EVERY tier — an external member's oracle today resolves the
 *                     external-shared built-in; with granted memberships, more (ruling 2: an
 *                     external collaborator is a member like any other, no special branch).
 *   PERMISSIVE team → the tier's BUILT-IN pointer partitions, arm: false (PCCC-6a: a permissive
 *                     read is not a reader-signal; the built-ins' content IS the legacy graph).
 *
 * Error boundary (spec SR15 ruling): a READ FAILURE anywhere in resolution THROWS — the route's
 * existing fail-closed 500, never a silent empty. A STRUCTURALLY-EMPTY result (queries
 * succeeded, no pointer rows / no memberships) returns `{ groups: [], arm: false }` with one
 * loud console.error — an unbootstrapped team is an operational fault, not a request error.
 * Never a fallback union in either case.
 */
export interface ArcScope {
  groups: string[];
  arm: boolean;
}

export async function resolveArcScope(
  db: DbClient,
  args: {
    teamId: string;
    teamSlug: string;
    memberId: string;
    tier: "team" | "external";
    /** Pre-resolved enforcement, when the caller already holds it (the arcs routes need it for
     *  the evidence filter regardless) — avoids a second oracle resolution. Absent/null =
     *  resolve here (PRET-6: `memberEnforcement` always resolves for a live principal; a
     *  substrate error throws — the caller's 500, never a widened scope). */
    enforcement?: import("@/lib/access/enforce").TimelineEnforcement | null;
  }
): Promise<ArcScope> {
  // PRET-6: enforcing is the only behavior — the member's oracle scope IS the resolution
  // (the permissive built-in-pointer arm retired with the model).
  const { memberEnforcement } = await import("@/lib/access/enforce");
  const enforce =
    args.enforcement != null
      ? args.enforcement
      : await memberEnforcement(db, { teamId: args.teamId, memberId: args.memberId });
  // Uncapped, same as the arcs GET has since PPARC-3 (Fable 6b Medium 3): arcs need the whole
  // ready scope for coverage and scope-key stability.
  const scope = await selectEnforcedGraphPartitions(db, {
    teamId: args.teamId,
    visibleProjectIds: [...enforce.visibleProjectIds],
    k: Number.MAX_SAFE_INTEGER,
  });
  if (scope.groups.length === 0) {
    console.error(`[arcs] resolveArcScope: member ${args.memberId} on team ${args.teamId} resolves ZERO partitions`);
  }
  return { groups: scope.groups, arm: true };
}
