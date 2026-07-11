import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { graphitiConfigured, GraphitiClient } from "@/lib/graph/graphiti-client";

/**
 * Retrieval-stack health for the admin dashboard (Phase 1 of the retrieval-observability plan).
 *
 * Keyword FTS is always on and local. The other legs are optional + externally-dependent and can
 * silently drop out — dense (pgvector + an embeddings provider) especially, which we watched go dark
 * under an OpenAI quota outage with zero signal. This computes a per-leg status + the dense embedding
 * COVERAGE (embedded vs embeddable items) so "is semantic search actually working right now, and how
 * much of the corpus does it cover?" is answerable on the dashboard instead of invisible.
 *
 * Best-effort: the whole thing degrades to sane defaults on error (never throws into a page render).
 */

export type LegState = "on" | "off";
export type DenseState = "off" | "healthy" | "building" | "degraded";
// Graph is externally-dependent like dense, so it gets the same "configured-but-broken" middle state:
// "degraded" = GRAPHITI_URL set but the service didn't answer /healthcheck (down/misconfigured). A
// configured URL alone isn't proof the leg works — Graphiti's worker dies silently.
export type GraphState = "off" | "on" | "degraded";

export interface DenseHealth {
  state: DenseState;
  embeddableItems: number;
  embeddedItems: number;
  pendingItems: number;
  coveragePct: number; // 0–100
  lastEmbeddedAt: string | null;
  lastRunFailed: boolean;
  note?: string;
}

export interface RetrievalHealth {
  keyword: LegState; // always "on"
  dense: DenseHealth;
  graph: GraphState;
  rerank: LegState;
}

const COVERAGE_FLOOR = 0.9; // ≥90% embedded = healthy
const STALE_MS = 2 * 60 * 60 * 1000; // no embed activity in 2h + incomplete = stalled, not "building"

/**
 * True when GRAPHITI_URL is a usable http(s) URL with a host (prod had a malformed "http://").
 * Single source of truth with the runtime GraphitiClient, so the health card and the code that
 * actually calls Graphiti agree on whether the leg is on.
 */
export const graphConfigured = graphitiConfigured;

/**
 * Derive the graph-leg state from its raw signals. Pure + unit-tested:
 *   • not configured (no/malformed GRAPHITI_URL)         → "off"
 *   • configured AND /healthcheck answered                → "on"
 *   • configured BUT /healthcheck failed (down/unreachable) → "degraded"
 */
export function deriveGraphState(input: { configured: boolean; reachable: boolean }): GraphState {
  if (!input.configured) return "off";
  return input.reachable ? "on" : "degraded";
}

/**
 * Derive the dense-leg state from the raw signals. Pure + unit-tested — the fiddly bit is separating
 * "off" (not set up) from "building" (catching up, amber) from "degraded" (erroring or stalled, red)
 * from "healthy" (green). `embeddable === 0` is healthy (nothing to embed).
 */
export function deriveDenseState(input: {
  configured: boolean; // EMBEDDINGS_URL set
  pgvectorLoaded: boolean; // item_chunks table present
  embeddable: number;
  embedded: number;
  lastRunFailed: boolean;
  lastEmbeddedAtMs: number | null;
  nowMs: number;
}): DenseState {
  if (!input.configured || !input.pgvectorLoaded) return "off";
  if (input.lastRunFailed) return "degraded"; // embedding is erroring right now (e.g. quota/outage)
  if (input.embeddable === 0) return "healthy";
  const coverage = input.embedded / input.embeddable;
  if (coverage >= COVERAGE_FLOOR) return "healthy";
  const stalled = input.lastEmbeddedAtMs === null || input.nowMs - input.lastEmbeddedAtMs > STALE_MS;
  return stalled ? "degraded" : "building"; // incomplete + not progressing = degraded; else catching up
}

export async function getRetrievalHealth(teamId: string): Promise<RetrievalHealth> {
  const rerank: LegState = process.env.RERANK_URL ? "on" : "off";
  const configured = !!process.env.EMBEDDINGS_URL;

  // Graph + dense both hit the network — run them concurrently so the card render isn't serialized.
  const graphConfiguredNow = graphConfigured(process.env.GRAPHITI_URL);
  const [dense, graphReachable] = await Promise.all([
    denseHealth(teamId, configured),
    graphConfiguredNow ? new GraphitiClient().healthcheck() : Promise.resolve(false),
  ]);
  const graph = deriveGraphState({ configured: graphConfiguredNow, reachable: graphReachable });
  return { keyword: "on", dense, graph, rerank };
}

async function denseHealth(teamId: string, configured: boolean): Promise<DenseHealth> {
  const empty: DenseHealth = {
    state: "off",
    embeddableItems: 0,
    embeddedItems: 0,
    pendingItems: 0,
    coveragePct: 0,
    lastEmbeddedAt: null,
    lastRunFailed: false,
  };
  if (!configured) return { ...empty, note: "EMBEDDINGS_URL not set — semantic search is off; keyword search still works." };

  try {
    // Coverage: embeddable items (non-empty body) vs those with an up-to-date chunk. Throws if the
    // optional pgvector schema (item_chunks) isn't loaded → treated as "off" below.
    const cov = await runSql<{ embeddable: number | string; embedded: number | string; last: string | Date | null }>(
      `with ch as (select item_id, min(content_sha256) as sha from item_chunks where team_id = $1 group by item_id)
       select
         count(*) filter (where i.body <> '') as embeddable,
         count(*) filter (where i.body <> '' and ch.sha = i.content_sha256) as embedded,
         (select max(created_at) from item_chunks where team_id = $1) as last
       from items i
       left join ch on ch.item_id = i.id
       where i.team_id = $1`,
      [teamId]
    );
    const embeddable = Number(cov.rows[0]?.embeddable ?? 0);
    const embedded = Number(cov.rows[0]?.embedded ?? 0);
    const lastRaw = cov.rows[0]?.last ?? null;
    const lastEmbeddedAt = lastRaw instanceof Date ? lastRaw.toISOString() : (lastRaw as string | null);

    // Most recent dense embedding run (per-team or instance-wide) — a failed one = degraded now.
    const runRes = await runSql<{ ok: boolean }>(
      `select ok from ingest_runs where source = 'dense' and (team_id = $1 or team_id is null)
       order by finished_at desc limit 1`,
      [teamId]
    );
    const lastRunFailed = runRes.rows.length > 0 && runRes.rows[0].ok === false;

    const state = deriveDenseState({
      configured: true,
      pgvectorLoaded: true,
      embeddable,
      embedded,
      lastRunFailed,
      lastEmbeddedAtMs: lastEmbeddedAt ? Date.parse(lastEmbeddedAt) : null,
      nowMs: Date.now(),
    });
    return {
      state,
      embeddableItems: embeddable,
      embeddedItems: embedded,
      pendingItems: Math.max(0, embeddable - embedded),
      coveragePct: embeddable ? Math.round((embedded / embeddable) * 100) : 100,
      lastEmbeddedAt,
      lastRunFailed,
      note:
        state === "degraded"
          ? "Semantic search is degraded — recent embeddings failed (check the embeddings provider/quota). Keyword search is unaffected."
          : state === "building"
            ? "Semantic index is catching up on the backlog."
            : undefined,
    };
  } catch {
    // item_chunks missing (pgvector schema not loaded) or a DB hiccup → semantic search is effectively off.
    return { ...empty, note: "pgvector schema not loaded — semantic search is off; keyword search still works." };
  }
}
