import { githubHeaders } from "@/lib/ingest/sources/github";

/**
 * GitHub token/repo checks for the Admin → Integrations private-repo connect flow. Kept separate
 * from the ingest source so the UI can validate a token + probe repo access WITHOUT running a sync.
 * `fetchImpl` is injectable for tests; it defaults to global fetch.
 */

const API = "https://api.github.com";
type Fetch = typeof fetch;

export interface TokenValidation {
  ok: boolean;
  login?: string; // the authenticated account, shown as "Connected as @login"
  error?: string;
}

/** Validate a PAT via GET /user. Never throws — network/HTTP errors become `{ ok:false, error }`. */
export async function validateGithubToken(token: string, fetchImpl: Fetch = fetch): Promise<TokenValidation> {
  if (!token.trim()) return { ok: false, error: "token is empty" };
  try {
    const res = await fetchImpl(`${API}/user`, { headers: githubHeaders(token) });
    if (res.status === 200) {
      const body = (await res.json()) as { login?: string };
      return { ok: true, login: body.login };
    }
    if (res.status === 401) return { ok: false, error: "token invalid or expired (401)" };
    if (res.status === 403) return { ok: false, error: "token forbidden or rate-limited (403)" };
    return { ok: false, error: `GitHub returned ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not reach GitHub" };
  }
}

/** public = readable by anyone · private = readable with this token · no_access = 404 (private-no-access or missing). */
export type RepoAccessState = "public" | "private" | "no_access" | "error";
export interface RepoAccess {
  repo: string;
  state: RepoAccessState;
}

/**
 * Probe a single repo's accessibility (optionally with a token) via GET /repos/{owner}/{repo}.
 * 200 → public/private by the `private` flag; 404 → no_access (GitHub deliberately hides whether a
 * private repo exists vs. is merely inaccessible); anything else → error. Never throws.
 */
export async function checkRepoAccess(
  repo: string,
  token?: string | null,
  fetchImpl: Fetch = fetch
): Promise<RepoAccess> {
  try {
    const res = await fetchImpl(`${API}/repos/${repo}`, { headers: githubHeaders(token) });
    if (res.status === 200) {
      const body = (await res.json()) as { private?: boolean };
      return { repo, state: body.private ? "private" : "public" };
    }
    if (res.status === 404) return { repo, state: "no_access" };
    return { repo, state: "error" };
  } catch {
    return { repo, state: "error" };
  }
}
