import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { addAuthorAlias } from "@/lib/admin/aliases";
import type { ActorContext } from "@/lib/admin/members";

/**
 * GitHub identity sync — the single place that links a member to a GitHub account
 * and derives their git-author aliases (incl. the privacy-preserving noreply forms).
 * Avatars/logins live on `members`; aliases live in `member_emails`. Nothing here
 * touches the scan payload — identity is kept out of the scanner entirely.
 *
 * Token comes from the caller (read from GITHUB_TOKEN env / stdin, never argv) and
 * is never logged. We only read what GitHub exposes for OTHER users: public profile,
 * avatar, numeric id, and org membership — NOT their private verified emails.
 */

const GH = "https://api.github.com";

function ghHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "aios-team-brain",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export interface GithubUser {
  login: string;
  id: number;
  avatar_url: string;
  name: string | null;
  email: string | null; // public email; usually null
}

export async function fetchGithubUser(login: string, token: string): Promise<GithubUser> {
  const r = await fetch(`${GH}/users/${encodeURIComponent(login)}`, { headers: ghHeaders(token) });
  if (!r.ok) throw new Error(`GitHub /users/${login} → ${r.status}`);
  const u = (await r.json()) as GithubUser;
  return u;
}

/**
 * Current HEAD commit SHA of a repo's branch (default `main`) via the GitHub API. Used by the
 * Codebases → GitHub freshness panel to compare a codebase's last-scanned SHA against the live
 * tip. `fullName` is "owner/repo". Token from GITHUB_TOKEN env, never logged. Throws on a bad
 * full_name or a non-2xx response — the caller decides whether to degrade to "unknown".
 */
export async function fetchRepoHeadSha(
  fullName: string,
  token: string,
  ref = "main"
): Promise<string> {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length) {
    throw new Error(`invalid repo full_name "${fullName}" (expected owner/repo)`);
  }
  const r = await fetch(
    `${GH}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
    { headers: ghHeaders(token) }
  );
  if (!r.ok) throw new Error(`GitHub /repos/${fullName}/commits/${ref} → ${r.status}`);
  const body = (await r.json()) as { sha?: string };
  if (!body.sha) throw new Error(`GitHub /repos/${fullName}/commits/${ref} → no sha in response`);
  return body.sha;
}

/** Candidate org members (login/id/avatar) for the admin to confirm against members. */
export async function listOrgMembers(
  org: string,
  token: string
): Promise<{ login: string; id: number; avatar_url: string }[]> {
  const out: { login: string; id: number; avatar_url: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${GH}/orgs/${encodeURIComponent(org)}/members?per_page=100&page=${page}`, {
      headers: ghHeaders(token),
    });
    if (!r.ok) throw new Error(`GitHub /orgs/${org}/members → ${r.status}`);
    const batch = (await r.json()) as { login: string; id: number; avatar_url: string }[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch.map((m) => ({ login: m.login, id: m.id, avatar_url: m.avatar_url })));
    if (batch.length < 100) break;
  }
  return out;
}

/** The GitHub noreply commit-email forms derivable from numeric id + login. */
export function noreplyEmails(user: { id: number; login: string }): string[] {
  const login = user.login.toLowerCase();
  return [`${user.id}+${login}@users.noreply.github.com`, `${login}@users.noreply.github.com`];
}

/**
 * Link a confirmed (member ↔ github login) pair: store avatar/login on the member,
 * and register their derivable git-author aliases (public email + noreply forms),
 * backfilling contributions. Returns a summary.
 */
export async function linkGithub(
  admin: DbClient,
  teamId: string,
  memberId: string,
  token: string,
  login: string,
  opts: { force?: boolean; actor?: ActorContext } = {}
): Promise<{ login: string; avatar_url: string; aliases: string[]; backfilled: number }> {
  const user = await fetchGithubUser(login, token);
  const { error } = await admin
    .from("members")
    .update({ github_login: user.login, avatar_url: user.avatar_url })
    .eq("id", memberId)
    .eq("team_id", teamId);
  if (error) throw new Error(`member github link failed: ${error.message}`);

  const aliases = [...(user.email ? [user.email.toLowerCase()] : []), ...noreplyEmails(user)];
  let backfilled = 0;
  for (const email of aliases) {
    const r = await addAuthorAlias(admin, teamId, memberId, email, { force: opts.force, actor: opts.actor });
    backfilled += r.backfilled + r.remapped;
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "github.linked",
    target_type: "member",
    target_id: memberId,
    meta: { login: user.login, aliases: aliases.length, backfilled },
  });
  return { login: user.login, avatar_url: user.avatar_url, aliases, backfilled };
}
