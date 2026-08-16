import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * PPARC-4 — the INVERSE criterion (design §4.9): after the p: (per-oracle) arc namespace retired,
 * NO production writer may mint a p: scope key again. The read cutover alone would let a missed
 * call site quietly re-mint per-oracle rows — with the straggler sweep janitoring the evidence
 * (the design names exactly this evasion). The MINTING template is the signature; the sweep's
 * `like 'p:%'` READ predicate is legal and deliberately not matched.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const SCAN = ["lib", "app", "components", "scripts"];
const MINT = "`p:${";

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("guard: the per-oracle p: arc namespace stays retired", () => {
  it("no production file mints a p:-prefixed scope key", () => {
    const offenders = SCAN.flatMap((d) => files(join(ROOT, d)))
      .filter((f) => readFileSync(f, "utf8").includes(MINT))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders, `these files re-mint the retired p: namespace: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the guard is non-vacuous — the minting template is caught when planted", () => {
    expect(("`p:${" + "teamId}:x`").includes(MINT)).toBe(true);
  });
});
