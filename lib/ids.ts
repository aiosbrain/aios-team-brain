import "server-only";
import { randomBytes } from "crypto";

/**
 * Stable, collision-safe row key for dashboard-created rows (tasks, decisions).
 *
 * The `ui-` prefix never collides with markdown-derived IDs on a push round-trip
 * (tasks.md `ID` column / decision-log.md `#` column hold integers or slugs), and
 * the random suffix makes intra-project collisions astronomically unlikely. The key
 * is persisted at create time so it stays stable when the row is written back into a
 * workspace file and later re-pushed (origin `ui`→`sync` lifecycle).
 */
export function uiRowKey(): string {
  return `ui-${randomBytes(4).toString("hex")}`;
}

/** True when a pg adapter error is a unique-constraint violation (no `.code` is
 *  surfaced by the adapter, so match on the Postgres message). */
export function isUniqueViolation(message: string | undefined): boolean {
  return !!message && /duplicate key|unique constraint/i.test(message);
}

/** Lowercase, hyphenated slug for a human-entered name (project/team slugs). */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
