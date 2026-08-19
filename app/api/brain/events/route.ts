import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { recentEvents } from "@/lib/graph/learning";
import { resolveHumanActorsByItem } from "@/lib/graph/human-actors";
import { attributeEventParticipants } from "@/lib/graph/arc-attribution";

export const runtime = "nodejs";

const WINDOW_HOURS = 24 * 7;
const LIMIT = 30;

/**
 * Layer 2 of the Brain-Learning panel: recent events (source episodes) with participants + the facts
 * extracted from each, so the panel can group facts by the event that produced them. Session-authed;
 * the member's ORACLE decides the visible partitions (ENFB-3: `selectEnforcedGraphPartitions` over the granted projects' stored pointers — rename-safe by the pointer principle). Best-effort empty.
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
  const admin = adminClient();
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const { visibleProjectsWithError } = await import("@/lib/access/oracle");
  const { selectEnforcedGraphPartitions } = await import("@/lib/graph/partition-read");
  const oracle = await visibleProjectsWithError(admin, { teamId: team.id, memberId: (me as { id: string }).id });
  if (oracle.error) {
    console.error(`[events] oracle resolution failed for team ${teamSlug}`);
    return Response.json({ events: [], as_of: new Date().toISOString(), degraded: true });
  }
  let groups: string[];
  try {
    const scope = await selectEnforcedGraphPartitions(admin, {
      teamId: team.id,
      visibleProjectIds: [...oracle.set.projectIds],
      k: Number.MAX_SAFE_INTEGER,
      arm: false,
    });
    const { data: sysVisible, error: sysErr } = await admin
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
      return Response.json({ events: [], as_of: new Date().toISOString(), degraded: true });
    }
    const seesSystem = ((sysVisible ?? []) as unknown[]).length > 0;
    if (scope.groups.length === 0 && seesSystem && !scope.generalSuppressed) {
      console.error(`[events] zero partitions for a system-visible member on team ${teamSlug} — stored pointers missing (wiring fault)`);
      return errorResponse("internal", "graph partition resolution failed", 500);
    }
    groups = scope.groups;
  } catch (e) {
    console.error(`[events] partition resolution failed for team ${teamSlug}:`, e);
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
