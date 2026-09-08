import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The reaper diagnostic (`scripts/staging-ops-reaper-check.sh`) is a COMMAND an engineer runs by
 * hand when the ops image, its base or the scheduled launch prefix changes — it builds an image and
 * takes minutes, so nothing in CI executes it. That is exactly why its defects are invisible until
 * the moment someone needs it, and all three pinned below were found that way rather than by a
 * failing run:
 *
 *   1. `mapfile` is a bash 4 builtin and macOS ships bash 3.2.57 (measured), so on a supported host
 *      the script died before it built anything — a diagnostic that cannot run diagnoses nothing.
 *   2. The lane outputs were fixed paths at the repository root and the happy path removed them with
 *      `rm -f …/.reaper-check-*.json`, so two concurrent invocations overwrote each other's evidence
 *      and the first to finish deleted the second's.
 *   3. The prefix parser ran under `mapfile -t … < <(node …)`, which discards the producer's exit
 *      status: a schedules.json whose services disagreed on the launch prefix reported the generic
 *      arity message instead of the parser's own named reason.
 *
 * These are file-shape assertions, which is the only tier available for a command CI must not run.
 */
describe("the ops reaper diagnostic can actually run, concurrently, and reports its parser's failures", () => {
  const script = readFileSync("scripts/staging-ops-reaper-check.sh", "utf8");
  // Comments discuss the removed constructs by name, so the checks below read the statements only.
  const statements = script.replace(/^\s*#.*$/gm, "");

  it("uses no bash-4 builtin, because the documented host bash is 3.2", () => {
    for (const builtin of ["mapfile", "readarray", "declare -A", "typeset -A"]) {
      expect(statements, `${builtin} is bash 4+; this script must run on macOS system bash`).not.toContain(builtin);
    }
    // …and the portable replacement is present, so this is not satisfied by deleting the read.
    expect(statements, "the launch prefix must still be READ from the deployed configuration")
      .toMatch(/while IFS= read -r \w+; do/);
  });

  it("consumes the prefix parser's exit status instead of only its output", () => {
    // A command substitution inside the condition: the reader sees the status. A process
    // substitution feeding a reader is the shape that swallowed it.
    expect(statements).toContain('if ! prefix_lines="$(node -e');
    expect(statements, "a process substitution hides the parser's exit status from the reader")
      .not.toMatch(/<\s*<\(\s*node/);
    // The arity check stays as the SECOND condition — a parser that exits 0 with the wrong shape is
    // a different failure from a parser that exits non-zero, and both must be named.
    expect(statements).toContain('[[ "${#override_prefix[@]}" -eq 4 ]]');
  });

  it("writes every lane's evidence into one per-run directory and removes nothing by wildcard", () => {
    expect(statements).toContain('run_id="$(date -u +%Y%m%dT%H%M%SZ)-${USER:-runner}-$$"');
    expect(statements).toContain('output_dir="$repo_root/.staging-ops-reaper-checks/$run_id"');
    expect(statements, "the fixed repo-root lane paths are what two concurrent runs collided on")
      .not.toContain("/.reaper-check-");
    expect(statements, "no lane evidence may live at a path that is not per-run")
      .not.toMatch(/\$repo_root"?\/[^\s"]*\.json/);
    expect(statements, "a wildcard removal deletes another invocation's evidence, not just this one's")
      .not.toMatch(/\brm\s+-f\s+[^\n]*\*/);
    // Each lane's write, its echo and its assertion must all name the same per-run file.
    const laneFiles = [...statements.matchAll(/"\$output_dir\/(?:\$\{lane\}|control)\.json"/g)];
    expect(laneFiles.length, "a lane output path escaped the per-run directory").toBeGreaterThanOrEqual(4);
  });

  it("keeps the retained evidence directory out of git", () => {
    // The outputs are deliberately NOT deleted on success, so an absent ignore rule turns every run
    // into untracked files in `git status` — and one of them into an accidental commit.
    const ignored = readFileSync(".gitignore", "utf8").split("\n").map((line) => line.trim());
    expect(ignored).toContain(".staging-ops-reaper-checks/");
  });
});
