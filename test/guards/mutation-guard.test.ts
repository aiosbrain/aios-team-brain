import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trackedChanges } from "../../scripts/mutation-guard.mjs";

/**
 * MUTGUARD-1 — the check that stops mutation testing eating uncommitted work.
 *
 * The hazard is specific: mutations are reverted with `git checkout <file>`, which restores from the
 * index/HEAD, so an uncommitted edit to a TRACKED file is destroyed by the revert. It happened three
 * times in one session, once landing a commit whose tests called a function the revert had deleted.
 *
 * The classification is the whole guard, so it is tested directly rather than through a scratch repo:
 * block on tracked changes, and — just as important — do NOT block on untracked files, because a
 * revert cannot reach those and a guard that fires on "I just wrote a new test file" gets bypassed.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A throwaway repo, isolated from the developer's global git config.
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` because a global `commit.gpgsign = true` (or any broken global
 * config) would otherwise break every scratch commit here and redden the guard's own tests on a
 * machine that has nothing wrong with it — review flagged it. Registered for cleanup so runs do not
 * litter the temp dir, which they previously did.
 */
const scratch: string[] = [];
function scratchRepo(prefix = "mutguard"): string {
  const dir = execFileSync("mktemp", ["-d", `${tmpdir()}/${prefix}-XXXXXX`], { encoding: "utf8" }).trim();
  scratch.push(dir);
  execFileSync("git", ["init", "-q", dir], { env: gitEnv() });
  return dir;
}
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("trackedChanges — what a `git checkout` revert can actually destroy", () => {
  it("blocks on modified tracked files, staged or unstaged", () => {
    const porcelain = [" M lib/query/llm-health.ts", "M  lib/ingest/pipeline-health.ts", "MM docs/ARCHITECTURE.md"].join("\n");
    expect(trackedChanges(porcelain).map((d) => d.path)).toEqual([
      "lib/query/llm-health.ts",
      "lib/ingest/pipeline-health.ts",
      "docs/ARCHITECTURE.md",
    ]);
  });

  it("does NOT block on untracked files — a revert cannot reach them", () => {
    // THE PRECISION THAT KEEPS IT USABLE. Writing a new test file is the normal state mid-slice; a
    // guard that fires on it gets worked around, and a worked-around guard is not a guard.
    expect(trackedChanges("?? test/some-new.test.ts\n?? scripts/probe.mjs")).toEqual([]);
  });

  it("does NOT block on gitignored files", () => {
    expect(trackedChanges("!! node_modules/x")).toEqual([]);
  });

  it("blocks on deletions and renames — those are tracked changes too", () => {
    const porcelain = [" D lib/gone.ts", "R  old.ts -> new.ts", "A  lib/added.ts"].join("\n");
    expect(trackedChanges(porcelain).map((d) => d.status)).toEqual([" D", "R ", "A "]);
  });

  it("is clean on an empty status, and tolerates trailing newlines", () => {
    expect(trackedChanges("")).toEqual([]);
    expect(trackedChanges("\n\n")).toEqual([]);
  });

  it("mixes correctly — one tracked change among untracked files still blocks", () => {
    const porcelain = ["?? test/new.test.ts", " M lib/real.ts", "?? scripts/probe.mjs"].join("\n");
    expect(trackedChanges(porcelain).map((d) => d.path)).toEqual(["lib/real.ts"]);
  });
});

describe("the script's exit codes — what the loop actually keys on", () => {
  const script = path.join(ROOT, "scripts", "mutation-guard.mjs");

  it("exits 0 and reports clean when the tree has no tracked changes", () => {
    // Run against a throwaway clean repo so the result does not depend on this worktree's state.
    const tmp = scratchRepo();
    execFileSync("git", ["-C", tmp, "commit", "-q", "--allow-empty", "-m", "init"], { env: gitEnv() });
    const out = execFileSync("node", [script, "--json"], { cwd: tmp, encoding: "utf8", env: gitEnv() });
    expect(JSON.parse(out).clean).toBe(true);
  });

  it("exits NON-ZERO when a tracked file is modified — the case that ate real work", () => {
    const tmp = scratchRepo();
    execFileSync("sh", ["-c", `echo one > "${tmp}/f.txt"`]);
    execFileSync("git", ["-C", tmp, "add", "f.txt"], { env: gitEnv() });
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "add"], { env: gitEnv() });
    execFileSync("sh", ["-c", `echo two > "${tmp}/f.txt"`]); // the UNSTAGED edit a revert would eat

    let code = 0;
    let stderr = "";
    try {
      execFileSync("node", [script], { cwd: tmp, encoding: "utf8", stdio: "pipe", env: gitEnv() });
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      code = e.status ?? -1;
      stderr = e.stderr ?? "";
    }
    expect(code, "the guard must refuse to mutate a dirty tree").toBe(1);
    // Exit 1 alone is not proof: node exits 1 on ANY uncaught crash, so a crash inside the refusal
    // path would keep this green for the wrong reason. Review's point; pin the message.
    expect(stderr, "exit 1 must come from the refusal, not from a crash").toContain("REFUSING");
  });

  it("refuses from a directory whose path needs URL-encoding — the silent no-op", () => {
    // `import.meta.url` percent-encodes a space while `argv[1]` does not, so the direct-invocation
    // check compared unequal and the script exited 0 WITH NO OUTPUT: the guard silently doing nothing,
    // which is the failure class this whole ticket exists to kill. Reproduced by review.
    const tmp = scratchRepo("mut guard");
    execFileSync("sh", ["-c", `cp "${script}" "${tmp}/mg.mjs"`]);
    execFileSync("sh", ["-c", `echo one > "${tmp}/f.txt"`]);
    execFileSync("git", ["-C", tmp, "add", "f.txt"], { env: gitEnv() });
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "add"], { env: gitEnv() });
    execFileSync("sh", ["-c", `echo two > "${tmp}/f.txt"`]);

    let code = 0;
    let stderr = "";
    try {
      execFileSync("node", ["./mg.mjs"], { cwd: tmp, encoding: "utf8", stdio: "pipe", env: gitEnv() });
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      code = e.status ?? -1;
      stderr = e.stderr ?? "";
    }
    expect(code, "a space in the path must not silently disable the guard").toBe(1);
    expect(stderr).toContain("REFUSING");
  });

  it("fails CLOSED when git status fails INSIDE a worktree — cannot tell is not safe", () => {
    // Codex's finding: the catch swallowed every git failure and exited 0, so a corrupt index let the
    // mutation loop proceed on a tree it could not prove recoverable — failing open in exactly the
    // situation the guard exists for. A truncated `.git/index` reproduces it: `git status` dies with
    // "index file smaller than expected" while `rev-parse --is-inside-work-tree` still answers `true`,
    // which is precisely the pair the fix keys on.
    //
    // This mutation SURVIVED the first fold — the fix shipped untested — which is the third time in
    // this session that a reviewer's finding was folded without pinning it.
    const tmp = scratchRepo();
    execFileSync("git", ["-C", tmp, "commit", "-q", "--allow-empty", "-m", "init"], { env: gitEnv() });
    execFileSync("sh", ["-c", `echo garbage-not-an-index > "${tmp}/.git/index"`]);

    let code = 0;
    let stderr = "";
    try {
      execFileSync("node", [script], { cwd: tmp, encoding: "utf8", stdio: "pipe", env: gitEnv() });
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      code = e.status ?? -1;
      stderr = e.stderr ?? "";
    }
    expect(code, "an unreadable repo must block, not wave the loop through").toBe(1);
    expect(stderr).toContain("REFUSING");
  });

  it("fails OPEN when there is no repo at all — the hazard cannot exist without git", () => {
    // The other half, and the reason the two cases are separated: blocking here would stop mutation
    // testing on an environment problem, and `git checkout` cannot destroy anything where there is no
    // git. Over-blocking is how a guard gets bypassed.
    const tmp = execFileSync("mktemp", ["-d", `${tmpdir()}/mutguard-norepo-XXXXXX`], { encoding: "utf8" }).trim();
    scratch.push(tmp);
    const out = execFileSync("node", [script, "--json"], { cwd: tmp, encoding: "utf8", env: gitEnv() });
    expect(JSON.parse(out).clean).toBe(true);
  });

  it("exits 0 with only an untracked file present", () => {
    const tmp = scratchRepo();
    execFileSync("git", ["-C", tmp, "commit", "-q", "--allow-empty", "-m", "init"], { env: gitEnv() });
    execFileSync("sh", ["-c", `echo new > "${tmp}/untracked.txt"`]);
    const out = execFileSync("node", [script, "--json"], { cwd: tmp, encoding: "utf8", env: gitEnv() });
    expect(JSON.parse(out).clean).toBe(true);
  });
});

describe("guard: the skill actually requires the check", () => {
  it("requires the FLOW that calls this check, not this check as a step to remember", () => {
    // MIGRATED BY MUTFLOW-1, deliberately and in the same change that broke it. This used to pin the
    // literal line "PROVE it — `node scripts/mutation-guard.mjs`" in the skill. That line is gone,
    // because requiring a check the operator has to remember to call is exactly what failed: the same
    // operator lost work three times in the session after this guard shipped. The skill now names ONE
    // command that runs the whole mutation sequence, and that command calls this script.
    //
    // So the wiring is pinned one level out — the skill must require `scripts/mutate.mjs`, and
    // `scripts/mutate.mjs` must invoke this guard. `test/guards/mutation-flow.test.ts` proves the
    // second link BEHAVIOURALLY (it runs the flow against a dirty scratch repo and asserts refusal),
    // which is stronger than what this file could assert about a prose step.
    const skill = readFileSync(path.join(ROOT, ".claude", "skills", "adversarial-build", "SKILL.md"), "utf8");
    expect(skill).toMatch(/Mutation-test with ONE command — `node scripts\/mutate\.mjs`/);
    const flow = readFileSync(path.join(ROOT, "scripts", "mutate.mjs"), "utf8");
    expect(flow).toContain("mutation-guard.mjs");
  });
});
