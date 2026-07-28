import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { visibleGroupIds } from "@/lib/graph/group";
import { recomputeArcs } from "@/lib/graph/arcs";
import { freshnessWire } from "@/lib/freshness";

export const runtime = "nodejs";
export const maxDuration = 120; // arc synthesis (LLM) inline path can take up to ~110s on a cold cache

const schema = z.object({
  team: z.string().min(1).max(120),
  corrections: z
    .array(
      z.object({
        arc_id: z.string().min(1).max(64),
        // Optional so an older client keeps working; stored so the correction stays diagnosable once
        // `arc_id` (sha of the title) churns on the next recompute.
        arc_title: z.string().max(300).optional(),
        corrected_text: z.string().min(1).max(4000),
      })
    )
    .max(10),
});

/**
 * Re-derive narrative arcs incorporating human corrections. The correction is written to Postgres FIRST
 * (`arc_corrections`, the record) and only then projected into Graphiti as an episode — it used to exist
 * solely as that episode, so a graph rollback erased it and a failed write silently reverted the user's
 * edit within one cache TTL (H13). A failed SAVE now surfaces as an error rather than a lie.
 * Session-authed + tier-scoped; team-tier only, since correcting an arc is an internal editorial act.
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
    .select("id, tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);
  const { id: memberId, tier } = me as { id: string; tier: "team" | "external" };
  if (tier !== "team") return errorResponse("forbidden", "corrections are team-tier only", 403);

  const admin = adminClient();
  const keys = await resolveAnsweringKeys(admin, team.id);
  const { arcs, freshness } = await recomputeArcs(
    admin,
    team.id,
    teamSlug,
    tier,
    visibleGroupIds(teamSlug, tier),
    corrections,
    keys,
    memberId
  );

  // WAS `new Date()`. A recompute can legitimately return arcs it did NOT compute: `canReuseArcs` skips
  // the model when facts are unchanged, and a degraded synthesis is refused in favour of the prior (H11).
  // Stamping "now" told the user their correction had landed in a fresh set when it may not have.
  return Response.json({ arcs, ...freshnessWire(freshness) });
}
