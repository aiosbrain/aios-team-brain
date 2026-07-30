import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * BUILD-FAILING GUARD: the tracked .githooks chain actually enforces what it claims.
 *
 * This repo sets `core.hooksPath=.githooks`, which makes git IGNORE `.git/hooks/` — the
 * directory where the machine-local NDA leak-gate shims are installed. The failure this
 * guard traces to (guard rollout fallout from AIO-578 / split program AIO-594): an
 * untracked pre-commit guard resolved its chain with `git rev-parse --git-path
 * hooks/pre-commit.chained`, which honors core.hooksPath and pointed at a nonexistent
 * `.githooks/pre-commit.chained` — so the NDA gate silently never ran on any commit, in
 * any worktree, on an NDA-gated repo.
 *
 * The tracked hooks now (a) block authored commits in the PRIMARY checkout, (b) no-op in
 * linked worktrees, and (c) chain the machine-local hook from the git COMMON dir — in
 * worktrees AND under the AIOS_ALLOW_PRIMARY_COMMIT override. These tests prove each
 * behavior against a disposable fixture repo using the real tracked hook files.
 *
 * The synthetic leak term below is OBVIOUSLY fake — never put a real confidential term
 * in a test.
 */

const REPO_ROOT = process.cwd();
const FAKE_TERM = "TOTALLY-FAKE-NDA-CLIENT-ZZ9";

/**
 * Env for fixture git calls: identity set, hook overrides stripped, and config
 * fully hermetic — a machine-global core.hooksPath / init.templateDir /
 * commit.gpgsign would otherwise change fixture behavior and red these tests
 * spuriously.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.GIT_INDEX_FILE;
delete GIT_ENV.AIOS_ALLOW_PRIMARY_COMMIT;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = GIT_ENV): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 20_000 });
}

/** Run git expecting failure; returns combined stdout+stderr of the failure. */
function gitFails(cwd: string, args: string[], env: NodeJS.ProcessEnv = GIT_ENV): string {
  try {
    execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 20_000, stdio: "pipe" });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}`;
  }
  throw new Error(`expected git ${args.join(" ")} to fail, but it succeeded`);
}

let root: string; // mkdtemp container
let primary: string; // fixture primary checkout
let sentinel: string; // file the fake machine-local hooks touch to prove they ran
let wtCounter = 0;

/** Fake machine-local NDA hook: record it ran; block if the staged/tree content leaks the fake term. */
function installLocalHook(name: "pre-commit" | "pre-push", scan: "staged" | "tree"): void {
  const grepSource =
    scan === "staged"
      ? `git diff --cached -- . | grep -F "${FAKE_TERM}"`
      : `git grep -F "${FAKE_TERM}" -- .`;
  writeFileSync(
    join(primary, ".git", "hooks", name),
    `#!/usr/bin/env bash\n` +
      `# fixture machine-local NDA gate (fake)\n` +
      `echo "${name}" >> "${sentinel}"\n` +
      `if ${grepSource} > /dev/null 2>&1; then\n` +
      `  echo "NDA-GATE: BLOCKED — forbidden term found (${scan})" >&2\n` +
      `  exit 1\n` +
      `fi\n` +
      `exit 0\n`,
  );
  chmodSync(join(primary, ".git", "hooks", name), 0o755);
}

function addWorktree(branch: string): string {
  const wt = join(root, `wt-${++wtCounter}`);
  git(primary, ["worktree", "add", "-b", branch, wt, "main"]);
  return wt;
}

function ranHooks(): string[] {
  return existsSync(sentinel) ? readFileSync(sentinel, "utf8").trim().split("\n").filter(Boolean) : [];
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "githooks-chain-"));
  primary = join(root, "repo");
  sentinel = join(root, "hook-ran.log");
  mkdirSync(primary);
  git(primary, ["init", "-b", "main"]);
  // Seed the fixture with the REAL tracked hooks before enabling hooksPath, so the
  // initial commit isn't blocked by the guard under test.
  mkdirSync(join(primary, ".githooks"));
  for (const hook of ["pre-commit", "pre-push", "post-checkout"]) {
    copyFileSync(join(REPO_ROOT, ".githooks", hook), join(primary, ".githooks", hook));
    chmodSync(join(primary, ".githooks", hook), 0o755);
  }
  writeFileSync(join(primary, "seed.txt"), "seed\n");
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-m", "seed"]);
  git(primary, ["config", "core.hooksPath", ".githooks"]);
  installLocalHook("pre-commit", "staged");
  installLocalHook("pre-push", "tree");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Re-install the fake machine-local hooks before every test so a mid-test failure
// (e.g. in the recursion test, which swaps .git/hooks/pre-commit) cannot cascade.
beforeEach(() => {
  installLocalHook("pre-commit", "staged");
  installLocalHook("pre-push", "tree");
});

describe("tracked pre-commit: primary-checkout guard", () => {
  it("blocks an authored commit in the PRIMARY checkout, on main", () => {
    writeFileSync(join(primary, "blocked.txt"), "clean content\n");
    git(primary, ["add", "blocked.txt"]);
    const out = gitFails(primary, ["commit", "-m", "should be blocked"]);
    expect(out).toContain("PRIMARY checkout");
    expect(out).toContain("aios worktree add");
    git(primary, ["reset", "HEAD", "blocked.txt"]);
    rmSync(join(primary, "blocked.txt"));
  });

  it("still blocks when the primary is entered through a SYMLINKED path", () => {
    // Regression: --absolute-git-dir is physical, but a logical `pwd` keeps the
    // inherited symlinked $PWD — without `pwd -P` normalization the comparison
    // never matches and the guard fails OPEN (e.g. ~/Tessera → ~/Projects).
    const link = join(root, "repo-via-symlink");
    symlinkSync(primary, link);
    const env = { ...GIT_ENV, PWD: link };
    writeFileSync(join(link, "sym.txt"), "clean content\n");
    git(link, ["add", "sym.txt"], env);
    const out = gitFails(link, ["commit", "-m", "via symlink"], env);
    expect(out).toContain("PRIMARY checkout");
    git(link, ["reset", "HEAD", "sym.txt"], env);
    rmSync(join(primary, "sym.txt"));
  });

  it("allows a commit in a linked worktree AND runs the machine-local (NDA) chain", () => {
    const wt = addWorktree("feat/clean");
    rmSync(sentinel, { force: true });
    writeFileSync(join(wt, "feature.txt"), "clean content\n");
    git(wt, ["add", "feature.txt"]);
    git(wt, ["commit", "-m", "clean commit in worktree"]);
    expect(ranHooks()).toContain("pre-commit"); // chain executed
  });

  it("NDA chain blocks a leaking commit in a linked worktree", () => {
    const wt = addWorktree("feat/leaky");
    writeFileSync(join(wt, "leak.txt"), `mentions ${FAKE_TERM} in prose\n`);
    git(wt, ["add", "leak.txt"]);
    const out = gitFails(wt, ["commit", "-m", "leaky commit"]);
    expect(out).toContain("NDA-GATE: BLOCKED");
  });

  it("AIOS_ALLOW_PRIMARY_COMMIT=1 allows a primary commit but STILL runs the NDA chain", () => {
    const env = { ...GIT_ENV, AIOS_ALLOW_PRIMARY_COMMIT: "1" };
    // leaking content: override does NOT bypass the NDA gate
    writeFileSync(join(primary, "leak.txt"), `mentions ${FAKE_TERM} in prose\n`);
    git(primary, ["add", "leak.txt"], env);
    const out = gitFails(primary, ["commit", "-m", "override + leak"], env);
    expect(out).toContain("NDA-GATE: BLOCKED");
    git(primary, ["reset", "HEAD", "leak.txt"], env);
    rmSync(join(primary, "leak.txt"));
    // clean content: override works, chain ran
    rmSync(sentinel, { force: true });
    writeFileSync(join(primary, "hotfix.txt"), "clean hotfix\n");
    git(primary, ["add", "hotfix.txt"], env);
    git(primary, ["commit", "-m", "intentional primary hotfix"], env);
    expect(ranHooks()).toContain("pre-commit");
  });

  it("git merge --ff-only in the primary is unaffected", () => {
    const wt = addWorktree("feat/ff");
    writeFileSync(join(wt, "ff.txt"), "clean ff content\n");
    git(wt, ["add", "ff.txt"]);
    git(wt, ["commit", "-m", "commit to fast-forward onto main"]);
    const before = git(primary, ["rev-parse", "HEAD"]).trim();
    git(primary, ["merge", "--ff-only", "feat/ff"]);
    const after = git(primary, ["rev-parse", "HEAD"]).trim();
    expect(after).not.toBe(before);
    expect(after).toBe(git(primary, ["rev-parse", "feat/ff"]).trim());
  });

  it("does not recurse when the machine-local hook is a copy of the tracked hook", () => {
    // Belt-and-braces: the tracked hook skips chain targets carrying its own marker.
    copyFileSync(join(REPO_ROOT, ".githooks", "pre-commit"), join(primary, ".git", "hooks", "pre-commit"));
    chmodSync(join(primary, ".git", "hooks", "pre-commit"), 0o755);
    const wt = addWorktree("feat/no-recurse");
    writeFileSync(join(wt, "safe.txt"), "clean content\n");
    git(wt, ["add", "safe.txt"]);
    git(wt, ["commit", "-m", "no infinite exec loop"]); // would time out on recursion
    installLocalHook("pre-commit", "staged"); // restore the fake NDA hook
  });
});

describe("tracked pre-push: machine-local chain", () => {
  it("runs the machine-local (NDA tree) hook on push, and pushes when clean", () => {
    const remote = join(root, "remote.git");
    git(root, ["init", "--bare", remote]);
    git(primary, ["remote", "add", "origin", remote]);
    rmSync(sentinel, { force: true });
    git(primary, ["push", "origin", "main"]);
    expect(ranHooks()).toContain("pre-push");
  });

  it("blocks the push when the machine-local hook finds a leak in the tree", () => {
    const wt = addWorktree("feat/leaky-tree");
    // Commit the leak with the machine-local pre-commit temporarily removed, to prove
    // pre-push independently catches what the commit stage missed.
    rmSync(join(primary, ".git", "hooks", "pre-commit"));
    writeFileSync(join(wt, "tree-leak.txt"), `mentions ${FAKE_TERM} in prose\n`);
    git(wt, ["add", "tree-leak.txt"]);
    git(wt, ["commit", "-m", "leak slipped past commit stage"]);
    installLocalHook("pre-commit", "staged");
    const out = gitFails(wt, ["push", "origin", "feat/leaky-tree"]);
    expect(out).toContain("NDA-GATE: BLOCKED");
    expect(out).toContain("BLOCKED by the machine-local hook");
  });
});

describe("static contract: hooks stay tracked, executable, and correctly resolved", () => {
  it("all three tracked hooks exist and are executable", () => {
    for (const hook of ["pre-commit", "pre-push", "post-checkout"]) {
      const p = join(REPO_ROOT, ".githooks", hook);
      expect(existsSync(p), `${hook} missing`).toBe(true);
      expect(statSync(p).mode & 0o111, `${hook} not executable`).not.toBe(0);
    }
  });

  it("no tracked hook resolves its chain via --git-path (honors hooksPath → recursion/dead target)", () => {
    for (const hook of ["pre-commit", "pre-push", "post-checkout"]) {
      const src = readFileSync(join(REPO_ROOT, ".githooks", hook), "utf8");
      // Scan code only — the hooks' own header comments explain (and name) the anti-pattern.
      const code = src
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      expect(code, `${hook} must not use --git-path hooks/…`).not.toMatch(/--git-path\s+hooks\//);
      expect(code, `${hook} must resolve the chain via the common dir`).toContain("--git-common-dir");
    }
  });

  it("pre-push keeps the docs-drift and skill-sync guards (never weakened)", () => {
    const src = readFileSync(join(REPO_ROOT, ".githooks", "pre-push"), "utf8");
    expect(src).toContain("check-docs-drift.mjs");
    expect(src).toContain("sync-skill-runtimes.sh");
    // The machine-local (NDA) chain must run BEFORE the drift guards.
    expect(src.indexOf('local_hook="$common_dir/hooks/pre-push"')).toBeLessThan(
      src.indexOf("check-docs-drift.mjs"),
    );
  });

  it("core.hooksPath enablement is pinned in package.json prepare", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.prepare).toContain("core.hooksPath .githooks");
  });
});
