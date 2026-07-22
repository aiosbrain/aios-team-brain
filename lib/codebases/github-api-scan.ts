import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { buildIdentityMap, resolveMember } from "@/lib/identity/resolve";

/**
 * GitHub-API codebase sync — the "auto-scan on link" path. Unlike the CLI scanner
 * (`aios-ingest scan`, which needs a local checkout to read the file tree + coverage for AEM
 * readiness), this uses only the GitHub REST API + the integration's PAT, so it runs server-side
 * whenever a repo is synced. It fills the two tables that power the per-person contribution table
 * and the commit-volume chart: `codebases` (identity) + `code_contributions` (per author/day).
 *
 * It deliberately does NOT write `code_metrics` (agentic/health/readiness/coverage) — those need
 * the checkout and remain the CLI scanner's job. To stay non-destructive, a repo that already has
 * a real scan (any `code_metrics` row) is left entirely to the scanner: the API path is a fallback
 * for linked-but-unscanned repos, never a clobber of richer scanner data.
 *
 * This module lives under `lib/codebases/` so the single-writer guard (CLAUDE.md §2) still holds.
 */

const GH = "https://api.github.com";

function ghHeaders(token: string): HeadersInit {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "aios-team-brain",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export interface ApiCommit {
  sha: string;
  author_email: string;
  author_name: string;
  authored_date: string; // ISO8601
  message: string;
}

export interface RepoMeta {
  full_name: string;
  default_branch: string;
  description: string;
  homepage: string;
  primary_language: string;
  languages: Record<string, number>;
  stars: number;
  forks: number;
  open_issues: number;
  is_archived: boolean;
}

export interface ApiContribution {
  author_key: string;
  author_name: string;
  author_email: string;
  day: string; // YYYY-MM-DD (UTC)
  commits: number;
  ai_commits: number;
}

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

// Commit-message markers left by AI coding agents (case-insensitive). Mirrors
// ingestion/aios_ingest/analyzers/codebase.py's _AI_TRAILER — keep both in sync; the
// shared fixture at test/fixtures/ai-trailer-cases.json pins every case both sides must
// pass. Extend as new agents appear.
const AI_MARKERS = [
  "co-authored-by: claude",
  "generated with [claude code]",
  "co-authored-by: codex",
  "co-authored-by: cursor",
  "co-authored-by: opencode",
  "co-authored-by: github copilot",
  "co-authored-by: devin",
  "🤖 generated with",
];

/** True when a commit message carries a known AI-agent trailer. Pure. */
export function isAiAssisted(message: string): boolean {
  const m = message.toLowerCase();
  return AI_MARKERS.some((marker) => m.includes(marker));
}

/** UTC calendar day (YYYY-MM-DD) of an ISO timestamp; "" if unparseable. Pure. */
export function dayOf(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Aggregate a commit list into per-(author, day) contribution rows. `author_key` is the
 * lower-cased author email (the identity map's primary key), falling back to the name so
 * commits with a hidden email still group. additions/deletions are 0 — the list API omits
 * per-commit stats and we won't pay one request per commit to get them. Pure.
 */
export function aggregateContributions(commits: readonly ApiCommit[]): ApiContribution[] {
  const byKey = new Map<string, ApiContribution>();
  for (const c of commits) {
    const email = c.author_email.trim().toLowerCase();
    const name = c.author_name.trim();
    const authorKey = email || name.toLowerCase();
    if (!authorKey) continue;
    const day = dayOf(c.authored_date);
    if (!day) continue;
    const mapKey = `${authorKey}|${day}`;
    const cur =
      byKey.get(mapKey) ??
      ({ author_key: authorKey, author_name: name, author_email: email, day, commits: 0, ai_commits: 0 } as ApiContribution);
    cur.commits += 1;
    if (isAiAssisted(c.message)) cur.ai_commits += 1;
    byKey.set(mapKey, cur);
  }
  return [...byKey.values()];
}

/** Normalize the GitHub `/commits` response into ApiCommit[]. Pure (tolerant of nulls). */
export function parseCommits(raw: unknown): ApiCommit[] {
  if (!Array.isArray(raw)) return [];
  const out: ApiCommit[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const commit = (r.commit ?? {}) as Record<string, unknown>;
    const author = (commit.author ?? {}) as Record<string, unknown>;
    out.push({
      sha: typeof r.sha === "string" ? r.sha : "",
      author_email: typeof author.email === "string" ? author.email : "",
      author_name: typeof author.name === "string" ? author.name : "",
      authored_date: typeof author.date === "string" ? author.date : "",
      message: typeof commit.message === "string" ? commit.message : "",
    });
  }
  return out;
}

// ── GitHub fetch (I/O) ────────────────────────────────────────────────────────

export async function fetchRepoMeta(owner: string, repo: string, token: string): Promise<RepoMeta> {
  const base = `${GH}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const r = await fetch(base, { headers: ghHeaders(token) });
  if (!r.ok) throw new Error(`GitHub /repos/${owner}/${repo} → ${r.status}`);
  const b = (await r.json()) as Record<string, unknown>;

  let languages: Record<string, number> = {};
  try {
    const lr = await fetch(`${base}/languages`, { headers: ghHeaders(token) });
    if (lr.ok) languages = (await lr.json()) as Record<string, number>;
  } catch {
    // languages are cosmetic (chips) — never fail the sync over them.
  }

  return {
    full_name: typeof b.full_name === "string" ? b.full_name : `${owner}/${repo}`,
    default_branch: typeof b.default_branch === "string" ? b.default_branch : "main",
    description: typeof b.description === "string" ? b.description : "",
    homepage: typeof b.homepage === "string" ? b.homepage : "",
    primary_language: typeof b.language === "string" ? b.language : "",
    languages,
    stars: typeof b.stargazers_count === "number" ? b.stargazers_count : 0,
    forks: typeof b.forks_count === "number" ? b.forks_count : 0,
    open_issues: typeof b.open_issues_count === "number" ? b.open_issues_count : 0,
    is_archived: Boolean(b.archived),
  };
}

/** Commits on the default branch since `sinceIso`, newest-first, paginated (capped). */
export async function fetchCommitsSince(
  owner: string,
  repo: string,
  token: string,
  sinceIso: string,
  maxPages = 10
): Promise<ApiCommit[]> {
  const base = `${GH}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`;
  const all: ApiCommit[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${base}?since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`;
    const r = await fetch(url, { headers: ghHeaders(token) });
    if (!r.ok) throw new Error(`GitHub /repos/${owner}/${repo}/commits → ${r.status}`);
    const batch = parseCommits(await r.json());
    all.push(...batch);
    if (batch.length < 100) break; // last page
  }
  return all;
}

// ── the guarded write ─────────────────────────────────────────────────────────

export interface GithubApiScanResult {
  codebase_id: string | null;
  contributions: number;
  /** set when the repo is left to the CLI scanner (already has code_metrics) */
  skipped?: "scanner-owned";
}

/**
 * Sync one repo's contributions via the GitHub API. Upserts the `codebases` identity and per-day
 * `code_contributions` (author→member attributed via the shared identity map). No-op on a repo
 * that already has a real scan — the scanner owns those rows. Never writes `code_metrics`.
 */
export async function ingestGithubApiScan(
  db: DbClient,
  auth: { teamId: string; memberId: string },
  params: { owner: string; repo: string; slug: string; token: string; windowDays?: number }
): Promise<GithubApiScanResult> {
  const { owner, repo, slug, token, windowDays = 90 } = params;

  // If a real scan exists, leave everything to the scanner (its rows are richer and it owns
  // last_scan_at + additions/deletions). The API path is only a fallback for unscanned repos.
  const { data: existing } = await db
    .from("codebases")
    .select("id")
    .eq("team_id", auth.teamId)
    .eq("slug", slug)
    .maybeSingle();
  if (existing) {
    const existingId = (existing as { id: string }).id;
    const { data: scanned } = await db
      .from("code_metrics")
      .select("id")
      .eq("codebase_id", existingId)
      .limit(1)
      .maybeSingle();
    if (scanned) return { codebase_id: existingId, contributions: 0, skipped: "scanner-owned" };
  }

  const meta = await fetchRepoMeta(owner, repo, token);
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const commits = await fetchCommitsSince(owner, repo, token, sinceIso);
  const contributions = aggregateContributions(commits).slice(0, 5000);

  // Upsert identity. NOTE: last_scan_at is intentionally omitted — this is a sync, not a code
  // scan; leaving it null keeps the card honestly flagged "not scanned" (readiness needs the CLI).
  const { data: cb, error: cbErr } = await db
    .from("codebases")
    .upsert(
      {
        team_id: auth.teamId,
        slug,
        full_name: meta.full_name,
        provider: "github",
        default_branch: meta.default_branch,
        description: meta.description,
        homepage: meta.homepage,
        primary_language: meta.primary_language,
        languages: meta.languages,
        stars: meta.stars,
        forks: meta.forks,
        open_issues: meta.open_issues,
        is_archived: meta.is_archived,
      },
      { onConflict: "team_id,slug" }
    )
    .select("id")
    .single();
  if (cbErr || !cb) throw new Error(`codebase upsert failed (${slug}): ${cbErr?.message}`);
  const codebaseId = (cb as { id: string }).id;

  const identityMap = await buildIdentityMap(db, auth.teamId);
  let written = 0;
  for (const row of contributions) {
    const memberId = resolveMember(identityMap, { email: row.author_email, key: row.author_key });
    const { error } = await db.from("code_contributions").upsert(
      {
        team_id: auth.teamId,
        codebase_id: codebaseId,
        author_key: row.author_key,
        author_name: row.author_name,
        author_email: row.author_email,
        member_id: memberId,
        day: row.day,
        commits: row.commits,
        ai_commits: row.ai_commits,
        additions: 0,
        deletions: 0,
      },
      { onConflict: "codebase_id,author_key,day" }
    );
    if (error) throw new Error(`contribution ${row.author_key}/${row.day}: ${error.message}`);
    written++;
  }

  await audit(db, {
    team_id: auth.teamId,
    actor_kind: "system",
    member_id: auth.memberId,
    action: "codebase.synced",
    target_type: "codebase",
    target_id: codebaseId,
    meta: { slug, source: "github-api", commits: commits.length, contributions: written },
  });

  return { codebase_id: codebaseId, contributions: written };
}
