#!/usr/bin/env node
/**
 * Run ONE mutation test as ONE command (MUTFLOW-1).
 *
 * WHY THIS EXISTS. MUTGUARD-1 shipped `scripts/mutation-guard.mjs` — a check that refuses to mutate a
 * tree with uncommitted tracked changes — and wired it into the adversarial-build skill. It did not
 * stop the failure. In the session after it shipped, the same operator lost work to
 * `git checkout -- <file>` three times and landed two commits whose messages outran their diffs (see
 * `docs/design/mutation-flow.md` §0, which is explicit about how much of that is checkable).
 *
 * The reason is that a mutation is NOT one command. It is edit → test → `git checkout` → hopefully
 * check, and the guard covers the first step IF you remember to call it. Every ad-hoc spelling — a
 * heredoc, a `sed -i`, an editor keystroke — skips it. The guard replaced a rule you have to remember
 * with a check that fails, and then left the rule standing around it. This is the whole sequence.
 *
 * WHAT IT DOES NOT CLAIM. It cannot stop anyone typing `git checkout`. It makes the safe path the short
 * path and prints a verdict the operator pastes instead of narrating from memory — the half of the
 * failure no start-of-run guard can see.
 *
 * NO TEST-RUNNER OVERRIDE EXISTS IN THIS CLI, and that is a fix, not an omission. An earlier version
 * read the test command from an env var so the guard test could stub it; both code reviewers pointed
 * out that this ships a way to forge the verdict — mutate a real file, stub the report, and print a
 * block byte-identical to a real run, which the skill then tells you to paste into a PR. The runner is
 * now an argument to `runMutationFlow`, the CLI hard-wires the real one, and the tests inject a fake by
 * calling the function. A slice about closing a bypass must not ship one.
 *
 * Usage:
 *   node scripts/mutate.mjs <target> --edit <needle-file> <replacement-file> [--edit …]
 *                           [--keep] [--keep-even-if-red] [--expect reddened|survived]
 *                           -- <vitest args…>
 *
 * Exit codes track the stated EXPECTATION, never the raw verdict:
 *   0  expectation met
 *   2  expectation missed (including "you asked to keep an edit whose tests fail")
 *   1  usage or infrastructure — always with a message naming which, because node exits 1 on any
 *      uncaught crash and a crashed tool must not look like a refusal.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, "..");
export const EXIT_MET = 0;
export const EXIT_MISSED = 2;
export const EXIT_REFUSED = 1;

export function parseArgs(argv) {
  const dashdash = argv.indexOf("--");
  const head = dashdash === -1 ? argv : argv.slice(0, dashdash);
  const vitestArgs = dashdash === -1 ? [] : argv.slice(dashdash + 1);
  const opts = { target: null, edits: [], keep: false, keepEvenIfRed: false, expect: null, vitestArgs };
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--edit") {
      const needle = head[++i];
      const replacement = head[++i];
      if (!needle || !replacement) return { error: "--edit needs <needle-file> <replacement-file>" };
      opts.edits.push({ needle, replacement });
    } else if (a === "--keep") opts.keep = true;
    else if (a === "--keep-even-if-red") { opts.keep = true; opts.keepEvenIfRed = true; }
    else if (a === "--expect") {
      opts.expect = head[++i];
      if (opts.expect !== "reddened" && opts.expect !== "survived")
        return { error: "--expect takes reddened|survived" };
    } else if (a.startsWith("-")) return { error: `unknown flag ${a}` };
    else if (opts.target === null) opts.target = a;
    else return { error: `unexpected argument ${a}` };
  }
  if (!opts.target) return { error: "no target file" };
  if (opts.edits.length === 0) return { error: "no --edit pairs" };
  // `--keep` means "this mutation IS the change I want", which expects the tests to STAY GREEN — that
  // is the proof the deleted thing was dead. Defaulting the expectation off the mode is what stops the
  // exit polarity inverting under it: otherwise `mutate --keep && git commit` commits a change whose
  // tests fail, at exit 0 (review's blocker on draft 2).
  if (opts.expect === null) opts.expect = opts.keep ? "survived" : "reddened";
  return { opts };
}

/**
 * Locate every needle against the ORIGINAL bytes and apply the replacements as ONE simultaneous
 * transformation.
 *
 * "Each needle matches exactly once" is undefined across pairs — does pair B match before or after
 * pair A applied? — and either reading can silently mutate the wrong site while reporting a clean
 * verdict, which is a report that means nothing. So: all matches resolve against the original, spans
 * may not overlap, no pair's needle may appear in another pair's replacement (the cascade the
 * simultaneous reading forbids), and edits apply by descending offset.
 */
export function planEdits(original, pairs) {
  const spans = [];
  for (const { needleText, replacementText, label } of pairs) {
    if (needleText.length === 0) return { error: `${label}: needle is empty` };
    const first = original.indexOf(needleText);
    if (first === -1) return { error: `${label}: needle does not appear in the target` };
    if (original.indexOf(needleText, first + 1) !== -1)
      return { error: `${label}: needle appears more than once — which occurrence would be silent` };
    spans.push({ start: first, end: first + needleText.length, replacementText, label });
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end)
      return { error: `${sorted[i].label} overlaps ${sorted[i - 1].label} in the target` };
  }
  for (const a of pairs) {
    for (const b of pairs) {
      if (a === b) continue;
      if (b.replacementText.includes(a.needleText))
        return { error: `${b.label}'s replacement contains ${a.label}'s needle — cascading edits are not simultaneous` };
    }
  }
  let out = original;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + span.replacementText + out.slice(span.end);
  }
  return { mutated: out };
}

/**
 * The verdict, from the AGGREGATE count rather than the nested assertion shape.
 *
 * Both reviewers landed on this independently: deriving RED/GREEN only from
 * `testResults[].assertionResults[].status` fails OPEN when that shape drifts — a report with failures
 * recorded only in aggregate reads as SURVIVED, and under `--keep` that keeps a broken edit at exit 0.
 * `numFailedTests` is the aggregate vitest 4.1.9 publishes; if it is missing this refuses, because
 * "cannot tell" must never read as "nothing failed". Nested assertions are used for the NAMES only,
 * best-effort, since a name list that comes up empty costs nothing.
 */
export function verdictFrom(report) {
  const total = Number(report?.numTotalTests);
  if (!Number.isFinite(total)) return { error: "the report has no test count" };
  if (total === 0)
    return { error: "ZERO tests ran — a filter that matches nothing reports all-green, which is not a survivor" };
  const failedCount = Number(report?.numFailedTests);
  if (!Number.isFinite(failedCount))
    return { error: "the report has no failure count — cannot tell red from green, and that must not read as green" };
  const names = Array.isArray(report?.testResults)
    ? report.testResults
        .flatMap((f) => (Array.isArray(f?.assertionResults) ? f.assertionResults : []))
        .filter((t) => t?.status === "failed")
        .map((t) => t.fullName ?? t.title ?? "(unnamed)")
    : [];
  return { verdict: failedCount > 0 ? "REDDENED" : "SURVIVED", total, failedCount, names };
}

/** A needle file written by any editor ends with a newline the operator did not type, so exactly one
 *  trailing newline is stripped. Everything else is byte-exact — a needle that fails to match must fail
 *  LOUDLY rather than be normalised into matching something else. */
export const readNeedle = (p) => readFileSync(p, "utf8").replace(/\n$/, "");

/**
 * The whole sequence. `testRunner` is injected so the guard test can drive every branch without the
 * production CLI carrying an override that could forge a verdict — see the header.
 *
 * `io` is likewise injected so the tests can capture output instead of racing stdout.
 */
export function runMutationFlow({ root, argv, testRunner, io = console, log = appendRunLog }) {
  const out = (s) => io.log(s);
  const err = (s) => io.error(s);
  const refuse = (message) => {
    err(`mutate: REFUSING — ${message}`);
    return EXIT_REFUSED;
  };
  const git = (args, opts = {}) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", ...opts }).trim();

  const parsed = parseArgs(argv);
  if (parsed.error) return refuse(`${parsed.error}\n  usage: node scripts/mutate.mjs <target> --edit <needle> <replacement> [--keep] -- <vitest args…>`);
  const { opts } = parsed;

  // 1 — the tree must be a committed checkpoint. Delegated to the guard rather than reimplemented, so
  // the two can never drift on what counts as one.
  const guard = spawnSync(process.execPath, [path.join(HERE, "mutation-guard.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (guard.status !== 0) {
    err(guard.stdout ?? "");
    err(guard.stderr ?? "");
    return refuse("the tree is not a committed checkpoint (see mutation-guard above) — commit first");
  }

  // 2 — the TARGET must be tracked. Not because the restore needs git (step 5 restores from bytes we
  // already hold) but because a file with no committed version is not a checkpoint to return to.
  const target = path.resolve(root, opts.target);
  if (!existsSync(target)) return refuse(`target ${opts.target} does not exist`);
  try {
    git(["ls-files", "--error-unmatch", target], { stdio: "pipe" });
  } catch {
    return refuse(`target ${opts.target} is untracked — there is no committed version to return to`);
  }

  // 3 — plan (still no write, so every refusal above and below is before the file is touched).
  const original = readFileSync(target, "utf8");
  const pairs = [];
  for (const [i, e] of opts.edits.entries()) {
    if (!existsSync(e.needle)) return refuse(`--edit needle file ${e.needle} does not exist`);
    if (!existsSync(e.replacement)) return refuse(`--edit replacement file ${e.replacement} does not exist`);
    pairs.push({ label: `--edit #${i + 1}`, needleText: readNeedle(e.needle), replacementText: readNeedle(e.replacement) });
  }
  const plan = planEdits(original, pairs);
  if (plan.error) return refuse(plan.error);
  if (plan.mutated === original) return refuse("the mutation changes nothing — a no-op cannot be survived or caught");
  const conflicting = opts.vitestArgs.find((a) => a.startsWith("--reporter") || a.startsWith("--outputFile"));
  if (conflicting) return refuse(`${conflicting} would clobber the machine-readable report this tool needs — remove it`);

  // Everything that can throw BEFORE the write happens before it (review: `mkdtempSync` used to run
  // after, so an unusable TMPDIR left the mutation applied with a raw stack trace).
  const reportPath = path.join(mkdtempSync(path.join(tmpdir(), "mutate-")), "report.json");
  let applied = false;
  let keeping = false;
  const restore = () => {
    writeFileSync(target, original);
    if (readFileSync(target, "utf8") !== original) {
      err("mutate: *** MUTATION STILL APPLIED *** — the restore did not take; `git checkout -- <file>` is your recovery");
      return false;
    }
    return true;
  };
  const onSignal = (sig) => {
    if (applied && !restore()) process.exit(EXIT_REFUSED);
    err(`mutate: interrupted (${sig}) — target ${applied ? "restored" : "untouched"}`);
    process.exit(EXIT_REFUSED);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => onSignal(sig));

  // 4 — mutate, run, and restore under `finally`, so ANY throw from here down still restores. Review
  // demonstrated two live crash windows that left the mutation in the tree with a raw stack.
  try {
    writeFileSync(target, plan.mutated);
    applied = true;
    const run = testRunner({ root, vitestArgs: opts.vitestArgs, reportPath });
    if (run?.stdout) out(run.stdout);

    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      return refuse("the test run produced no readable report — cannot tell how many tests ran, and 'cannot tell' must not read as 'some did'");
    }
    const v = verdictFrom(report);
    if (v.error) return refuse(v.error);

    // Did the TEST RUN write to the file under mutation? Then a kept diff would be mutation-plus-noise.
    // Reported either way; only `--keep` refuses on it (review: this used to refuse unconditionally and
    // blamed a flag the operator never passed).
    let testDirtiedTarget = false;
    try {
      testDirtiedTarget = readFileSync(target, "utf8") !== plan.mutated;
    } catch {
      testDirtiedTarget = true; // the test deleted it; `finally` restores from the bytes we hold
    }

    const keepRefusedForRed = opts.keep && v.verdict === "REDDENED" && !opts.keepEvenIfRed;
    keeping = opts.keep && !keepRefusedForRed && !testDirtiedTarget;

    out(`\nmutate: ${v.verdict}`);
    for (const name of v.names) out(`  red: ${name}`);
    out(`  tests run: ${v.total}${v.names.length === 0 && v.failedCount > 0 ? ` (${v.failedCount} failed, names unavailable)` : ""}`);

    if (testDirtiedTarget) {
      err(`mutate: TEST DIRTIED TARGET — the test run wrote to the file under mutation${opts.keep ? "; --keep refused, restored" : "; restored"}`);
      if (opts.keep) return EXIT_REFUSED;
    }
    if (keepRefusedForRed) {
      err("mutate: NOT KEPT — the edit you asked to keep breaks tests. Re-run with --keep-even-if-red if that is intended.");
      return EXIT_MISSED;
    }
    if (keeping && v.verdict === "REDDENED")
      err("mutate: *** KEPT FAILING MUTATION *** — the tree now holds a change whose tests fail");
    if (keeping) {
      // Scoped to the target: an unscoped stat printed AFTER the tests would list whatever they
      // dirtied, and this stat is the artefact meant to replace writing a message from intent.
      out("\nkept (target only):");
      out(git(["diff", "--stat", "--", target]));
    }

    // Other tracked files the test run dirtied are REPORTED, never conflated with a failed restore — a
    // check that reddens on unrelated noise is one the operator learns to ignore. Compared on the
    // parsed path, not a line suffix: `endsWith` swallowed `sub/target.txt` while mutating `target.txt`.
    const rel = path.relative(root, target);
    const otherDirt = git(["status", "--porcelain", "--untracked-files=no"])
      .split("\n")
      .filter(Boolean)
      .filter((line) => line.slice(3).split(" -> ").pop() !== rel);
    if (otherDirt.length > 0) {
      err("\nmutate: the test run also dirtied:");
      for (const line of otherDirt) err(`  ${line}`);
    }

    const met = v.verdict === (opts.expect === "reddened" ? "REDDENED" : "SURVIVED");
    out(`  expected: ${opts.expect} — ${met ? "met" : "MISSED"}`);
    log(root, { target: rel, verdict: v.verdict, expect: opts.expect, met, keep: keeping, total: v.total });
    return met ? EXIT_MET : EXIT_MISSED;
  } finally {
    if (applied && !keeping && !restore()) return EXIT_REFUSED;
  }
}

/**
 * One line per run, to a git-ignored log.
 *
 * It exists because of a question the incidents could not answer: was the guard SKIPPED, or did it run
 * and fail? Nothing recorded an invocation, so the post-mortem could only infer. This makes the next
 * one answerable. Best-effort — a log that cannot be written must never fail a mutation run.
 */
export function appendRunLog(root, entry) {
  try {
    appendFileSync(
      path.join(root, ".mutate-runs.log"),
      `${new Date().toISOString()} ${JSON.stringify(entry)}\n`
    );
  } catch {
    /* the log is evidence, not a gate */
  }
}

/** The real runner. The CLI is hard-wired to it; there is no override (see the header). */
function vitestRunner({ root, vitestArgs, reportPath }) {
  return spawnSync(
    "npx",
    ["vitest", "run", ...vitestArgs, "--reporter=json", `--outputFile.json=${reportPath}`],
    { cwd: root, encoding: "utf8" }
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // `MUTATE_ROOT` moves WHICH repo is guarded — never whether it is. Both reviewers checked it for a
  // bypass and cleared it: the guard, `ls-files` and the target all resolve under the same root, so a
  // target outside it is refused as untracked.
  const root = process.env.MUTATE_ROOT ? path.resolve(process.env.MUTATE_ROOT) : DEFAULT_ROOT;
  process.exit(runMutationFlow({ root, argv: process.argv.slice(2), testRunner: vitestRunner }));
}
