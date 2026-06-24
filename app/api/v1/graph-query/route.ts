import { NextRequest } from "next/server";
import { z } from "zod";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";
import { GraphitiClient } from "@/lib/graph/graphiti-client";
import { visibleGroupIds } from "@/lib/graph/group";

export const runtime = "nodejs";

const schema = z.object({
  query: z.string().min(1).max(2000),
  maxFacts: z.number().int().min(1).max(100).optional(),
});

/**
 * POST /api/v1/graph-query — natural-language query against the Graphiti graph memory
 * (experiment, alongside `/api/v1/query`). Tier-enforced: results are scoped to the group_ids
 * the caller's tier may see (`visibleGroupIds`) — Graphiti has no tier awareness, so this is the
 * SOLE isolation (CLAUDE.md §5). Returns citable facts (text + temporal validity + source).
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:graph-query`, 30))) {
    return errorResponse("rate_limited", "30/min per key", 429);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);

  const client = new GraphitiClient();
  if (!client.configured) {
    return errorResponse("not_configured", "graph memory (GRAPHITI_URL) is not configured", 503);
  }

  // Resolve the team slug, then scope to the tiers this caller may see.
  const { data: team } = await supabase.from("teams").select("slug").eq("id", auth.teamId).maybeSingle();
  if (!team) return errorResponse("internal", "team not found", 500);
  const groupIds = visibleGroupIds((team as { slug: string }).slug, auth.memberTier);

  try {
    const facts = await client.search(parsed.data.query, groupIds, parsed.data.maxFacts ?? 20);
    await audit(supabase, {
      team_id: auth.teamId,
      actor_kind: "api_key",
      member_id: auth.memberId,
      api_key_id: auth.apiKeyId,
      action: "graph.query",
      meta: { tier: auth.memberTier, groups: groupIds.length, results: facts.length },
    });
    return Response.json({ facts });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "graph query failed", 502);
  }
}
