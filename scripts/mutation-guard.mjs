#!/usr/bin/env node
/**
 * Refuse to start mutation testing on a tree with uncommitted work (MUTGUARD-1).
 *
 * WHY THIS EXISTS, and why prose was not enough. Mutations are applied in place and reverted with
 * `git checkout <file>`, and that revert silently destroys work — because the revert is the thing you
 * expect to succeed.
 *
 * PRECISELY WHAT IT DESTROYS, verified against real git rather than asserted (an earlier version of
 * this comment, the skill, and three test names all overstated it, and BOTH reviewers caught it):
 * two-argument `git checkout -- <path>` restores the worktree from the INDEX, not from HEAD. So an
 * UNSTAGED edit (` M`) is lost, a STAGED one (`M `) SURVIVES, and `MM` loses only the unstaged layer.
 *
 * The guard blocks on staged changes anyway, and the reason is the policy rather than the blast
 * radius: the loop's contract is that a mutation run measures a COMMITTED CHECKPOINT you can return
 * to. A staged-but-uncommitted tree is not one — and an operator who reaches for
 * `git checkout HEAD -- <file>` or `git restore -s HEAD` does lose it. Stating that honestly matters
 * more than the stricter-sounding claim, because a guard justified by something false is one argument
 * away from being switched off. The adversarial-build skill has said "commit BEFORE mutation-testing" since it
 * was written, and on 2026-08-14/15 the same operator lost work to it three times in one session:
 * an extracted function and its tests were wiped mid-fold, and a commit landed whose tests called a
 * function that no longer existed. A repair script then no-opped against the reverted text and
 * printed success, so the loss surfaced only on re-reading the file.
 *
 * That is a rule you have to remember, which this repo's own §2 says to replace with a check that
 * fails. This is the check.
 *
 * ONLY TRACKED MODIFICATIONS BLOCK, and the precision is deliberate. `git checkout <pathspec>` cannot
 * destroy an untracked file — the pathspec does not match it, and the command errors instead. So an
 * untracked new file is not at risk, and blocking on it would make the guard fire on the extremely
 * normal state of "I just wrote a new test file". A guard that over-blocks gets bypassed, and a
 * bypassed guard is not a guard.
 *
 * Usage:
 *   node scripts/mutation-guard.mjs            # exits 1 if tracked files are modified
 *   node scripts/mutation-guard.mjs --json     # machine-readable, for a wrapper
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Tracked paths with uncommitted changes — staged or unstaged.
 *
 * Pure over its input so the classification is testable without a scratch repo: `git status
 * --porcelain` emits two status columns then the path. `??` is untracked (safe, ignored) and `!!` is
 * ignored-by-gitignore (safe). Everything else — ` M`, `M `, `MM`, ` D`, `A `, `R `… — is a tracked
 * path whose working-tree or index state differs from HEAD, which is exactly what a revert eats.
 */
export function trackedChanges(porcelain) {
  return porcelain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const status = line.slice(0, 2);
      return status !== "??" && status !== "!!";
    })
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

function main() {
  const json = process.argv.includes("--json");
  let porcelain = "";
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  } catch {
    // The catch used to swallow EVERY failure and exit 0. Review was right that this is the wrong
    // default inside a real repo: a corrupt index or broken worktree metadata would let the mutation
    // loop proceed on a tree it could not prove was recoverable — a guard failing open in exactly the
    // situation it exists for.
    //
    // So the two cases are separated. NOT A REPO ⇒ fail OPEN: the hazard is git-specific and cannot
    // occur, and blocking would stop mutation testing on an environment problem. REPO PRESENT but
    // status unreadable ⇒ fail CLOSED: we cannot see what is at risk, and "cannot tell" must not read
    // as "safe" — the standing rule in this codebase.
    let insideRepo = false;
    try {
      insideRepo =
        execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ===
        "true";
    } catch {
      insideRepo = false;
    }
    if (insideRepo) {
      if (json) process.stdout.write(JSON.stringify({ clean: false, unreadable: true, dirty: [] }, null, 2) + "\n");
      process.stderr.write(
        "\nmutation-guard: REFUSING to mutate — inside a git worktree but `git status` failed, so the\n" +
          "tree cannot be verified recoverable. Fix the repo state (a stale index.lock, a corrupt index)\n" +
          "and re-run.\n\n"
      );
      process.exit(1);
    }
    // `--json` must ALWAYS emit JSON — it is the machine-readable contract, and a caller parsing it
    // gets "Unexpected end of JSON input" otherwise. Found by the test written for the branch above.
    if (json) process.stdout.write(JSON.stringify({ clean: true, noRepo: true, dirty: [] }, null, 2) + "\n");
    process.stderr.write("mutation-guard: not a git repository — nothing a revert could destroy, skipping\n");
    process.exit(0);
  }

  const dirty = trackedChanges(porcelain);
  if (json) {
    process.stdout.write(JSON.stringify({ clean: dirty.length === 0, dirty }, null, 2) + "\n");
  }

  if (dirty.length === 0) {
    if (!json) process.stdout.write("mutation-guard: tree is clean — safe to mutate\n");
    process.exit(0);
  }

  if (!json) {
    process.stderr.write(
      "\nmutation-guard: REFUSING to mutate — these tracked files have uncommitted changes:\n\n" +
        dirty.map((d) => `  ${d.status}  ${d.path}`).join("\n") +
        "\n\nMutation testing must run against a COMMITTED CHECKPOINT you can get back. Commit these first.\n\n" +
        "What the revert actually eats: `git checkout -- <file>` restores from the INDEX, so an\n" +
        "UNSTAGED edit is destroyed silently by the command you expect to succeed (this has cost real\n" +
        "work three times). A STAGED edit survives that particular command — but it is still not a\n" +
        "checkpoint, and `git checkout HEAD -- <file>` does take it.\n\n" +
        "Untracked files are not listed and do not block — a revert cannot reach them.\n\n"
    );
  }
  process.exit(1);
}

// Only run when invoked directly, so the pure helper above can be imported by its test.
//
// `pathToFileURL`, NOT a `file://` template. `import.meta.url` percent-encodes (a space becomes
// `%20`) while `process.argv[1]` is raw, so from a directory whose path needs encoding the comparison
// failed and the script exited 0 WITH NO OUTPUT — the guard the skill had just told you to trust,
// silently doing nothing. That is the exact failure class this ticket exists to kill, and the same
// shape as the repair script that printed success over reverted text. Found by review, reproduced
// live from `/tmp/mut guard .../`.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
} else if (process.argv[1] !== undefined && /mutation-guard\.mjs$/.test(process.argv[1])) {
  // Belt and braces: if this file was clearly the entry point but the URL comparison still disagreed,
  // say so loudly rather than exiting silently. A guard that declines to run must never do it quietly.
  process.stderr.write("mutation-guard: could not confirm direct invocation — refusing to stay silent\n");
  main();
}
