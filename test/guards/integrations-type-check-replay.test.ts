import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveReplayPlan,
  gitBlobId,
  REPLAY_SUPERSESSIONS,
} from "../../scripts/migration-replay-plan.mjs";

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
 * Invariant that prevents recurrence: EVERY definition of `integrations_type_check` that is
 * actually REPLAYED — the inline one in schema.sql and every re-add in the effective replay plan —
 * must allow the identical, complete set of types. Then no intermediate replay state can ever be
 * narrower than live data.
 *
 * HOW A NEW TYPE IS ADDED NOW (AIO-1167). The first form of this rule was "update every migration
 * that re-adds the constraint", which rewrites shipped history. Shipped migrations are immutable:
 * a new type lands in schema.sql and ONE new migration carrying the complete set, and each earlier
 * re-add is declared obsolete in `scripts/migration-replay-plan.mjs`, which omits exactly those
 * statements from replay. This guard therefore reads the EFFECTIVE plan — the SQL the deploy runs —
 * and separately pins the historical files so the old habit of editing them fails here too.
 */

const PG_DIR = join(import.meta.dirname, "..", "..", "postgres");
const MIG_DIR = join(PG_DIR, "migrations");
const CONSTRAINT = "integrations_type_check";

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

function rawMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(MIG_DIR, f), "utf8") }));
}

/** Every re-add of `integrations_type_check` in a migration set, mapped to its allowed set. */
function constraintsIn(migrations: Array<{ name: string; sql: string }>): Array<{ file: string; types: string[] }> {
  return migrations
    .filter(({ sql }) => /add constraint integrations_type_check/i.test(sql))
    .map(({ name, sql }) => {
      const idx = sql.indexOf("add constraint integrations_type_check");
      return { file: name, types: typeValues(sql.slice(idx, idx + 400)) };
    });
}

/** What a deploy REPLAYS: the effective plan, with superseded definitions omitted. */
function migrationConstraints(): Array<{ file: string; types: string[] }> {
  return constraintsIn(effectiveReplayPlan(rawMigrations()));
}

describe("integrations_type_check replay consistency", () => {
  it("schema.sql defines a non-empty allowed set (extractor is non-vacuous)", () => {
    const types = schemaSqlTypes();
    expect(types.length).toBeGreaterThan(5);
    expect(types).toContain("github");
    expect(types).toContain("typefully");
  });

  it("every REPLAYED re-add carries the SAME complete set as schema.sql", () => {
    const canonical = schemaSqlTypes();
    const migrations = migrationConstraints();
    expect(migrations.length, "no replayed migration re-adds integrations_type_check").toBeGreaterThan(0);

    const drift = migrations.filter(
      (m) => JSON.stringify(m.types) !== JSON.stringify(canonical)
    );
    const detail = drift
      .map((m) => `  ${m.file}: missing [${canonical.filter((t) => !m.types.includes(t)).join(", ")}]`)
      .join("\n");
    expect(
      drift.map((m) => m.file),
      `These migrations replay integrations_type_check with a set that differs from schema.sql — ` +
        `replaying them would reject rows the live constraint allows. Do NOT edit a shipped file: ` +
        `declare its definition obsolete in scripts/migration-replay-plan.mjs:\n${detail}`
    ).toEqual([]);
  });

  it("the current set includes 'gdrive', and exactly the owning migration replays it", () => {
    expect(schemaSqlTypes()).toContain("gdrive");
    expect(migrationConstraints().map((m) => m.file)).toEqual(["20260922090000_integrations_gdrive_type.sql"]);
  });

  it("the shipped re-adds are pinned, narrower, and absent from the replay", () => {
    // The five files staging shipped. Each still carries the pre-`gdrive` set VERBATIM (history is
    // not rewritten), is byte-pinned by its git blob id, and is covered by a supersession — so the
    // narrower definition exists in the repository and never reaches a database.
    const raw = rawMigrations();
    const shipped = REPLAY_SUPERSESSIONS.filter((entry) => entry.constraint === CONSTRAINT);
    expect(shipped.map((entry) => entry.migration)).toEqual([
      "20260624120000_ai_provider_integration_types.sql",
      "20260710140000_integrations_openrouter_type.sql",
      "20260711160000_publishing.sql",
      "20260725160000_integrations_notion_type.sql",
      "20260817090000_integrations_clickup_type.sql",
    ]);
    const replayed = new Set(migrationConstraints().map((m) => m.file));
    for (const entry of shipped) {
      const file = raw.find((m) => m.name === entry.migration);
      expect(file, `${entry.migration} must still exist`).toBeDefined();
      expect(gitBlobId(file!.sql), `${entry.migration} changed — shipped migrations are immutable`).toBe(entry.gitBlob);
      const historical = constraintsIn([file!]);
      expect(historical, `${entry.migration} must still carry its historical re-add`).toHaveLength(1);
      expect(historical[0].types).not.toContain("gdrive");
      expect(replayed.has(entry.migration), `${entry.migration}'s obsolete re-add must not replay`).toBe(false);
    }
  });

  it("MUTANT: without the supersessions, the historical files fail this guard", () => {
    // Non-vacuity for the whole arrangement: replayed raw, the shipped files are exactly the drift
    // the 2026-07-13 incident was — so the plan, not luck, is what keeps the set complete.
    const canonical = schemaSqlTypes();
    const narrower = constraintsIn(rawMigrations()).filter(
      (m) => JSON.stringify(m.types) !== JSON.stringify(canonical)
    );
    expect(narrower.map((m) => m.file)).toHaveLength(5);
  });
});
