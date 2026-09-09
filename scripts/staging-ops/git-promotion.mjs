import { execFileSync } from "node:child_process";

function git(cwd, args, options = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : String(error);
    throw new Error(detail || `git ${args[0]} failed`);
  }
}

function isAncestor(cwd, ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Exact non-force ref promotion. The optional seam exists only to prove a real remote race; the
 * production caller leaves it absent and relies on the remote's atomic non-fast-forward refusal.
 */
export function promoteExactCommit({ cwd, remote = "origin", expectedMain, candidate, beforePush }) {
  if (!/^[0-9a-f]{40}$/i.test(String(expectedMain)) || !/^[0-9a-f]{40}$/i.test(String(candidate))) {
    throw new Error("promotion requires full 40-character main and candidate SHAs");
  }
  git(cwd, ["cat-file", "-e", `${candidate}^{commit}`]);
  git(cwd, ["fetch", "--no-tags", remote, "+refs/heads/main:refs/remotes/release-controller/main"]);
  const actualMain = git(cwd, ["rev-parse", "refs/remotes/release-controller/main"]);
  if (actualMain !== expectedMain) throw new Error(`main changed: expected ${expectedMain}, observed ${actualMain}`);
  if (actualMain === candidate) return { status: "already-promoted", sha: candidate };
  if (!isAncestor(cwd, actualMain, candidate)) throw new Error("candidate is not a fast-forward of current main");
  beforePush?.();
  git(cwd, ["push", "--porcelain", remote, `${candidate}:refs/heads/main`]);
  return { status: "promoted", sha: candidate };
}
