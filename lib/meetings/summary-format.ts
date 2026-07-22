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
