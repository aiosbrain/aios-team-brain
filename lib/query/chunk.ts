/**
 * Deterministic text chunking for dense indexing. Pure (no server-only) so it's unit-testable and
 * usable anywhere. Splits on paragraph/sentence boundaries where possible, packs up to ~maxChars per
 * chunk, and carries a small overlap so a fact spanning a boundary still surfaces in one chunk.
 */

export interface ChunkOptions {
  /** target max characters per chunk (soft cap) */
  maxChars?: number;
  /** characters of trailing context repeated at the start of the next chunk */
  overlap?: number;
}

const DEFAULT_MAX = 1200;
const DEFAULT_OVERLAP = 150;

/** Split into segments on blank lines first, then over-long segments on sentence boundaries. */
function segments(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    // Over-long paragraph → break on sentence enders, falling back to hard slices.
    let buf = "";
    for (const sent of p.split(/(?<=[.!?])\s+/)) {
      if (buf && buf.length + sent.length + 1 > maxChars) {
        out.push(buf);
        buf = "";
      }
      if (sent.length > maxChars) {
        for (let i = 0; i < sent.length; i += maxChars) out.push(sent.slice(i, i + maxChars));
      } else {
        buf = buf ? `${buf} ${sent}` : sent;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/**
 * Chunk `text` into ≲maxChars pieces with `overlap` chars of continuity between adjacent chunks.
 * Returns [] for empty input. Never splits mid-word at the overlap seam (trims to a space).
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_MAX);
  const overlap = Math.max(0, Math.min(opts.overlap ?? DEFAULT_OVERLAP, Math.floor(maxChars / 2)));
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const segs = segments(clean, maxChars);
  const chunks: string[] = [];
  let buf = "";
  for (const seg of segs) {
    if (buf && buf.length + seg.length + 1 > maxChars) {
      chunks.push(buf);
      // seed the next buffer with the tail of this chunk (word-aligned) for overlap
      if (overlap > 0) {
        const tail = buf.slice(-overlap);
        const sp = tail.indexOf(" ");
        buf = sp >= 0 ? tail.slice(sp + 1) : "";
      } else {
        buf = "";
      }
    }
    buf = buf ? `${buf} ${seg}` : seg;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
