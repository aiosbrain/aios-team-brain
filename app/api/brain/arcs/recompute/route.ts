import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { visibleGroupIds } from "@/lib/graph/group";
import { recomputeArcs } from "@/lib/graph/arcs";

export const runtime = "nodejs";
export const maxDuration = 120; // arc synthesis (LLM) inline path can take up to ~110s on a cold cache

const schema = z.object({
  team: z.string().min(1).max(120),
  corrections: z
    .array(z.object({ arc_id: z.string().min(1).max(64), corrected_text: z.string().min(1).max(4000) }))
    .max(10),
});

/**
 * Re-derive narrative arcs incorporating human corrections, and persist each correction back to
 * Graphiti as a first-class episode so it informs future synthesis. Session-authed + tier-scoped.
 * team-tier only: writing corrections is an internal edit (an external viewer can't reshape the graph).
 */
export async function POST(req: NextRequest) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("invalid_payload", "team + corrections required", 422);
  const { team: teamSlug, corrections } = parsed.data;

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
  if (tier !== "team") return errorResponse("forbidden", "corrections are team-tier only", 403);

  const admin = adminClient();
  const keys = await resolveAnsweringKeys(admin, team.id);
  const arcs = await recomputeArcs(
    admin,
    team.id,
    teamSlug,
    tier,
    visibleGroupIds(teamSlug, tier),
    corrections,
    keys
  );

  return Response.json({ arcs, as_of: new Date().toISOString() });
}
