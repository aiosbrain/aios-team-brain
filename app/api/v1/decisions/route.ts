import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";

export const runtime = "nodejs";

/**
 * Decision writeback for `aios pull`: decisions created or edited IN THE DASHBOARD
 * since the cursor — UI-created rows (`source_item_id IS NULL`, the discriminator),
 * plus synced rows whose `updated_at` moved after their source item's `synced_at`
 * (a dashboard edit). Mirrors `GET /api/v1/tasks`. Tier-scoped: an external-tier key
 * sees only `audience='external'` decisions (no RLS backstop on postgres).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:decisions:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "1970-01-01T00:00:00Z";

  let query = supabase
    .from("decisions")
    .select(
      "row_key, decided_at, title, rationale, decided_by, impact, tier, audience, updated_at, source_item_id, projects(slug), items:source_item_id(synced_at)"
    )
    .eq("team_id", auth.teamId)
    .gt("updated_at", since)
    .order("updated_at", { ascending: true })
    .limit(500);
  // Tier isolation: external principals never receive team-tier decisions.
  if (auth.memberTier === "external") query = query.eq("audience", "external");

  const { data, error } = await query;
  if (error) return errorResponse("internal", error.message, 500);

  const uiChanged = (data ?? []).filter((d) => {
    if (d.source_item_id == null) return true; // created in the dashboard
    const synced = (d.items as unknown as { synced_at: string } | null)?.synced_at;
    return synced ? new Date(d.updated_at) > new Date(synced) : false; // edited after sync
  });

  const byProject = new Map<
    string,
    {
      row_key: string;
      decided_at: string | null;
      title: string;
      rationale: string;
      decided_by: string;
      impact: string;
      tier: number | null;
      audience: string;
    }[]
  >();
  for (const d of uiChanged) {
    const slug = (d.projects as unknown as { slug: string })?.slug ?? "unknown";
    if (!byProject.has(slug)) byProject.set(slug, []);
    byProject.get(slug)!.push({
      row_key: d.row_key as string,
      decided_at: d.decided_at as string | null,
      title: d.title as string,
      rationale: d.rationale as string,
      decided_by: d.decided_by as string,
      impact: d.impact as string,
      tier: d.tier as number | null,
      audience: d.audience as string,
    });
  }

  return Response.json({
    decisions: [...byProject.entries()].map(([project, rows]) => ({ project, rows })),
    next_cursor: null,
  });
}
