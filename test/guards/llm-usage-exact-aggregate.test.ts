import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard: money is aggregated in SQL, never by summing a capped row fetch in JavaScript.
 *
 * THE BUG THIS TRACES TO. Two surfaces read `llm_usage` by fetching rows under a `.limit(...)` and
 * summing them here — Pulse at 50,000, the /costs breakdown at 100,000. Once the table held more
 * rows than the cap, each silently summed a subset, and because the caps differed the SAME window
 * produced two different totals. Production, 2026-08-03: 128,998 rows reported as $18.62 on Pulse
 * and $88.33 on /costs, against a true $98.84.
 *
 * Why a guard rather than trusting the fix: the failure is INVISIBLE until the table outgrows the
 * cap, it under-reports (so it reads as good news), and nothing errors. A reviewer cannot see it in
 * a diff — `.limit(100_000)` looks like prudence. The only durable defence is to make the pattern
 * fail the build at the moment someone reintroduces it.
 *
 * KNOWN BLIND SPOT, stated rather than implied: a builder assigned to a variable with `.limit()`
 * applied in a LATER statement is not detected — the chain scan stops at the statement boundary.
 * Widening it to scan forward would false-positive across unrelated statements, and a guard that
 * cries wolf gets deleted. The data-mechanics tier is the backstop for that shape.
 *
 * Deliberately narrow: it polices `llm_usage` (the money ledger) rather than every table. A row cap
 * on a LIST is fine — `llm_failures` legitimately fetches `cap + 1` to detect truncation and says so
 * in the response. What is never fine is a capped fetch feeding a dollar figure.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib"];

/** The one module allowed to read `llm_usage` for money — and it uses SQL aggregates, asserted below. */
const AGGREGATE_MODULE = join("lib", "metrics", "llm-spend.ts");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Strip comments — prose describing the hazard is not the hazard. Same rule the Railway policy uses. */
function stripComments(src: string): string {
  return src
    .replace(/(^|[\s(,;=:[{])\/\*[\s\S]*?\*\//g, "$1 ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Files that read `llm_usage` through the query builder AND put a row cap on it. */
function cappedLlmUsageReads(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      const src = stripComments(readFileSync(file, "utf8"));
      // The gate admits BOTH shapes. An earlier version gated on the builder call alone, so a file
      // using only raw SQL was skipped entirely and the raw-SQL check below silently covered nothing.
      // Found by probing the guard with a real offender instead of trusting that it worked.
      if (!src.includes('from("llm_usage")') && !/from\s+llm_usage/i.test(src)) continue;

      // Isolate each `.from("llm_usage")` chain and look for a `.limit(...)` on it. An INSERT chain
      // has no limit, and the single-row `firstAt` probe is `.limit(1)` — a lookup, not an aggregate.
      // Raw SQL too. The scan below only sees builder chains, but `llm-spend.ts` establishes
      // `runSql` as the way to read this table — so a hand-written `select … from llm_usage … limit N`
      // would be completely invisible to a builder-only guard.
      for (const stmt of src.match(/`[^`]*from\s+llm_usage[^`]*`/gi) ?? []) {
        if (/\blimit\b/i.test(stmt) && !/count\(|sum\(/i.test(stmt)) {
          hits.push(`${rel}: raw SQL reads llm_usage with a LIMIT and no aggregate`);
        }
      }

      const chains = src.split('from("llm_usage")').slice(1);
      for (const chain of chains) {
        const upToStatementEnd = chain.split(/;\s*\n/)[0];
        // ANY argument, not just a numeric literal: `.limit(SPEND_CAP)` is the same bug wearing a
        // constant, and the numeric-only form let it through.
        const m = /\.limit\(\s*([^)]*)\s*\)/.exec(upToStatementEnd);
        if (!m) continue;
        const arg = m[1].trim();
        if (/^1$/.test(arg)) continue; // `.limit(1)` is a single-row probe, not a truncated sum
        hits.push(`${rel}: .limit(${arg}) on an llm_usage read`);
      }
    }
  }
  return hits.sort();
}

describe("llm_usage money reads are exact", () => {
  it("no capped row fetch feeds a spend figure", () => {
    const offenders = cappedLlmUsageReads();
    expect(
      offenders,
      `A capped \`llm_usage\` fetch cannot produce a correct total — it silently sums a subset once the\n` +
        `table outgrows the cap, and it fails in the reassuring direction (spend looks LOWER).\n` +
        `Aggregate in Postgres via lib/metrics/llm-spend instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the aggregate module actually aggregates in SQL", () => {
    // Without this, the guard above could be satisfied by deleting the cap and fetching EVERY row —
    // exact, but unbounded memory, and it would regress to a JS sum.
    const src = readFileSync(join(ROOT, AGGREGATE_MODULE), "utf8");
    expect(src).toMatch(/sum\(cost_usd\)/);
    expect(src).toMatch(/group by/i);
    expect(src).not.toMatch(/\.reduce\(/); // no JS summation of fetched rows
  });

  it("the aggregate module carries the tier predicate into the SQL", () => {
    // `llm_usage` has no RLS backstop. Moving the sum into SQL is exactly where a viewer filter gets
    // dropped, and the result would be a member seeing the team's whole spend.
    const src = stripComments(readFileSync(join(ROOT, AGGREGATE_MODULE), "utf8"));
    expect(src).toMatch(/viewer\.isAdmin/);
    expect(src).toMatch(/member_id = \$/);
  });

  it("no data value is interpolated into the SQL text", () => {
    // Every user/caller-supplied VALUE must arrive as a bound parameter. Only three kinds of thing
    // may be interpolated, and none of them can carry data:
    //   column / dimension  — resolved through the closed DIMENSIONS allowlist (asserted below)
    //   nextParamIndex / params.length — integers, used to build "$3" placeholders
    //   scope.sql           — a constant fragment this module itself wrote
    const SAFE = new Set(["column", "dimension", "nextParamIndex", "params.length", "scope.sql"]);
    const src = stripComments(readFileSync(join(ROOT, AGGREGATE_MODULE), "utf8"));
    const interpolations = [...src.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());

    expect(interpolations.length).toBeGreaterThan(0); // non-vacuous: there ARE interpolations to police
    expect(interpolations.filter((x) => !SAFE.has(x))).toEqual([]);
  });

  it("the grouped column comes from a closed allowlist, never from the caller", () => {
    // `${column}` is the only identifier spliced into the statement, so it is the one place a caller
    // could reach the SQL text. It must be a lookup, not the argument itself.
    const src = stripComments(readFileSync(join(ROOT, AGGREGATE_MODULE), "utf8"));
    expect(src).toMatch(/DIMENSIONS\[dimension\]/);
    expect(src).toMatch(/unknown spend dimension/); // and an unknown key throws rather than splices
  });
});
