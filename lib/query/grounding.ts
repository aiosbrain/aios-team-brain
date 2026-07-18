import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { isRestrictedTier } from "@/lib/auth/visibility";

/**
 * Term-specificity analysis for the grounding signal (Gap #3). The old signal was
 * `grounded = any FTS hit exists`; under OR-semantics one incidental common word ("update" chatter
 * across channels) flipped it true for a topic never ingested → the abstain safety stopped firing.
 *
 * The fix keys on term RARITY (document frequency), not term count or ts_rank — because a specific
 * single-term query ("SSRF", "AIO-146", a person's name) is strongly grounded but scores low on both.
 * A term is "specific" when it appears in ≤ `GROUNDING_COMMON_FRAC` of the corpus (default 15%).
 *
 * Returns two flags the caller combines with "did FTS hit anything" (`hadFtsHit`):
 *   • specificMatching — a specific term that ACTUALLY matches ≥1 item exists → real evidence → grounded.
 *   • allCommon        — every query term is corpus-common → fall back to hadFtsHit (no regression,
 *                        no over-abstain on legit common-word queries like "latest update").
 * Neither → the false-grounding signature (specific terms that match nothing + incidental common
 * words) → NOT grounded. Best-effort: on any error returns {false, true} so grounding degrades to
 * the old any-hit behavior rather than throwing. Tier-scoped on the live `items.access`.
 */

const COMMON_FRAC = Number(process.env.GROUNDING_COMMON_FRAC ?? 0.15);

export interface TermSpecificity {
  specificMatching: boolean;
  allCommon: boolean;
}

export async function analyzeTermSpecificity(
  teamId: string,
  tier: "team" | "external",
  terms: string[]
): Promise<TermSpecificity> {
  if (terms.length === 0) return { specificMatching: false, allCommon: true };
  try {
    const access = isRestrictedTier(tier) ? "and access = 'external'" : "";
    // One row per term: corpus total + that term's document frequency, both tier-scoped.
    const sql = `
      select t.term,
        (select count(*) from items where team_id = $1 ${access}) as total,
        (select count(*) from items where team_id = $1 ${access}
           and search @@ websearch_to_tsquery('english', t.term)) as df
      from unnest($2::text[]) as t(term)`;
    const res = await runSql<{ term: string; total: number | string; df: number | string }>(sql, [teamId, terms]);
    if (res.rows.length === 0) return { specificMatching: false, allCommon: true };

    const total = Number(res.rows[0].total) || 0;
    // A term in ≤ COMMON_FRAC of the corpus is "specific". ceil so a tiny corpus still discriminates
    // (N=12, 15% → threshold 2: "SSRF" in 1 doc is specific, "update" in all 12 is common).
    const threshold = Math.max(1, Math.ceil(COMMON_FRAC * total));

    let specificMatching = false;
    let allCommon = true;
    for (const r of res.rows) {
      const df = Number(r.df) || 0;
      if (df >= 1 && df <= threshold) specificMatching = true; // specific AND actually matches
      if (df <= threshold) allCommon = false; // a specific term (matching or not) means "not all common"
    }
    return { specificMatching, allCommon };
  } catch {
    return { specificMatching: false, allCommon: true }; // degrade to old any-hit behavior
  }
}
