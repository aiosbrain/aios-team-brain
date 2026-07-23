/**
 * Parse a meeting summary into bullet points for skimmable rendering. Pure (no server-only) so the
 * client detail view and tests share it. Summaries are now generated as a bulleted list
 * (lib/meetings/llm-extract), but older notes hold a prose paragraph — this returns [] for those so
 * the UI falls back to paragraph rendering instead of mangling a sentence into fake bullets.
 */

const BULLET_RE = /^\s*[-*•]\s+/;

/**
 * Normalize the LLM's raw `summary` field into the canonical newline-joined bullet STRING that
 * `summaryBullets` (and the stored `meeting_notes.summary` column) expect. The prompt asks for a
 * `"- ...\n- ..."` string, and most models comply — but some a team can pick as their answering
 * provider (observed live: `qwen/qwen3.7-plus` via OpenRouter) return `summary` as a JSON ARRAY of
 * bullet strings. Both shapes must render identically, so an array is joined with every element
 * forced to a single leading "- " marker (any pre-existing bullet marker is stripped first so it's
 * never doubled). A string is passed through trimmed; anything else becomes "" (no usable summary).
 */
export function normalizeSummaryField(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `- ${s.replace(/^[-*•]\s*/, "").trim()}`)
      .join("\n");
  }
  return "";
}

/**
 * A compact 1–3 sentence synopsis of a meeting, for the list-rail card preview so notes are skimmable.
 * Flattens the stored summary (bulleted OR prose), strips markdown bullet/heading markers, treats each
 * bullet as a sentence unit, and returns the leading `maxSentences` (capped at `maxChars`). Pure +
 * unit-tested. Returns "" for an empty/unusable summary so the card can fall back. Handles the JSON-array
 * summary shape via `normalizeSummaryField` first.
 */
export function meetingSynopsis(summary: unknown, maxSentences = 3, maxChars = 240): string {
  const parts = normalizeSummaryField(summary)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•#>]+\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    // Give each part a terminator so bullets read as sentences — but only when it lacks one, so a
    // bullet ending in "!"/"?" doesn't become "…!." and a period isn't doubled.
    .map((l) => (/[.!?]$/.test(l) ? l : `${l}.`));
  if (!parts.length) return "";
  const text = parts.join(" ");
  // Split on a terminator FOLLOWED BY whitespace, so intra-word periods ("v1.2", "e.g.") stay intact
  // instead of fracturing into "v1. 2" / "e. g." (Fable review).
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  let out = sentences.slice(0, maxSentences).join(" ").trim();
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, "").trim() + "…";
  return out;
}

export function summaryBullets(summary: string): string[] {
  const lines = summary.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => BULLET_RE.test(l));
  // Treat as a bulleted list only when it clearly IS one: ≥2 bullets and (almost) every line is a
  // bullet. A lone leading "- " in an otherwise prose blob shouldn't trigger list rendering.
  if (bullets.length >= 2 && bullets.length >= lines.length - 1) {
    return bullets.map((l) => l.replace(BULLET_RE, "").trim()).filter(Boolean);
  }
  return [];
}
