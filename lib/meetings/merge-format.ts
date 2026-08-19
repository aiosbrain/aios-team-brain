/**
 * Pure transcript similarity + merge for duplicate-meeting detection (Meetings merge). No
 * server-only, so tests + the orchestration share it. Two people uploading the same meeting produce
 * overlapping-but-not-identical transcripts (one may have missed parts), so:
 *  - similarity uses the OVERLAP COEFFICIENT (|A∩B| / min(|A|,|B|)) on word shingles — high even
 *    when one transcript is a partial subset of the other (Jaccard would under-score that case);
 *  - merge is a deterministic UNION: the longer transcript as the base, plus the other's lines that
 *    aren't already present, so no content is lost and near-duplicates aren't doubled.
 */

const SHINGLE_SIZE = 5;

/** Per-transcript char budget for the LLM merge; over it we use the lossless deterministic union. */
export const LLM_MERGE_MAX_CHARS = 12_000;

/** LLM merge is viable only when both transcripts are non-empty and within the char budget. Pure. */
export function canLlmMerge(a: string, b: string, cap = LLM_MERGE_MAX_CHARS): boolean {
  return a.trim().length > 0 && b.trim().length > 0 && a.length <= cap && b.length <= cap;
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word n-gram shingles (order-sensitive), for content-overlap comparison. */
export function transcriptShingles(text: string, size = SHINGLE_SIZE): Set<string> {
  const words = normalizeWords(text);
  const out = new Set<string>();
  if (words.length < size) {
    if (words.length) out.add(words.join(" ")); // short text: one shingle so it can still match itself
    return out;
  }
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
  return out;
}

/** Overlap coefficient in [0,1]: how much of the SMALLER transcript's content appears in the other. */
export function transcriptOverlap(a: string, b: string): number {
  const sa = transcriptShingles(a);
  const sb = transcriptShingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  return inter / small.size;
}

const normLine = (l: string): string => l.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Deterministically merge two transcripts of the same meeting. The longer is the base; lines from
 * the other whose normalized form isn't already present are appended under a labeled section, so a
 * partial second transcript contributes only what it uniquely captured.
 */
export function mergeTranscripts(a: string, b: string): string {
  const [base, other] = a.length >= b.length ? [a, b] : [b, a];
  const present = new Set(base.split(/\r?\n/).map(normLine).filter(Boolean));
  const extra = other
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => {
      const n = normLine(l);
      return n && !present.has(n);
    });
  if (extra.length === 0) return base;
  return `${base.trimEnd()}\n\n--- additional from a second transcript ---\n${extra.join("\n")}`;
}

/**
 * Title similarity for meetings that cannot be compared by BODY (MTGATT-1 / AIO-962).
 *
 * `transcriptOverlap` is the right comparator for two transcripts of the same conversation, and
 * useless for a calendar event — which has NO BODY by design (`from-calendar.ts`: "a calendar event
 * needs no body"). That is why a pushed calendar event and the Granola transcript of the same meeting
 * could never merge: `findDuplicateMeeting` skipped every candidate whose item had no body, so the
 * two became two notes for one meeting — one with exact attendance and no content, one with content
 * and inferred (sometimes invented) attendance.
 *
 * Deliberately token-set based, not string equality. (Titles here are PLACEHOLDERS for real
 * production meetings — this repo is public. Keep the SHAPE if you change them: one producer's
 * title must EXTEND the other's, which is the case this exists for.) The two producers name the same meeting
 * differently — Google carries the invite subject ("Ana & John — Northwind Demo Prep"),
 * Granola derives its own ("Ana & John — Northwind Demo Prep + AIOS"). Requiring equality
 * would merge almost nothing; requiring a shared token would merge almost everything ("Meeting").
 *
 * ⚠️ DORMANT — it has NO production caller yet. `findDuplicateMeeting` accepts an `incomingTitle`
 * and uses it, but its one call site (`app/t/[team]/meetings/actions.ts`) does not pass one, and the
 * path a pushed calendar event actually takes (`backfillMergeDuplicateMeetings`) excludes bodyless
 * notes and never calls `findDuplicateMeeting` at all. Wiring it is MTGATT-2, which must FIRST close
 * two hazards the review found: two different same-day meetings titled only with a person's name
 * score 1.0 here (names are not stopwords), and the merge survivor is whichever note existed first,
 * so a transcript arriving after its calendar event would fold INTO the bodyless note and lose its
 * body.
 *
 * Returns the Jaccard overlap of significant tokens, 0..1. Pure.
 */
export function titleSimilarity(a: string, b: string): number {
  const toks = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        // Split on anything that is not a letter or digit, so em-dashes, ampersands and punctuation
        // separate rather than fusing two words into one token.
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !TITLE_STOPWORDS.has(t))
    );
  const A = toks(a);
  const B = toks(b);
  // No significant tokens on either side means "no evidence", NOT "identical". Two meetings called
  // "Sync" and "Chat" would otherwise score 1.0 on empty sets and merge.
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * Words too common in meeting titles to be evidence of the SAME meeting. "Meeting with John" and
 * "Meeting with Sarah" share `meeting` and `with`; without this they would look half-identical.
 */
const TITLE_STOPWORDS = new Set([
  "the", "and", "with", "for", "meeting", "call", "sync", "session", "chat", "catch",
  "min", "mins", "minute", "minutes", "hour", "weekly", "daily", "standup", "check",
]);
