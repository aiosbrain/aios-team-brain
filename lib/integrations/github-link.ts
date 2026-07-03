import type { SupabaseClient } from "@supabase/supabase-js";
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
async function firstGithubRow(supabase: SupabaseClient, teamId: string): Promise<GithubRow | null> {
  const { data } = await supabase
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

/** Upsert the canonical github row with a new repos list, preserving other config + status. */
async function writeRepos(
  supabase: SupabaseClient,
  auth: IntegrationAuth,
  row: GithubRow | null,
  repos: string[]
): Promise<void> {
  await upsertIntegration(supabase, auth, {
    type: "github",
    name: row?.name ?? "github", // conflict key is (team,type,name) — a stable name = one row
    config: { ...(row?.config ?? {}), repos },
    status: row?.status ?? "enabled", // new row → enabled; existing → keep its status
  });
}

/**
 * Link a repo (`owner/repo` or a github URL). Creates the github integration row on first link.
 * Returns the resulting repos list. Throws `RepoFormatError` on malformed input (surfaced to the UI).
 */
export async function linkGithubRepo(
  supabase: SupabaseClient,
  auth: IntegrationAuth,
  repoInput: string
): Promise<string[]> {
  const row = await firstGithubRow(supabase, auth.teamId);
  const repos = addRepo(currentRepos(row), repoInput); // validates + case-insensitive de-dup
  await writeRepos(supabase, auth, row, repos);
  return repos;
}

/**
 * Ensure a canonical github integration row exists (creating an empty one if none) and return its
 * id — so a token can be attached before any repo is linked. Idempotent via the (team,type,name)
 * upsert key.
 */
export async function ensureGithubIntegration(
  supabase: SupabaseClient,
  auth: IntegrationAuth
): Promise<string> {
  const row = await firstGithubRow(supabase, auth.teamId);
  const { id } = await upsertIntegration(supabase, auth, {
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
  supabase: SupabaseClient,
  teamId: string
): Promise<{ repos: string[]; token: string | null }> {
  const { data } = await supabase
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
  supabase: SupabaseClient,
  auth: IntegrationAuth,
  repoInput: string
): Promise<string[]> {
  const row = await firstGithubRow(supabase, auth.teamId);
  if (!row) return [];
  const repos = removeRepo(currentRepos(row), repoInput);
  await writeRepos(supabase, auth, row, repos);
  return repos;
}
