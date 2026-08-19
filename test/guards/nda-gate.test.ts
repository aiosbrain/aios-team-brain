import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs";
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
function run(env: Record<string, string>, args: string[] = []): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
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
    // a synthetic term in this tracked fixture, so this is a real scan, not a mocked one.
    const redacted = scan(["SYNTHETICTERM"]);
    expect(redacted.length).toBeGreaterThan(0);
    expect(redacted.every((f) => f.text === undefined)).toBe(true);
    // No term index either (review Low 8): it is a membership oracle and it leaks the list size.
    expect(redacted.every((f) => !("termIndex" in f))).toBe(true);
    expect(redacted.every((f) => f.term === undefined)).toBe(true);
    expect(redacted.every((f) => typeof f.file === "string" && typeof f.line === "number")).toBe(true);

    // …and the escape hatch still works, for a trusted terminal.
    expect(scan(["SYNTHETICTERM"], { revealLines: true }).some((f) => typeof f.text === "string")).toBe(true);
  });

  it("reports locations only in a trusted local terminal, and exits 1", () => {
    const r = run({ NDA_TERMS: "SYNTHETICTERM" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/BLOCKED/);
    expect(r.err).toMatch(/protected text is withheld/i);
  });

  it("collapses public CI output to one verdict so locations cannot become a membership oracle", () => {
    const r = run({ NDA_TERMS: "SYNTHETICTERM", CI: "true" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/BLOCKED/);
    expect(r.err).not.toMatch(/test\/guards|:\d+|locations|run locally/i);
    expect(r.err).not.toContain("SYNTHETICTERM");
  });

  it("refuses reveal mode in CI, without echoing the configured pattern", () => {
    const privatePattern = "SYNTHETICTERM";
    const r = run({ NDA_TERMS: privatePattern, CI: "true" }, ["--reveal"]);
    expect(r.code).toBe(2);
    expect(`${r.out}\n${r.err}`).not.toContain(privatePattern);
  });

  it("still executes when invoked through a symlinked CLI path", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-cli-"));
    const link = join(dir, "nda-scan.mjs");
    try {
      symlinkSync(SCRIPT, link);
      expect(() =>
        execFileSync("node", [link], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NDA_TERMS: "" } })
      ).toThrow(expect.objectContaining({ status: 2 }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans filenames, binaries, symlink blobs, multiline spelling, and punctuation-safe paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-tree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "SYNTHETIC SECRET:name.txt"), "safe body\n");
      writeFileSync(join(dir, "binary.bin"), Buffer.from("before\0SYNTHETIC SECRET\0after"));
      writeFileSync(join(dir, "utf16.txt"), Buffer.from("before SYNTHETIC SECRET after", "utf16le"));
      writeFileSync(join(dir, "split.txt"), "SYNTHETIC\nSECRET\n");
      symlinkSync("SYNTHETIC SECRET-target", join(dir, "link"));
      git("add", "-A");
      git("commit", "-qm", "fixture");

      const findings = scan(["SYNTHETIC[[:space:]]+SECRET"], { cwd: dir });
      expect(findings.length).toBeGreaterThanOrEqual(5);
      expect(findings.every((f) => f.text === undefined && f.term === undefined)).toBe(true);
      // A confidential path is itself unsafe to print; control punctuation cannot confuse parsing.
      expect(findings.some((f) => f.file === "tracked path (redacted)")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts scanner-engine failures instead of echoing a private invalid expression", () => {
    const privateInvalidPattern = "PRIVATE[";
    let message = "";
    try {
      scan([privateInvalidPattern]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/scan could not run/i);
    expect(message).not.toContain(privateInvalidPattern);
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
      expect(scan(["SYNTHETICTERM"], { cwd: dir, treeish: added }).length).toBeGreaterThan(0);
      expect(scan(["SYNTHETICTERM"], { cwd: dir, treeish: removed })).toEqual([]);
      // A term in a commit MESSAGE is reported: it never appears in any tree, and is just as public.
      git("commit", "-qm", "mentions SYNTHETICTERM in the message", "--allow-empty");
      expect(scanRange(["SYNTHETICTERM"], `${removed}..HEAD`, { cwd: dir }).length).toBeGreaterThan(0);

      // Paths are public history too, but renaming one away must not make the scrub self-fail.
      writeFileSync(join(dir, "SYNTHETICTERM-file.txt"), "safe\n");
      git("add", "-A");
      git("commit", "-qm", "add path fixture");
      const pathAdded = git("rev-parse", "HEAD").trim();
      renameSync(join(dir, "SYNTHETICTERM-file.txt"), join(dir, "replacement-file.txt"));
      git("add", "-A");
      git("commit", "-qm", "scrub path fixture");
      const pathScrubbed = git("rev-parse", "HEAD").trim();
      expect(scanRange(["SYNTHETICTERM"], `${removed}..${pathAdded}`, { cwd: dir }).length).toBeGreaterThan(0);
      expect(scanRange(["SYNTHETICTERM"], `${pathAdded}..${pathScrubbed}`, { cwd: dir })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds content introduced by a merge resolution even after a later scrub", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-merge-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "merge.txt"), "base\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();
      const primary = git("branch", "--show-current").trim();
      git("checkout", "-qb", "side");
      writeFileSync(join(dir, "merge.txt"), "side\n");
      git("commit", "-qam", "side");
      git("checkout", "-q", primary);
      writeFileSync(join(dir, "merge.txt"), "main\n");
      git("commit", "-qam", "main");
      try {
        git("merge", "side");
      } catch {
        // The synthetic conflict is resolved with content found in neither parent.
      }
      writeFileSync(join(dir, "merge.txt"), "SYNTHETICTERM\n");
      git("add", ".");
      git("commit", "-qm", "resolve merge");
      writeFileSync(join(dir, "merge.txt"), "replacement\n");
      git("commit", "-qam", "scrub merge resolution");

      expect(scan(["SYNTHETICTERM"], { cwd: dir })).toEqual([]);
      expect(scanRange(["SYNTHETICTERM"], `${base}..HEAD`, { cwd: dir }).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans the prospective merge tree, not only two individually clean parents", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-merge-tree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      const body = (first: string, second: string) => [first, ...Array(8).fill(""), second, "suffix", ""].join("\n");
      writeFileSync(join(dir, "joined.txt"), body("prefix", "placeholder"));
      git("add", ".");
      git("commit", "-qm", "root");
      const root = git("rev-parse", "HEAD").trim();
      const primary = git("branch", "--show-current").trim();
      git("checkout", "-qb", "feature");
      writeFileSync(join(dir, "joined.txt"), body("prefix", "TERM"));
      git("commit", "-qam", "feature side");
      const head = git("rev-parse", "HEAD").trim();
      git("checkout", "-q", primary);
      writeFileSync(join(dir, "joined.txt"), body("SYNTHETIC", "placeholder"));
      git("commit", "-qam", "base side");
      const base = git("rev-parse", "HEAD").trim();
      const mergeTree = git("merge-tree", "--write-tree", base, head).trim();
      const term = "SYNTHETIC[[:space:]]+TERM";

      expect(scan([term], { cwd: dir, treeish: base })).toEqual([]);
      expect(scan([term], { cwd: dir, treeish: head })).toEqual([]);
      expect(scanRange([term], `${root}..${head}`, { cwd: dir })).toEqual([]);
      expect(scan([term], { cwd: dir, treeish: mergeTree }).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans each intermediate tree, including cross-boundary text and opaque binary additions", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-history-tree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      // The parent already matches a DIFFERENT protected pattern. Comparing only one aggregate
      // before/after boolean would let the new cross-boundary pattern hide behind this old match.
      writeFileSync(join(dir, "joined.txt"), "ALREADYVISIBLE\nSYNTHETIC\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();

      // Only the second line is added, so a patch-line scan cannot see the term spanning both.
      writeFileSync(join(dir, "joined.txt"), "ALREADYVISIBLE\nSYNTHETIC\nTERM\n");
      // The NUL is deliberately after 9 KB: prefix-only binary sniffing is a real bypass.
      writeFileSync(join(dir, "opaque.bin"), Buffer.concat([Buffer.alloc(9_000, 65), Buffer.from([0, 1, 2, 3, 4])]));
      git("add", ".");
      git("commit", "-qm", "publish intermediate fixtures");
      writeFileSync(join(dir, "joined.txt"), "replacement\n");
      rmSync(join(dir, "opaque.bin"));
      git("add", "-A");
      git("commit", "-qm", "scrub intermediate fixtures");

      const terms = ["ALREADYVISIBLE", "SYNTHETIC[[:space:]]+TERM"];
      expect(scan(terms, { cwd: dir })).toEqual([]);
      const findings = scanRange(terms, `${base}..HEAD`, { cwd: dir });
      expect(findings.some((finding) => finding.file.includes("changed tracked content"))).toBe(true);
      expect(findings.some((finding) => finding.file.includes("opaque binary"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects ERE backreferences before invoking a potentially backtracking grep", () => {
    expect(() => scan([String.raw`(SYNTHETIC)\\1`])).toThrow(/scan could not run/i);
  });

  it("fails closed when the secret is unavailable — 'cannot run' is never a green check", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "nda-gate.yml"), "utf8");
    expect(workflow).toMatch(/dependabot\[bot\]/);
    expect(workflow).toMatch(/gate fails closed/i);
    expect(workflow).not.toMatch(/exit 0/);
  });

  it("runs trusted base-branch code and treats a PR head only as data", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "nda-gate.yml"), "utf8");
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("refs/pull/$PR_NUMBER/head:refs/nda-scan/pr-head");
    expect(workflow).toContain("refs/pull/$PR_NUMBER/merge:refs/nda-scan/pr-merge");
    expect(workflow).toContain('test "$(git show -s --format=%P "$MERGE_SHA")" = "$BASE_SHA $HEAD_SHA"');
    expect(workflow).toContain('node scripts/nda-scan.mjs --tree "$MERGE_SHA" --range "$BASE_SHA..$HEAD_SHA"');
    expect(workflow).toContain('node scripts/nda-scan.mjs --range "$BASE_SHA..$HEAD_SHA"');
    expect(workflow).toContain('node scripts/nda-scan.mjs --range "$HEAD_SHA"');
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("secrets.NDA_TERMS");
    expect(workflow).toContain("statuses: write");
    expect(workflow).toContain('statuses/${HEAD_SHA}');
    expect(workflow).toContain("if: github.event_name == 'pull_request_target' && always()");
    expect(workflow).not.toMatch(/checkout[^\n]*head|ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
    // The ordinary PR workflow must never inject the private list into PR-controlled code.
    expect(ci).not.toContain("secrets.NDA_TERMS");
    expect(ci).not.toContain("node scripts/nda-scan.mjs");
  });
});
