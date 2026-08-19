import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { adminClient } from "@/lib/db/admin";
import { recentFacts } from "@/lib/graph/learning";

export const runtime = "nodejs";

const WINDOW_HOURS = 24;
const LIMIT = 15;

/**
 * Layer 1 of the "What the Brain is Learning" panel: recently-extracted atomic facts from the
 * Graphiti graph (last 24h). Session-authed; the caller's ORACLE decides the visible partitions
 * (ENFB-3: `selectEnforcedGraphPartitions` over the member's granted projects' STORED pointers —
 * the one partition read model; a renamed team still reads its own graph because the pointers,
 * not slugs, resolve) — the sole enforcement for the graph (no RLS backstop, CLAUDE.md §5).
 * Best-effort: an empty list when Graphiti/Neo4j is unconfigured or unreachable.
 */
export async function GET(req: NextRequest) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  const teamSlug = new URL(req.url).searchParams.get("team");
  if (!teamSlug) return errorResponse("invalid_payload", "team is required", 422);

  // Resolve team + membership under RLS — nothing unless the signed-in user is an active member.
  const { data: team } = await rls.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return errorResponse("forbidden", "not a member of this team", 403);
  const { data: me } = await rls
    .from("members")
    .select("id")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  // ENFB-3: the ONE partition read model — the member's ORACLE scope through the STORED
  // pointers (`selectEnforcedGraphPartitions`, the path graph-query/arcs/retrieve adopted in
  // ENFB-1), replacing the legacy tier-pair resolution. Measured no-op for a stock member
  // (the system pointers ARE the legacy pair). arm:false — a 60s-polling feed must not be an
  // arming heartbeat; k uncapped — no silent truncation. Discrimination (design round 2):
  //   oracle read ERROR            → degraded JSON (the panels' existing tolerance);
  //   genuinely-empty scope        → empty feed (incl. General debt-suppressed — fail closed);
  //   visible system project + zero pointers + NOT suppressed → a WIRING FAULT, loud 500.
  // Deliberately not carried from the legacy resolver (spec §1): the slug-derived
  // unbootstrapped fallback (stored path = one owner), assertDirection (PRET-4 ruling 2:
  // grants ARE the scope), assertNoForeignHistory (pointer-only resolution never reaches the
  // slug-reuse state).
  const { visibleProjectsWithError } = await import("@/lib/access/oracle");
  const { selectEnforcedGraphPartitions } = await import("@/lib/graph/partition-read");
  const oracle = await visibleProjectsWithError(adminClient(), { teamId: team.id, memberId: (me as { id: string }).id });
  if (oracle.error) {
    console.error(`[facts] oracle resolution failed for team ${teamSlug}`);
    return Response.json({ facts: [], as_of: new Date().toISOString(), stale: false, degraded: true, window_hours: WINDOW_HOURS });
  }
  let groups: string[];
  try {
    const scope = await selectEnforcedGraphPartitions(adminClient(), {
      teamId: team.id,
      visibleProjectIds: [...oracle.set.projectIds],
      k: Number.MAX_SAFE_INTEGER,
      arm: false,
    });
    const { data: sysVisible, error: sysErr } = await adminClient()
      .from("projects")
      .select("id")
      .eq("team_id", team.id)
      .eq("kind", "system")
      .in("id", [...oracle.set.projectIds])
      .limit(1);
    // An ERRORED discriminator input is UNDETERMINABLE, not "no" (Codex diff L2): returning a
    // benign empty here would mask exactly the wiring fault the loud arm exists to surface.
    if (sysErr) {
      console.error(`[feed] system-project discriminator read failed for team ${teamSlug}:`, sysErr.message);
      return Response.json({ facts: [], as_of: new Date().toISOString(), stale: false, degraded: true, window_hours: WINDOW_HOURS });
    }
    const seesSystem = ((sysVisible ?? []) as unknown[]).length > 0;
    if (scope.groups.length === 0 && seesSystem && !scope.generalSuppressed) {
      console.error(`[facts] zero partitions for a system-visible member on team ${teamSlug} — stored pointers missing (wiring fault)`);
      return errorResponse("internal", "graph partition resolution failed", 500);
    }
    groups = scope.groups;
  } catch (e) {
    console.error(`[facts] partition resolution failed for team ${teamSlug}:`, e);
    return Response.json({ facts: [], as_of: new Date().toISOString(), stale: false, degraded: true, window_hours: WINDOW_HOURS });
  }

  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const { facts, ok } = await recentFacts(groups, since, LIMIT);

  // `as_of` is honest here — this is a live Neo4j read, not a cache. The bug was `ok`: `recentFacts`
  // already distinguishes "the window is genuinely quiet" from "the read FAILED" (its own comment says
  // "treating as degraded, not as an empty window"), and the route dropped it — so a Neo4j outage
  // rendered as a benign empty fact list. `stale` is structurally false for a live read.
  return Response.json({
    facts,
    as_of: new Date().toISOString(),
    stale: false,
    degraded: !ok,
    window_hours: WINDOW_HOURS,
  });
}
