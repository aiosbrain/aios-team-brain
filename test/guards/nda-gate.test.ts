import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTerms, scan } from "@/scripts/nda-scan.mjs";

/**
 * The NDA gate must not be able to become decorative.
 *
 * It was, once, and that is why this exists: a client's name reached this PUBLIC repo because the
 * only gate was a per-machine hook reading a private term list, and `.githooks/pre-push` skips it
 * silently when absent. Whether a confidential name reached a public repo depended on whose laptop
 * ran `git push`. The properties below are the ones whose loss would recreate that.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "nda-scan.mjs");

/** Run the CLI and return its exit code + streams, without throwing on non-zero. */
function run(env: Record<string, string>): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
    return { code: 0, out, err: "" };
  } catch (e) {
    const x = e as { status: number; stdout: string; stderr: string };
    return { code: x.status, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

describe("guard: the NDA confidentiality gate", () => {
  it("FAILS CLOSED with no term list — an unconfigured gate is never a pass", () => {
    // The local gate's own rule, and the one that matters most: the failure mode of a
    // confidentiality gate must be "block", never "shrug". Exit 2 (not 1) so the workflow can tell
    // misconfiguration from a real leak and say the right thing.
    const r = run({ NDA_TERMS: "" });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/fails closed/i);
  });

  it("throws rather than reporting clean when the parsed term list is empty", () => {
    // A terms file of nothing but comments parses to zero terms. Reporting "clean" on that would be
    // the same vacuous pass wearing a configured-looking secret.
    expect(() => scan([])).toThrow(/refusing to report a pass/i);
  });

  it("parses the term list exactly as the local gate does — comments and blanks dropped", () => {
    // Two gates that disagree about what a term IS are worse than one, because the disagreement is
    // only ever discovered by a leak getting through the weaker one.
    expect(parseTerms("# a comment\n\n  spaced  \nterm-two\n#trailing\n")).toEqual(["spaced", "term-two"]);
  });

  it("REDACTS by default — this repo's Actions logs are world-readable", () => {
    // A gate that logs "found <client name> at file:40" publishes the thing it defends. `vitest` is
    // a term that certainly matches tracked files, so this is a real scan, not a mocked one.
    const redacted = scan(["vitest"]);
    expect(redacted.length).toBeGreaterThan(0);
    expect(redacted.every((f) => f.text === undefined)).toBe(true);
    expect(redacted.every((f) => typeof f.file === "string" && typeof f.line === "number")).toBe(true);

    // …and the escape hatch still works, for a trusted terminal.
    expect(scan(["vitest"], { revealLines: true }).some((f) => typeof f.text === "string")).toBe(true);
  });

  it("reports a leak with locations only, and exits 1 — distinct from misconfiguration", () => {
    const r = run({ NDA_TERMS: "vitest" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/BLOCKED/);
    expect(r.err).toMatch(/withheld because this log may be public/i);
  });

  it("is wired into CI, not merely present in the tree", () => {
    // The whole defect was a gate that existed but did not run. A scanner nothing invokes would be
    // the same failure with a nicer implementation.
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("nda-gate:");
    expect(ci).toContain("node scripts/nda-scan.mjs");
    expect(ci).toContain("secrets.NDA_TERMS");
    // A fork PR cannot access secrets, so the gate cannot run there — that must be ANNOUNCED, not
    // silently passed, or forks become the new "whose laptop pushed".
    expect(ci).toMatch(/NDA gate could not run/);
  });
});
