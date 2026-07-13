import { createHash } from "node:crypto";
import type { ItemPayload } from "@/lib/api/schemas";

/**
 * Pure: a GitHub repo's fetched text files → brain `deliverable` items, ONE per file (the native
 * port of the Python sidecar's GitHub source, which imported repo files as deliverables).
 *
 * Unlike the issue importer (kind="task", one item with rows + project-wide diff-delete), this
 * mirrors the Slack/content pattern: each file is its own kind="deliverable" item keyed by a stable
 * path, idempotent via sha256. Files are NOT diff-deleted (only task/decision rows are), so a file
 * removed from the repo leaves a stale item rather than vanishing — matching every other
 * content source. Team tier.
 */

export interface GithubFileRaw {
  path: string; // repo-relative path, e.g. "docs/guide.md"
  body: string;
  htmlUrl?: string;
  // Last-commit author of this file (best-effort; absent when the commits lookup fails). The EMAIL
  // is the reliable key for author→member resolution (matches how commits are attributed).
  authorLogin?: string;
  authorEmail?: string;
  authorName?: string;
}

export interface NormalizeGithubFilesInput {
  owner: string;
  repo: string;
  ref: string;
  files: GithubFileRaw[];
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safeSegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeGithubFiles(input: NormalizeGithubFilesInput): ItemPayload[] {
  const ownerSeg = safeSegment(input.owner) || "owner";
  const repoSeg = safeSegment(input.repo) || "repo";
  const project = `github-${ownerSeg}-${repoSeg}`;

  return input.files.map((f) => ({
    project,
    path: `github/${ownerSeg}-${repoSeg}/${f.path}`.slice(0, 500),
    kind: "deliverable" as const,
    content_sha256: sha256(f.body),
    // `actor` = the file's last-committer name (display only). `author_email`/`author_login` in
    // frontmatter are the resolution keys the runner + a backfill use to attribute to a member —
    // persisted so re-attribution never needs to re-hit GitHub. Mirrors commits-to-items.
    actor: f.authorName ?? "",
    access: "team",
    frontmatter: {
      source: "github",
      repo: `${input.owner}/${input.repo}`,
      ref: input.ref,
      repo_path: f.path,
      url: f.htmlUrl ?? "",
      ...(f.authorName ? { author: f.authorName } : {}),
      ...(f.authorEmail ? { author_email: f.authorEmail } : {}),
      ...(f.authorLogin ? { author_login: f.authorLogin } : {}),
    },
    body: f.body,
  }));
}
