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
  graphEpisodes: number | null; // projected episodes for this team (null when graph off/unreadable)
  graphLastProjectedAt: string | null; // most recent successful projection (null = never)
  graphStalled: boolean; // degraded specifically because the projector stopped writing (vs unreachable)
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
 *   • not configured (no/malformed GRAPHITI_URL)             → "off"
 *   • configured BUT /healthcheck failed (down/unreachable)   → "degraded"
 *   • reachable BUT the last projection RUN errored (writes failing, e.g. Graphiti 422) → "degraded"
 *   • reachable AND the projector isn't erroring                → "on"
 *
 * Keyed on the last `graph_project` run's ok-flag, NOT time-since-last-projection: a team with nothing
 * new to ingest is quiet, not broken, so a pure "no writes in 6h" staleness would cry wolf every idle
 * night/weekend. The run flag only goes false when a projection tick actually errored — which is the
 * 2026-07 failure (Graphiti 422'd every write while `/healthcheck` stayed green).
 */
export function deriveGraphState(input: {
  configured: boolean;
  reachable: boolean;
  lastRunFailed: boolean;
}): GraphState {
  if (!input.configured) return "off";
  if (!input.reachable) return "degraded";
  return input.lastRunFailed ? "degraded" : "on";
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
  const [dense, graphReachable, graphFresh, graphRunFailed] = await Promise.all([
    denseHealth(teamId, configured),
    graphConfiguredNow ? new GraphitiClient().healthcheck() : Promise.resolve(false),
    graphConfiguredNow ? graphFreshness(teamId) : Promise.resolve({ episodes: null, lastProjectedAt: null }),
    graphConfiguredNow ? lastGraphProjectRunFailed() : Promise.resolve(false),
  ]);
  const graph = deriveGraphState({ configured: graphConfiguredNow, reachable: graphReachable, lastRunFailed: graphRunFailed });
  // Degraded specifically because the projector's last run errored (reachable, but writes failing) —
  // the card renders a different, more actionable banner for this than for a hard-unreachable service.
  const graphStalled = graph === "degraded" && graphReachable && graphRunFailed;
  return {
    keyword: "on",
    dense,
    graph,
    graphEpisodes: graphFresh.episodes,
    graphLastProjectedAt: graphFresh.lastProjectedAt,
    graphStalled,
    rerank,
  };
}

/** Projection freshness from the `graph_episodes` ledger (Postgres, no Graphiti round-trip): how many
 *  episodes this team has projected and when the projector last succeeded. Drives the "reachable but
 *  stalled" degraded state. Best-effort — nulls on any error so the card still renders. */
/** Is the projector failing RIGHT NOW? The scheduler records each tick with a signal to `ingest_runs`
 *  (source='graph_project', global). A persistent failure (e.g. Graphiti 422 on every write) re-records
 *  `ok=false` every tick, so it stays "recent"; a single transient failure ages out of the window (a
 *  quiet team records nothing on healthy ticks, so without the window one old failure would latch
 *  "degraded" forever — the false-alarm H7 exists to avoid). Window = a few projector intervals.
 *  No recent run ⇒ not failing. Best-effort. */
async function lastGraphProjectRunFailed(): Promise<boolean> {
  try {
    const intervalMin = Math.max(1, Number(process.env.GRAPH_PROJECT_MINUTES ?? 60));
    const windowMin = Math.max(3 * intervalMin, 180);
    const res = await runSql<{ ok: boolean }>(
      "select ok from ingest_runs where source = 'graph_project' and finished_at > now() - ($1::int * interval '1 minute') order by finished_at desc limit 1",
      [windowMin]
    );
    return res.rows[0]?.ok === false;
  } catch {
    return false;
  }
}

async function graphFreshness(teamId: string): Promise<{ episodes: number | null; lastProjectedAt: string | null }> {
  try {
    const res = await runSql<{ n: string; mx: string | null }>(
      "select count(*)::int as n, max(projected_at) as mx from graph_episodes where team_id = $1",
      [teamId]
    );
    const row = res.rows[0];
    return { episodes: row ? Number(row.n) : 0, lastProjectedAt: row?.mx ?? null };
  } catch {
    return { episodes: null, lastProjectedAt: null };
  }
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
