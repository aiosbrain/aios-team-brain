import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { getFusedArcs } from "@/lib/graph/arc-fusion";
import { resolveArcScope } from "@/lib/graph/partition-read";
import { memberEnforcement } from "@/lib/access/enforce";
import { filterArcsByVisibleItems } from "@/lib/graph/arc-visibility";
import { freshnessWire, computedNow } from "@/lib/freshness";

export const runtime = "nodejs";
// Arc synthesis with a reasoning model can be slow (it reasons over ~200 facts). Give the inline
// cold-compute path headroom; the SWR background refresh isn't bound by this anyway.
export const maxDuration = 120;

/** Why the arc panel is empty — so the UI shows the actual cause instead of a benign "no arcs yet". */

const schema = z.object({ team: z.string().min(1).max(120) });

/**
 * Layer 3 — narrative arcs (synthesized from the last 7d of the Graphiti graph, cached 4h).
 * Session-authed; the member's scope comes from `resolveArcScope` (PRET-3: mode-keyed — the
 * enforcing oracle scope or the permissive built-in partitions; sole enforcement, fail-closed).
 * The LLM key comes from the team's AI model settings (same as the Q&A path). Best-effort empty
 * when the graph/LLM is unavailable.
 */
export async function POST(req: NextRequest) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("invalid_payload", "team is required", 422);
  const teamSlug = parsed.data.team;

  const { data: team } = await rls.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return errorResponse("forbidden", "not a member of this team", 403);
  const { data: me } = await rls
    .from("members")
    .select("id, role")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  const memberId = (me as { id: string }).id;
  // PRET-4 §1a: `tier` downstream (resolveArcScope's permissive arm, the corrections gate) is
  // POSTURE — everyone-membership — not the members.tier record.
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  const tier = await resolveViewerPosture(adminClient(), team.id, memberId);
  const admin = adminClient();
  const keys = await resolveAnsweringKeys(admin, team.id);

  // Access enforcement — resolved BEFORE the read, because the read's SCOPE depends on it. The
  // resolution fails CLOSED: a substrate error throws → 500, never the unfiltered set; a
  // structurally-empty scope serves an empty panel (spec SR15 boundary).
  let enforce: import("@/lib/access/enforce").TimelineEnforcement | null;
  let scope: import("@/lib/graph/partition-read").ArcScope;
  try {
    enforce = await memberEnforcement(admin, { teamId: team.id, memberId });
    // PRET-3 ARCS UNIFICATION (docs/design/pret3-arcs-unification.md): ONE mode-keyed resolution
    // for EVERY reader class — enforcing teams get the member's oracle scope (uncapped, arm:true,
    // any tier: ruling 2 makes externals members); permissive teams get the built-in pointer
    // partitions (arm:false). The tier-row path has no reader after this.
    scope = await resolveArcScope(admin, { teamId: team.id, teamSlug, memberId, tier, enforcement: enforce });
  } catch {
    return errorResponse("internal", "enforcement check failed", 500);
  }

  // The fused panel is THE arcs read (ruling 1): per-partition g: rows, at most one inline
  // synthesis, budgeted warming, coverage disclosed — for everyone.
  const { arcs: allArcs, freshness, covered, total } = await getFusedArcs(admin, team.id, teamSlug, scope.groups, keys);

  // The PCCB-5 evidence filter stays as defense-in-depth: a partition scope's facts are
  // principal-visible by construction, but an item restricted BETWEEN synthesis and read is not.
  const arcs = filterArcsByVisibleItems(allArcs, enforce?.visibleItemIds ?? null);

  // PRET-6: the empty-panel DIAGNOSTIC (the three reason codes + the ops note) is RETIRED with
  // the permissive mode. It read TEAM-WIDE graph/LLM health, which §5.7
  // forbids serving to a partitioned member (it discloses that invisible content is in flight),
  // so it was already computed only on permissive teams — with every read now enforced, the
  // branch was dead. Every empty panel takes the neutral envelope; the wire keys stay (constant
  // null/undefined) so no consumer's shape breaks. Diagnosis lives on the admin surfaces
  // (Retrieval health / generation health), which are role-gated and may read team-wide state.
  const wire = freshnessWire(freshness);
  // §5.7 (Codex B5 Medium): when an ENFORCING member's result is empty, the tier cache's
  // `as_of`/`stale`/`degraded` would leak hidden-corpus refresh/failure activity (they reflect the
  // full-tier synthesis, not the member's empty slice). Return a neutral envelope so "team has
  // nothing" and "everything is invisible" are indistinguishable. Permissive → byte-identical.
  if (enforce != null && arcs.length === 0) {
    // Neutral envelope via the freshness layer (`computedNow` — not an inline `new Date()`, which the
    // fabricated-freshness guard rightly forbids): an empty result has no cached data whose staleness
    // to report, and stamping the tier row's real time is the §5.7 leak.
    // Coverage pair on EVERY branch (Codex M4: 'universal' meant universal — a branch-dependent
    // shape is a false wire claim even when no consumer discriminates on it today).
    return Response.json({ arcs, reason: null, note: undefined, coveredPartitions: covered, totalPartitions: total, ...freshnessWire(computedNow()) });
  }
  return Response.json({
    arcs,
    // PPARC-3 coverage disclosure (design §2.2) — universal since PRET-3: every read is fused,
    // so every client receives the pair (spec M4: an ADDITIVE gain for former tier-path clients).
    coveredPartitions: covered,
    totalPartitions: total,
    // `degraded` is the ENVELOPE's (R2/M6): "a leg this payload depended on failed" — incl. the
    // dangerous non-empty-but-degraded case (H11). The retired diagnostic's model-failing
    // contribution died with it (that flag was only ever true on the empty path, which the
    // envelope subsumes).
    degraded: wire.degraded,
    reason: null,
    note: undefined,
    // WAS `new Date().toISOString()` — a lie. `arc_cache` has a 4h TTL and the SWR branch deliberately
    // serves rows OLDER than that, so this stamped hours-old arcs as current, and destroyed the
    // backdating H11/H12 built to mark an untrustworthy synthesis. Now the row's real time.
    as_of: wire.as_of,
    stale: wire.stale,
  });
}
