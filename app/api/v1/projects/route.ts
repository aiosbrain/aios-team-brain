import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";

export const runtime = "nodejs";

/**
 * Team projects for `aios pull`, so a workspace can register **brain-created** projects
 * (those never pushed from a repo) as local marker files. Team-tier only — projects are
 * team metadata with no per-project tier, so an external key gets 403 (no RLS backstop).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  if (auth.memberTier !== "team") {
    return errorResponse("forbidden_tier", "projects are team-tier only", 403);
  }

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:projects:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const { data, error } = await supabase
    .from("projects")
    .select("slug, name, last_synced_at")
    .eq("team_id", auth.teamId)
    .order("slug");
  if (error) return errorResponse("internal", error.message, 500);

  return Response.json({
    projects: (data ?? []).map((p) => ({
      slug: p.slug as string,
      name: p.name as string,
      // brain-created projects have never been pushed from a repo.
      brain_only: (p.last_synced_at as string | null) == null,
    })),
  });
}
