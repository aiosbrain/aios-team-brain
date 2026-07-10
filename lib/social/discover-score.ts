/**
 * Deterministic opportunity scoring (Social Brain discovery). Pure + clock-injected so the
 * heuristic is unit-testable and reproducible. This is a FIRST-CUT heuristic (product-steerable):
 * it ranks a brain `items` row on how worth-communicating it looks, from cheap signals only —
 * recency, kind, and substance. No LLM. Scores are 0..1; the store persists them and later
 * ranking/planning consumes them.
 */

/** Item kinds discovery considers notable enough to surface as opportunities. */
export const DISCOVER_KINDS = ["decision", "deliverable", "artifact"] as const;

export interface ScoreInput {
  kind: string;
  updatedAtMs: number;
  nowMs: number;
  bodyLength: number;
  hasTitle: boolean;
}

export interface OpportunityScores {
  novelty: number;
  relevance: number;
  urgency: number;
  confidence: number;
}

// Kind weights — a decision is the most communicable, a raw artifact (e.g. a commit) the least.
const KIND_RELEVANCE: Record<string, number> = { decision: 0.9, deliverable: 0.7, artifact: 0.6 };
const KIND_URGENCY: Record<string, number> = { decision: 0.6, deliverable: 0.35, artifact: 0.3 };

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Exponential recency decay: 1.0 at age 0, 0.5 at one half-life, → 0 as it ages out. */
export function recencyFactor(ageMs: number, halfLifeDays = 14): number {
  const days = Math.max(0, ageMs) / 86_400_000;
  return clamp01(Math.pow(0.5, days / halfLifeDays));
}

export function scoreCandidate(input: ScoreInput): OpportunityScores {
  const recency = recencyFactor(input.nowMs - input.updatedAtMs);
  const relevance = KIND_RELEVANCE[input.kind] ?? 0.5;
  const urgency = (KIND_URGENCY[input.kind] ?? 0.3) * (0.5 + 0.5 * recency);
  // Substance: a longer body reads as more communicable, saturating at ~500 chars.
  const substance = clamp01(input.bodyLength / 500);
  const confidence = 0.2 * (input.hasTitle ? 1 : 0) + 0.8 * substance;
  return {
    novelty: round2(recency),
    relevance: round2(relevance),
    urgency: round2(clamp01(urgency)),
    confidence: round2(clamp01(confidence)),
  };
}
