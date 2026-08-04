import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: a standalone index in schema.sql may not reference a migration-added column unless
 * schema.sql ALSO carries the mirrored `add column if not exists`.
 *
 * The failure this traces to (2026-08-04, prod deploys blocked): #492 added decision columns to
 * `codebase_findings` via migration AND the create-table body, then created a standalone partial
 * index on `decision_expires_at` in schema.sql. On a live DB the table already existed, so
 * `create table if not exists` was a no-op, the index statement aborted the load with
 * `column "decision_expires_at" does not exist` — and because schema.sql loads BEFORE migrations
 * (scripts/pg-load-schema.mjs), the migration that would have added the column never ran. Every
 * deploy failed until the alter was mirrored into schema.sql (the same pattern the adjacent
 * `occurrence_count` alter already followed). Same replay class as incident #251.
 *
 * The rule encoded: for every (table, column) pair that any migration adds via
 * `add column if not exists`, if schema.sql's standalone `create index` statements reference that
 * column on that table, schema.sql must contain its own `alter table <table> add column if not
 * exists <column>`. From-zero stays correct either way; this is about the live-DB replay order.
 */

const ROOT = process.cwd();
const schema = readFileSync(join(ROOT, "postgres/schema.sql"), "utf8");
const migDir = join(ROOT, "postgres/migrations");

/**
 * (table, column) → offset of the `alter table … add column if not exists` that adds it. The offset
 * matters: statements execute top-to-bottom, so a mirrored alter placed AFTER the index it exists to
 * protect still aborts the live load — the guard must reject that, not just require presence.
 */
function addedColumns(sql: string): Map<string, number> {
  const out = new Map<string, number>();
  // An ALTER can carry several comma-separated add-column clauses; scan statement-wise.
  const alterRe = /alter\s+table\s+(?:if\s+exists\s+)?([a-z0-9_]+)\s+((?:.|\n)*?);/gi;
  for (const m of sql.matchAll(alterRe)) {
    const table = m[1].toLowerCase();
    for (const col of m[2].matchAll(/add\s+column\s+if\s+not\s+exists\s+([a-z0-9_]+)/gi)) {
      const key = `${table}.${col[1].toLowerCase()}`;
      if (!out.has(key)) out.set(key, m.index ?? 0);
    }
  }
  return out;
}

/** Standalone `create index` statements in schema.sql: table, referenced-column text, and offset. */
function indexStatements(sql: string): { table: string; body: string; at: number }[] {
  const out: { table: string; body: string; at: number }[] = [];
  const re = /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[a-z0-9_]+\s+on\s+([a-z0-9_]+)\s*((?:.|\n)*?);/gi;
  for (const m of sql.matchAll(re)) out.push({ table: m[1].toLowerCase(), body: m[2].toLowerCase(), at: m.index ?? 0 });
  return out;
}

describe("schema.sql standalone indexes vs migration-added columns", () => {
  it("every migration-added column referenced by a standalone schema.sql index is also altered-in by schema.sql", () => {
    const migrationAdded = new Set<string>();
    for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql"))) {
      for (const pair of addedColumns(readFileSync(join(migDir, f), "utf8")).keys()) migrationAdded.add(pair);
    }
    const schemaAdded = addedColumns(schema);
    const violations: string[] = [];
    for (const { table, body, at } of indexStatements(schema)) {
      for (const pair of migrationAdded) {
        const [t, col] = pair.split(".");
        if (t !== table) continue;
        // Word-boundary match keeps `decision_at` from matching inside `decision_expires_at`.
        if (!new RegExp(`\\b${col}\\b`).test(body)) continue;
        const alterAt = schemaAdded.get(pair);
        // Present AND above the index — statements run top-to-bottom, so a mirror placed below the
        // index it protects is the same broken load with a green guard (review finding).
        if (alterAt === undefined || alterAt > at) {
          violations.push(
            `schema.sql index on "${table}" references "${col}", which only a migration adds — ` +
              `mirror \`alter table ${table} add column if not exists ${col}\` into schema.sql ` +
              `BEFORE the index, or the load aborts on any live DB that predates the migration.`
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("is non-vacuous: the incident's own pair is seen by both sides", () => {
    // If either parser goes blind (a regex refactor), the guard silently passes on everything —
    // so pin the exact pair from the 2026-08-04 incident on both sides of the rule.
    const migAdded = addedColumns(
      readFileSync(join(migDir, "20260804160000_explainable_debt_decisions.sql"), "utf8")
    );
    expect(migAdded.has("codebase_findings.decision_expires_at")).toBe(true);
    expect(addedColumns(schema).has("codebase_findings.decision_expires_at")).toBe(true);
    const idx = indexStatements(schema).filter(
      (s) => s.table === "codebase_findings" && /\bdecision_expires_at\b/.test(s.body)
    );
    expect(idx.length).toBeGreaterThan(0);
  });
});
