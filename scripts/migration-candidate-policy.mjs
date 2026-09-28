import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RELEASE_BRANCH, remoteRef } from "./branches.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UNPROMOTED_CANDIDATE = Object.freeze({
  tag: "v0.13.0",
  object: "a8f33f700027999e2af8486e1d813360abd9f8d0",
  commit: "1c3af67a54fa721a4d4040afad1089d10faf6229",
  annotation: "AIOS Team Brain v0.13.0 — unpromoted validation candidate for release commissioning",
});
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
function compare(a, b) {
  const left = a.slice(1).split(".").map(Number);
  const right = b.slice(1).split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
export function candidateGitFacts(cwd = ROOT) {
  const readGit = args => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const ancestor = (commit, ref) => {
    try {
      readGit(["merge-base", "--is-ancestor", commit, ref]);
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw new Error(`candidate ancestry check unavailable for ${ref}`);
    }
  };
  return { readGit, ancestor };
}
const gitFacts = candidateGitFacts();

/** Local classification only. The actual migration run must also check fresh release state. */
export function inspectUnpromotedCandidate(declared, existing, {
  usingDeclaration = true, readGit = gitFacts.readGit, ancestor = gitFacts.ancestor,
} = {}) {
  const candidate = UNPROMOTED_CANDIDATE;
  if (!usingDeclaration || !existing.includes(candidate.tag) || declared.includes(candidate.tag)) return null;
  const newest = declared.filter(tag => RELEASE_TAG.test(tag)).sort(compare).pop();
  if (!newest || compare(candidate.tag, newest) <= 0) return null;
  if (readGit(["rev-parse", "--is-shallow-repository"]) !== "false")
    throw new Error("candidate classification requires complete git history");
  const ref = `refs/tags/${candidate.tag}`;
  if (readGit(["cat-file", "-t", ref]) !== "tag" ||
      readGit(["rev-parse", ref]) !== candidate.object ||
      readGit(["rev-parse", `${ref}^{commit}`]) !== candidate.commit ||
      readGit(["for-each-ref", "--format=%(contents)", ref]) !== candidate.annotation) return null;
  if (ancestor(candidate.commit, "HEAD") || ancestor(candidate.commit, remoteRef(RELEASE_BRANCH))) return null;
  return candidate;
}

/** Only an authenticated fresh 404 is evidence of no published release; errors never exempt. */
export async function assertCandidateHasNoRelease(candidate, {
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!token?.trim()) throw new Error("candidate release check requires an authenticated GitHub token");
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/aiosbrain/aios-team-brain/releases/tags/${candidate.tag}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Cache-Control": "no-cache" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("candidate release check unavailable");
  }
  if (response.status === 404) return;
  if (response.status === 200) throw new Error(`candidate exception refused: ${candidate.tag} has a published GitHub release`);
  throw new Error(`candidate release check unavailable (HTTP ${response.status})`);
}

/** Runtime authorization: bind the fresh publication check to the same immutable git candidate. */
export async function verifiedCandidateExemption(declared, existing, options = {}) {
  const candidate = inspectUnpromotedCandidate(declared, existing, options);
  if (!candidate) return null;
  await assertCandidateHasNoRelease(candidate, options);
  if (inspectUnpromotedCandidate(declared, existing, options) !== candidate)
    throw new Error("candidate git state changed during release verification");
  return { ...candidate, publishedReleaseStatus: 404 };
}
