import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";

export const runtime = "nodejs";

// GET /api/v1/items/<id> — fetch a single item on demand (e.g. one deliverable).
// Tier filtering is re-applied: an external-tier key can only read external items.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:items:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const { id } = await ctx.params;

  let q = supabase
    .from("items")
    .select("id, path, kind, access, frontmatter, body, content_sha256, actor, updated_at, projects(slug)")
    .eq("team_id", auth.teamId)
    .eq("id", id)
    .limit(1);
  if (auth.memberTier === "external") q = q.eq("access", "external");

  const { data, error } = await q;
  if (error) return errorResponse("internal", error.message, 500);
  const row = data?.[0];
  if (!row) return errorResponse("not_found", "no such item (or above your tier)", 404);

  return Response.json({
    id: row.id,
    project: (row.projects as unknown as { slug: string })?.slug,
    path: row.path,
    kind: row.kind,
    access: row.access,
    frontmatter: row.frontmatter,
    body: row.body,
    content_sha256: row.content_sha256,
    actor: row.actor,
    updated_at: row.updated_at,
  });
}
