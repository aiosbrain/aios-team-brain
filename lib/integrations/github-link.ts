import type { DbClient } from "@/lib/db/types";
import { runSql } from "@/lib/db/pg/pool";
import { upsertIntegration, type IntegrationAuth } from "./manage";
import { decryptSecret } from "@/lib/secrets/crypto";
import { addRepo, removeRepo } from "./github-repos";

/**
 * Persistence for the Admin → Integrations "GitHub repositories" panel. A team's linked repos live
 * in ONE canonical github integration row (`config.repos: string[]`). These get-or-create that row
 * and apply an immutable add/remove, writing through the single-writer `upsertIntegration` (which
 * validates the config + audits). Callers (the admin server actions) supply an admin `auth` context;
 * this module does NOT gate — the action's `requireAdmin` is the gate.
 */

interface GithubRow {
  name: string;
  status: "enabled" | "disabled";
  config: Record<string, unknown>;
}

/** The team's canonical github integration (earliest-created if several), or null. */
async function firstGithubRow(db: DbClient, teamId: string): Promise<GithubRow | null> {
  const { data } = await db
    .from("integrations")
    .select("name, status, config")
    .eq("team_id", teamId)
    .eq("type", "github")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    name: data.name as string,
    status: (data.status as "enabled" | "disabled") ?? "enabled",
    config: ((data.config as Record<string, unknown>) ?? {}) as Record<string, unknown>,
  };
}

function currentRepos(row: GithubRow | null): string[] {
  return Array.isArray(row?.config.repos) ? (row!.config.repos as string[]) : [];
}

/**
 * Per-repo import-history window (AIO-798): `days` is what the admin chose; `sinceIso` is the
 * absolute anchor resolved ONCE at link time. The anchor is the load-bearing half — recomputing
 * `now − days` on each tick is a SLIDING window, and because issues are one diff-synced item per
 * repo, issues aging out of a sliding fetch would be diff-DELETED from the brain tick after tick
 * (plan-review blocker on this design). An array, not a Record keyed by repo name: the config
 * secret-key scan walks nested object keys, and a repo literally named `acme/token-service` in key
 * position would make the whole config unsavable.
 */
export interface RepoHistoryEntry {
  repo: string;
  days: number;
  sinceIso: string;
}

function currentRepoHistory(row: GithubRow | null): RepoHistoryEntry[] {
  const raw = row?.config.repoHistory;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is RepoHistoryEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as RepoHistoryEntry).repo === "string" &&
      typeof (e as RepoHistoryEntry).days === "number" &&
      typeof (e as RepoHistoryEntry).sinceIso === "string"
  );
}

/**
 * The stored history entry for a repo, or null = linked before windows existed (or outside the
 * panel) = the pre-window behaviour: unbounded issues, default commit window. Pure and exported —
 * the importer keys every windowed fetch on this one resolver.
 */
export function resolveRepoHistory(
  config: Record<string, unknown>,
  fullName: string
): RepoHistoryEntry | null {
  const raw = Array.isArray(config.repoHistory) ? (config.repoHistory as RepoHistoryEntry[]) : [];
  const hit = raw.find((e) => e && typeof e.repo === "string" && e.repo.toLowerCase() === fullName.toLowerCase());
  return hit && typeof hit.days === "number" && typeof hit.sinceIso === "string" ? hit : null;
}

/** Upsert the canonical github row with a new repos list (and optionally the history entries),
 *  preserving other config + status. `repoHistory` stays ABSENT until the first entry exists —
 *  legacy rows must remain byte-identical (`.optional()`, never defaulted). */
async function writeRepos(
  db: DbClient,
  auth: IntegrationAuth,
  row: GithubRow | null,
  repos: string[],
  repoHistory?: RepoHistoryEntry[]
): Promise<void> {
  const config: Record<string, unknown> = { ...(row?.config ?? {}), repos };
  if (repoHistory !== undefined) {
    if (repoHistory.length > 0) config.repoHistory = repoHistory;
    else delete config.repoHistory;
  }
  await upsertIntegration(db, auth, {
    type: "github",
    name: row?.name ?? "github", // conflict key is (team,type,name) — a stable name = one row
    config,
    status: row?.status ?? "enabled", // new row → enabled; existing → keep its status
  });
}

/**
 * Link a repo (`owner/repo` or a github URL). Creates the github integration row on first link.
 * Returns the resulting repos list. Throws `RepoFormatError` on malformed input (surfaced to the UI).
 */
export async function linkGithubRepo(
  db: DbClient,
  auth: IntegrationAuth,
  repoInput: string,
  /** History window chosen at link time (AIO-798). Omitted = pre-window behaviour (no entry). */
  historyDays?: number
): Promise<string[]> {
  const row = await firstGithubRow(db, auth.teamId);
  const repos = addRepo(currentRepos(row), repoInput); // validates + case-insensitive de-dup
  let history: RepoHistoryEntry[] | undefined;
  if (historyDays !== undefined) {
    // The linked name as normalized by addRepo (last entry is the newly added repo).
    const full = repos[repos.length - 1];
    const kept = currentRepoHistory(row).filter((e) => e.repo.toLowerCase() !== full.toLowerCase());
    // The anchor: resolved exactly once, here. The importer only ever READS it back.
    history = [...kept, { repo: full, days: historyDays, sinceIso: new Date(Date.now() - historyDays * 86_400_000).toISOString() }];
  }
  await writeRepos(db, auth, row, repos, history);
  return repos;
}

/**
 * Ensure a canonical github integration row exists (creating an empty one if none) and return its
 * id — so a token can be attached before any repo is linked. Idempotent via the (team,type,name)
 * upsert key.
 */
export async function ensureGithubIntegration(
  db: DbClient,
  auth: IntegrationAuth
): Promise<string> {
  const row = await firstGithubRow(db, auth.teamId);
  const { id } = await upsertIntegration(db, auth, {
    type: "github",
    name: row?.name ?? "github",
    config: { ...(row?.config ?? {}), repos: currentRepos(row) }, // preserve repos, no-op if unchanged
    status: row?.status ?? "enabled",
  });
  return id;
}

/**
 * The canonical github row's linked repos + its decrypted token (or null). Server-only — the token
 * is decrypted in-process for the access-probe/importer and never returned to a browser. Reads the
 * row regardless of enabled/disabled so an access check reflects the true stored token.
 */
export async function githubReposAndToken(
  db: DbClient,
  teamId: string
): Promise<{ repos: string[]; token: string | null }> {
  const { data } = await db
    .from("integrations")
    .select("config, secret_ciphertext")
    .eq("team_id", teamId)
    .eq("type", "github")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const config = ((data?.config as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const repos = Array.isArray(config.repos) ? (config.repos as string[]) : [];
  const cipher = data?.secret_ciphertext as string | null | undefined;
  return { repos, token: cipher ? decryptSecret(cipher) : null };
}

/** Unlink a repo (case-insensitive). No-op if no github row / repo absent. Returns the repos list. */
export async function unlinkGithubRepo(
  db: DbClient,
  auth: IntegrationAuth,
  repoInput: string
): Promise<string[]> {
  const row = await firstGithubRow(db, auth.teamId);
  if (!row) return [];
  const repos = removeRepo(currentRepos(row), repoInput);
  const linked = new Set(repos.map((r) => r.toLowerCase()));
  // Prune history entries for repos no longer linked, so the array can't outgrow the config cap.
  const history = currentRepoHistory(row).filter((e) => linked.has(e.repo.toLowerCase()));
  await writeRepos(db, auth, row, repos, history);
  return repos;
}

/**
 * Tasks already materialized from a repo's issues project (`github-<owner>-<repo>`) — the re-link
 * warning's number (AIO-798): unlink never purges items/tasks, so re-linking with a NARROWER window
 * diff-deletes every previously imported task outside it on the first sync. Best-effort: 0 on error.
 */
export async function countPreviouslyImportedTasks(
  teamId: string,
  owner: string,
  repo: string
): Promise<number> {
  try {
    const res = await runSql<{ n: number }>(
      `select count(*)::int as n from tasks t join projects p on p.id = t.project_id
        where t.team_id = $1 and p.slug = $2`,
      [teamId, `github-${owner.toLowerCase()}-${repo.toLowerCase()}`]
    );
    return res.rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}
