import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
    const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", tmp]);
    execFileSync("git", ["-C", tmp, "commit", "-q", "--allow-empty", "-m", "init"], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const out = execFileSync("node", [script, "--json"], { cwd: tmp, encoding: "utf8" });
    expect(JSON.parse(out).clean).toBe(true);
  });

  it("exits NON-ZERO when a tracked file is modified — the case that ate real work", () => {
    const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", tmp]);
    execFileSync("sh", ["-c", `echo one > ${tmp}/f.txt`]);
    execFileSync("git", ["-C", tmp, "add", "f.txt"]);
    execFileSync("git", ["-C", tmp, "commit", "-q", "-m", "add"], { env });
    execFileSync("sh", ["-c", `echo two > ${tmp}/f.txt`]); // the uncommitted edit a revert would eat

    let code = 0;
    try {
      execFileSync("node", [script], { cwd: tmp, encoding: "utf8", stdio: "pipe" });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    expect(code, "the guard must refuse to mutate a dirty tree").toBe(1);
  });

  it("exits 0 with only an untracked file present", () => {
    const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", tmp]);
    execFileSync("git", ["-C", tmp, "commit", "-q", "--allow-empty", "-m", "init"], { env });
    execFileSync("sh", ["-c", `echo new > ${tmp}/untracked.txt`]);
    const out = execFileSync("node", [script, "--json"], { cwd: tmp, encoding: "utf8" });
    expect(JSON.parse(out).clean).toBe(true);
  });
});

describe("guard: the skill actually requires the check", () => {
  it("names the script in the adversarial-build loop's mutation step", () => {
    // The field can ship computed-and-unread; so can a script nothing invokes. Pin the wiring.
    const skill = readFileSync(path.join(ROOT, ".claude", "skills", "adversarial-build", "SKILL.md"), "utf8");
    expect(skill).toContain("scripts/mutation-guard.mjs");
  });
});
