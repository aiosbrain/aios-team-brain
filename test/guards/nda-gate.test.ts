import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTerms, scan, scanRange } from "@/scripts/nda-scan.mjs";

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
    // No term index either (review Low 8): it is a membership oracle and it leaks the list size.
    expect(redacted.every((f) => !("termIndex" in f))).toBe(true);
    expect(redacted.every((f) => f.term === undefined)).toBe(true);
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

  it("scans the PR's COMMITS, and REMOVING a term is not itself a violation", () => {
    // Two properties that must hold together. A clean final tree is not a clean history — merge
    // commits are enabled, so a term added then removed within a PR still lands on `main`. But a
    // commit that REMOVES a term necessarily contains it on the removed side of its own patch, so a
    // naive range scan fails every scrub commit — including the one that introduced this gate. A
    // gate that blocks the fix for the thing it guards gets bypassed, and a bypassed gate is worse
    // than none.
    //
    // HERMETIC ON PURPOSE. The first version of this test asserted against THIS repo's history,
    // which meant naming the real confidential term in a test file — and the gate caught it, which
    // is exactly what it is for. A guard for a confidentiality tool must never need the secret it
    // guards; a synthetic repo gives the same evidence and cannot leak.
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      git("commit", "-qm", "base", "--allow-empty"); // so the first real commit has a parent
      const base = git("rev-parse", "HEAD").trim();

      writeFileSync(join(dir, "f.txt"), "SYNTHETICTERM is here\n");
      git("add", "-A");
      git("commit", "-qm", "add it");
      const added = git("rev-parse", "HEAD").trim();

      writeFileSync(join(dir, "f.txt"), "REPLACEMENT is here\n");
      git("add", "-A");
      git("commit", "-qm", "scrub it");
      const removed = git("rev-parse", "HEAD").trim();

      // The commit that ADDS the term must be reported…
      expect(scanRange(["SYNTHETICTERM"], `${base}..${added}`, { cwd: dir }).length).toBeGreaterThan(0);
      // …and the one that REMOVES it must not, even though its own patch carries the term on the
      // `-` side. Removal is the cure, not the disease.
      expect(scanRange(["SYNTHETICTERM"], `${added}..${removed}`, { cwd: dir })).toEqual([]);
      // A term in a commit MESSAGE is reported: it never appears in any tree, and is just as public.
      git("commit", "-qm", "mentions SYNTHETICTERM in the message", "--allow-empty");
      expect(scanRange(["SYNTHETICTERM"], `${removed}..HEAD`, { cwd: dir }).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a fork and for Dependabot — 'cannot run' is never a green check", () => {
    // Review High 1: a green REQUIRED check is a pass, whatever the annotation says. If the gate
    // exits 0 when it could not run, forks and bots simply become the new "whose laptop pushed".
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("nda-gate:"), ci.indexOf("secret-scan:"));
    expect(job).toMatch(/cannot run on a fork/);
    expect(job).toMatch(/dependabot\[bot\]/);
    // No `exit 0` anywhere in the unrunnable branches.
    expect(job).not.toMatch(/exit 0/);
    // And the history scan needs full depth, or the range is unreachable.
    expect(job).toContain("fetch-depth: 0");
  });

  it("is wired into CI, not merely present in the tree", () => {
    // The whole defect was a gate that existed but did not run. A scanner nothing invokes would be
    // the same failure with a nicer implementation.
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("nda-gate:");
    expect(ci).toContain("node scripts/nda-scan.mjs");
    expect(ci).toContain("secrets.NDA_TERMS");
    expect(ci).toContain("--range");
  });
});
