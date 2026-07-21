import { NextRequest } from "next/server";
import { z } from "zod";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { errorResponse } from "@/lib/api/schemas";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { visibleGroupIds } from "@/lib/graph/group";
import { getArcs } from "@/lib/graph/arcs";
import { getLlmHealth } from "@/lib/query/llm-health";
import { graphHasFacts } from "@/lib/query/retrieval-health";

export const runtime = "nodejs";
// Arc synthesis with a reasoning model can be slow (it reasons over ~200 facts). Give the inline
// cold-compute path headroom; the SWR background refresh isn't bound by this anyway.
export const maxDuration = 120;

/** Why the arc panel is empty — so the UI shows the actual cause instead of a benign "no arcs yet". */
type EmptyReason = "no_facts" | "model_failing" | "synthesis_empty" | null;

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
  const keys = await resolveAnsweringKeys(admin, team.id);
  const arcs = await getArcs(admin, team.id, teamSlug, tier, visibleGroupIds(teamSlug, tier), keys);

  // Empty arcs are ambiguous — tell the client the ACTUAL cause so the panel stops showing a benign
  // "no arcs yet" for what is really a broken graph or a failing model:
  //   • no facts in the graph        → the projector hasn't populated it (graph/projector issue)
  //   • facts exist + LLM degraded   → the answering/reasoning model is failing (empty/timeout)
  //   • facts exist + LLM ok         → synthesis produced nothing this time (usually transient)
  let reason: EmptyReason = null;
  let note: string | undefined;
  if (arcs.length === 0) {
    const [hasFacts, llm] = await Promise.all([graphHasFacts(team.id), getLlmHealth(team.id)]);
    if (!hasFacts) {
      reason = "no_facts";
      note =
        "The knowledge graph has no facts yet, so there's nothing to synthesize. The graph projector may not have run or is failing — an admin can check Admin → Integrations → Retrieval health (Graph memory).";
    } else if (llm.state === "degraded") {
      reason = "model_failing";
      note =
        llm.note ??
        "The answering model recently failed to produce output — check Admin → Integrations and the Active answering model.";
    } else {
      reason = "synthesis_empty";
      note = "The graph has facts but synthesis returned nothing this time — this is usually transient; try again shortly.";
    }
  }

  // The diagnostic `note` names internal admin surfaces and — for `model_failing` — embeds the raw
  // provider error (`llm.note` → internal LLM base URL, model slug, and the provider's error body).
  // That's team-internal infra detail: redact it for `external`-tier collaborators (who can't act on it
  // and shouldn't see the config), keeping only the coarse `reason` category. Team tier still gets the
  // actionable note.
  return Response.json({
    arcs,
    degraded: reason === "model_failing", // back-compat flag
    reason,
    note: isRestrictedTier(tier) ? undefined : note,
    as_of: new Date().toISOString(),
  });
}
