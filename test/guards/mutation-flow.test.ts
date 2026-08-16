import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, planEdits, runMutationFlow, verdictFrom } from "../../scripts/mutate.mjs";

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
 * The tool is pointed at a scratch repo with `MUTATE_ROOT` — which both reviewers checked for a bypass
 * and cleared, since the guard, `ls-files` and the target all resolve under one root. The fake test
 * RUNNER is injected as a function argument, never an env override: the first version used one, and both
 * reviewers showed it let the production CLI forge a verdict.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MUTATE = path.join(ROOT, "scripts", "mutate.mjs");

let scratch: string;
const files: string[] = [];

/**
 * A fake test runner, INJECTED — not an env override.
 *
 * The first version of this file stubbed the runner with `MUTATE_TEST_CMD`, and both code reviewers
 * showed that shipped a verdict-forgery channel in the production CLI: mutate a real file, stub the
 * report, and print a block byte-identical to a real run — which the skill then tells you to paste into
 * a PR. The override is gone from the CLI; the runner is a parameter, and only the tests pass a fake.
 *
 * `sideEffect` lets a test observe WHEN the runner ran (a sentinel) and WHAT it saw (the target's bytes
 * at run time), which is how "refuses before running tests" and "the tests see the mutant" get pinned.
 */
const fakeRunner = (
  report: Record<string, unknown>,
  sideEffect?: (ctx: { root: string }) => void
) => {
  const calls: { root: string }[] = [];
  const run = ({ root, reportPath }: { root: string; reportPath: string }) => {
    calls.push({ root });
    sideEffect?.({ root });
    writeFileSync(reportPath, JSON.stringify(report));
    return { stdout: "" };
  };
  return Object.assign(run, { calls });
};

const green = (total = 2) => ({ numTotalTests: total, numFailedTests: 0, testResults: [] });
const red = (names: string[], total = 2) => ({
  numTotalTests: total,
  numFailedTests: names.length,
  testResults: [{ assertionResults: names.map((n) => ({ status: "failed", fullName: n })) }],
});

/** Captures the tool's output instead of racing stdout. */
const capture = () => {
  const lines: string[] = [];
  return { io: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }, text: () => lines.join("\n") };
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

/** Reads a needle file the way the tool does — one trailing newline stripped, bytes otherwise. */
const readNeedleFor = (p: string) => readFileSync(p, "utf8").replace(/\n$/, "");

function needleFile(name: string, text: string): string {
  const p = path.join(scratch, name);
  writeFileSync(p, text);
  files.push(p);
  return p;
}

/** In-process, with an injected runner — the only way a fake runner exists anywhere now. */
function flow(
  dir: string,
  args: string[],
  report: Record<string, unknown> = green(),
  sideEffect?: (ctx: { root: string }) => void
) {
  const cap = capture();
  const runner = fakeRunner(report, sideEffect);
  const status = runMutationFlow({ root: dir, argv: args, testRunner: runner, io: cap.io, log: () => {} });
  return { status, out: cap.text(), runner };
}

/** Through the real CLI, for the properties that must hold of the shipped binary. It has no runner
 *  override, so this is only used where the flow refuses BEFORE any test would run. */
function cli(dir: string, args: string[]) {
  return spawnSync(process.execPath, [MUTATE, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, MUTATE_ROOT: dir },
  });
}

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "mutflow-guard-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("guard: the flow refuses before it can destroy anything", () => {
  it("REFUSES on a dirty tracked tree — before mutating, and before any test runs", () => {
    // THE core property, and the one a source scan cannot show. The sentinel is what proves "before any
    // test runs": review pointed out that asserting refusal + unchanged bytes would still pass if the
    // flow had run the tests first.
    const { dir, target } = newRepo("dirty");
    writeFileSync(target, "alpha\nBETA-uncommitted\ngamma\n");
    const dirtyBytes = readFileSync(target, "utf8");
    const r = flow(dir, [target, "--edit", needleFile("n1", "alpha"), needleFile("r1", "ALPHA")]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("REFUSING");
    expect(r.runner.calls).toHaveLength(0); // the tests never ran
    expect(readFileSync(target, "utf8")).toBe(dirtyBytes); // the operator's work is untouched
  });

  it("REFUSES on a dirty tree THROUGH THE SHIPPED CLI too, not only in-process", () => {
    // The in-process tests inject a runner; this one runs the binary an operator actually invokes, to
    // prove the wiring in `main()` is the same wiring the tests exercise.
    const { dir, target } = newRepo("dirty-cli");
    writeFileSync(target, "alpha\nDIRTY\ngamma\n");
    const r = cli(dir, [target, "--edit", needleFile("nc", "alpha"), needleFile("rc", "ALPHA")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("REFUSING");
  });

  it("has NO env override for the test runner — the CLI cannot be made to forge a verdict", () => {
    // Both reviewers found this as a HIGH: an env-substituted test command lets someone mutate a real
    // file, stub the report, and print a verdict block byte-identical to a real run — which the skill
    // tells you to paste into a PR. The runner is a function parameter now, and nothing in the script
    // reads a command from the environment.
    const src = readFileSync(MUTATE, "utf8");
    expect(src).not.toContain("MUTATE_TEST_CMD");
    expect(src).not.toMatch(/process\.env\.[A-Z_]*(CMD|COMMAND|RUNNER)/);
  });

  it("REFUSES an untracked target — a file with no committed version is not a checkpoint", () => {
    const { dir } = newRepo("untracked");
    const loose = path.join(dir, "loose.txt");
    writeFileSync(loose, "alpha\n");
    const r = flow(dir, [loose, "--edit", needleFile("n2", "alpha"), needleFile("r2", "ALPHA")]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("untracked");
    expect(r.runner.calls).toHaveLength(0);
  });

  it("REFUSES a needle that matches zero times, and one that matches twice", () => {
    const { dir, target } = newRepo("cardinality", "alpha\nbeta\nalpha\n");
    const zero = flow(dir, [target, "--edit", needleFile("n3", "omega"), needleFile("r3", "X")]);
    expect(zero.status).toBe(1);
    expect(zero.out).toContain("does not appear");
    const twice = flow(dir, [target, "--edit", needleFile("n4", "alpha"), needleFile("r4", "X")]);
    expect(twice.status).toBe(1);
    expect(twice.out).toContain("more than once");
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\nalpha\n");
  });

  it("REFUSES when ZERO tests ran, rather than reporting a survivor", () => {
    const { dir, target } = newRepo("zerotests");
    const r = flow(dir, [target, "--edit", needleFile("n5", "beta"), needleFile("r5", "BETA")], green(0));
    expect(r.status).toBe(1);
    expect(r.out).toContain("ZERO tests");
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n"); // and restored
  });

  it("REFUSES a report with no FAILURE count — red/green must not fail open", () => {
    // Review's third HIGH: the verdict used to come only from the nested assertion shape, so a report
    // recording failures in aggregate read as SURVIVED — and under --keep that keeps a broken edit at
    // exit 0. The count is authoritative now, and its absence refuses.
    const { dir, target } = newRepo("noverdict");
    const r = flow(dir, [target, "--edit", needleFile("n6", "beta"), needleFile("r6", "BETA")], {
      numTotalTests: 3,
      testResults: [],
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("failure count");
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("reads RED from the aggregate count even when the assertion shape drifts", () => {
    const { dir, target } = newRepo("drift");
    const r = flow(dir, [target, "--edit", needleFile("n7", "beta"), needleFile("r7", "BETA")], {
      numTotalTests: 3,
      numFailedTests: 2,
      testResults: [{ somethingElse: [] }],
    });
    expect(r.out).toContain("REDDENED");
    expect(r.out).toContain("names unavailable");
    expect(r.status).toBe(0); // default --expect reddened
  });

  it("every refusal names itself, so a crashed tool is not mistaken for a refusal", () => {
    const { dir } = newRepo("usage");
    const r = cli(dir, ["nope.txt"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("mutate: REFUSING");
  });
});

describe("guard: the tests see the MUTANT, and the tree comes back", () => {
  it("runs the tests against the MUTATED bytes", () => {
    // Review's M1: nothing pinned this. A regression of the form "only write the file under --keep"
    // passed every other test in this file — and the tool's entire purpose is that the tests run
    // against the mutant.
    const { dir, target } = newRepo("observed");
    let seen = "";
    const r = flow(
      dir,
      [target, "--edit", needleFile("n8", "beta"), needleFile("r8", "BETA")],
      green(),
      () => { seen = readFileSync(target, "utf8"); }
    );
    expect(seen).toContain("BETA");
    expect(r.runner.calls).toHaveLength(1);
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n"); // restored afterwards
  });

  it("restores even when the run throws after the mutation is applied", () => {
    // Review demonstrated two live crash windows that left the mutation in the tree with a raw stack.
    const { dir, target } = newRepo("throws");
    const cap = capture();
    const boom = () => { throw new Error("runner exploded"); };
    expect(() =>
      runMutationFlow({ root: dir, argv: [target, "--edit", needleFile("n9", "beta"), needleFile("r9", "BETA")], testRunner: boom, io: cap.io, log: () => {} })
    ).toThrow(/exploded/);
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("restores when the test run DELETES the target", () => {
    const { dir, target } = newRepo("deleted");
    const r = flow(dir, [target, "--edit", needleFile("n10", "beta"), needleFile("r10", "BETA")], green(), () => {
      rmSync(target);
    });
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n");
    expect(r.out).toContain("TEST DIRTIED TARGET");
  });

  it("reports a target the TEST RUN dirtied — and only --keep refuses on it", () => {
    // Review's M2: this used to exit 1 unconditionally and blame a flag the operator never passed.
    const { dir, target } = newRepo("dirtied");
    const dirty = () => writeFileSync(target, "clobbered\n");
    const plain = flow(dir, [target, "--edit", needleFile("n11", "beta"), needleFile("r11", "BETA")], red(["x"]), dirty);
    expect(plain.out).toContain("TEST DIRTIED TARGET");
    expect(plain.status).toBe(0); // default --expect reddened was still met
    const kept = flow(dir, [target, "--edit", needleFile("n12", "beta"), needleFile("r12", "BETA"), "--keep"], green(), dirty);
    expect(kept.status).toBe(1); // --keep refuses mutation-plus-noise
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("reports OTHER tracked files the test run dirtied, matching on the path not a suffix", () => {
    // Review's L1: `endsWith` swallowed `sub/target.txt` while mutating `target.txt`.
    const { dir, target } = newRepo("otherdirt");
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "sub", "target.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "sub"], { cwd: dir });
    const r = flow(dir, [target, "--edit", needleFile("n13", "beta"), needleFile("r13", "BETA")], red(["x"]), () => {
      writeFileSync(path.join(dir, "sub", "target.txt"), "two\n");
    });
    expect(r.out).toContain("also dirtied");
    expect(r.out).toContain("sub/target.txt");
    execFileSync("git", ["checkout", "--", "."], { cwd: dir });
  });
});

describe("guard: the verdict, the expectation, and --keep", () => {
  it("exit tracks the EXPECTATION, not the verdict — so --keep cannot invert the polarity", () => {
    const { dir, target } = newRepo("expect");
    const n = needleFile("n14", "beta");
    const rep = needleFile("r14", "BETA");
    expect(flow(dir, [target, "--edit", n, rep], red(["red"])).status).toBe(0);
    expect(flow(dir, [target, "--edit", n, rep], green()).status).toBe(2);
    expect(flow(dir, [target, "--edit", n, rep, "--expect", "survived"], green()).status).toBe(0);
  });

  it("--keep leaves the edit applied when green, and REFUSES to keep a red one", () => {
    const { dir, target } = newRepo("keep");
    const n = needleFile("n15", "beta");
    const rep = needleFile("r15", "BETA");

    const redRun = flow(dir, [target, "--edit", n, rep, "--keep"], red(["red"]));
    expect(redRun.status).toBe(2);
    expect(redRun.out).toContain("NOT KEPT");
    expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\ngamma\n");

    const greenRun = flow(dir, [target, "--edit", n, rep, "--keep"], green());
    expect(greenRun.status).toBe(0);
    expect(readFileSync(target, "utf8")).toContain("BETA");
    expect(greenRun.out).toContain("kept (target only)");
    execFileSync("git", ["checkout", "--", "."], { cwd: dir });
  });

  it("--keep-even-if-red keeps it, but says so in capitals", () => {
    const { dir, target } = newRepo("keepred");
    const r = flow(dir, [target, "--edit", needleFile("n16", "beta"), needleFile("r16", "BETA"), "--keep-even-if-red"], red(["red"]));
    expect(readFileSync(target, "utf8")).toContain("BETA");
    expect(r.out).toContain("KEPT FAILING MUTATION");
    execFileSync("git", ["checkout", "--", "."], { cwd: dir });
  });

  it("verdictFrom fails closed on a missing count, and never treats absence as green", () => {
    expect(verdictFrom({ numTotalTests: 1 }).error).toContain("failure count");
    expect(verdictFrom({}).error).toContain("test count");
    expect(verdictFrom({ numTotalTests: 0, numFailedTests: 0 }).error).toContain("ZERO tests");
    expect(verdictFrom({ numTotalTests: 2, numFailedTests: 0 }).verdict).toBe("SURVIVED");
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
    const plan = planEdits("alpha beta", [
      { label: "#1", needleText: "alpha", replacementText: "beta" },
      { label: "#2", needleText: "beta", replacementText: "gamma" },
    ]);
    expect(plan.error).toContain("cascading");
  });

  it("matches a MID-LINE needle: exactly one trailing newline is stripped, nothing else", () => {
    // The acceptance criterion had no test (review's M4). An editor adds the newline the operator did
    // not type; anything beyond that must fail loudly rather than be normalised into matching.
    const n = needleFile("mid-needle", "b > at &&\n"); // as any editor would save it
    const r = needleFile("mid-repl", "b > at ||\n");
    expect(readNeedleFor(n)).toBe("b > at &&");
    const plan = planEdits("if (b > at && x) {", [
      { label: "#1", needleText: readNeedleFor(n), replacementText: readNeedleFor(r) },
    ]);
    expect(plan.mutated).toBe("if (b > at || x) {");
  });

  it("--keep defaults the expectation to survived, and --expect overrides it", () => {
    expect(parseArgs(["f", "--edit", "a", "b"]).opts.expect).toBe("reddened");
    expect(parseArgs(["f", "--edit", "a", "b", "--keep"]).opts.expect).toBe("survived");
    expect(parseArgs(["f", "--edit", "a", "b", "--keep", "--expect", "reddened"]).opts.expect).toBe("reddened");
  });
});

describe("guard: the skill names the flow, and the flow owns the guard", () => {
  const src = readFileSync(MUTATE, "utf8");

  it("delegates the checkpoint question rather than reimplementing it", () => {
    // Stated for what it is (review's L2): a best-effort scan. The BEHAVIOURAL proof that the call is
    // live is the dirty-tree refusal above; this only says there is no obvious second definition.
    expect(src).toContain("mutation-guard.mjs");
  });

  it("owns the reporter, so the test count cannot be scraped from human output", () => {
    expect(src).toContain("--reporter=json");
    expect(src).toContain("numTotalTests");
  });

  it("the skill names this command and no longer narrates the manual sequence", () => {
    const skill = readFileSync(path.join(ROOT, ".claude", "skills", "adversarial-build", "SKILL.md"), "utf8");
    expect(skill).toContain("scripts/mutate.mjs");
    expect(skill).not.toMatch(/revert, confirm the tree is clean/);
    expect(skill).not.toMatch(/Lost work during mutation testing \| process rule/);
  });
});
