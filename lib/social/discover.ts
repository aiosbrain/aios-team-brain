import "server-only";
import type { DbClient } from "@/lib/db/types";
import { createOpportunity } from "./store";
import { DISCOVER_KINDS, scoreCandidate } from "./discover-score";
import type { AccessTier, OpportunityRow, SocialActor } from "./types";

/**
 * Content discovery (Social Brain): the on-ramp that turns existing brain knowledge into ranked
 * opportunities. It scans recent `items` of the notable kinds (decision/deliverable/artifact),
 * scores each with the deterministic heuristic (discover-score), and creates one opportunity per
 * item — idempotent by `item:<id>` so re-runs don't duplicate. Each opportunity inherits the
 * item's `access`, so the evidence→tier-leak invariant (store.createOpportunity) holds by
 * construction. No LLM; the scoring/selection is a first-cut heuristic meant to be product-steered.
 */

const MIN_BODY = 80; // skip trivial items (a one-line note isn't worth communicating)

export interface DiscoverOptions {
  /** Look back this many hours (default 30 days). */
  sinceHours?: number;
  /** Max items to scan (default 100). */
  limit?: number;
  /** Injected clock for deterministic scoring/tests. */
  now?: Date;
  actor?: SocialActor;
}

export interface DiscoverSummary {
  scanned: number;
  created: number;
  skipped: number;
  opportunities: OpportunityRow[];
}

interface CandidateRow {
  id: string;
  kind: string;
  access: AccessTier;
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  updated_at: string;
}

/** Title from frontmatter, else the path's basename (sans extension), else "Untitled". */
function deriveTitle(row: CandidateRow): string {
  const fmTitle = row.frontmatter?.title;
  if (typeof fmTitle === "string" && fmTitle.trim()) return fmTitle.trim().slice(0, 200);
  const base = row.path.split("/").pop() ?? row.path;
  const noExt = base.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  return noExt || "Untitled";
}

/** A one-line excerpt of the body for the opportunity summary. */
function excerpt(body: string, max = 280): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Topics from frontmatter tags/topics (string arrays only). */
function deriveTopics(row: CandidateRow): string[] {
  const raw = row.frontmatter?.topics ?? row.frontmatter?.tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string").slice(0, 10);
}

export async function discoverOpportunities(
  db: DbClient,
  teamId: string,
  opts: DiscoverOptions = {}
): Promise<DiscoverSummary> {
  const now = opts.now ?? new Date();
  const sinceHours = opts.sinceHours ?? 24 * 30;
  const since = new Date(now.getTime() - sinceHours * 3_600_000).toISOString();
  const limit = opts.limit ?? 100;

  const { data, error } = await db
    .from("items")
    .select("id, kind, access, path, body, frontmatter, updated_at")
    .eq("team_id", teamId)
    .in("kind", [...DISCOVER_KINDS])
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`discoverOpportunities: items scan failed: ${error.message}`);
  const items = (data ?? []) as CandidateRow[];

  // Which items already became opportunities (idempotency + accurate created/skipped counts).
  const { data: existing } = await db
    .from("social_opportunities")
    .select("dedup_key")
    .eq("team_id", teamId);
  const seen = new Set(
    ((existing ?? []) as { dedup_key: string | null }[]).map((r) => r.dedup_key).filter(Boolean)
  );

  const summary: DiscoverSummary = { scanned: items.length, created: 0, skipped: 0, opportunities: [] };

  for (const it of items) {
    const dedupKey = `item:${it.id}`;
    if (seen.has(dedupKey) || (it.body?.length ?? 0) < MIN_BODY) {
      summary.skipped++;
      continue;
    }
    const title = deriveTitle(it);
    const scores = scoreCandidate({
      kind: it.kind,
      updatedAtMs: Date.parse(it.updated_at),
      nowMs: now.getTime(),
      bodyLength: it.body.length,
      hasTitle: !!(it.frontmatter?.title),
    });
    const opp = await createOpportunity(
      db,
      teamId,
      {
        access: it.access, // per-item tier → evidence→tier invariant satisfied by construction
        sourceType: it.kind,
        title,
        summary: excerpt(it.body),
        evidence: [{ itemId: it.id, path: it.path }],
        topics: deriveTopics(it),
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
