import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { listMemberIdentities } from "@/lib/identity/list";

export const runtime = "nodejs";

/**
 * GET /api/v1/members — the team roster with contact handles + cross-tool identities,
 * so an external tool (e.g. a Hermes comms agent or the `slack` CLI) can resolve "how do
 * I reach teammate X" from the single source of truth instead of a local list.
 *
 * Also carries `github_login`/`avatar_url` (populated by the admin GitHub sync) so
 * tools that render contributors — e.g. `aios timeline` — can resolve avatars from
 * the brain before falling back to GitHub's public avatar CDN.
 *
 * Team-tier only (the roster is team metadata; an external key gets 403). Optional filters:
 *   ?email=<addr>     exact roster email
 *   ?handle=<handle>  exact actor_handle
 *   ?provider=<p>     only return members that have an identity for that provider (e.g. slack),
 *                     and narrow each member's `identities` to that provider.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  if (auth.memberTier !== "team") {
    return errorResponse("forbidden_tier", "the roster is team-tier only", 403);
  }

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:members:get`, 60))) {
    return errorResponse("rate_limited", "60 reads/min per key", 429);
  }

  const url = new URL(req.url);
  const email = url.searchParams.get("email")?.toLowerCase() || null;
  const handle = url.searchParams.get("handle")?.toLowerCase() || null;
  const provider = url.searchParams.get("provider")?.toLowerCase() || null;

  let q = db
    .from("members")
    .select("id, email, display_name, actor_handle, github_login, avatar_url, role, tier, status")
    .eq("team_id", auth.teamId)
    .eq("is_connector", false)
    .neq("status", "disabled");
  if (email) q = q.eq("email", email);
  if (handle) q = q.eq("actor_handle", handle);

  const { data: rows, error } = await q.order("display_name");
  if (error) return errorResponse("internal", error.message, 500);

  const identities = await listMemberIdentities(db, auth.teamId);

  const members = (rows ?? [])
    .map((m) => {
      const rec = identities.get(m.id as string);
      let provs = rec?.providers ?? [];
      if (provider) provs = provs.filter((p) => p.provider === provider);
      return {
        id: m.id as string,
        email: m.email as string,
        display_name: m.display_name as string,
        actor_handle: m.actor_handle as string,
        github_login: (m.github_login as string | null) ?? null,
        avatar_url: (m.avatar_url as string | null) ?? null,
        role: m.role as string,
        tier: m.tier as string,
        identities: provs,
        email_aliases: rec?.emails ?? [],
      };
    })
    .filter((m) => !provider || m.identities.length > 0);

  return Response.json({ members });
}
