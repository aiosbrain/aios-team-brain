import "server-only";
import { timeoutFetch } from "@/lib/http";
import { GITHUB_API, githubHeaders } from "@/lib/ingest/sources/github";
import {
  DEFAULT_FILE_GLOBS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_REPO,
  globToRegExp,
  matchesAny,
} from "@/lib/ingest/sources/github-files";
import { CHUNK_CHARS, MAX_EPISODE_CHUNKS } from "@/lib/graph/project";

/**
 * Pre-link import estimate for a GitHub repo (AIO-798) — the number an admin sees BEFORE anything
 * is fetched into the brain, because linking a repo is a spend decision and today it is made blind.
 *
 * Three metadata calls, no file contents:
 *   1. the git tree (every blob's path + byte size) → markdown corpus → episodes;
 *   2. the Search API issue count in the history window (Search EXCLUDES pull requests — the plain
 *      /issues endpoint counts them and the importer then drops them, so it would run 2-4x hot);
 *   3. the commits count in the window via the `Link: rel="last"` page number.
 *
 * The chunk math imports `CHUNK_CHARS` / `MAX_EPISODE_CHUNKS` from the projector and the file
 * filter imports the importer's own globs/caps — this module owns NO copy of either, so it cannot
 * drift from what the import will actually do. That is the whole design: the estimate is the
 * importer's arithmetic run against metadata, not a parallel model of it.
 *
 * Commits are counted but NOT priced: the linked-repo commit path (`ingestGithubApiScan`) writes
 * contribution aggregates only — no items, no episodes, no LLM calls. Pricing them was the plan
 * review's blocker #2 on the first draft of this design.
 */

/** Issues land in one diff-synced task item per repo; this is the honest floor for how many issue
 *  rows share an episode chunk. Labelled an estimate in the UI — issue bodies vary wildly. */
export const ISSUES_PER_EPISODE_EST = 12;

export interface GithubImportEstimate {
  /** Markdown files the importer would fetch (glob-matched, ≤MAX_FILE_BYTES, capped). */
  files: number;
  fileEpisodes: number;
  /** True when the tree was truncated (~100k entries) or the file cap bound — the numbers are a floor. */
  atLeast: boolean;
  /** Issues (NOT PRs) updated in the window; null when the count could not be read. */
  issueCount: number | null;
  issueEpisodes: number;
  /** Commits in the window; null when unreadable. Contributor graphs only — never priced. */
  commitCount: number | null;
  episodes: number;
}

export type GithubEstimateResult =
  | ({ ok: true } & GithubImportEstimate)
  | { ok: false; reason: "unreachable" | "error"; detail: string };

/** min(ceil(bytes/CHUNK_CHARS), MAX_EPISODE_CHUNKS) — the projector's own chunking, over tree
 *  metadata (bytes ≈ chars for markdown; stated as an estimate in the UI). */
export function episodesForBytes(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.min(Math.ceil(bytes / CHUNK_CHARS), MAX_EPISODE_CHUNKS);
}

/** Issue rows share one diff-synced item, whose chunking the projector caps like any other item. */
export function episodesForIssueCount(count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.ceil(count / ISSUES_PER_EPISODE_EST), MAX_EPISODE_CHUNKS);
}

export interface TreeBlob {
  type?: string;
  path?: string;
  size?: number;
}

/**
 * Fold a git tree into the file half of the estimate. Pure — the arithmetic under test without a
 * network. Mirrors the importer exactly: glob match, the >MAX_FILE_BYTES skip, and the
 * MAX_FILES_PER_REPO cap (files beyond the cap are not imported, so they are not priced — but they
 * DO set `atLeast`, since a capped estimate is a floor, not a total).
 */
export function estimateFromTree(
  blobs: TreeBlob[],
  globs: string[] | undefined,
  treeTruncated: boolean
): Pick<GithubImportEstimate, "files" | "fileEpisodes" | "atLeast"> {
  const compiled = (globs && globs.length ? globs : DEFAULT_FILE_GLOBS).map(globToRegExp);
  const matched = blobs.filter(
    (b) =>
      b.type === "blob" &&
      typeof b.path === "string" &&
      matchesAny(b.path, compiled) &&
      (b.size ?? 0) <= MAX_FILE_BYTES
  );
  const counted = matched.slice(0, MAX_FILES_PER_REPO);
  return {
    files: counted.length,
    fileEpisodes: counted.reduce((sum, b) => sum + episodesForBytes(b.size ?? 0), 0),
    atLeast: treeTruncated || matched.length > MAX_FILES_PER_REPO,
  };
}

/**
 * Total-count from a paginated endpoint queried with `per_page=1`: the `Link` header's `rel="last"`
 * page number IS the count. No `Link` header at all means everything fit on one page — the count is
 * the returned page's length (0 or 1 here), NOT zero; that distinction is load-bearing for
 * single-commit repos.
 */
export function countFromLinkHeader(link: string | null, pageLength: number): number {
  if (!link) return pageLength;
  const m = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
  return m ? Number(m[1]) : pageLength;
}

const iso = (d: Date) => d.toISOString();

/** The estimate, from ~3 GitHub metadata calls. Never throws — an unreachable repo is a result. */
export async function estimateGithubImport(opts: {
  owner: string;
  repo: string;
  token?: string | null;
  /** History window in days; 0 = no history (issues anchored at link time, no commit backfill). */
  historyDays: number;
  fileGlobs?: string[];
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<GithubEstimateResult> {
  const fetchImpl = opts.fetchImpl ?? timeoutFetch;
  const headers = githubHeaders(opts.token);
  const base = `${GITHUB_API}/repos/${opts.owner}/${opts.repo}`;
  const now = opts.nowMs ?? Date.now();
  const since = iso(new Date(now - Math.max(opts.historyDays, 0) * 86_400_000));
  try {
    const repoRes = await fetchImpl(base, { headers });
    if (repoRes.status === 404 || repoRes.status === 403) {
      // Private without (or beyond the scope of) the stored PAT — the panel shows the existing
      // no-access vocabulary and the admin may still link; the cost is honestly unknown.
      return { ok: false, reason: "unreachable", detail: `GitHub returned ${repoRes.status}` };
    }
    if (!repoRes.ok) return { ok: false, reason: "error", detail: `GitHub GET repo failed (${repoRes.status})` };
    const ref = ((await repoRes.json()) as { default_branch?: string }).default_branch || "main";

    const treeRes = await fetchImpl(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers });
    if (!treeRes.ok) return { ok: false, reason: "error", detail: `GitHub GET tree failed (${treeRes.status})` };
    const tree = (await treeRes.json()) as { tree?: TreeBlob[]; truncated?: boolean };
    const fileHalf = estimateFromTree(tree.tree ?? [], opts.fileGlobs, tree.truncated === true);

    // Issues (window only meaningful when history is requested; days=0 → count 0 by construction).
    let issueCount: number | null = 0;
    if (opts.historyDays > 0) {
      try {
        const q = encodeURIComponent(`repo:${opts.owner}/${opts.repo} type:issue updated:>=${since.slice(0, 10)}`);
        const res = await fetchImpl(`${GITHUB_API}/search/issues?q=${q}&per_page=1`, { headers });
        issueCount = res.ok ? ((await res.json()) as { total_count?: number }).total_count ?? null : null;
      } catch {
        issueCount = null;
      }
    }

    // Commits in window — contributor graphs, never priced.
    let commitCount: number | null = 0;
    if (opts.historyDays > 0) {
      try {
        const res = await fetchImpl(`${base}/commits?since=${encodeURIComponent(since)}&per_page=1`, { headers });
        if (res.ok) {
          const page = (await res.json()) as unknown[];
          commitCount = countFromLinkHeader(res.headers.get("link"), Array.isArray(page) ? page.length : 0);
        } else if (res.status === 409) {
          commitCount = 0; // empty repository
        } else {
          commitCount = null;
        }
      } catch {
        commitCount = null;
      }
    }

    const issueEpisodes = episodesForIssueCount(issueCount ?? 0);
    return {
      ok: true,
      ...fileHalf,
      issueCount,
      issueEpisodes,
      commitCount,
      episodes: fileHalf.fileEpisodes + issueEpisodes,
    };
  } catch (err) {
    return { ok: false, reason: "error", detail: err instanceof Error ? err.message : "estimate failed" };
  }
}
