import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `integrations_type_check` replay-consistency guard.
 *
 * Spec = the 2026-07-13 failed deploy. `npm run pg:schema` (the Railway preDeployCommand)
 * REPLAYS every file in `postgres/migrations/` in lexical order on every deploy — there is no
 * applied-tracking table (see `scripts/pg-load-schema.mjs`). Three migrations each
 * `drop + re-add` the `integrations_type_check` CHECK, and each carried the *allowed set as of
 * its own write date*:
 *   - 20260624120000 → up to 'google'      (narrow)
 *   - 20260710140000 → + 'openrouter'      (wider)
 *   - 20260711160000 → + 'typefully'       (widest, == schema.sql)
 * Once prod held an 'openrouter'/'typefully' integration row (allowed by the current, widest
 * constraint), replaying the *earlier, narrower* migration re-imposed a CHECK that the existing
 * row violated → "check constraint integrations_type_check is violated by some row" → the schema
 * load aborted and the release was halted.
 *
 * Invariant that prevents recurrence: EVERY definition of `integrations_type_check` — the inline
 * one in schema.sql and every re-add in a migration — must allow the identical, complete set of
 * types. Then no intermediate replay state can ever be narrower than live data. Adding a new type
 * means updating schema.sql AND every migration that re-adds the constraint, or this fails the
 * build in review instead of on the next deploy.
 */

const PG_DIR = join(import.meta.dirname, "..", "..", "postgres");
const MIG_DIR = join(PG_DIR, "migrations");

/** Pull the quoted values out of a `check (type in ('a','b',...))` fragment. */
function typeValues(fragment: string): string[] {
  const m = fragment.match(/type\s+in\s*\(([^)]*)\)/i);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

/** The inline `integrations` column constraint in schema.sql (canonical from-zero shape). */
function schemaSqlTypes(): string[] {
  const sql = readFileSync(join(PG_DIR, "schema.sql"), "utf8");
  const start = sql.indexOf("create table if not exists integrations (");
  expect(start, "integrations table not found in schema.sql").toBeGreaterThan(-1);
  const body = sql.slice(start, start + 1000);
  return typeValues(body);
}

/** Every migration that re-adds `integrations_type_check`, mapped to its allowed set. */
function migrationConstraints(): Array<{ file: string; types: string[] }> {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(MIG_DIR, f), "utf8") }))
    .filter(({ sql }) => /add constraint integrations_type_check/i.test(sql))
    .map(({ file, sql }) => {
      const idx = sql.indexOf("add constraint integrations_type_check");
      return { file, types: typeValues(sql.slice(idx, idx + 400)) };
    });
}

describe("integrations_type_check replay consistency", () => {
  it("schema.sql defines a non-empty allowed set (extractor is non-vacuous)", () => {
    const types = schemaSqlTypes();
    expect(types.length).toBeGreaterThan(5);
    expect(types).toContain("github");
    expect(types).toContain("typefully");
  });

  it("every migration re-adds the constraint with the SAME complete set as schema.sql", () => {
    const canonical = schemaSqlTypes();
    const migrations = migrationConstraints();
    expect(migrations.length, "no migration re-adds integrations_type_check").toBeGreaterThan(0);

    const drift = migrations.filter(
      (m) => JSON.stringify(m.types) !== JSON.stringify(canonical)
    );
    const detail = drift
      .map((m) => `  ${m.file}: missing [${canonical.filter((t) => !m.types.includes(t)).join(", ")}]`)
      .join("\n");
    expect(
      drift.map((m) => m.file),
      `These migrations re-add integrations_type_check with a set that differs from schema.sql — ` +
        `replaying them would reject rows the live constraint allows:\n${detail}`
    ).toEqual([]);
  });
});
