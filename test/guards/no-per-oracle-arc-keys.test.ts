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

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function offendersIn(roots: string[]): string[] {
  return roots
    .flatMap((d) => files(d))
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      return MINTS.some((m) => src.includes(m));
    });
}

describe("guard: the per-oracle p: arc namespace stays retired", () => {
  it("no production file mints a p:-prefixed scope key (template or concat shape)", () => {
    const offenders = offendersIn(SCAN.map((d) => join(ROOT, d))).map((f) => f.slice(ROOT.length + 1));
    expect(offenders, `these files re-mint the retired p: namespace: ${offenders.join(", ")}`).toEqual([]);
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
});
