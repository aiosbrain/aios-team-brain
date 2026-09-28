/** Raw accepted title for plain-text rendering. Other item kinds keep their path heading. */
export function noteTitle(kind: unknown, frontmatter: unknown): string | null {
  if (kind !== "note" || !frontmatter || typeof frontmatter !== "object") return null;
  const title = (frontmatter as Record<string, unknown>).title;
  return typeof title === "string" && /\S/u.test(title) ? title : null;
}
