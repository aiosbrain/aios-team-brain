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
