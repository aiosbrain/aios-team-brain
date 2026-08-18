import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { visibleTierGroupIds } from "@/lib/graph/tier-groups";
import { recentEvents } from "@/lib/graph/learning";
import { resolveHumanActorsByItem } from "@/lib/graph/human-actors";
import { attributeEventParticipants } from "@/lib/graph/arc-attribution";

export const runtime = "nodejs";

const WINDOW_HOURS = 24 * 7;
const LIMIT = 30;

/**
 * Layer 2 of the Brain-Learning panel: recent events (source episodes) with participants + the facts
 * extracted from each, so the panel can group facts by the event that produced them. Session-authed;
 * tier decides the visible group_ids (`visibleTierGroupIds`, sole enforcement — pointer-resolved,
 * so a renamed team still reads its own graph). Best-effort empty.
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
    .select("id")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  // PRET-4 §1a: posture, not the record.
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  const tier = await resolveViewerPosture(adminClient(), team.id, (me as { id: string }).id);
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  // Pointer-resolved (the rename doctrine — see lib/graph/tier-groups.ts), admin-scoped by teamId:
  // the pointer lives on `projects`, outside the member's RLS view. Best-effort empty on a
  // resolution failure, matching this panel's documented contract — but LOUD in the log, because a
  // silent empty is exactly the failure mode this change exists to end.
  const admin = adminClient();
  let groups: string[];
  try {
    groups = await visibleTierGroupIds(admin, { teamId: team.id, teamSlug, tier });
  } catch (e) {
    console.error(`[events] tier group resolution failed for team ${teamSlug}:`, e);
    return Response.json({ events: [], as_of: new Date().toISOString(), degraded: true });
  }
  const events = await recentEvents(groups, since, LIMIT);

  // Tag any recognized AI-agent participant name with the human behind that event's item, or
  // "(unattributed AI agent)" when none resolves — same attribution as narrative arcs (Layer 3);
  // see docs/design/brain-learning-panel.md.
  const itemIds = [...new Set(events.map((e) => e.itemId).filter((id): id is string => !!id))];
  const humanByItem = await resolveHumanActorsByItem(admin, team.id, itemIds);
  const attributed = attributeEventParticipants(events, humanByItem);

  // `degraded` on EVERY branch (additive): a field that appears only on the failure path is a
  // branch-dependent wire shape, and it leaves a genuinely quiet week indistinguishable from a
  // resolution failure — the ambiguity this whole change exists to remove.
  return Response.json({ events: attributed, as_of: new Date().toISOString(), degraded: false });
}
