import { NextRequest } from "next/server";
import { z } from "zod";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";
import { revocationEpoch } from "@/lib/access/authorization-epoch";
import { neo4jConfigured } from "@/lib/graph/neo4j";
import { GraphProvenanceUnavailableError, GraphScopeEpochChangedError, readAuthorizedGraphFactsResult } from "@/lib/graph/provenance-read";

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

  const { data: team } = await db.from("teams").select("slug").eq("id", auth.teamId).maybeSingle();
  if (!team) return errorResponse("internal", "team not found", 500);

  // AIO-1167 R94 — the bounded retry owns the WHOLE chain: epoch capture → the member's CURRENT oracle
  // projects → their stored partitions → the provenance read bound to that epoch. A changed epoch
  // restarts all of it; the read never re-certifies the old groups under a newer epoch.
  let result: Awaited<ReturnType<typeof readAuthorizedGraphFactsResult>> | null = null;
  let groupIds: string[] = [];
  try {
    for (let attempt = 0; attempt < 2 && result === null; attempt += 1) {
      const epoch = await revocationEpoch(db, auth.teamId).catch(() => {
        throw new GraphProvenanceUnavailableError("graph authorization epoch is unreadable");
      });
      const scope = await resolveGraphQueryScope(db, auth).catch((cause: unknown) => {
        throw new ScopeResolutionFailure(cause);
      });
      if ("response" in scope) return scope.response;
      groupIds = scope.groups;
      if (groupIds.length === 0) {
        return Response.json({ facts: [], incomplete: false, continuation: null, checked: 0 });
      }
      if (!neo4jConfigured()) {
        return errorResponse("not_configured", "graph memory (Neo4j) is not configured", 503);
      }
      try {
        result = await readAuthorizedGraphFactsResult(db, {
          teamId: auth.teamId,
          groupIds,
          query: parsed.data.query,
          limit: parsed.data.maxFacts ?? 20,
          offset: parsed.data.continuation,
          expectedEpoch: epoch,
        });
      } catch (error) {
        if (error instanceof GraphScopeEpochChangedError) continue; // re-resolve the member's scope
        throw error;
      }
    }
    if (result === null) throw new GraphProvenanceUnavailableError("graph authorization changed repeatedly");
    // A successful authorized read is audited, as before the provenance owner existed (AIO-1167 R44
    // C14): who asked and how much came back — counts only, never query text or fact content. A
    // refused or failed read throws before this and is never recorded as a success. Audited once per
    // request: the candidate is never re-read after this, so no second success is recorded for it.
    await audit(db, {
      team_id: auth.teamId,
      actor_kind: "api_key",
      member_id: auth.memberId,
      api_key_id: auth.apiKeyId,
      action: "graph.query",
      meta: {
        tier: auth.memberTier, groups: groupIds.length, results: result.facts.length,
        checked: result.checked, incomplete: result.incomplete,
      },
    });
    // The LAST await before publication (accepted spec §Revocation barriers; the events route's
    // rule). The read re-checked its epoch before returning, but the audit write is another await: a
    // revocation processed during it must not see these facts served. A changed — or unreadable —
    // epoch withholds the candidate as the retryable unavailable answer; nothing asynchronous may
    // follow this check.
    const current = await revocationEpoch(db, auth.teamId).catch(() => null);
    if (result.epoch !== null && current !== result.epoch) {
      throw new GraphProvenanceUnavailableError("graph authorization changed before publication");
    }
    return Response.json({ facts: result.facts.map((fact) => ({
      uuid: fact.id,
      fact: fact.fact,
      valid_at: fact.at,
      source_node_name: fact.subject,
      target_node_name: fact.object,
    })), incomplete: result.incomplete, continuation: result.nextOffset, checked: result.checked });
  } catch (e) {
    // A scope-resolution exception propagates exactly as it did before R94 (outside the read's 502).
    if (e instanceof ScopeResolutionFailure) throw e.cause;
    if (e instanceof GraphProvenanceUnavailableError) {
      return errorResponse("temporarily_unavailable", "graph provenance authorization is temporarily unavailable", 503);
    }
    return errorResponse("internal", e instanceof Error ? e.message : "graph query failed", 502);
  }
}

/** Carries a scope-resolution exception past the read's error mapping, unchanged. */
class ScopeResolutionFailure extends Error {
  constructor(readonly cause: unknown) {
    super("graph-query scope resolution failed");
  }
}

/**
 * ENFB-1: the ORACLE's partition scope via the STORED-pointer path — the same substrate the
 * retrieve/arcs reads use (design round-1 blocker: the minting helper would have silently emptied this
 * route; the built-ins carry grandfathered legacy pointers only the stored path resolves). Uncapped — the
 * route's own maxFacts caps output. Empty scope → empty facts. R94: resolved once PER ATTEMPT, after that
 * attempt's epoch capture.
 */
async function resolveGraphQueryScope(
  db: ReturnType<typeof adminClient>,
  auth: { teamId: string; memberId: string },
): Promise<{ groups: string[] } | { response: Response }> {
  const { visibleProjects } = await import("@/lib/access/oracle");
  const { selectEnforcedGraphPartitions } = await import("@/lib/graph/partition-read");
  const { projectIds } = await visibleProjects(db, { teamId: auth.teamId, memberId: auth.memberId });
  if (projectIds.size === 0) return { groups: [] };
  // Only the member's VISIBLE system projects: another member's broken partition is not this
  // member's wiring fault, and must not fail a healthy visible scope.
  const { data: visibleSystems } = await db
    .from("projects")
    .select("id,graph_group_id")
    .eq("team_id", auth.teamId)
    .eq("kind", "system")
    .in("id", [...projectIds]);
  if (((visibleSystems ?? []) as Array<{ graph_group_id: string | null }>)
    .some((project) => !project.graph_group_id)) {
    console.error(`[graph-query] member ${auth.memberId} on team ${auth.teamId}: visible SYSTEM project is missing its stored graph pointer`);
    return { response: errorResponse("internal", "graph partition resolution failed", 500) };
  }
  const scope = await selectEnforcedGraphPartitions(db, {
    teamId: auth.teamId,
    visibleProjectIds: [...projectIds],
    k: Number.MAX_SAFE_INTEGER,
  });
  // The LOUD arm (design round-2 condition), discriminated: zero partitions is LEGITIMATE for a member
  // whose only visibility is cold (unarmed) initiatives — but a member who can see a SYSTEM project
  // (General/external-shared, which bypass readiness and carry grandfathered pointers) resolving zero
  // partitions means the stored pointers are missing: a wiring fault, never ordinary empty facts.
  if (scope.groups.length === 0) {
    const { data: sys } = await db
      .from("projects")
      .select("id")
      .eq("team_id", auth.teamId)
      .eq("kind", "system")
      .in("id", [...projectIds]);
    if (((sys ?? []) as unknown[]).length > 0) {
      console.error(`[graph-query] member ${auth.memberId} on team ${auth.teamId}: visible SYSTEM project resolved ZERO partitions (missing stored pointers)`);
      return { response: errorResponse("internal", "graph partition resolution failed", 500) };
    }
  }
  return { groups: scope.groups };
}
