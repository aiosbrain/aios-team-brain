import "server-only";
import { createHash } from "node:crypto";
import type { DbClient } from "@/lib/db/types";
import { ingestItem } from "@/lib/ingest";
import type { ItemPayload } from "@/lib/api/schemas";
import { resolveMember, type IdentityMap, type AuthorIdentity } from "@/lib/identity/resolve";

/**
 * Project a codebase scan's `recent_commits` into searchable `items` so NL queries can answer
 * "what did <person> commit / John's git history" with citable commit messages — not just the
 * aggregate counts in `code_contributions`. Commits are stored as `artifact` items tagged
 * `frontmatter.source = "git"` (kept off the public `item_kind` contract on purpose) in a dedicated
 * `commits` project, attributed to the resolved member via ingestItem's internal author override.
 * Idempotent: re-scanning re-pushes the same path+body → sha dedup → no-op.
 */

const COMMITS_PROJECT = "commits";

export interface ScanCommit {
  sha?: unknown;
  author?: unknown;
  message?: unknown;
  committed_at?: unknown;
  ai?: unknown;
  additions?: unknown;
  deletions?: unknown;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safeSegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);

/** Pull a `name <email>` pair out of a git author string (best-effort). */
export function parseAuthorIdentity(author: string): AuthorIdentity & { name: string } {
  const m = author.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || m[2], email: m[2].trim(), key: m[2].trim() };
  const isEmail = author.includes("@");
  return { name: author, email: isEmail ? author.trim() : undefined, key: author.trim() };
}

/** Pure: a scan commit → the brain's ItemPayload (or null if it has no stable sha). */
export function normalizeCommit(codebaseSlug: string, commit: ScanCommit): ItemPayload | null {
  const sha = str(commit.sha).trim();
  if (!sha) return null;
  const author = str(commit.author).trim() || "unknown";
  const message = str(commit.message).trim();
  const when = str(commit.committed_at).trim();
  const ai = commit.ai === true;
  const adds = int(commit.additions);
  const dels = int(commit.deletions);
  const slug = safeSegment(codebaseSlug);
  const shortSha = sha.slice(0, 10);

  const body =
    `# Commit ${shortSha} — ${codebaseSlug}\n\n` +
    `**${author}**${when ? ` · ${when}` : ""}\n\n` +
    `${message || "(no message)"}\n\n` +
    `\`${sha}\` · +${adds}/-${dels}${ai ? " · AI-assisted" : ""}\n`;

  return {
    project: COMMITS_PROJECT,
    path: `commits/${slug}/${sha}.md`,
    kind: "artifact",
    content_sha256: sha256(body),
    actor: author,
    access: "team",
    frontmatter: {
      source: "git",
      type: "commit",
      codebase: codebaseSlug,
      sha,
      author,
      committed_at: when,
      ai,
      additions: adds,
      deletions: dels,
    },
    body,
  };
}

/**
 * Ingest a codebase's recent commits as items, attributing each to the resolved member.
 * Reuses the caller's already-built identity map. Returns the count of commits processed.
 */
export async function projectCommitsToItems(
  supabase: DbClient,
  auth: { teamId: string; memberId: string; apiKeyId: string },
  codebaseSlug: string,
  recentCommits: ScanCommit[],
  identityMap: IdentityMap
): Promise<number> {
  let processed = 0;
  for (const commit of recentCommits) {
    const payload = normalizeCommit(codebaseSlug, commit);
    if (!payload) continue;
    const authorMemberId = resolveMember(identityMap, parseAuthorIdentity(str(commit.author)));
    await ingestItem(supabase, auth, payload, "team", { authorMemberId });
    processed++;
  }
  return processed;
}
