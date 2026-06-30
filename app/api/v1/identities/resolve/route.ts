import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { buildIdentityMap, resolveByProviderId, resolveMember } from "@/lib/identity/resolve";
import { listMemberIdentities } from "@/lib/identity/list";

export const runtime = "nodejs";

/**
 * GET /api/v1/identities/resolve — resolve an external identifier to a team member and
 * return their canonical contact set (incl. every provider identity, so a caller can map
 * e.g. email → Slack `U…`). The congruent way for the `slack` CLI / Hermes to answer
 * "what is teammate X's Slack id" without keeping a parallel list.
 *
 * Team-tier only. Resolution inputs (one required):
 *   ?provider=<p>&external_id=<id>   provider user id (e.g. provider=slack&external_id=U…)
 *   ?email=<addr>                    roster email or alias
 *   ?handle=<handle>                 actor_handle
 * Returns 404 when nothing resolves.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  if (auth.memberTier !== "team") {
    return errorResponse("forbidden_tier", "identity resolution is team-tier only", 403);
  }

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:resolve:get`, 120))) {
    return errorResponse("rate_limited", "120 resolves/min per key", 429);
  }

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider")?.toLowerCase() || null;
  const externalId = url.searchParams.get("external_id") || null;
  const email = url.searchParams.get("email")?.toLowerCase() || null;
  const handle = url.searchParams.get("handle") || null;

  if (!externalId && !email && !handle) {
    return errorResponse(
      "bad_request",
      "supply one of: provider+external_id, email, or handle",
      400
    );
  }
  if (externalId && !provider) {
    return errorResponse("bad_request", "external_id requires provider", 400);
  }

  const map = await buildIdentityMap(supabase, auth.teamId);
  let memberId: string | null = null;
  if (externalId && provider) memberId = resolveByProviderId(map, provider, externalId);
  if (!memberId && (email || handle)) memberId = resolveMember(map, { email: email ?? undefined, key: handle ?? undefined });

  if (!memberId) return errorResponse("not_found", "no member matches that identifier", 404);

  const { data: m, error } = await supabase
    .from("members")
    .select("id, email, display_name, actor_handle, github_login, role, tier")
    .eq("team_id", auth.teamId)
    .eq("id", memberId)
    .maybeSingle();
  if (error) return errorResponse("internal", error.message, 500);
  if (!m) return errorResponse("not_found", "member resolved but not readable", 404);

  const identities = (await listMemberIdentities(supabase, auth.teamId)).get(memberId);
  const provs = identities?.providers ?? [];
  const slack = provs.find((p) => p.provider === "slack");

  return Response.json({
    member: {
      id: m.id as string,
      email: m.email as string,
      display_name: m.display_name as string,
      actor_handle: m.actor_handle as string,
      github_login: (m.github_login as string | null) ?? null,
      role: m.role as string,
      tier: m.tier as string,
    },
    identities: provs,
    email_aliases: identities?.emails ?? [],
    // convenience: the Slack user id, when linked (used by the `slack` CLI resolver).
    slack_id: slack?.externalId ?? null,
  });
}
