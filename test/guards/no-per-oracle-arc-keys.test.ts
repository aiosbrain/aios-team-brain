import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PPARC-4 — the INVERSE criterion (design §4.9): after the p: (per-oracle) arc namespace retired,
 * NO production writer may mint a p: scope key again — the straggler sweep would janitor the
 * evidence of exactly such a writer. TWO mint shapes are matched (template literal AND string
 * concat — the concat evasion was the review's Medium 2), and the self-test drives the REAL
 * scanner over a planted offender, not a string against itself.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const SCAN = ["lib", "app", "components", "scripts"];
// Spaced AND unspaced concat shapes (review Low 1: prettier normalizes to the spaced form, but the
// guard must not be one formatter exception away from blind). `.concat()`/`join(":")`/variable-held
// prefixes stay unmatched — the threat model is ACCIDENTAL reintroduction, not adversarial evasion.
const MINTS = ["`p:${", '"p:" +', "'p:' +", '"p:"+', "'p:'+"];

// The SQL surface is a REALISTIC re-mint path (Codex PPARC-4 Medium 3): a migration/backfill can
// write p: rows with `'p:' || …` and the 7-day straggler sweep would janitor the evidence. Scan
// postgres/ too, allowlisting the two SANCTIONED p:-era rewrites — they MOVE or retire existing
// p: keys (rekey to team id; re-scope to g:), minting nothing new. Any other .sql hit fails.
const SQL_SCAN = ["postgres"];
const SQL_MINT = "'p:' ||";
const SQL_SANCTIONED = new Set([
  "postgres/migrations/20260816130000_arc_scope_keys_team_id.sql",
  "postgres/migrations/20260816150000_arc_corrections_partition_scope.sql",
]);

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

function offendersIn(roots: string[]): string[] {
  return roots
    .flatMap((d) => files(d, /\.(ts|tsx|mjs)$/))
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      return MINTS.some((m) => src.includes(m));
    });
}

function sqlOffendersIn(roots: string[], sanctioned: ReadonlySet<string> = new Set()): string[] {
  return roots
    .flatMap((d) => files(d, /\.sql$/))
    .filter((f) => readFileSync(f, "utf8").includes(SQL_MINT))
    .filter((f) => !sanctioned.has(f.slice(ROOT.length + 1).split("\\").join("/")));
}

describe("guard: the per-oracle p: arc namespace stays retired", () => {
  it("no production file mints a p:-prefixed scope key (template or concat shape)", () => {
    const offenders = offendersIn(SCAN.map((d) => join(ROOT, d))).map((f) => f.slice(ROOT.length + 1));
    expect(offenders, `these files re-mint the retired p: namespace: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no SQL file mints a p:-prefixed key outside the two sanctioned p:-era rewrites", () => {
    const offenders = sqlOffendersIn(SQL_SCAN.map((d) => join(ROOT, d)), SQL_SANCTIONED).map((f) => f.slice(ROOT.length + 1));
    expect(offenders, `these SQL files re-mint the retired p: namespace: ${offenders.join(", ")}`).toEqual([]);
    // The allowlist is not dead weight: the sanctioned files DO carry the mint shape, so removing
    // the allowlist (or widening the sweep of a future edit into them) keeps the scanner honest.
    const unsanctioned = sqlOffendersIn(SQL_SCAN.map((d) => join(ROOT, d)));
    expect(unsanctioned.length).toBe(SQL_SANCTIONED.size);
  });

  it("the SCANNER catches a planted offender — not just the pattern matching itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "p-mint-guard-"));
    try {
      writeFileSync(join(dir, "sneaky.ts"), 'const k = "p:" + teamId + ":" + groups.join(",");\n');
      writeFileSync(join(dir, "innocent.ts"), 'const k = `g:${group}`;\n');
      const hits = offendersIn([dir]);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain("sneaky");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the SQL SCANNER catches a planted offender migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "p-mint-sql-guard-"));
    try {
      writeFileSync(join(dir, "20990101000000_backfill.sql"), "update arc_cache set group_key = 'p:' || team_id || ':x';\n");
      writeFileSync(join(dir, "innocent.sql"), "delete from arc_cache where group_key like 'g:%';\n");
      const hits = sqlOffendersIn([dir]);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain("backfill");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
