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
  // A commit that shares NO history with main — its own root. This is what makes the ancestry
  // refusal reachable: with `expectedMain` equal to the real remote main, the main-changed guard
  // passes and `merge-base --is-ancestor` is the only thing left to refuse.
  git(work, "switch", "--orphan", "unrelated");
  writeFileSync(join(work, "unrelated"), "divergent lineage");
  git(work, "add", "unrelated");
  git(work, "commit", "-qm", "unrelated root");
  const divergent = git(work, "rev-parse", "HEAD");
  git(work, "switch", "staging");
  execFileSync("git", ["clone", "-q", "--branch", "main", remote, racer], { env });
  git(racer, "config", "user.email", "race@example.test");
  git(racer, "config", "user.name", "Race Test");
  return { remote, work, racer, base, candidate, divergent };
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

  it("refuses a candidate on a divergent lineage, before pushing anything", () => {
    // THE LOCAL ANCESTRY GUARD, actually reached. The row this replaces passed `expectedMain` =
    // candidate while the remote main was still `base`, so it exited at the main-changed check and
    // never evaluated ancestry at all — its `/main changed|not a fast-forward/` alternation accepted
    // that earlier, unrelated refusal. Here the expectation MATCHES the remote, so `merge-base
    // --is-ancestor` is the only thing that can refuse, and the message is pinned exactly.
    const f = fixture();
    let beforePushCalls = 0;
    expect(() => promoteExactCommit({
      cwd: f.work,
      remote: "origin",
      expectedMain: f.base,
      candidate: f.divergent,
      beforePush: () => { beforePushCalls += 1; },
    })).toThrow(/^candidate is not a fast-forward of current main$/);
    // Refused BEFORE the push seam — an ancestry refusal that had already started pushing would be
    // a different (and much worse) behaviour wearing the same error message.
    expect(beforePushCalls, "the push path was entered despite the ancestry refusal").toBe(0);
    expect(git(f.work, "ls-remote", f.remote, "refs/heads/main").split(/\s/)[0]).toBe(f.base);
  });

  it("refuses a MOVED main as main-changed, distinctly from the ancestry refusal", () => {
    // The other half of the alternation the old row conflated. Both refusals are real and they send
    // an operator to different fixes, so each is pinned to its own message.
    const f = fixture();
    expect(() => promoteExactCommit({ cwd: f.work, remote: "origin", expectedMain: f.candidate, candidate: f.base }))
      .toThrow(/^main changed: expected /);
    expect(git(f.work, "ls-remote", f.remote, "refs/heads/main").split(/\s/)[0]).toBe(f.base);
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
