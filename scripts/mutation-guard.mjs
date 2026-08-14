#!/usr/bin/env node
/**
 * Refuse to start mutation testing on a tree with uncommitted work (MUTGUARD-1).
 *
 * WHY THIS EXISTS, and why prose was not enough. Mutations are applied in place and reverted with
 * `git checkout <file>`, which restores that file from the index/HEAD. Any uncommitted edit to a
 * TRACKED file is therefore destroyed by the revert — silently, because the revert is the thing you
 * expect to succeed. The adversarial-build skill has said "commit BEFORE mutation-testing" since it
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
    // Not a git repo, or git is unavailable. FAIL OPEN with a warning rather than blocking the loop
    // on an environment problem: the cost of a false block here is that mutation testing cannot run
    // at all, and the thing being protected is a git-specific hazard that cannot occur without git.
    process.stderr.write("mutation-guard: could not read git status — skipping the check\n");
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
        "\n\nMutations are reverted with `git checkout <file>`, which restores from the index/HEAD, so\n" +
        "every change listed above would be DESTROYED — silently, by the revert you expect to succeed.\n" +
        "This has cost real work three times.\n\n" +
        "Commit them first (that is the point: a mutation run should measure a tree you can get back).\n" +
        "Untracked files are not listed and do not block — a revert cannot reach them.\n\n"
    );
  }
  process.exit(1);
}

// Only run when invoked directly, so the pure helper above can be imported by its test.
if (import.meta.url === `file://${process.argv[1]}`) main();
