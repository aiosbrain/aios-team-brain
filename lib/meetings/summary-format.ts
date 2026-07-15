/**
 * Parse a meeting summary into bullet points for skimmable rendering. Pure (no server-only) so the
 * client detail view and tests share it. Summaries are now generated as a bulleted list
 * (lib/meetings/llm-extract), but older notes hold a prose paragraph — this returns [] for those so
 * the UI falls back to paragraph rendering instead of mangling a sentence into fake bullets.
 */

const BULLET_RE = /^\s*[-*•]\s+/;

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
