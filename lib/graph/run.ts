import "server-only";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import { GraphitiClient } from "./graphiti-client";
import { projectItemsToGraph } from "./project";

/**
 * Graph-projection runner — the on-ramp that actually drives `projectSlackToGraph` (which is
 * otherwise just a library function nobody calls). Mirrors `lib/ingest/run.ts`: resolve the
 * team(s), then project each. Two callers: the admin "Project to graph" action (on-demand) and
 * `lib/graph/scheduler.ts` (interval). Inert when Graphiti isn't configured (no GRAPHITI_URL) — it
 * returns a clean `configured:false` skip instead of throwing, so prod (where the graph is off)
 * is a cheap no-op.
 */

export interface GraphProjectionSummary {
  ok: boolean;
  /** Whether GRAPHITI_URL is set. When false nothing ran — the rest are zero. */
  configured: boolean;
  teams: number;
  scanned: number;
  projected: number;
  skipped: number;
  errors: string[];
}

// Phase 1 keeps a single run bounded (episodes are LLM-extracted on Graphiti's side). The per-row
// sha dedup makes re-runs cheap no-ops; a backlog larger than this needs cursor pagination (Phase 2).
const DEFAULT_LIMIT = Number(process.env.GRAPH_PROJECT_LIMIT ?? 500);

async function resolveTeams(
  supabase: DbClient,
  teamId?: string
): Promise<{ id: string; slug: string }[]> {
  let q = supabase.from("teams").select("id, slug");
  if (teamId) q = q.eq("id", teamId);
  const { data, error } = await q;
  if (error) throw new Error(`graph projection: load teams failed: ${error.message}`);
  return (data ?? []) as { id: string; slug: string }[];
}

export async function runGraphProjection(opts?: {
  teamId?: string;
  client?: GraphitiClient;
  supabase?: DbClient;
  limit?: number;
}): Promise<GraphProjectionSummary> {
  const client = opts?.client ?? new GraphitiClient();
  const summary: GraphProjectionSummary = {
    ok: true,
    configured: client.configured,
    teams: 0,
    scanned: 0,
    projected: 0,
    skipped: 0,
    errors: [],
  };
  if (!client.configured) return summary; // nowhere to project — skip cleanly

  const supabase = opts?.supabase ?? adminClient();
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const teams = await resolveTeams(supabase, opts?.teamId);
  summary.teams = teams.length;

  for (const t of teams) {
    try {
      const s = await projectItemsToGraph(supabase, {
        teamId: t.id,
        teamSlug: t.slug,
        client,
        limit,
      });
      summary.scanned += s.scanned;
      summary.projected += s.projected;
      summary.skipped += s.skipped;
    } catch (e) {
      summary.ok = false;
      summary.errors.push(`${t.slug}: ${e instanceof Error ? e.message : "projection failed"}`);
    }
  }
  return summary;
}
