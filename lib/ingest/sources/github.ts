import "server-only";

import { timeoutFetch } from "@/lib/http";
import type { GithubIssueRaw } from "./github-normalize";

/**
 * Read-only GitHub Issues fetch for the inbound ingestion runner. Pulls all issues (open + closed)
 * for a repo via the REST API, paginated. Works token-free on public repos; a PAT (the integration
 * secret) lifts rate limits and reaches private repos. PRs are returned by this endpoint too — the
 * normalize step drops them (they carry a `pull_request` field).
 */

export const GITHUB_API = "https://api.github.com";

/** Standard GitHub REST headers; the PAT (optional) lifts rate limits and reaches private repos. */
export function githubHeaders(token?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

const API = GITHUB_API;

export interface FetchedGithubRepo {
  owner: string;
  repo: string;
  issues: GithubIssueRaw[];
}

export async function fetchGithubRepoIssues(opts: {
  owner: string;
  repo: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  /**
   * ANCHORED history window (AIO-798): issues updated at/after this instant. Must be the stored
   * per-repo anchor, never `now − days` recomputed per tick — a sliding window diff-DELETES issues
   * as they age out of the fetch (the issues item is one diff-synced payload per repo). `state=all`
   * stays alongside it: closing an issue bumps `updated_at`, so closed-in-window issues import
   * only because both params are sent. Absent = the pre-window unbounded fetch.
   */
  sinceIso?: string;
}): Promise<FetchedGithubRepo> {
  const fetchImpl = opts.fetchImpl ?? timeoutFetch;
  const headers = githubHeaders(opts.token);

  const issues: GithubIssueRaw[] = [];
  const maxPages = opts.maxPages ?? 50;
  for (let page = 1; page <= maxPages; page++) {
    const since = opts.sinceIso ? `&since=${encodeURIComponent(opts.sinceIso)}` : "";
    const url = `${API}/repos/${opts.owner}/${opts.repo}/issues?state=all&per_page=100&page=${page}${since}`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub GET issues failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const batch = (await res.json()) as GithubIssueRaw[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch);
    if (batch.length < 100) break;
  }

  return { owner: opts.owner, repo: opts.repo, issues };
}
