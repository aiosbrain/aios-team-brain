import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  renameSync,
  symlinkSync,
} from "node:fs";
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
function run(
  env: Record<string, string>,
  args: string[] = [],
  cwd = ROOT
): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
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
    // GitHub exports CI=true for the entire test process. Explicitly model a trusted local shell;
    // otherwise this test correctly receives the public, location-free output it tests below.
    const r = run({ NDA_TERMS: "SYNTHETICTERM", CI: "" });
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

  it("validates the explicit commit limit without exposing configured patterns", () => {
    const invalid = run(
      { NDA_TERMS: "SYNTHETIC_NEVER_PRESENT", CI: "true" },
      ["--range", "HEAD", "--max-commits", "0"]
    );
    expect(invalid.code).toBe(2);
    expect(invalid.err).toMatch(/positive safe integer/i);

    const unscoped = run(
      { NDA_TERMS: "SYNTHETIC_NEVER_PRESENT", CI: "true" },
      ["--max-commits", "500"]
    );
    expect(unscoped.code).toBe(2);
    expect(unscoped.err).toMatch(/requires --range/i);
    expect(`${invalid.out}\n${invalid.err}\n${unscoped.out}\n${unscoped.err}`).not.toContain(
      "SYNTHETIC_NEVER_PRESENT"
    );
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

  it("returns real clean and blocked verdicts for ranges over 100 commits", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-long-range-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      git("commit", "-qm", "base", "--allow-empty");
      const base = git("rev-parse", "HEAD").trim();

      for (let i = 1; i <= 101; i += 1) {
        git("commit", "-qm", `synthetic clean commit ${i}`, "--allow-empty");
      }
      expect(scanRange(["SYNTHETICTERM"], `${base}..HEAD`, { cwd: dir })).toEqual([]);

      git("commit", "-qm", "synthetic message contains SYNTHETICTERM", "--allow-empty");
      expect(scanRange(["SYNTHETICTERM"], `${base}..HEAD`, { cwd: dir, maxCommits: 500 }).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails an explicitly bounded range above 500 commits with a distinct actionable verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-pr-limit-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      git("commit", "-qm", "base", "--allow-empty");
      const base = git("rev-parse", "HEAD").trim();

      for (let i = 1; i <= 501; i += 1) {
        git("commit", "-qm", `synthetic empty commit ${i}`, "--allow-empty");
      }
      const bounded = run(
        { NDA_TERMS: "SYNTHETIC_NEVER_PRESENT", CI: "true" },
        ["--range", `${base}..HEAD`, "--max-commits", "500"],
        dir
      );
      expect(bounded.code).toBe(3);
      expect(bounded.err).toMatch(/501 commits/);
      expect(bounded.err).toMatch(/limit of 500/);
      expect(bounded.err).toMatch(/split or rebase/i);
      expect(`${bounded.out}\n${bounded.err}`).not.toContain("SYNTHETIC_NEVER_PRESENT");

      const engineFailure = run(
        { NDA_TERMS: "SYNTHETIC[", CI: "true" },
        ["--range", `${base}..HEAD`],
        dir
      );
      expect(engineFailure.code).toBe(2);
      expect(`${engineFailure.out}\n${engineFailure.err}`).not.toContain("SYNTHETIC[");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("counts a capped range before enumerating commit hashes and validates the count", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-count-first-"));
    const gitShim = join(dir, "git");
    const enumerationMarker = join(dir, "enumerated");
    const previousPath = process.env.PATH;
    const previousCount = process.env.NDA_TEST_COMMIT_COUNT;
    const previousMarker = process.env.NDA_TEST_ENUMERATION_MARKER;
    try {
      writeFileSync(
        gitShim,
        `#!/bin/sh
if [ "$1" = "rev-list" ] && [ "$2" = "--count" ]; then
  printf '%s\\n' "$NDA_TEST_COMMIT_COUNT"
  exit 0
fi
if [ "$1" = "rev-list" ] && [ "$2" = "--reverse" ]; then
  : > "$NDA_TEST_ENUMERATION_MARKER"
  exit 97
fi
exit 98
`
      );
      chmodSync(gitShim, 0o755);
      process.env.PATH = `${dir}:${previousPath ?? ""}`;
      process.env.NDA_TEST_ENUMERATION_MARKER = enumerationMarker;

      process.env.NDA_TEST_COMMIT_COUNT = "not-a-count";
      expect(() => scanRange(["SYNTHETICTERM"], "synthetic", { cwd: dir, maxCommits: 500 })).toThrow(
        /scan could not run/i
      );
      expect(existsSync(enumerationMarker)).toBe(false);

      process.env.NDA_TEST_COMMIT_COUNT = "9007199254740992";
      expect(() => scanRange(["SYNTHETICTERM"], "synthetic", { cwd: dir, maxCommits: 500 })).toThrow(
        /scan could not run/i
      );
      expect(existsSync(enumerationMarker)).toBe(false);

      process.env.NDA_TEST_COMMIT_COUNT = "501";
      expect(() => scanRange(["SYNTHETICTERM"], "synthetic", { cwd: dir, maxCommits: 500 })).toThrow(
        /501 commits.*limit of 500/i
      );
      expect(existsSync(enumerationMarker)).toBe(false);
    } finally {
      process.env.PATH = previousPath;
      if (previousCount === undefined) delete process.env.NDA_TEST_COMMIT_COUNT;
      else process.env.NDA_TEST_COMMIT_COUNT = previousCount;
      if (previousMarker === undefined) delete process.env.NDA_TEST_ENUMERATION_MARKER;
      else process.env.NDA_TEST_ENUMERATION_MARKER = previousMarker;
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
    expect(workflow).toContain(
      'node scripts/nda-scan.mjs --tree "$MERGE_SHA" --range "$BASE_SHA..$HEAD_SHA" --max-commits 500'
    );
    expect(workflow).toContain('node scripts/nda-scan.mjs --range "$BASE_SHA..$HEAD_SHA"');
    expect(workflow).toMatch(/node scripts\/nda-scan\.mjs --range "\$HEAD_SHA"\s*\n/);
    expect(workflow.match(/--max-commits/g)).toHaveLength(1);
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
