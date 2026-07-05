import "server-only";

import { GITHUB_API, githubHeaders } from "./github";
import { timeoutFetch } from "@/lib/http";
import type { GithubFileRaw } from "./github-files-normalize";

/**
 * Read-only GitHub repo-file fetch for the inbound ingestion runner — the native port of the Python
 * sidecar's GitHub source. Walks a repo's tree at the default branch (or a configured ref), keeps
 * the text files matching the configured globs, and decodes each blob. Works token-free on public
 * repos; a PAT (the integration secret) lifts rate limits and reaches private repos.
 */

export const DEFAULT_FILE_GLOBS = ["*.md", "*.mdx"];

// Max decoded file size to import (skip large/generated files; the item body column caps at 1MB).
const MAX_FILE_BYTES = 800_000;

export interface FetchedGithubFiles {
  owner: string;
  repo: string;
  ref: string;
  files: GithubFileRaw[];
}

/** fnmatch-style glob → RegExp. `*` spans path separators (matches the Python `fnmatch` semantics). */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(path: string, globs: RegExp[]): boolean {
  return globs.some((re) => re.test(path));
}

export async function fetchGithubRepoFiles(opts: {
  owner: string;
  repo: string;
  token?: string | null;
  ref?: string;
  globs?: string[];
  fetchImpl?: typeof fetch;
  maxFiles?: number;
}): Promise<FetchedGithubFiles> {
  const fetchImpl = opts.fetchImpl ?? timeoutFetch;
  const headers = githubHeaders(opts.token);
  const globs = (opts.globs && opts.globs.length ? opts.globs : DEFAULT_FILE_GLOBS).map(globToRegExp);
  const maxFiles = opts.maxFiles ?? 1000;
  const base = `${GITHUB_API}/repos/${opts.owner}/${opts.repo}`;

  // Resolve the ref (default branch) unless one was configured.
  let ref = opts.ref;
  if (!ref) {
    const repoRes = await fetchImpl(base, { headers });
    if (!repoRes.ok) {
      throw new Error(`GitHub GET repo failed (${repoRes.status})`);
    }
    ref = ((await repoRes.json()) as { default_branch?: string }).default_branch || "main";
  }

  const treeRes = await fetchImpl(`${base}/git/trees/${ref}?recursive=1`, { headers });
  if (!treeRes.ok) {
    const text = await treeRes.text().catch(() => "");
    throw new Error(`GitHub GET tree failed (${treeRes.status}): ${text.slice(0, 200)}`);
  }
  const tree = (await treeRes.json()) as { tree?: { type?: string; path?: string }[] };
  const paths = (tree.tree ?? [])
    .filter((n) => n.type === "blob" && n.path && matchesAny(n.path, globs))
    .map((n) => n.path as string)
    .slice(0, maxFiles);

  const files: GithubFileRaw[] = [];
  for (const path of paths) {
    const res = await fetchImpl(`${base}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${ref}`, {
      headers,
    });
    if (!res.ok) continue;
    const data = (await res.json()) as { encoding?: string; content?: string; html_url?: string };
    if (data.encoding !== "base64" || !data.content) continue;
    let body: string;
    try {
      body = Buffer.from(data.content, "base64").toString("utf-8");
    } catch {
      continue; // binary / undecodable — skip
    }
    if (Buffer.byteLength(body, "utf-8") > MAX_FILE_BYTES) continue;
    files.push({ path, body, htmlUrl: data.html_url });
  }

  return { owner: opts.owner, repo: opts.repo, ref, files };
}
