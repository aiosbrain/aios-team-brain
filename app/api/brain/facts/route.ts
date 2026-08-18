import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { adminClient } from "@/lib/db/admin";
import { visibleTierGroupIds } from "@/lib/graph/tier-groups";
import { recentFacts } from "@/lib/graph/learning";

export const runtime = "nodejs";

const WINDOW_HOURS = 24;
const LIMIT = 15;

/**
 * Layer 1 of the "What the Brain is Learning" panel: recently-extracted atomic facts from the
 * Graphiti graph (last 24h). Session-authed; the caller's TIER decides which group_ids are visible
 * (`visibleTierGroupIds`, resolved from the built-ins' STORED pointers so a renamed team still
 * reads its own graph) — the sole tier enforcement for the graph (no RLS backstop, CLAUDE.md §5).
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
    .select("tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  const tier = (me as { tier: "team" | "external" }).tier;
  // Pointer-resolved, admin-scoped by teamId (the pointer lives on `projects`, which the member's
  // RLS view does not cover). A resolution failure degrades HONESTLY — `degraded: true` with no
  // facts — rather than falling back to a slug-derived id, which on a renamed team is a group that
  // has never been written to and reads as a benign empty panel.
  let groups: string[];
  try {
    groups = await visibleTierGroupIds(adminClient(), { teamId: team.id, teamSlug, tier });
  } catch (e) {
    console.error(`[facts] tier group resolution failed for team ${teamSlug}:`, e);
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
