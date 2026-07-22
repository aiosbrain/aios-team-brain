import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * GENERALIZED enumerated-CHECK replay-consistency guard (generalizes the `integrations_type_check`
 * guard to EVERY value-list CHECK, after the same pattern re-armed the incident on the gateway tables).
 *
 * Spec = the 2026-07-13 failed deploy, as a class. `npm run pg:schema` (the Railway preDeployCommand)
 * REPLAYS every `postgres/migrations/*.sql` in lexical order on every deploy, with no applied-tracking
 * table. When a migration `drop`s + re-`add`s an enumerated CHECK — `check (col in ('a','b',…))` —
 * carrying only the allowed set as of its own write date, and a LATER migration/schema widened that
 * set, then once prod holds a row with a newer value, replaying the EARLIER, narrower migration
 * re-imposes a CHECK the live row violates → "check constraint … is violated by some row" → the schema
 * load aborts and the release is halted.
 *
 * Invariant that prevents recurrence, for EVERY such constraint: every place it is defined — the inline
 * column check in schema.sql (Postgres auto-names it `<table>_<col>_check`), any named re-add in
 * schema.sql, and every re-add in a migration — must allow the IDENTICAL, complete value set. Then no
 * intermediate replay state is ever narrower than live data. Widening a set means updating schema.sql
 * AND every migration that (re-)defines the constraint, or this fails the build in review instead of on
 * the next deploy.
 */

const PG_DIR = join(import.meta.dirname, "..", "..", "postgres");
const MIG_DIR = join(PG_DIR, "migrations");

/** One place a named enumerated CHECK is defined. */
interface Def {
  name: string;
  values: string[]; // sorted, deduped
  source: string; // file it came from
  inMigration: boolean;
}

/** Sorted, unique quoted values from a `col in ('a', 'b', …)` fragment (handles newlines). */
function valuesOf(inList: string): string[] {
  return [...new Set([...inList.matchAll(/'([^']+)'/g)].map((m) => m[1]))].sort();
}

// A CHECK's leading `<col> is null or ` (nullable enums, e.g. gateway_audit_log.decision) sits before
// the `<col> in (…)` we key on — allow it so those aren't invisible to the parser.
const NULLABLE_PREFIX = String.raw`(?:\w+\s+is\s+null\s+or\s+)?`;

/** Named re-adds: `... add constraint <name> ... check ([col is null or] <col> in (…))` (multi-line ok). */
function namedDefs(sql: string, source: string, inMigration: boolean): Def[] {
  const re = new RegExp(String.raw`add constraint\s+(\w+)\s+check\s*\(\s*${NULLABLE_PREFIX}\w+\s+in\s*\(([^)]*)\)`, "gi");
  return [...sql.matchAll(re)].map((m) => ({ name: m[1], values: valuesOf(m[2]), source, inMigration }));
}

/** Inline column checks in schema.sql CREATE TABLEs → the auto-name Postgres gives them,
 *  `<table>_<col>_check`, so they compare against the same constraint the migrations re-add. */
function inlineSchemaDefs(sql: string): Def[] {
  const defs: Def[] = [];
  // Split into per-table chunks so we can attribute each inline check to its table.
  const tableRe = /create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\);/gi;
  for (const t of sql.matchAll(tableRe)) {
    const table = t[1];
    const body = t[2];
    // `<col> <type…> check ([<col> is null or] <col> in (…))` — the in-listed column is the guarded one.
    const colRe = new RegExp(String.raw`check\s*\(\s*${NULLABLE_PREFIX}(\w+)\s+in\s*\(([^)]*)\)`, "gi");
    for (const c of body.matchAll(colRe)) {
      defs.push({ name: `${table}_${c[1]}_check`, values: valuesOf(c[2]), source: "schema.sql", inMigration: false });
    }
  }
  return defs;
}

/** Independent, loose detection of every enumerated CHECK a migration re-adds — used only to assert the
 *  strict parser above didn't silently miss one (a future CHECK form it can't parse becomes a red test,
 *  not an invisible gap). Matches `add constraint <name> … check ( … in ('…' ) … );`. */
function looseEnumConstraintNames(sql: string): string[] {
  const names: string[] = [];
  for (const m of sql.matchAll(/add constraint\s+(\w+)\b([\s\S]*?);/gi)) {
    if (/check\s*\(/i.test(m[2]) && /\bin\s*\(\s*'/i.test(m[2])) names.push(m[1]);
  }
  return names;
}

function allDefs(): Def[] {
  const schema = readFileSync(join(PG_DIR, "schema.sql"), "utf8");
  const migFiles = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  return [
    ...inlineSchemaDefs(schema),
    ...namedDefs(schema, "schema.sql", false),
    ...migFiles.flatMap((f) => namedDefs(readFileSync(join(MIG_DIR, f), "utf8"), f, true)),
  ];
}

describe("enumerated-CHECK replay consistency (generalized)", () => {
  const defs = allDefs();
  const byName = new Map<string, Def[]>();
  for (const d of defs) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);

  // Only constraints a MIGRATION re-defines can be replayed narrower than live data — those are the ones
  // that must stay in lockstep with schema.sql. (A constraint only ever defined inline in schema.sql is
  // created once from-zero and never replayed narrow.)
  const migrationReadded = [...byName.entries()].filter(([, ds]) => ds.some((d) => d.inMigration));

  it("finds the enumerated constraints re-added by migrations (extractor is non-vacuous)", () => {
    const names = migrationReadded.map(([n]) => n);
    // The incident constraint plus the gateway/answering ones the pattern re-armed.
    expect(names).toContain("integrations_type_check");
    expect(names).toContain("gateway_audit_log_event_check");
    expect(names).toContain("gateway_executions_role_snapshot_check");
    expect(names).toContain("gateway_executions_tier_snapshot_check");
    expect(names).toContain("teams_answering_provider_check");
    // Each has a real, non-empty value set.
    for (const [, ds] of migrationReadded) for (const d of ds) expect(d.values.length).toBeGreaterThan(0);
  });

  it("the parser captures every enumerated CHECK any migration re-adds (a form it can't parse fails loudly)", () => {
    // Guards the guard: if a future migration re-adds an enumerated CHECK in a shape the strict parser
    // above misses, this turns that silent blind spot into a red test.
    const migFiles = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    const uncaptured: string[] = [];
    for (const f of migFiles) {
      const sql = readFileSync(join(MIG_DIR, f), "utf8");
      for (const name of looseEnumConstraintNames(sql)) {
        if (!(byName.get(name) ?? []).some((d) => d.inMigration && d.source === f)) uncaptured.push(`${name} in ${f}`);
      }
    }
    expect(uncaptured, `enumerated CHECK re-adds the guard's parser did not capture:\n${uncaptured.join("\n")}`).toEqual([]);
  });

  it("every migration-re-added enumerated CHECK allows the SAME complete set everywhere it is defined", () => {
    const drift: string[] = [];
    for (const [name, ds] of migrationReadded) {
      // Canonical = the widest set seen (the intended, current allowed set).
      const canonical = ds.reduce((a, b) => (b.values.length > a.length ? b.values : a), ds[0].values);
      for (const d of ds) {
        if (JSON.stringify(d.values) !== JSON.stringify(canonical)) {
          const missing = canonical.filter((v) => !d.values.includes(v));
          drift.push(`${name} in ${d.source}: missing [${missing.join(", ")}] (replaying this halts the deploy once a row uses one)`);
        }
      }
    }
    expect(drift, `enumerated CHECK definitions drift — converge every re-add to the full set:\n${drift.join("\n")}`).toEqual([]);
  });
});
