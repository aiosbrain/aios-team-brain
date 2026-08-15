import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { adminClient } from "@/lib/db/admin";
import { graphitiConfigured, GraphitiClient } from "@/lib/graph/graphiti-client";
import { getLlmHealth, type LlmHealth } from "@/lib/query/llm-health";
import { resolveGraphChatTarget, resolveGraphEmbeddingTarget, isRefusal } from "@/lib/llm/graph-proxy";
import {
  groupCensuses,
  readExtractionSignals,
  type CensusRefusal,
  type ExtractionStallCause,
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
  /** Distinct ITEMS this team actually PUSHED to Graphiti (sentinel rows — tombstones, tier-vacates and
   *  unlanded reservations — excluded), null when the graph is off/unreadable. It is the SAME number the
   *  stall reason quotes, and it now comes from the same producer, after review found the card rendering
   *  an unfiltered total ("125 episodes") beside a reason string saying "25 episodes were projected":
   *  one number shown, a different one reasoned about. Renamed from `graphEpisodes` (STALLSCOPE-1): it
   *  has counted distinct items since PCCC-3, and one item is one-or-more chunk episodes. */
  graphItems: number | null;
  graphLastProjectedAt: string | null; // most recent successful projection (null = never)
  graphStalled: boolean; // degraded specifically because the projector stopped writing (vs unreachable)
  graphExtractionStalled: boolean; // episodes are reaching Graphiti (202) but no job is completing
  /**
   * WHICH stall — `never-extracted` (0 facts, ever) or `stopped` (jobs stopped completing). Null when
   * not stalled. The card MUST branch on this rather than composing its own copy: before STALLPROBE-1
   * both causes were the same sentence, and after it "extracting 0 facts" is true of only one of them.
   */
  graphExtractionCause: ExtractionStallCause | null;
  /** The server-composed operator sentence for that stall — single writer, shared verbatim with the
   *  pipeline banner via `lib/graph/extraction-health.extractionStallReason`. */
  graphExtractionReason: string | null;
  /**
   * A TRUE but NON-LOUD statement: this team has no completed extraction, and the graph worker is
   * provably completing other groups' work, so the likeliest cause is queue depth (STALLSCOPE-1 §2e).
   * Rendered as a note on this card and NOWHERE else — in particular it never reaches the pipeline
   * banner, whose sentence ("the brain isn't getting fresh data") would be false for it. Null unless
   * that state holds; a suppression nothing renders is how the census alarm sat silently dead.
   */
  graphExtractionNote: string | null;
  /** Hours between the newest pushed episode and the newest COMPLETED job. Passed to the card so its
   *  short leg text can quote the MEASURED lag instead of hard-coding the budget constant, which
   *  would drift silently if `EXTRACTION_LAG_BUDGET_MS` moved (and importing that constant into a
   *  component would drag a `server-only` module across the boundary). Null when either end is
   *  unknown. */
  graphExtractionLagHours: number | null;
  /** Newest extracted RELATES_TO fact (ISO), OBSERVATIONAL ONLY since STALLPROBE-1: it no longer
   *  accuses, because on a mature graph most extracted edges deduplicate and create no new fact, so a
   *  frozen fact clock is the normal state of a healthy extractor. Shown because it is still the
   *  answer to "is the graph learning anything NEW?", which is a real question — just not the same
   *  question as "is the extractor alive?". Null when the graph is off/unreadable or has no facts. */
  graphNewestFactAt: string | null;
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
    // ONE producer, shared with the pipeline banner (STALLSCOPE-1 §2g). This card used to assemble the
    // same six reads itself, which is how it missed the liveness signal entirely when that shipped —
    // and how its item count and the predicate's diverged again under PCCC-3. There is now one
    // assembler, so the two surfaces cannot describe different populations.
    graphExtraction,
    graphGroupCensuses,
    graphProxyRefusal,
    llm,
  ] =
    await Promise.all([
    denseHealth(teamId, configured),
    graphConfiguredNow ? new GraphitiClient().healthcheck() : Promise.resolve(false),
    graphConfiguredNow ? readExtractionSignals(teamId) : Promise.resolve(null),
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
  // From the SAME ledger pass as the items/groups/timestamps the verdict rests on. It used to be its
  // own `graphFreshness` query on this file's side — the second assembler PCCC-3 then changed on one
  // side only. Different SENTINEL treatment from `newestPushAtMs`, deliberately (see `LedgerRead`).
  const lastProjectedAt = graphExtraction?.lastProjectedAt ?? null;
  const lastProjectedAtMs = lastProjectedAt ? Date.parse(lastProjectedAt) : null;
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
  //
  // The verdict, the cause and the sentence all arrive from the ONE producer — this surface no longer
  // composes any of them. `graphReachable` still gates it: an unreachable service is a different leg's
  // report, and its reads answer nothing anyway.
  const graphExtractionStalled = graphReachable && (graphExtraction?.verdict.stalled ?? false);
  const graphExtractionCause = graphExtractionStalled ? (graphExtraction?.verdict.cause ?? null) : null;
  const graphExtractionLagHours = graphExtraction?.lagHours ?? null;
  const graphExtractionReason = graphExtractionStalled ? (graphExtraction?.reason ?? null) : null;
  // The suppressed-but-true state (STALLSCOPE-1 §2e): no completed extraction for this team, but the
  // worker is provably completing other groups' work, so this is queue depth rather than a failure. It
  // renders as a note on this card and reaches no banner.
  const graphExtractionNote = graphReachable ? (graphExtraction?.note ?? null) : null;
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
    graphItems: graphExtraction?.signals.items ?? null,
    graphLastProjectedAt: lastProjectedAt,
    graphStalled,
    graphExtractionStalled,
    graphExtractionCause,
    graphExtractionReason,
    graphExtractionNote,
    graphExtractionLagHours,
    graphNewestFactAt:
      graphExtraction?.newestFactAtMs == null
        ? null
        : new Date(graphExtraction.newestFactAtMs).toISOString(),
    graphCensusPolluted,
    graphCensus,
    graphProxyRefusal,
    graphFacts: graphExtraction?.signals.facts ?? null,
    rerank,
    augment,
    llm,
    emailDeliverable,
  };
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
