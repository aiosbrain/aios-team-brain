import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteExactCommit } from "../scripts/staging-ops/git-promotion.mjs";

const made: string[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aios-promotion-"));
  made.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const racer = join(root, "racer");
  execFileSync("git", ["init", "--bare", "-q", remote], { env });
  execFileSync("git", ["clone", "-q", remote, work], { env });
  git(work, "config", "user.email", "release@example.test");
  git(work, "config", "user.name", "Release Test");
  git(work, "switch", "-c", "main");
  writeFileSync(join(work, "state"), "base");
  git(work, "add", "state");
  git(work, "commit", "-qm", "base");
  git(work, "push", "-qu", "origin", "main");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "switch", "-c", "staging");
  writeFileSync(join(work, "state"), "candidate");
  git(work, "commit", "-qam", "candidate");
  const candidate = git(work, "rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--branch", "main", remote, racer], { env });
  git(racer, "config", "user.email", "race@example.test");
  git(racer, "config", "user.name", "Race Test");
  return { remote, work, racer, base, candidate };
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("exact non-force promotion", () => {
  it("fast-forwards main to the exact peeled candidate", () => {
    const f = fixture();
    expect(promoteExactCommit({ cwd: f.work, remote: "origin", expectedMain: f.base, candidate: f.candidate })).toMatchObject({ status: "promoted", sha: f.candidate });
    expect(git(f.work, "ls-remote", f.remote, "refs/heads/main").split(/\s/)[0]).toBe(f.candidate);
  });

  it("refuses a non-descendant without force", () => {
    const f = fixture();
    expect(() => promoteExactCommit({ cwd: f.work, remote: "origin", expectedMain: f.candidate, candidate: f.base })).toThrow(/main changed|not a fast-forward/);
  });

  it("lets the remote reject a concurrent incompatible main advance", () => {
    const f = fixture();
    expect(() => promoteExactCommit({
      cwd: f.work,
      remote: "origin",
      expectedMain: f.base,
      candidate: f.candidate,
      beforePush: () => {
        writeFileSync(join(f.racer, "racer"), "advance");
        git(f.racer, "add", "racer");
        git(f.racer, "commit", "-qm", "concurrent main");
        git(f.racer, "push", "-q", "origin", "main");
      },
    })).toThrow(/non-fast-forward|failed to push|rejected/i);
    expect(git(f.work, "ls-remote", f.remote, "refs/heads/main").split(/\s/)[0]).not.toBe(f.candidate);
  });

  it("treats an already exact main as an audited no-op", () => {
    const f = fixture();
    git(f.work, "push", "-q", "origin", `${f.candidate}:refs/heads/main`);
    expect(promoteExactCommit({ cwd: f.work, remote: "origin", expectedMain: f.candidate, candidate: f.candidate })).toEqual({ status: "already-promoted", sha: f.candidate });
  });
});
