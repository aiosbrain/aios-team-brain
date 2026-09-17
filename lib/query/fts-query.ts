// Question words + common stopwords dropped before building the FTS query — they carry no signal
// and (under AND semantics) tanked recall (e.g. "what has john been posting to slack" required the
// literal "posting"/"slack" in the body). We keep all other terms.
const FTS_STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "were",
  "be", "been", "being", "what", "who", "whom", "whose", "when", "where", "why", "how", "which",
  "did", "do", "does", "has", "have", "had", "with", "about", "from", "by", "our", "we", "you",
  "i", "me", "my", "your", "their", "this", "that", "these", "those", "it", "its", "as", "at",
  "any", "all", "can", "could", "would", "should", "tell", "show", "give", "list", "get",
  // Temporal/recency deictics: query INTENT, not content — they never match usefully as keywords
  // and (df≈0) would otherwise poison the grounding signal (Gap #3). Recency is handled by the
  // recency fallback + activity digests, not by matching the literal word.
  "latest", "recent", "recently", "lately", "today", "yesterday", "tomorrow", "currently", "now", "soon", "upcoming",
]);

/**
 * Is this raw token (original case preserved) worth searching on?
 *   • never a stopword
 *   • ≥3 chars → yes
 *   • exactly 2 chars → only if it's a version/product token with a digit (v2, s3, k8) OR an
 *     acronym the user upper-cased (CI, QA, PR, DB) — NOT a lowercase common word (us, up, so, no).
 *   • 1 char → no (single letters are noise)
 * The 2-char rule is the fix for eng-heavy channels where CI/QA/PR/S3 are the load-bearing terms;
 * dropping them (the old `length >= 3` filter) meant a query ABOUT them searched on filler words.
 */
export function isSignificantTerm(original: string): boolean {
  const t = original.toLowerCase();
  if (FTS_STOP.has(t)) return false;
  if (t.length >= 3) return true;
  if (t.length === 2) return /\d/.test(t) || original === original.toUpperCase();
  return false;
}

/**
 * Build a recall-friendly FTS query: significant terms OR-joined. `websearch_to_tsquery` treats the
 * word "or" as the OR operator, so this matches docs containing ANY significant term (then the LLM
 * filters relevance) instead of requiring ALL of them. Falls back to the raw question when nothing
 * significant remains. (Ranked/semantic retrieval — pgvector — is the durable fix at larger scale.)
 */
export function significantTerms(question: string): string[] {
  // Match on the ORIGINAL (case preserved) so `isSignificantTerm` can tell an upper-cased acronym
  // (CI) from a lowercase common word (us); lowercase only after the keep/drop decision. De-duped.
  const terms = (question.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [])
    .filter(isSignificantTerm)
    .map((t) => t.toLowerCase());
  return [...new Set(terms)];
}

/**
 * Conjunctive intent (Gap: OR-semantics can't require BOTH topics). An explicit upper-cased `AND`
 * between topics is an opt-in precision operator (like a search engine's AND): narrow to docs that
 * contain ALL the named topics, instead of the OR default's recall bias. Returns the de-duped term
 * list when the operator is present with a real topic on each side, else null (→ OR path unchanged).
 *
 * Deliberately ONLY upper-cased `AND`, never lowercase "and": "and" is a ubiquitous stopword (it is
 * in FTS_STOP), so treating every "and" as a hard conjunction would gut recall on ordinary questions
 * ("what did john and mary decide"). Conservative, mirroring parseChannelScope (Gap #4) — no false
 * positives. Multi-word sides collapse to a flat AND of every significant term (websearch_to_tsquery
 * has no grouping), so "auth flow AND payments" requires auth+flow+payments; single-word sides (the
 * common "auth AND payments") are exact. Pure + unit-tested.
 */
export function conjunctiveTerms(question: string): string[] | null {
  if (!/\bAND\b/.test(question)) return null; // case-sensitive: only the upper-cased operator
  const sides = question.split(/\bAND\b/).map(significantTerms);
  if (sides.length < 2 || sides.some((s) => s.length === 0)) return null; // a real topic each side
  const all = [...new Set(sides.flat())];
  return all.length >= 2 ? all : null;
}

/**
 * The FTS query the retrieval leg runs. `websearch_to_tsquery('english', …)` reads the literal word
 * "or" as OR and space/"and" as AND, so the join word alone flips the operator — no SQL change. OR by
 * default (recall bias; the LLM filters relevance); AND only when `conjunctiveTerms` fires (precision).
 */
export function buildFtsQuery(question: string): { query: string; terms: string[]; conjunctive: boolean } {
  const conj = conjunctiveTerms(question);
  if (conj) return { query: conj.join(" and "), terms: conj, conjunctive: true };
  const terms = significantTerms(question);
  return { query: terms.length ? terms.join(" or ") : question, terms, conjunctive: false };
}

export function toOrQuery(question: string): string {
  return buildFtsQuery(question).query;
}

