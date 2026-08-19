import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";

export const runtime = "nodejs";

// GET /api/v1/items/<id> — fetch a single item on demand (e.g. one deliverable).
// ENFB-1: the MEMBERSHIP oracle gates the read (the list/by-id disagreement closed — a row the
// list omits can no longer be fetched by id); the posture arm stays as the coarse outer wall.
// A membership-denied id returns the SAME 404 as an absent one (§5.7 — absent and invisible
// are indistinguishable).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:items:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const { id } = await ctx.params;

  const NOT_FOUND = () => errorResponse("not_found", "no such item (or not visible to you)", 404);

  // The by-id membership probe (shared-predicate §2.1) — fail closed BEFORE the row is read.
  const { canSeeItem } = await import("@/lib/access/enforce");
  if (!(await canSeeItem(db, { teamId: auth.teamId, memberId: auth.memberId }, id))) {
    return NOT_FOUND();
  }

  let q = db
    .from("items")
    .select("id, path, kind, access, frontmatter, body, content_sha256, actor, updated_at, projects(slug)")
    .eq("team_id", auth.teamId)
    .eq("id", id)
    .limit(1);
  if (isRestrictedTier(auth.memberTier)) q = q.eq("access", "external");

  const { data, error } = await q;
  if (error) return errorResponse("internal", error.message, 500);
  const row = data?.[0];
  if (!row) return NOT_FOUND();

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
