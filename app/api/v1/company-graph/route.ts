import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";

export const runtime = "nodejs";

/**
 * GET /api/v1/company-graph — the structured stakeholder map (brain-api v1.5, AIO-141).
 *
 * Projects the structured Company-Graph (`graph_entities` / `graph_relationships`) as a
 * people + ownership view for the workspace stakeholder-map surface (`aios stakeholders`,
 * MCP `brain_stakeholders`). Answers "who owns domain X" and "who reports to whom".
 * This is the typed-rows counterpart to POST /api/v1/query (the NL Graphiti memory) —
 * a different subsystem; no prose here.
 *
 * Team-tier only: the graph tables carry a `team_id` but no per-row tier column and there
 * is no RLS backstop, so this handler is the SOLE tier gate (same posture as /projects,
 * /metrics, /codebases). An external key gets 403 forbidden_tier.
 *
 * Empty-graph contract: an authenticated team-tier key on an unseeded team returns
 * `200 { "people": [], "ownership": [] }` — never a 500.
 *
 * Attendance ("who attended meeting Y") is NOT served here — it is derived client-side
 * from GET /items meeting markers (contract v1.5 §company-graph, point 4).
 */

/** The relationship types projected into `ownership[]` (contract v1.5, point 2). */
const OWNERSHIP_EDGE_TYPES = ["OWNS", "TOUCHES", "PRODUCES"];

/** Project an optional string attr; a missing/non-string attr is emitted as null. */
function attrStr(attrs: Record<string, unknown> | null, key: string): string | null {
  const v = attrs?.[key];
  return typeof v === "string" ? v : null;
}

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  if (auth.memberTier !== "team") {
    return errorResponse("forbidden_tier", "the company graph is team-tier only", 403);
  }

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:company-graph:get`, 60))) {
    return errorResponse("rate_limited", "60 reads/min per key", 429);
  }

  // One entity read serves both halves: `people[]` (entity_type=actor) and the
  // server-side join that resolves ownership edge targets (typically workflows).
  const [entitiesRes, edgesRes] = await Promise.all([
    db
      .from("graph_entities")
      .select("entity_id, entity_type, name, attrs")
      .eq("team_id", auth.teamId)
      .order("entity_id"),
    db
      .from("graph_relationships")
      .select("from_id, to_id, relationship_type")
      .eq("team_id", auth.teamId)
      .in("relationship_type", OWNERSHIP_EDGE_TYPES)
      .order("from_id"),
  ]);
  if (entitiesRes.error) return errorResponse("internal", entitiesRes.error.message, 500);
  if (edgesRes.error) return errorResponse("internal", edgesRes.error.message, 500);

  type EntityRow = {
    entity_id: string;
    entity_type: string;
    name: string;
    attrs: Record<string, unknown> | null;
  };
  const entities = (entitiesRes.data ?? []) as EntityRow[];
  const byId = new Map(entities.map((e) => [e.entity_id, e]));

  // people[]: every actor entity; role/job_family/reports_to projected out of attrs
  // (the seed stores the whole fixture object in attrs), missing attrs → null.
  const people = entities
    .filter((e) => e.entity_type === "actor")
    .map((e) => ({
      entity_id: e.entity_id,
      name: e.name,
      role: attrStr(e.attrs, "role"),
      job_family: attrStr(e.attrs, "job_family"),
      reports_to: attrStr(e.attrs, "reports_to"),
    }));

  // ownership[]: OWNS/TOUCHES/PRODUCES edges with to_id resolved against the entity
  // read above — this join is what makes `--owns "<domain>"` substring queries
  // matchable. An edge whose to_id doesn't resolve is skipped (contract point 2).
  const ownership = (edgesRes.data ?? []).flatMap(
    (r: { from_id: string; to_id: string; relationship_type: string }) => {
      const target = byId.get(r.to_id);
      if (!target) return [];
      return [
        {
          person_id: r.from_id,
          relationship: r.relationship_type,
          target_id: r.to_id,
          target_kind: target.entity_type,
          target_name: target.name,
          target_job_family: attrStr(target.attrs, "job_family"),
        },
      ];
    }
  );

  return Response.json({ people, ownership });
}
