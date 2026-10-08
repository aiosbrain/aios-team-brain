import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { effectiveReplayPlan, REPLAY_SUPERSESSIONS } from "../../scripts/migration-replay-plan.mjs";

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
 * Invariant that prevents recurrence, for EVERY such constraint: every place it is defined AND REPLAYED
 * — the inline column check in schema.sql (Postgres auto-names it `<table>_<col>_check`), any named
 * re-add in schema.sql, and every re-add in the effective replay plan — must allow the IDENTICAL,
 * complete value set. Then no intermediate replay state is ever narrower than live data.
 *
 * Widening a set (AIO-1167 onward) means: schema.sql, ONE new migration carrying the complete set, and
 * a supersession entry in `scripts/migration-replay-plan.mjs` for each earlier migration that re-adds
 * the constraint. It no longer means editing those earlier files — shipped migrations are immutable,
 * and `test/guards/migration-replay-plan.test.ts` pins them. Leave an earlier re-add replaying and
 * this fails the build in review instead of on the next deploy.
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

function rawMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(MIG_DIR, f), "utf8") }));
}

/**
 * The migrations as a deploy REPLAYS them — the effective plan from
 * `scripts/migration-replay-plan.mjs`, the same function `pg-load-schema.mjs` calls. A shipped
 * migration is immutable; where a later one widened a CHECK it re-adds, that obsolete definition is
 * omitted from replay rather than edited in place, so it is the plan (not the raw file) whose
 * definitions must agree.
 */
function replayedMigrations(): Array<{ name: string; sql: string }> {
  return effectiveReplayPlan(rawMigrations()).map(({ name, sql }) => ({ name, sql }));
}

function allDefs(migrations: Array<{ name: string; sql: string }> = replayedMigrations()): Def[] {
  const schema = readFileSync(join(PG_DIR, "schema.sql"), "utf8");
  return [
    ...inlineSchemaDefs(schema),
    ...namedDefs(schema, "schema.sql", false),
    ...migrations.flatMap((m) => namedDefs(m.sql, m.name, true)),
  ];
}

/** Every definition that disagrees with the widest set seen for its constraint. */
function driftOf(defs: Def[]): string[] {
  const grouped = new Map<string, Def[]>();
  for (const d of defs) grouped.set(d.name, [...(grouped.get(d.name) ?? []), d]);
  const drift: string[] = [];
  for (const [name, ds] of grouped) {
    if (!ds.some((d) => d.inMigration)) continue;
    // Canonical = the widest set seen (the intended, current allowed set).
    const canonical = ds.reduce((a, b) => (b.values.length > a.length ? b.values : a), ds[0].values);
    for (const d of ds) {
      if (JSON.stringify(d.values) !== JSON.stringify(canonical)) {
        const missing = canonical.filter((v) => !d.values.includes(v));
        drift.push(`${name} in ${d.source}: missing [${missing.join(", ")}] (replaying this halts the deploy once a row uses one)`);
      }
    }
  }
  return drift;
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
    const uncaptured: string[] = [];
    for (const { name: f, sql } of replayedMigrations()) {
      for (const name of looseEnumConstraintNames(sql)) {
        if (!(byName.get(name) ?? []).some((d) => d.inMigration && d.source === f)) uncaptured.push(`${name} in ${f}`);
      }
    }
    expect(uncaptured, `enumerated CHECK re-adds the guard's parser did not capture:\n${uncaptured.join("\n")}`).toEqual([]);
  });

  it("every REPLAYED enumerated CHECK allows the SAME complete set everywhere it is defined", () => {
    const drift = driftOf(defs);
    expect(
      drift,
      `enumerated CHECK definitions drift. Widen in a NEW migration carrying the full set, mirror ` +
        `schema.sql, and declare each earlier re-add obsolete in scripts/migration-replay-plan.mjs — ` +
        `never edit a shipped migration:\n${drift.join("\n")}`
    ).toEqual([]);
  });

  it("the widened values are in the complete current sets", () => {
    const current = (name: string) => byName.get(name)?.find((d) => !d.inMigration)?.values ?? [];
    expect(current("integrations_type_check")).toContain("gdrive");
    expect(current("project_context_memberships_method_check")).toContain("gdrive_claim");
  });

  it("MUTANT: the same check over the RAW shipped files reports exactly the superseded definitions", () => {
    // Non-vacuity. If the supersessions were dropped — or this guard read the raw files again — the
    // six shipped definitions are precisely the narrower-replay hazard, and they are caught BY NAME.
    const rawDrift = driftOf(allDefs(rawMigrations()));
    const expected = REPLAY_SUPERSESSIONS.map((entry) => `${entry.constraint} in ${entry.migration}`).sort();
    expect(rawDrift.map((line) => line.split(":")[0]).sort()).toEqual(expected);
  });
});
