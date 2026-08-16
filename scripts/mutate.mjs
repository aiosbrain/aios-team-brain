#!/usr/bin/env node
/**
 * Run ONE mutation test as ONE command (MUTFLOW-1).
 *
 * WHY THIS EXISTS. MUTGUARD-1 shipped `scripts/mutation-guard.mjs` — a check that refuses to mutate a
 * tree with uncommitted tracked changes — and wired it into the adversarial-build skill. It did not
 * stop the failure. In the session after it shipped, the same operator lost work to
 * `git checkout -- <file>` three times and landed two commits whose messages outran their diffs (see
 * `docs/design/mutation-flow.md` §0 for the incident table and how much of it is checkable).
 *
 * The reason is that a mutation is NOT one command. It is edit → test → `git checkout` → hopefully
 * check, and the guard covers the first step IF you remember to call it. Every ad-hoc spelling — a
 * heredoc, a `sed -i`, an editor keystroke — skips it. The guard replaced a rule you have to remember
 * with a check that fails, and then left the rule standing around it. This is the whole sequence.
 *
 * WHAT IT DOES NOT CLAIM. It cannot stop anyone typing `git checkout`. It makes the safe path the
 * short path and prints a verdict the operator can paste instead of narrating from memory — the half
 * of the failure that no start-of-run guard can see.
 *
 * Usage:
 *   node scripts/mutate.mjs <target> --edit <needle-file> <replacement-file> [--edit …]
 *                           [--keep] [--keep-even-if-red] [--expect reddened|survived]
 *                           -- <vitest args…>
 *
 * Exit codes track the stated EXPECTATION, never the raw verdict (see `--expect` below):
 *   0  expectation met
 *   2  expectation missed
 *   1  usage or infrastructure — always with a message naming which, because node exits 1 on any
 *      uncaught crash and a crashed tool must not look like a refusal.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo this operates on. Overridable ONLY so the guard test can exercise the refusal paths
 * BEHAVIOURALLY in a scratch repository — review's first blocker was that asserting "the source
 * mentions the guard" passes with the call dead, so the test has to actually run the tool against a
 * dirty tree. The override moves WHICH repo is guarded; it cannot skip the guard.
 */
const ROOT = process.env.MUTATE_ROOT
  ? path.resolve(process.env.MUTATE_ROOT)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXIT_MET = 0;
const EXIT_MISSED = 2;
const EXIT_REFUSED = 1;

/** Every refusal prints WHY. `node` exits 1 on an uncaught throw too, so the message is the only thing
 *  that distinguishes "this tool refused" from "this tool crashed" (the sibling guard pins the same). */
function refuse(message) {
  console.error(`mutate: REFUSING — ${message}`);
  process.exit(EXIT_REFUSED);
}

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
  // `--keep` means "this mutation IS the change I want", and that expects the tests to STAY GREEN —
  // the proof the deleted thing was dead. Defaulting the expectation off the mode is what stops the
  // exit-code polarity inverting under it (review: `mutate --keep && git commit` would otherwise
  // commit a change whose tests fail, at exit 0).
  if (opts.expect === null) opts.expect = opts.keep ? "survived" : "reddened";
  return { opts };
}

/**
 * Locate every needle against the ORIGINAL bytes and apply the replacements as one simultaneous
 * transformation.
 *
 * "Each needle matches exactly once" is undefined across pairs — does pair B match before or after
 * pair A applied? — and either reading can silently mutate the wrong site while reporting a clean
 * verdict, which is a report that means nothing. So: all matches are resolved against the original,
 * spans may not overlap, no pair's needle may appear in another pair's replacement (that is the
 * cascade the simultaneous reading exists to forbid), and edits apply by descending offset.
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

/** A needle file written by any editor ends with a newline the operator did not type, so exactly one
 *  trailing newline is stripped. Everything else is byte-exact — a needle that fails to match must
 *  fail LOUDLY rather than be normalised into matching something else. */
const readNeedle = (p) => readFileSync(p, "utf8").replace(/\n$/, "");

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) refuse(`${parsed.error}\n\n  usage: node scripts/mutate.mjs <target> --edit <needle-file> <replacement-file> [--keep] -- <vitest args…>`);
  const { opts } = parsed;

  // 1 — the tree must be a committed checkpoint. Delegated to the guard rather than reimplemented, so
  // the two can never drift on what counts as one.
  const guardScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "mutation-guard.mjs");
  const guard = spawnSync(process.execPath, [guardScript], { cwd: ROOT, encoding: "utf8" });
  if (guard.status !== 0) {
    process.stderr.write(guard.stdout ?? "");
    process.stderr.write(guard.stderr ?? "");
    refuse("the tree is not a committed checkpoint (see mutation-guard above) — commit first");
  }

  // 2 — the TARGET must be tracked. Not because the restore needs git (step 5 restores from bytes we
  // already hold) but because a file with no committed version is not a checkpoint to return to.
  const target = path.resolve(ROOT, opts.target);
  if (!existsSync(target)) refuse(`target ${opts.target} does not exist`);
  try {
    git(["ls-files", "--error-unmatch", target], { stdio: "pipe" });
  } catch {
    refuse(`target ${opts.target} is untracked — there is no committed version to return to`);
  }

  // 3 — plan and apply, simultaneously, against the original bytes.
  const original = readFileSync(target, "utf8");
  const pairs = opts.edits.map((e, i) => {
    if (!existsSync(e.needle)) refuse(`--edit needle file ${e.needle} does not exist`);
    if (!existsSync(e.replacement)) refuse(`--edit replacement file ${e.replacement} does not exist`);
    return {
      label: `--edit #${i + 1}`,
      needleText: readNeedle(e.needle),
      replacementText: readNeedle(e.replacement),
    };
  });
  const plan = planEdits(original, pairs);
  if (plan.error) refuse(plan.error);
  if (plan.mutated === original) refuse("the mutation changes nothing — a no-op cannot be survived or caught");
  writeFileSync(target, plan.mutated);
  const mutatedBytes = plan.mutated;

  // 4 — run the tests, and OWN the reporter so "how many tests ran" is machine-readable. Scraping the
  // human reporter would break the day its format changes, and would break toward vacuity: a filter
  // matching nothing prints all-green, which reads as SURVIVED and means nothing.
  const reportDir = mkdtempSync(path.join(tmpdir(), "mutate-"));
  const reportPath = path.join(reportDir, "report.json");
  const conflicting = opts.vitestArgs.find((a) => a.startsWith("--reporter") || a.startsWith("--outputFile"));
  const restore = () => {
    writeFileSync(target, original);
    // Belt and braces: git is the recovery path when the in-memory copy is gone (an abnormal exit),
    // and the byte compare is what proves the restore actually happened.
    if (readFileSync(target, "utf8") !== original) {
      console.error("mutate: RESTORE FAILED — the target does not match its pre-mutation bytes");
      process.exit(EXIT_REFUSED);
    }
  };
  if (conflicting) {
    restore();
    refuse(`${conflicting} would clobber the machine-readable report this tool needs — remove it`);
  }
  // Restore on an abnormal exit rather than leaving the mutation applied and silent.
  const onSignal = () => {
    try { writeFileSync(target, original); } catch { /* fall through to the loud message */ }
    console.error("mutate: interrupted — target restored (verify with `git status --short`)");
    process.exit(EXIT_REFUSED);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // `MUTATE_TEST_CMD` exists for the guard test alone: a scratch repo has no vitest, and the criteria
  // that matter there (zero tests ran, restore, exit codes) are about how this tool READS a report,
  // not about vitest. It writes the same JSON shape.
  const run = process.env.MUTATE_TEST_CMD
    ? spawnSync("sh", ["-c", `${process.env.MUTATE_TEST_CMD} "${reportPath}"`], { cwd: ROOT, encoding: "utf8" })
    : spawnSync(
        "npx",
        ["vitest", "run", ...opts.vitestArgs, "--reporter=json", `--outputFile.json=${reportPath}`],
        { cwd: ROOT, encoding: "utf8" }
      );
  process.stdout.write(run.stdout ?? "");

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    restore();
    refuse("the test run produced no readable report — cannot tell how many tests ran, and 'cannot tell' must not read as 'some did'");
  }
  const total = Number(report.numTotalTests);
  if (!Number.isFinite(total)) {
    restore();
    refuse("the report has no test count — see above");
  }
  if (total === 0) {
    restore();
    refuse("ZERO tests ran — a filter that matches nothing reports all-green, which is not a survivor");
  }

  const failed = (report.testResults ?? [])
    .flatMap((f) => f.assertionResults ?? [])
    .filter((t) => t.status === "failed")
    .map((t) => t.fullName ?? t.title);
  const verdict = failed.length > 0 ? "REDDENED" : "SURVIVED";

  // 5 — did the TEST RUN dirty the target itself? Then a kept diff would be mutation-plus-noise, and a
  // default restore would silently discard those writes. Reported either way, refused under --keep.
  const afterTests = readFileSync(target, "utf8");
  const testDirtiedTarget = afterTests !== mutatedBytes;

  // 6 — restore unless the mutation IS the change, and say what the tree looks like afterwards.
  const keeping = opts.keep && !(verdict === "REDDENED" && !opts.keepEvenIfRed) && !testDirtiedTarget;
  if (!keeping) restore();

  console.log(`\nmutate: ${verdict}`);
  for (const name of failed) console.log(`  red: ${name}`);
  console.log(`  tests run: ${total}`);

  if (testDirtiedTarget) {
    console.error("mutate: TEST DIRTIED TARGET — the test run wrote to the file under mutation; restored, and --keep refused");
    process.exit(EXIT_REFUSED);
  }
  if (opts.keep && verdict === "REDDENED" && !opts.keepEvenIfRed) {
    console.error("mutate: NOT KEPT — the edit you asked to keep breaks tests. Re-run with --keep-even-if-red if that is intended.");
    process.exit(EXIT_MISSED);
  }
  if (keeping) {
    if (verdict === "REDDENED") console.error("mutate: *** KEPT FAILING MUTATION *** — the tree now holds a change whose tests fail");
    // Scoped to the target: an unscoped stat printed AFTER the tests would list whatever they dirtied,
    // and this stat is the artefact meant to replace writing a commit message from intent.
    console.log("\nkept (target only):");
    console.log(git(["diff", "--stat", "--", target]));
  }

  // Other tracked files the test run dirtied are REPORTED, never conflated with a failed restore — a
  // check that reddens on unrelated noise is one the operator learns to ignore.
  const otherDirt = git(["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.endsWith(path.relative(ROOT, target)));
  if (otherDirt.length > 0) {
    console.error("\nmutate: the test run also dirtied:");
    for (const line of otherDirt) console.error(`  ${line}`);
  }

  const met = verdict === (opts.expect === "reddened" ? "REDDENED" : "SURVIVED");
  console.log(`  expected: ${opts.expect} — ${met ? "met" : "MISSED"}`);
  process.exit(met ? EXIT_MET : EXIT_MISSED);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
