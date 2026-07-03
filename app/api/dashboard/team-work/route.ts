import { NextRequest } from "next/server";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { getProviderKey } from "@/lib/integrations/manage";
import { getTeamWork } from "@/lib/dashboard/team-work-live";

export const runtime = "nodejs";
export const maxDuration = 60; // arc synthesis (LLM) can be slow on a cold cache

/**
 * Dashboard "Working On" data: per-person summary (narrative arcs), open tasks, and recent
 * accomplishments — assembled server-side and fetched by the client card so the LLM arc synthesis
 * never blocks the home page SSR. Session-authed; tier decides the visible group_ids
 * (`visibleGroupIds`, sole enforcement). Best-effort empty when Graphiti/LLM is unavailable.
 */
export async function GET(req: NextRequest) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  const teamSlug = new URL(req.url).searchParams.get("team");
  if (!teamSlug) return errorResponse("invalid_payload", "team is required", 422);

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

  const people = await getTeamWork(admin, team.id, teamSlug, tier, { openaiKey, anthropicKey });
  return Response.json({ people, as_of: new Date().toISOString() });
}
