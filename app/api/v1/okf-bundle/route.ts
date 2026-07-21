import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { extractLinks, extractTitle, resolveLink } from "@/lib/okf/links";

export const runtime = "nodejs";

const PAGE_SIZE = 500;

/**
 * GET /api/v1/okf-bundle — the engagement's OKF link graph (contract:
 * aios-workspace docs/brain-api.md). The link graph is derived on read from
 * stored item bodies (same regex as the CLI); functionally identical to the
 * contract's "denormalized at ingest" note, without a migration or re-ingest
 * dependency. Tier filtering matches GET /items, and links pointing above the
 * caller's tier ceiling are redacted.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const url = new URL(req.url);
  const includeBody = url.searchParams.get("include_body") === "true";
  const project = url.searchParams.get("project");
  const since = url.searchParams.get("since") || "1970-01-01T00:00:00Z";
  const cursor = url.searchParams.get("cursor");
  const requestedTier = url.searchParams.get("tier");

  const db = adminClient();
  // include_body returns full text → tighter limit, per contract.
  const ok = includeBody
    ? await rateLimit(db, `${auth.apiKeyId}:okf-body`, 10)
    : await rateLimit(db, `${auth.apiKeyId}:okf`, 30);
  if (!ok) return errorResponse("rate_limited", includeBody ? "10/min with body" : "30/min", 429);

  // Effective tier can never exceed the caller's ceiling.
  const ceiling = auth.memberTier; // "team" | "external"
  const effectiveTier: "team" | "external" =
    requestedTier === "external" ? "external" : ceiling; // requesting "team" while external stays external

  // Resolve the optional project slug → id up front. (Filtering on an embedded
  // relation column does not restrict parent rows in PostgREST without an inner
  // join, so we filter by project_id instead.)
  let projectId: string | null = null;
  if (project) {
    const { data: p } = await db
      .from("projects")
      .select("id")
      .eq("team_id", auth.teamId)
      .eq("slug", project)
      .maybeSingle();
    if (!p) {
      return Response.json({
        bundle: { project, generated_at: new Date().toISOString(), nodes: [] },
        next_cursor: null,
      });
    }
    projectId = p.id;
  }

  // 1. Path → access map for the whole team, to resolve + redact links.
  //    (Whole-team is intentional: keys are slug-scoped, and cross-project
  //    links are preserved as "broken" per contract point 3.)
  const { data: allRows, error: mapErr } = await db
    .from("items")
    .select("path, access, projects(slug)")
    .eq("team_id", auth.teamId);
  if (mapErr) return errorResponse("internal", mapErr.message, 500);
  const accessByPath = new Map<string, string>();
  for (const r of allRows ?? []) {
    const slug = (r.projects as unknown as { slug: string } | null)?.slug ?? "";
    accessByPath.set(`${slug}::${r.path}`, r.access);
  }

  // 2. The page of nodes the caller's tier may see.
  let q = db
    .from("items")
    .select("path, kind, access, frontmatter, body, content_sha256, updated_at, projects(slug)")
    .eq("team_id", auth.teamId)
    .gt("updated_at", cursor || since)
    .order("updated_at", { ascending: true })
    .order("path", { ascending: true })
    .limit(PAGE_SIZE);
  if (isRestrictedTier(effectiveTier)) q = q.eq("access", "external");
  if (projectId) q = q.eq("project_id", projectId);
  const { data: rows, error } = await q;
  if (error) return errorResponse("internal", error.message, 500);

  const tierVisible = (access: string) =>
    effectiveTier === "team" ? true : access === "external";

  const nodes = (rows ?? []).map((r) => {
    const slug = (r.projects as unknown as { slug: string } | null)?.slug ?? "";
    const body = r.body || "";
    const links = extractLinks(body).filter((link) => {
      // Redact links whose resolved target is above the caller's tier ceiling.
      // Broken/unresolved links are preserved (contract point 3).
      const target = resolveLink(r.path, link);
      const targetAccess = accessByPath.get(`${slug}::${target}`);
      if (targetAccess === undefined) return true; // broken or cross-project — keep
      return tierVisible(targetAccess);
    });
    return {
      path: r.path,
      title: extractTitle(body) || (r.frontmatter as Record<string, unknown>)?.title || r.path.split("/").pop(),
      kind: r.kind,
      access: r.access,
      frontmatter: r.frontmatter,
      links,
      body: includeBody ? body : null,
    };
  });

  const next_cursor =
    (rows?.length ?? 0) === PAGE_SIZE ? rows![rows!.length - 1].updated_at : null;

  return Response.json({
    bundle: {
      project: project ?? "*",
      generated_at: new Date().toISOString(),
      nodes,
    },
    next_cursor,
  });
}
