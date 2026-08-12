import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { adminClient } from "@/lib/db/admin";
import { graphitiConfigured, GraphitiClient } from "@/lib/graph/graphiti-client";
import { getLlmHealth, type LlmHealth } from "@/lib/query/llm-health";
import { resolveGraphChatTarget, resolveGraphEmbeddingTarget, isRefusal } from "@/lib/llm/graph-proxy";
import {
  countGraphFacts,
  deriveGraphExtractionStalled,
  groupCensuses,
  newestEpisodeAtMs,
  newestEpisodicAtMs,
  newestFactAtMs,
  type CensusRefusal,
  type GroupCensus,
} from "@/lib/graph/extraction-health";
import { resolveEmbeddingBackend } from "@/lib/query/embedding-key";

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
  graphExtractionStalled: boolean; // episodes are reaching Graphiti (202) but its extractor makes no facts
  /** Extraction runs, but a group's same-name entity-split rate is over its own baseline — the
   *  name-collision census (AIO-693 re-armed by ALARMFIX-1). Never true while the alarm is unarmed
   *  (`CENSUS_ALARM_ARMED`), but the per-group numbers below show either way. */
  graphCensusPolluted: boolean;
  /** The per-group census the admin card renders: names active in the recent window, how many are
   *  split across >1 node, the share vs baseline, and the refusal cause when unjudgeable. */
  graphCensus: GroupCensusSummary[];
  /** A CONFIG refusal from the graph LLM proxy — Anthropic selected, embeddings unset or the wrong
   *  width, ambiguous team. Resolved from settings only (no upstream call, no spend), so it is free
   *  to check on every render and lands here INSTANTLY. Without it a misconfiguration is
   *  indistinguishable from the quota death this proxy was built to prevent: both would surface only
   *  as a stall, 6h later, with the actionable message buried in another service's logs. */
  graphProxyRefusal: string | null;
  graphFacts: number | null; // extracted RELATES_TO facts in Neo4j (null = unreadable)
  rerank: LegState;
  augment: LegState; // optional external retrieval-augment service (RETRIEVAL_AUGMENT_URL)
  llm: LlmHealth; // answering-model health — did the configured model recently produce output?
  emailDeliverable: boolean; // a provider is configured (RESEND_API_KEY/SMTP_URL) so alerts/invites can actually send
}

/** One group's census, shaped for the card (derived from `lib/graph/extraction-health.GroupCensus`). */
export interface GroupCensusSummary {
  group: string;
  recentNames: number | null;
  recentSplit: number | null;
  recentShare: number | null; // 0..1, null when not computable
  baselineShare: number | null;
  refusal: CensusRefusal | null; // null = judged
  judgeable: boolean;
  polluted: boolean;
  /** Entity nodes created in the same recent window (PIPEFF-2). Null = graph unreadable. */
  recentEntities: number | null;
  /** Entities created ÷ episodes projected, both over the recent window. **OBSERVATIONAL** — it
   *  gates nothing (no leg state, no banner, no mail); it is displayed so the same-item predecessor
   *  filter's one plausible failure mode (variant-name fragmentation, which the split-share census
   *  is blind to by construction) has a sensor at all. Null when the window projected nothing —
   *  never Infinity, never a zero that reads as a measurement. */
  entitiesPerEpisode: number | null;
}

const COVERAGE_FLOOR = 0.9; // ≥90% embedded = healthy
const STALE_MS = 2 * 60 * 60 * 1000; // no embed activity in 2h + incomplete = stalled, not "building"

/**
 * True when GRAPHITI_URL is a usable http(s) URL with a host (prod had a malformed "http://").
 * Single source of truth with the runtime GraphitiClient, so the health card and the code that
 * actually calls Graphiti agree on whether the leg is on.
 */
export const graphConfigured = graphitiConfigured;

/** Whether the graph has any projected episodes for this team — the proxy for "facts exist to
 *  synthesize arcs from." Empty ⇒ the projector never populated the graph (a graph/projector issue),
 *  as opposed to a synthesis/model failure. Best-effort: false on any error. */
export async function graphHasFacts(teamId: string): Promise<boolean> {
  try {
    const res = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1",
      [teamId]
    );
    return (res.rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

// Reachable but no projection in this long ⇒ the graph is going stale even though /healthcheck is
// green. This is the 2026-07 failure a healthcheck-only probe MISSED: Graphiti's write endpoint
// 422'd for days (projector wedged) while the service kept answering /healthcheck, so the card read
// "on" while the Learning page slowly emptied. Freshness of the write path is the real signal.
const GRAPH_STALE_MS = 6 * 60 * 60 * 1000;

/** A projector that hasn't written in > GRAPH_STALE_MS is stalled. `null` = nothing has ever projected
 *  (fresh install / nothing to project) → NOT a stall. Pure + unit-tested. */
export function isGraphStale(lastProjectedAtMs: number | null, nowMs: number): boolean {
  return lastProjectedAtMs !== null && nowMs - lastProjectedAtMs > GRAPH_STALE_MS;
}

/**
 * Derive the graph-leg state from its raw signals. Pure + unit-tested:
 *   • not configured (no/malformed GRAPHITI_URL)             → "off"
 *   • configured BUT /healthcheck failed (down/unreachable)   → "degraded"
 *   • reachable BUT projector hasn't written in > GRAPH_STALE_MS (writes failing) → "degraded"
 *   • reachable + writing BUT extraction is failing — no facts from projected episodes, or facts
 *     polluted by abnormal duplicate-entity rates (both arrive via `extractionStalled`) → "degraded"
 *   • reachable AND recently projected (or nothing to project yet) → "on"
 */
export function deriveGraphState(input: {
  configured: boolean;
  reachable: boolean;
  lastProjectedAtMs: number | null;
  extractionStalled: boolean;
  nowMs: number;
}): GraphState {
  if (!input.configured) return "off";
  if (!input.reachable) return "degraded";
  if (isGraphStale(input.lastProjectedAtMs, input.nowMs)) return "degraded";
  if (input.extractionStalled) return "degraded"; // accepting episodes but extracting no facts
  return "on";
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
  const augment: LegState = process.env.RETRIEVAL_AUGMENT_URL ? "on" : "off";
  const emailDeliverable = !!(process.env.RESEND_API_KEY || process.env.SMTP_URL);
  // Dense is "configured" when the team has a RESOLVED embeddings backend — the Admin pick
  // (teams.embedding_provider) OR env EMBEDDINGS_URL — not env alone, else a team-configured install
  // reads "off" and never alerts on an outage.
  const configured = (await resolveEmbeddingBackend(teamId)) !== null;

  // Graph + dense both hit the network — run them concurrently so the card render isn't serialized.
  const graphConfiguredNow = graphConfigured(process.env.GRAPHITI_URL);
  const [
    dense,
    graphReachable,
    graphFresh,
    graphFacts,
    graphNewestFactAt,
    graphNewestEpisodeAt,
    graphNewestEpisodicAt,
    graphGroupCensuses,
    graphProxyRefusal,
    llm,
  ] =
    await Promise.all([
    denseHealth(teamId, configured),
    graphConfiguredNow ? new GraphitiClient().healthcheck() : Promise.resolve(false),
    graphConfiguredNow ? graphFreshness(teamId) : Promise.resolve({ episodes: null, lastProjectedAt: null }),
    graphConfiguredNow ? countGraphFacts() : Promise.resolve(null),
    graphConfiguredNow ? newestFactAtMs() : Promise.resolve(null),
    graphConfiguredNow ? newestEpisodeAtMs(teamId) : Promise.resolve(null),
    // When graphiti last FINISHED a job — the liveness leg (STALLPROBE-1).
    graphConfiguredNow ? newestEpisodicAtMs() : Promise.resolve(null),
    graphConfiguredNow ? groupCensuses(teamId) : Promise.resolve([] as GroupCensus[]),
    // Config-only resolution: no upstream call, nothing spent. Best-effort — a broken probe must
    // never fail the admin page.
    graphConfiguredNow
      ? Promise.all([
          resolveGraphChatTarget(adminClient(), teamId),
          resolveGraphEmbeddingTarget(adminClient(), teamId),
        ])
          .then(([chat, embed]) =>
            isRefusal(chat) ? chat.message : isRefusal(embed) ? embed.message : null
          )
          .catch(() => null)
      : Promise.resolve(null),
    getLlmHealth(teamId),
  ]);
  const lastProjectedAtMs = graphFresh.lastProjectedAt ? Date.parse(graphFresh.lastProjectedAt) : null;
  const nowMs = Date.now();
  // Reachable + writing, but projected episodes aren't becoming facts (Graphiti's extractor is failing
  // on every job). Only meaningful when reachable — an unreachable service reports facts=null.
  // The lag compares against `graphNewestEpisodeAt`, NOT `lastProjectedAtMs`. They differ by exactly
  // the thing that matters: `lastProjectedAtMs` is the newest `projected_at` on ANY ledger row
  // regardless of the sentinel, while the lag needs the newest episode actually PUSHED, since a
  // redaction wave bumps the ledger without producing anything for Graphiti to extract.
  //
  // Since GRAPHCOST-1, `projected_at` advances only on a pass that actually POSTed episodes: a
  // re-projection whose chunks were all unchanged (an edit past the extraction cap) writes the ledger
  // and deliberately leaves the timestamp alone, because bumping it would make `newestEpisodeAtMs`
  // above report a push that never happened and cry wolf on the extraction-lag probe. The tradeoff is
  // here: `isGraphStale` reads "the projector is alive" from pushes, so a ≥6h window whose ONLY
  // projection activity was such passes reads as quiet. That is a widening of a false-positive the
  // unchanged-content skip already had (it never bumped either), and it errs toward the alarm that is
  // actionable — "nothing has been pushed in 6h" is true in that window.
  const graphExtractionStalled =
    graphReachable &&
    deriveGraphExtractionStalled({
      episodes: graphFresh.episodes,
      facts: graphFacts,
      newestEpisodeAtMs: graphNewestEpisodeAt,
      newestFactAtMs: graphNewestFactAt,
      // STALLPROBE-1. This call site was MISSED when the liveness leg was first added, because the
      // field was optional and "omitted ⇒ old behaviour" — so the pipeline banner got the fix while
      // THIS card, the one that produced the bug report, kept the false positive and the two surfaces
      // silently disagreed. The field is required now; `test/guards/extraction-stall-callsites` is the
      // backstop.
      newestEpisodicAtMs: graphNewestEpisodicAt,
    });
  // The OTHER extraction failure: episodes become facts, but the facts are confidently wrong —
  // same-name entity splits accumulating from a model/embedding stack resolving identity badly
  // (AIO-693, the 2026-07-30 incident; census signal since ALARMFIX-1). Same detector as the
  // pipeline banner + the admin email alarm, so all three surfaces flip on the same evidence and
  // can't drift apart.
  const graphCensus: GroupCensusSummary[] = graphGroupCensuses.map((c) => ({
    group: c.group,
    recentNames: c.signals.recentNames,
    recentSplit: c.signals.recentSplit,
    recentShare: c.pollution.recentShare,
    baselineShare: c.pollution.baselineShare,
    refusal: c.pollution.refusal,
    judgeable: c.pollution.judgeable,
    polluted: c.pollution.polluted,
    recentEntities: c.recentEntities,
    entitiesPerEpisode: c.entitiesPerEpisode,
  }));
  // NOTE (PIPEFF-2): `entitiesPerEpisode` is carried to the card and STOPS THERE. It is not read by
  // `graphCensusPolluted` below, by `deriveGraphState`, or by `lib/graph/extraction-alert`. Wiring it
  // into any of those would arm an alarm on a band nobody has measured yet.
  const graphCensusPolluted = graphReachable && graphCensus.some((c) => c.judgeable && c.polluted);
  const graph = deriveGraphState({
    configured: graphConfiguredNow,
    reachable: graphReachable,
    lastProjectedAtMs,
    // Either extraction failure degrades the leg — no facts, or wrong facts.
    extractionStalled: graphExtractionStalled || graphCensusPolluted,
    nowMs,
  });
  // Degraded specifically because the projector went quiet (reachable, but a stale write path) — the
  // card renders a different, more actionable banner for this than for a hard-unreachable service.
  const graphStalled = graph === "degraded" && graphReachable && isGraphStale(lastProjectedAtMs, nowMs);
  return {
    keyword: "on",
    dense,
    graph,
    graphEpisodes: graphFresh.episodes,
    graphLastProjectedAt: graphFresh.lastProjectedAt,
    graphStalled,
    graphExtractionStalled,
    graphCensusPolluted,
    graphCensus,
    graphProxyRefusal,
    graphFacts,
    rerank,
    augment,
    llm,
    emailDeliverable,
  };
}

/** Projection freshness from the `graph_episodes` ledger (Postgres, no Graphiti round-trip): how many
 *  episodes this team has projected and when the projector last succeeded. Drives the "reachable but
 *  stalled" degraded state. Best-effort — nulls on any error so the card still renders. */
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
  if (!configured)
    return {
      ...empty,
      note: "No embeddings model configured (Admin → Integrations) and EMBEDDINGS_URL not set — semantic search is off; keyword search still works.",
    };

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
