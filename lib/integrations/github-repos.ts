/**
 * Pure helpers for the Admin → Integrations "GitHub repositories" panel. A team's linked repos live
 * in the github integration's `config.repos: string[]` (see lib/api/schemas.ts). These functions
 * validate + normalize user input and apply immutable add/remove with case-insensitive de-dup —
 * GitHub owner/repo names are case-insensitive. The server actions (integrations/actions.ts) call
 * these, then persist via the single-writer `upsertIntegration`.
 */

/** Thrown when input isn't a valid `owner/repo` (or a github URL that resolves to one). */
export class RepoFormatError extends Error {
  constructor(input: string) {
    super(`"${input}" is not a valid repo — use owner/name (e.g. acme/api).`);
    this.name = "RepoFormatError";
  }
}

// GitHub owner: letters/digits/hyphens. Repo: letters/digits/dot/underscore/hyphen. One slash.
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9._-]+$/;

/**
 * Normalize a repo reference to `owner/repo`. Accepts a bare `owner/repo` or a github.com URL
 * (with/without scheme, `.git`, or trailing slash), preserving the original case. Throws
 * `RepoFormatError` on anything that isn't a single valid `owner/repo`.
 */
export function normalizeRepo(input: string): string {
  let s = input.trim();
  // Strip a github.com URL down to owner/repo.
  s = s.replace(/^https?:\/\//i, "").replace(/^(www\.)?github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!REPO_RE.test(s)) throw new RepoFormatError(input);
  return s;
}

/** Immutably append a normalized repo, de-duplicating case-insensitively (existing entry wins). */
export function addRepo(repos: readonly string[], input: string): string[] {
  const next = normalizeRepo(input);
  if (repos.some((r) => r.toLowerCase() === next.toLowerCase())) return [...repos];
  return [...repos, next];
}

/** Immutably remove a repo, matched case-insensitively. No-op if absent. */
export function removeRepo(repos: readonly string[], input: string): string[] {
  const target = input.trim().toLowerCase();
  return repos.filter((r) => r.toLowerCase() !== target);
}
