import "server-only";
import { randomBytes } from "crypto";

/**
 * Stable, collision-safe row key for dashboard-created rows (tasks, decisions).
 *
 * The `ui-` prefix is RESERVED for dashboard-created rows (documented in brain-api.md);
 * markdown authors should not write `ui-*` keys. The 12-hex (48-bit) random suffix makes
 * an intra-project collision with a hand-authored `ui-*` key cryptographically negligible
 * (~1 in 2.8e14 per attempt). The key is persisted at create time so it stays stable when
 * the row is written back into a workspace file and later re-pushed (origin `ui`→`sync`).
 */
export function uiRowKey(): string {
  return `ui-${randomBytes(6).toString("hex")}`;
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
