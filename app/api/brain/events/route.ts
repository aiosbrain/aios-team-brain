import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { visibleGroupIds } from "@/lib/graph/group";
import { recentEvents } from "@/lib/graph/learning";
import { resolveHumanActorsByItem } from "@/lib/graph/human-actors";
import { attributeEventParticipants } from "@/lib/graph/arc-attribution";

export const runtime = "nodejs";

const WINDOW_HOURS = 24 * 7;
const LIMIT = 30;

/**
 * Layer 2 of the Brain-Learning panel: recent events (source episodes) with participants + the facts
 * extracted from each, so the panel can group facts by the event that produced them. Session-authed;
 * tier decides the visible group_ids (`visibleGroupIds`, sole enforcement). Best-effort empty.
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
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const events = await recentEvents(visibleGroupIds(teamSlug, tier), since, LIMIT);

  // Tag any recognized AI-agent participant name with the human behind that event's item, or
  // "(unattributed AI agent)" when none resolves — same attribution as narrative arcs (Layer 3);
  // see docs/design/brain-learning-panel.md.
  const itemIds = [...new Set(events.map((e) => e.itemId).filter((id): id is string => !!id))];
  const humanByItem = await resolveHumanActorsByItem(adminClient(), team.id, itemIds);
  const attributed = attributeEventParticipants(events, humanByItem);

  return Response.json({ events: attributed, as_of: new Date().toISOString() });
}
