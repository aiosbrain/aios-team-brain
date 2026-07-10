import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { visibleGroupIds } from "@/lib/graph/group";
import { recentFacts } from "@/lib/graph/learning";

export const runtime = "nodejs";

const WINDOW_HOURS = 24;
const LIMIT = 15;

/**
 * Layer 1 of the "What the Brain is Learning" panel: recently-extracted atomic facts from the
 * Graphiti graph (last 24h). Session-authed; the caller's TIER decides which group_ids are visible
 * (`visibleGroupIds`) — the sole tier enforcement for the graph (no RLS backstop, CLAUDE.md §5).
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
  const groups = visibleGroupIds(teamSlug, tier);
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const facts = await recentFacts(groups, since, LIMIT);

  return Response.json({ facts, as_of: new Date().toISOString(), window_hours: WINDOW_HOURS });
}
