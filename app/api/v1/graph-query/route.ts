import { NextRequest } from "next/server";
import { z } from "zod";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { neo4jConfigured } from "@/lib/graph/neo4j";
import { GraphProvenanceUnavailableError, readAuthorizedGraphFactsResult } from "@/lib/graph/provenance-read";

export const runtime = "nodejs";

const schema = z.object({
  query: z.string().min(1).max(2000),
  maxFacts: z.number().int().min(1).max(100).optional(),
  continuation: z.number().int().nonnegative().optional(),
});

/**
 * POST /api/v1/graph-query — natural-language query against the Graphiti graph memory
 * (experiment, alongside `/api/v1/query`). Tier-enforced: results are scoped to the group_ids
 * the member's ORACLE partition scope via the stored pointers (ENFB-1 — visibleProjects →
 * selectEnforcedGraphPartitions, superseding #591's pointer-resolved tier groups on this
 * route; Graphiti has no tier awareness, so this is the
 * SOLE isolation (CLAUDE.md §5). Returns citable facts (text + temporal validity + source).
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:graph-query`, 30))) {
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

  // ENFB-1: the ORACLE's partition scope via the STORED-pointer path — the same substrate the
  // retrieve/arcs reads use (design round-1 blocker: the minting helper would have silently
  // emptied this route; the built-ins carry grandfathered legacy pointers only the stored path
  // resolves). Uncapped — the route's own maxFacts caps output. Empty scope → empty facts.
  const { data: team } = await db.from("teams").select("slug").eq("id", auth.teamId).maybeSingle();
  if (!team) return errorResponse("internal", "team not found", 500);
  const { visibleProjects } = await import("@/lib/access/oracle");
  const { selectEnforcedGraphPartitions } = await import("@/lib/graph/partition-read");
  const { projectIds } = await visibleProjects(db, { teamId: auth.teamId, memberId: auth.memberId });
  let groupIds: string[] = [];
  if (projectIds.size > 0) {
    const { data: visibleSystems } = await db
      .from("projects")
      .select("id,graph_group_id")
      .eq("team_id", auth.teamId)
      .eq("kind", "system");
    if (((visibleSystems ?? []) as Array<{ graph_group_id: string | null }>)
      .some((project) => !project.graph_group_id)) {
      console.error(`[graph-query] member ${auth.memberId} on team ${auth.teamId}: visible SYSTEM project is missing its stored graph pointer`);
      return errorResponse("internal", "graph partition resolution failed", 500);
    }
    const scope = await selectEnforcedGraphPartitions(db, {
      teamId: auth.teamId,
      visibleProjectIds: [...projectIds],
      k: Number.MAX_SAFE_INTEGER,
    });
    groupIds = scope.groups;
    // The LOUD arm (design round-2 condition), discriminated: zero partitions is LEGITIMATE for
    // a member whose only visibility is cold (unarmed) initiatives — but a member who can see a
    // SYSTEM project (General/external-shared, which bypass readiness and carry grandfathered
    // pointers) resolving zero partitions means the stored pointers are missing: a wiring
    // fault, never ordinary empty facts.
    if (groupIds.length === 0) {
      const { data: sys } = await db
        .from("projects")
        .select("id")
        .eq("team_id", auth.teamId)
        .eq("kind", "system")
        .in("id", [...projectIds]);
      if (((sys ?? []) as unknown[]).length > 0) {
        console.error(`[graph-query] member ${auth.memberId} on team ${auth.teamId}: visible SYSTEM project resolved ZERO partitions (missing stored pointers)`);
        return errorResponse("internal", "graph partition resolution failed", 500);
      }
    }
  }
  if (groupIds.length === 0) {
    return Response.json({ facts: [], incomplete: false, continuation: null, checked: 0 });
  }
  if (!neo4jConfigured()) {
    return errorResponse("not_configured", "graph memory (Neo4j) is not configured", 503);
  }

  try {
    const result = await readAuthorizedGraphFactsResult(db, {
      teamId: auth.teamId,
      groupIds,
      query: parsed.data.query,
      limit: parsed.data.maxFacts ?? 20,
      offset: parsed.data.continuation,
    });
    return Response.json({ facts: result.facts.map((fact) => ({
      uuid: fact.id,
      fact: fact.fact,
      valid_at: fact.at,
      source_node_name: fact.subject,
      target_node_name: fact.object,
    })), incomplete: result.incomplete, continuation: result.nextOffset, checked: result.checked });
  } catch (e) {
    if (e instanceof GraphProvenanceUnavailableError) {
      return errorResponse("temporarily_unavailable", "graph provenance authorization is temporarily unavailable", 503);
    }
    return errorResponse("internal", e instanceof Error ? e.message : "graph query failed", 502);
  }
}
