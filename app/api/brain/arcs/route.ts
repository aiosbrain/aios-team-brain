import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { getProviderKey } from "@/lib/integrations/manage";
import { visibleGroupIds } from "@/lib/graph/group";
import { getArcs } from "@/lib/graph/arcs";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({ team: z.string().min(1).max(120) });

/**
 * Layer 3 — narrative arcs (synthesized from the last 7d of the Graphiti graph, cached 10 min).
 * Session-authed; tier decides the visible group_ids (`visibleGroupIds`, sole enforcement). The LLM
 * key comes from the team's AI model settings (same as the Q&A path). Best-effort empty when the
 * graph/LLM is unavailable.
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
    .select("tier")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  const tier = (me as { tier: "team" | "external" }).tier;
  const admin = adminClient();
  const [openaiKey, anthropicKey] = await Promise.all([
    getProviderKey(admin, team.id, "openai"),
    getProviderKey(admin, team.id, "anthropic"),
  ]);
  const arcs = await getArcs(admin, team.id, teamSlug, tier, visibleGroupIds(teamSlug, tier), {
    openaiKey,
    anthropicKey,
  });

  return Response.json({ arcs, as_of: new Date().toISOString() });
}
