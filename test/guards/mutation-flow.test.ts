import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, planEdits } from "../../scripts/mutate.mjs";

/**
 * BUILD-FAILING GUARD for the mutation flow (MUTFLOW-1).
 *
 * WHY IT IS BEHAVIOURAL AND NOT A SOURCE SCAN. The first draft of this slice's acceptance criteria
 * asserted only that `mutate.mjs` *mentions* `mutation-guard.mjs`. Review pointed out that a tool which
 * calls the guard and ignores its result satisfies that completely — the pin-the-call-site failure this
 * repo already carries a scar from. So the refusal paths are exercised by RUNNING the tool against
 * scratch git repositories, and the source scan survives only for the one property a run cannot show:
 * that the tracked-changes logic is not reimplemented.
 *
 * The tool is pointed at a scratch repo with `MUTATE_ROOT`, and its test command is replaced with
 * `MUTATE_TEST_CMD` (a scratch repo has no vitest). Neither can skip the guard — they move which repo
 * is guarded and which command produces the report this tool then READS.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MUTATE = path.join(ROOT, "scripts", "mutate.mjs");

let scratch: string;
const files: string[] = [];

/** A JSON report in vitest's shape, written by a shell command — the tool must READ it, not scrape. */
const reportCmd = (total: number, failedNames: string[] = []) => {
  const results =
    failedNames.length === 0
      ? `[{"assertionResults":[{"status":"passed","fullName":"ok"}]}]`
      : `[{"assertionResults":[${failedNames
          .map((n) => `{"status":"failed","fullName":"${n}"}`)
          .join(",")}]}]`;
  return `printf '{"numTotalTests":${total},"testResults":${results}}' >`;
};

function newRepo(name: string, content = "alpha\nbeta\ngamma\n"): { dir: string; target: string } {
  const dir = path.join(scratch, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  const target = path.join(dir, "target.txt");
  writeFileSync(target, content);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return { dir, target };
}

function needleFile(name: string, text: string): string {
  const p = path.join(scratch, name);
  writeFileSync(p, text);
  files.push(p);
  return p;
}

function run(dir: string, args: string[], testCmd = reportCmd(1)) {
  return spawnSync(process.execPath, [MUTATE, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, MUTATE_ROOT: dir, MUTATE_TEST_CMD: testCmd },
  });
}

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "mutflow-guard-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("guard: the flow refuses before it can destroy anything", () => {
  it("REFUSES on a dirty tracked tree, before mutating and before running tests", () => {
    // THE core property, and the one a source scan cannot show. If this passes while the guard call is
    // dead, everything else in this file is decoration.
    const { dir, target } = newRepo("dirty");
    writeFileSync(path.join(dir, "target.txt"), "alpha\nBETA-uncommitted\ngamma\n");
    const dirtyBytes = readFileSync(target, "utf8");
    const r = run(dir, [target, "--edit", needleFile("n1", "alpha"), needleFile("r1", "ALPHA")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("REFUSING");
    // …and the operator's uncommitted work is untouched.
    expect(readFileSync(target, "utf8")).toBe(dirtyBytes);
  });

  it("REFUSES an untracked target — a file with no committed version is not a checkpoint", () => {
    const { dir } = newRepo("untracked");
    const loose = path.join(dir, "loose.txt");
    writeFileSync(loose, "alpha\n");
    const r = run(dir, [loose, "--edit", needleFile("n2", "alpha"), needleFile("r2", "ALPHA")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("untracked");
  });

  it("REFUSES a needle that matches zero times, and one that matches twice", () => {
    // A mutation that touched nothing, or an unknown one of two sites, reports a verdict that means
    // nothing — the same vacuity the zero-tests rule below covers on the other axis.
    const { dir, target } = newRepo("cardinality", "alpha\nbeta\nalpha\n");
    const zero = run(dir, [target, "--edit", needleFile("n3", "omega"), needleFile("r3", "X")]);
    expect(zero.status).toBe(1);
    expect(zero.stderr).toContain("does not appear");
    const twice = run(dir, [target, "--edit", needleFile("n4", "alpha"), needleFile("r4", "X")]);
    expect(twice.status).toBe(1);
    expect(twice.stderr).toContain("more than once");
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\nalpha\n");
  });

  it("REFUSES when ZERO tests ran, rather than reporting a survivor", () => {
    // The hazard draft 1 missed: a filter selecting no files prints all-green, which reads as SURVIVED.
    const { dir, target } = newRepo("zerotests");
    const r = run(dir, [target, "--edit", needleFile("n5", "beta"), needleFile("r5", "BETA")], reportCmd(0));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ZERO tests");
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n"); // and restored
  });

  it("REFUSES when the report is unreadable — 'cannot tell' must not read as 'some tests ran'", () => {
    const { dir, target } = newRepo("noreport");
    const r = run(dir, [target, "--edit", needleFile("n6", "beta"), needleFile("r6", "BETA")], "true");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no readable report|test count/);
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("every refusal names itself, so a crashed tool is not mistaken for a refusal", () => {
    // node exits 1 on any uncaught throw; the message is the only discriminator.
    const { dir } = newRepo("usage");
    const r = run(dir, ["nope.txt"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("mutate: REFUSING");
  });
});

describe("guard: the flow restores, and says what it did", () => {
  it("restores the target to its committed bytes after a run", () => {
    const { dir, target } = newRepo("restore");
    const before = readFileSync(target, "utf8");
    const r = run(dir, [target, "--edit", needleFile("n7", "beta"), needleFile("r7", "BETA")], reportCmd(3, ["a test"]));
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(r.stdout).toContain("REDDENED");
    expect(r.stdout).toContain("a test");
  });

  it("exit tracks the EXPECTATION, not the verdict — so --keep cannot invert the polarity", () => {
    // Review's blocker on draft 2: pinning exit to the raw verdict makes SURVIVED (the success case
    // under --keep) exit non-zero, and REDDENED (a broken kept edit) exit 0.
    const { dir, target } = newRepo("expect");
    const n = needleFile("n8", "beta");
    const rep = needleFile("r8", "BETA");
    const caught = run(dir, [target, "--edit", n, rep], reportCmd(2, ["red"]));
    expect(caught.status).toBe(0); // default --expect reddened, and it reddened
    const survived = run(dir, [target, "--edit", n, rep], reportCmd(2));
    expect(survived.status).toBe(2); // survived when it should have been caught
    const wanted = run(dir, [target, "--edit", n, rep, "--expect", "survived"], reportCmd(2));
    expect(wanted.status).toBe(0);
  });

  it("--keep leaves the edit applied when green, and REFUSES to keep a red one", () => {
    const { dir, target } = newRepo("keep");
    const n = needleFile("n9", "beta");
    const rep = needleFile("r9", "BETA");

    const red = run(dir, [target, "--edit", n, rep, "--keep"], reportCmd(2, ["red"]));
    expect(red.status).not.toBe(0);
    expect(red.stderr).toContain("NOT KEPT");
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n"); // restored, not kept

    const green = run(dir, [target, "--edit", n, rep, "--keep"], reportCmd(2));
    expect(green.status).toBe(0);
    expect(readFileSync(target, "utf8")).toContain("BETA"); // kept
    expect(green.stdout).toContain("kept (target only)");
  });

  it("--keep-even-if-red keeps it, but says so in capitals", () => {
    const { dir, target } = newRepo("keepred");
    const r = run(
      dir,
      [target, "--edit", needleFile("n10", "beta"), needleFile("r10", "BETA"), "--keep-even-if-red"],
      reportCmd(2, ["red"])
    );
    expect(readFileSync(target, "utf8")).toContain("BETA");
    expect(r.stderr).toContain("KEPT FAILING MUTATION");
  });

  it("reports a target the TEST RUN dirtied instead of silently discarding it", () => {
    // Under --keep the kept diff would otherwise be mutation-plus-noise; under restore the write would
    // vanish without a word.
    const { dir, target } = newRepo("dirtied");
    const cmd = `printf 'clobbered\\n' > "${target}"; ${reportCmd(1)}`;
    const r = run(dir, [target, "--edit", needleFile("n11", "beta"), needleFile("r11", "BETA")], cmd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TEST DIRTIED TARGET");
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n");
  });
});

describe("guard: multi-edit semantics are simultaneous against the original", () => {
  it("applies several pairs together", () => {
    const plan = planEdits("one two three", [
      { label: "#1", needleText: "one", replacementText: "1" },
      { label: "#2", needleText: "three", replacementText: "3" },
    ]);
    expect(plan.mutated).toBe("1 two 3");
  });

  it("refuses overlapping spans", () => {
    const plan = planEdits("abcdef", [
      { label: "#1", needleText: "abcd", replacementText: "X" },
      { label: "#2", needleText: "cdef", replacementText: "Y" },
    ]);
    expect(plan.error).toContain("overlaps");
  });

  it("refuses a replacement that contains another pair's needle — cascade, not simultaneity", () => {
    // The ordering hazard both reviewers named: if #1's replacement creates #2's needle, "matches
    // exactly once" means different things before and after, and the mutation is silently not the one
    // the operator described.
    const plan = planEdits("alpha beta", [
      { label: "#1", needleText: "alpha", replacementText: "beta" },
      { label: "#2", needleText: "beta", replacementText: "gamma" },
    ]);
    expect(plan.error).toContain("cascading");
  });

  it("--keep defaults the expectation to survived, and --expect overrides it", () => {
    expect(parseArgs(["f", "--edit", "a", "b"]).opts.expect).toBe("reddened");
    expect(parseArgs(["f", "--edit", "a", "b", "--keep"]).opts.expect).toBe("survived");
    expect(parseArgs(["f", "--edit", "a", "b", "--keep", "--expect", "reddened"]).opts.expect).toBe("reddened");
  });
});

describe("guard: the flow owns the guard and the skill names the flow", () => {
  const src = readFileSync(MUTATE, "utf8");

  it("delegates the checkpoint question rather than reimplementing it", () => {
    // The one property a run cannot show. The behavioural refusal above proves the call is live; this
    // proves there is no second definition of "is this tree a checkpoint" to drift from the first.
    expect(src).toContain("mutation-guard.mjs");
    expect(src).not.toMatch(/status\s+--porcelain[^\n]*\n[^\n]*trackedChanges/);
  });

  it("owns the reporter, so the test count cannot be scraped from human output", () => {
    expect(src).toContain("--reporter=json");
    expect(src).toContain("numTotalTests");
  });

  it("the skill names this command and no longer narrates the manual sequence", () => {
    // Three sites, all of which review found: the guard-invocation paragraph, the break/revert/confirm
    // step, and the failure-modes row that still credited a "process rule". If any survives, the skill
    // documents two paths and this slice's central claim is false on day one.
    const skill = readFileSync(path.join(ROOT, ".claude", "skills", "adversarial-build", "SKILL.md"), "utf8");
    expect(skill).toContain("scripts/mutate.mjs");
    expect(skill).not.toMatch(/revert, confirm the tree is clean/);
    expect(skill).not.toMatch(/Lost work during mutation testing \| process rule/);
  });
});
