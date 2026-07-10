import "server-only";
import type { DbClient } from "@/lib/db/types";
import { getArcs, type NarrativeArc, type ProviderKeys } from "@/lib/graph/arcs";
import { createOpportunity } from "./store";
import { evidenceCeiling } from "./tier";
import { recencyFactor, type OpportunityScores } from "./discover-score";
import type { AccessTier, Evidence, OpportunityRow, SocialActor } from "./types";
import type { DiscoverSummary } from "./discover";

/**
 * Content discovery FROM narrative arcs (Social Brain). Where `discover.ts` turns individual `items`
 * into opportunities, this turns the team's Layer-3 narrative arcs (`lib/graph/arcs.getArcs`) into
 * opportunities — the "look at the arcs and pick stories to post" on-ramp. Arcs are already
 * synthesized, evidence-backed, and human-attributed, so an arc is a natural candidate story.
 *
 * Idempotent by `arc:<arc.id>` (arc ids are stable content hashes). **Tier safety:** an arc's
 * evidence can span several items of mixed tier, so each opportunity's `access` is computed as the
 * most-restrictive tier across its evidence (`evidenceCeiling`) — a story built from any internal
 * (`team`) item can never become an `external` (publicly postable) opportunity. `createOpportunity`
 * re-checks this invariant as the single writer; we compute it here so we never hand it an
 * over-exposed request.
 */

export interface DiscoverArcsOptions {
  now?: Date;
  actor?: SocialActor;
  /** Inject arcs instead of fetching via `getArcs` — used by tests (getArcs needs Neo4j). */
  arcs?: NarrativeArc[];
}

const CONFIDENCE_SCORE: Record<NarrativeArc["confidence"], number> = { high: 0.9, medium: 0.6, low: 0.3 };

/** Deterministic scoring for an arc-sourced opportunity — arc confidence drives the confidence
 *  score; recency (from `derived_at`) drives novelty/urgency; arcs are synthesized storylines so
 *  relevance is high by construction. Pure + clock-injected, mirroring `discover-score`. */
export function scoreArc(arc: NarrativeArc, nowMs: number): OpportunityScores {
  const derivedMs = Date.parse(arc.derived_at);
  const recency = recencyFactor(nowMs - (Number.isFinite(derivedMs) ? derivedMs : nowMs));
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return {
    novelty: round2(recency),
    relevance: 0.8, // an arc is a curated storyline, not a raw item — inherently worth communicating
    urgency: round2(0.5 * (0.5 + 0.5 * recency)),
    confidence: CONFIDENCE_SCORE[arc.confidence],
  };
}

/** An arc's evidence → opportunity `Evidence[]`, keeping only entries that link back to a brain item. */
export function arcEvidence(arc: NarrativeArc): Evidence[] {
  return arc.evidence
    .filter((e) => !!e.itemId)
    .map((e) => ({ itemId: e.itemId, ...(e.source ? { note: e.source } : {}) }));
}

/** Resolve the `access` tier of a batch of item ids in one query → `Map<itemId, tier>`. Missing ids
 *  simply don't appear (the caller counts them as restrictive, fail-closed). Best-effort empty map. */
async function resolveItemTiers(db: DbClient, teamId: string, itemIds: string[]): Promise<Map<string, AccessTier>> {
  const out = new Map<string, AccessTier>();
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return out;
  const { data } = await db.from("items").select("id, access").eq("team_id", teamId).in("id", ids);
  for (const r of (data ?? []) as { id: string; access: AccessTier }[]) out.set(r.id, r.access);
  return out;
}

/** The tier-safe `access` for an arc, from its evidence items' tiers (missing → restrictive). */
function arcAccess(evidence: Evidence[], tiers: Map<string, AccessTier>): AccessTier {
  const ids = evidence.map((e) => e.itemId).filter((id): id is string => !!id);
  const resolved = ids.map((id) => tiers.get(id)).filter((t): t is AccessTier => !!t);
  const missing = ids.length - resolved.length;
  return evidenceCeiling(resolved, missing);
}

/**
 * Discover opportunities from the team's narrative arcs. Fetches arcs (or uses injected ones),
 * creates one opportunity per arc at its tier-safe access, idempotent by `arc:<id>`.
 */
export async function discoverOpportunitiesFromArcs(
  db: DbClient,
  teamId: string,
  teamSlug: string,
  tier: AccessTier,
  groups: string[],
  keys: ProviderKeys,
  opts: DiscoverArcsOptions = {}
): Promise<DiscoverSummary> {
  const now = opts.now ?? new Date();
  const arcs = opts.arcs ?? (await getArcs(db, teamId, teamSlug, tier, groups, keys));

  // Resolve every arc's evidence-item tiers in one pass so per-arc access is a pure in-memory calc.
  const allItemIds = arcs.flatMap((a) => a.evidence.map((e) => e.itemId).filter((id): id is string => !!id));
  const tiers = await resolveItemTiers(db, teamId, allItemIds);

  const { data: existing } = await db.from("social_opportunities").select("dedup_key").eq("team_id", teamId);
  const seen = new Set(
    ((existing ?? []) as { dedup_key: string | null }[]).map((r) => r.dedup_key).filter(Boolean)
  );

  const summary: DiscoverSummary = { scanned: arcs.length, created: 0, skipped: 0, opportunities: [] as OpportunityRow[] };

  for (const arc of arcs) {
    const dedupKey = `arc:${arc.id}`;
    if (seen.has(dedupKey)) {
      summary.skipped++;
      continue;
    }
    const evidence = arcEvidence(arc);
    const access = arcAccess(evidence, tiers);
    const scores = scoreArc(arc, now.getTime());
    const opp = await createOpportunity(
      db,
      teamId,
      {
        access,
        sourceType: "arc",
        title: arc.title,
        summary: arc.summary,
        evidence,
        topics: [],
        noveltyScore: scores.novelty,
        relevanceScore: scores.relevance,
        urgencyScore: scores.urgency,
        confidenceScore: scores.confidence,
        dedupKey,
      },
      opts.actor
    );
    seen.add(dedupKey);
    summary.created++;
    summary.opportunities.push(opp);
  }
  return summary;
}
