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
import { matchingTermSets, parseTerms, scan, scanRange } from "@/scripts/nda-scan.mjs";

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

  it("maps physical grep records to exact values across empty and newline edge positions", () => {
    const matches = matchingTermSets(
      ["", "\nleading", "trailing\n", "trailing\n\n", "multiple\n\nlines", "both ALPHA beta\n"],
      ["^$", "^leading$", "^trailing$", "^multiple$", "^lines$", "alpha", "beta"]
    );

    expect(matches.map((indexes) => [...indexes])).toEqual([
      [],
      [0, 1],
      [2],
      [0, 2],
      [0, 3, 4],
      [5, 6],
    ]);
  });

  it("fails closed on malformed or out-of-range grep record indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-grep-records-"));
    const previousPath = process.env.PATH;
    const previousRealGrep = process.env.NDA_TEST_REAL_GREP;
    const previousMode = process.env.NDA_TEST_GREP_MODE;
    try {
      const realGrep = execFileSync("sh", ["-c", "command -v grep"], { encoding: "utf8" }).trim();
      const grepShim = join(dir, "grep");
      writeFileSync(
        grepShim,
        `#!/bin/sh
if [ "$NDA_TEST_GREP_MODE" = "malformed" ]; then
  printf 'not-a-record\n'
  exit 0
fi
if [ "$NDA_TEST_GREP_MODE" = "out-of-range" ]; then
  printf '2:value\n'
  exit 0
fi
exec "$NDA_TEST_REAL_GREP" "$@"
`
      );
      chmodSync(grepShim, 0o755);
      process.env.NDA_TEST_REAL_GREP = realGrep;
      process.env.PATH = `${dir}:${previousPath ?? ""}`;

      process.env.NDA_TEST_GREP_MODE = "malformed";
      expect(() => matchingTermSets(["value"], ["value"])).toThrow(/scan could not run/i);
      process.env.NDA_TEST_GREP_MODE = "out-of-range";
      expect(() => matchingTermSets(["value"], ["value"])).toThrow(/scan could not run/i);
    } finally {
      process.env.PATH = previousPath;
      if (previousRealGrep === undefined) delete process.env.NDA_TEST_REAL_GREP;
      else process.env.NDA_TEST_REAL_GREP = previousRealGrep;
      if (previousMode === undefined) delete process.env.NDA_TEST_GREP_MODE;
      else process.env.NDA_TEST_GREP_MODE = previousMode;
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("blocks add-then-scrub history when a newline path precedes a reused matching value", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-newline-owner-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const term = "SYNTHETIC[[:space:]]+TERM";
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "legacy.txt"), "SYNTHETIC\nTERM\n");
      writeFileSync(join(dir, "target.txt"), "SYNTHETIC\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();

      writeFileSync(join(dir, "legacy.txt"), "safe\n");
      writeFileSync(join(dir, "a\nb.txt"), "neutral\n");
      git("add", ".");
      git("commit", "-qm", "scrub legacy and add newline path");
      writeFileSync(join(dir, "target.txt"), "SYNTHETIC\nTERM\n");
      git("commit", "-qam", "publish matching target");
      writeFileSync(join(dir, "target.txt"), "safe\n");
      git("commit", "-qam", "scrub matching target");

      expect(scan([term], { cwd: dir })).toEqual([]);
      const result = run({ NDA_TERMS: term, CI: "true" }, ["--range", `${base}..HEAD`, "--max-commits", "500"], dir);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/BLOCKED/);
      expect(`${result.out}\n${result.err}`).not.toContain(term);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses exact normalized range matches while still scanning a newly modified value", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-range-cache-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      git("commit", "-qm", "base", "--allow-empty");
      const base = git("rev-parse", "HEAD").trim();
      const repeatedBody = `SAFE-${"x".repeat(160)}\n`;

      writeFileSync(join(dir, "a.txt"), repeatedBody);
      git("add", ".");
      git("commit", "-qm", "add repeated body");
      renameSync(join(dir, "a.txt"), join(dir, "b.txt"));
      git("add", "-A");
      git("commit", "-qm", "rename repeated body once");
      renameSync(join(dir, "b.txt"), join(dir, "c.txt"));
      git("add", "-A");
      git("commit", "-qm", "rename repeated body twice");
      writeFileSync(join(dir, "c.txt"), `${repeatedBody.trim()} SYNTHETICTERM\n`);
      git("commit", "-qam", "modify repeated body");

      // The 400-byte test bound is below the old per-commit accounting total but above the exact
      // unique normalized values. The modified value is distinct, so it must still be matched.
      const findings = scanRange(["SYNTHETICTERM"], `${base}..HEAD`, {
        cwd: dir,
        maxScannedBytes: 400,
      });
      expect(findings.some((finding) => finding.file.includes("changed tracked content"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the range budget fail-closed for distinct content and cannot raise the 64 MiB cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-range-budget-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      git("commit", "-qm", "base", "--allow-empty");
      const base = git("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "one.txt"), `ONE-${"a".repeat(160)}\n`);
      git("add", ".");
      git("commit", "-qm", "add first distinct body");
      writeFileSync(join(dir, "two.txt"), `TWO-${"b".repeat(160)}\n`);
      git("add", ".");
      git("commit", "-qm", "add second distinct body");

      expect(() => scanRange(["SYNTHETIC_NEVER_PRESENT"], `${base}..HEAD`, {
        cwd: dir,
        maxScannedBytes: 300,
      })).toThrow(/scan could not run/i);
      expect(() => scanRange(["SYNTHETIC_NEVER_PRESENT"], `${base}..HEAD`, {
        cwd: dir,
        maxScannedBytes: 64 * 1024 * 1024 + 1,
      })).toThrow(/scan could not run/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects the first over-budget value before reading a later changed blob", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-early-budget-"));
    const shimDir = mkdtempSync(join(tmpdir(), "nda-gate-early-budget-shim-"));
    const marker = join(shimDir, "late-blob-read");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const previousPath = process.env.PATH;
    const previousRealGit = process.env.NDA_TEST_REAL_GIT;
    const previousLateObject = process.env.NDA_TEST_LATE_OBJECT;
    const previousLateMarker = process.env.NDA_TEST_LATE_READ_MARKER;
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      git("commit", "-qm", "base", "--allow-empty");
      const base = git("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "a-over-budget.txt"), `${"a".repeat(128)}\n`);
      writeFileSync(join(dir, "z-must-not-read.txt"), `${"z".repeat(128)}\n`);
      git("add", ".");
      git("commit", "-qm", "add ordered budget fixtures");
      const head = git("rev-parse", "HEAD").trim();

      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const gitShim = join(shimDir, "git");
      writeFileSync(
        gitShim,
        `#!/bin/sh
if [ "$1" = "show" ] && [ "$2" = "$NDA_TEST_LATE_OBJECT" ]; then
  : > "$NDA_TEST_LATE_READ_MARKER"
  exit 97
fi
exec "$NDA_TEST_REAL_GIT" "$@"
`
      );
      chmodSync(gitShim, 0o755);
      process.env.NDA_TEST_REAL_GIT = realGit;
      process.env.NDA_TEST_LATE_OBJECT = `${head}:z-must-not-read.txt`;
      process.env.NDA_TEST_LATE_READ_MARKER = marker;
      process.env.PATH = `${shimDir}:${previousPath ?? ""}`;

      expect(() => scanRange(["SYNTHETIC_NEVER_PRESENT"], `${base}..${head}`, {
        cwd: dir,
        maxScannedBytes: 80,
      })).toThrow(/scan could not run/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = previousPath;
      if (previousRealGit === undefined) delete process.env.NDA_TEST_REAL_GIT;
      else process.env.NDA_TEST_REAL_GIT = previousRealGit;
      if (previousLateObject === undefined) delete process.env.NDA_TEST_LATE_OBJECT;
      else process.env.NDA_TEST_LATE_OBJECT = previousLateObject;
      if (previousLateMarker === undefined) delete process.env.NDA_TEST_LATE_READ_MARKER;
      else process.env.NDA_TEST_LATE_READ_MARKER = previousLateMarker;
      rmSync(dir, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("isolates cached matches between term sets and range invocations", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-range-cache-scope-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      git("commit", "-qm", "base", "--allow-empty");
      const base = git("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "scope.txt"), "safe\n");
      git("add", ".");
      git("commit", "-qm", "safe range");
      const safe = git("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "scope.txt"), "safe SYNTHETICTERM\n");
      git("commit", "-qam", "matching range");

      expect(scanRange(["SYNTHETICTERM"], `${base}..${safe}`, { cwd: dir })).toEqual([]);
      expect(scanRange(["SYNTHETIC_NEVER_PRESENT"], `${base}..HEAD`, { cwd: dir })).toEqual([]);
      expect(scanRange(["SYNTHETICTERM"], `${base}..HEAD`, { cwd: dir }).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates a previous-parent blob read failure after exact path existence is proven", () => {
    const dir = mkdtempSync(join(tmpdir(), "nda-gate-parent-read-"));
    const shimDir = mkdtempSync(join(tmpdir(), "nda-gate-git-shim-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const previousPath = process.env.PATH;
    const previousRealGit = process.env.NDA_TEST_REAL_GIT;
    const previousFailObject = process.env.NDA_TEST_FAIL_OBJECT;
    try {
      git("init", "-q");
      git("config", "user.email", "t@t.local");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "resource.txt"), "before\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "resource.txt"), "after\n");
      git("commit", "-qam", "modify resource");

      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const gitShim = join(shimDir, "git");
      writeFileSync(
        gitShim,
        `#!/bin/sh
if [ "$1" = "show" ] && [ "$2" = "$NDA_TEST_FAIL_OBJECT" ]; then
  exit 97
fi
exec "$NDA_TEST_REAL_GIT" "$@"
`
      );
      chmodSync(gitShim, 0o755);
      process.env.NDA_TEST_REAL_GIT = realGit;
      process.env.NDA_TEST_FAIL_OBJECT = `${base}:resource.txt`;
      process.env.PATH = `${shimDir}:${previousPath ?? ""}`;

      expect(() => scanRange(["SYNTHETIC_NEVER_PRESENT"], `${base}..HEAD`, { cwd: dir })).toThrow(
        /tracked content could not be read/i
      );
    } finally {
      process.env.PATH = previousPath;
      if (previousRealGit === undefined) delete process.env.NDA_TEST_REAL_GIT;
      else process.env.NDA_TEST_REAL_GIT = previousRealGit;
      if (previousFailObject === undefined) delete process.env.NDA_TEST_FAIL_OBJECT;
      else process.env.NDA_TEST_FAIL_OBJECT = previousFailObject;
      rmSync(dir, { recursive: true, force: true });
      rmSync(shimDir, { recursive: true, force: true });
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
  }, 60_000);

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
