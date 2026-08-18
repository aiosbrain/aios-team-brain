import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { isRestrictedTier } from "@/lib/auth/visibility";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { extractLinks, extractTitle, resolveLink } from "@/lib/okf/links";
import { pageVisibleOkfItems, parseOkfCursor, formatOkfCursor } from "@/lib/okf/page";
import { visibleItemIds } from "@/lib/access/enforce";

export const runtime = "nodejs";

const PAGE_SIZE = 500;

/**
 * GET /api/v1/okf-bundle — the engagement's OKF link graph (contract:
 * aios-workspace docs/brain-api.md). The link graph is derived on read from
 * stored item bodies (same regex as the CLI); functionally identical to the
 * contract's "denormalized at ingest" note, without a migration or re-ingest
 * dependency. Tier filtering matches GET /items; ENFB-1 adds the MEMBERSHIP oracle: the page
 * intersects with the caller's visible-id set, and link redaction follows the §2.4 three-state
 * contract (dangling preserved, membership-invisible redacted like above-tier, visible
 * preserved). The cursor is the §2.5 composite `<updated_at>|<id>` (legacy bare-timestamp
 * accepted).
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

  // ENFB-1: the caller's MEMBERSHIP-visible id set, resolved ONCE — gates the page AND feeds
  // the §2.4 link-redaction contract. Fail closed: a resolution error serves an empty page.
  const vis = await visibleItemIds(db, { teamId: auth.teamId, memberId: auth.memberId });
  if (vis.error) return errorResponse("internal", "access resolution failed", 500);

  // 1. Path → {id, access} map for the WHOLE team (deliberately unfiltered — it is an internal
  //    map that is never serialized, and it is what lets redaction DISCRIMINATE the three §2.4
  //    target states: absent → preserve; present-but-invisible → redact; visible → preserve).
  const { data: allRows, error: mapErr } = await db
    .from("items")
    .select("id, path, access, projects(slug)")
    .eq("team_id", auth.teamId);
  if (mapErr) return errorResponse("internal", mapErr.message, 500);
  const targetByPath = new Map<string, { id: string; access: string }>();
  for (const r of allRows ?? []) {
    const slug = (r.projects as unknown as { slug: string } | null)?.slug ?? "";
    targetByPath.set(`${slug}::${r.path}`, { id: r.id as string, access: r.access as string });
  }

  // 2. The page: membership-visible rows only, composite keyset (§2.5). A legacy bare-timestamp
  //    cursor still resumes (strictly-after semantics).
  const after = cursor ? parseOkfCursor(cursor) : { ts: since, id: null };
  if (!after) return errorResponse("invalid_payload", "malformed cursor", 422);
  let rows;
  try {
    rows = await pageVisibleOkfItems({
      teamId: auth.teamId,
      visibleIds: [...vis.ids],
      after,
      projectId,
      externalOnly: isRestrictedTier(effectiveTier),
      limit: PAGE_SIZE,
    });
  } catch {
    return errorResponse("internal", "page query failed", 500);
  }

  const tierVisible = (access: string) =>
    effectiveTier === "team" ? true : access === "external";

  const nodes = rows.map((r) => {
    const slug = r.slug ?? "";
    const body = r.body || "";
    const links = extractLinks(body).filter((link) => {
      // §2.4: dangling targets are preserved (the author's problem, not access); an existing
      // target is redacted unless BOTH walls pass — the posture ceiling (as before) and the
      // caller's membership visibility (ENFB-1). The existence bit a redaction discloses is
      // the same class today's tier redaction already discloses (§5.7-compatible, stated).
      const target = resolveLink(r.path, link);
      const t = targetByPath.get(`${slug}::${target}`);
      if (t === undefined) return true; // dangling — keep
      return tierVisible(t.access) && vis.ids.has(t.id);
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
    rows.length === PAGE_SIZE ? formatOkfCursor(rows[rows.length - 1].updated_at, rows[rows.length - 1].id) : null;

  return Response.json({
    bundle: {
      project: project ?? "*",
      generated_at: new Date().toISOString(),
      nodes,
    },
    next_cursor,
  });
}
