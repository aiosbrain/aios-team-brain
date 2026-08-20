/**
 * TICKFIT-1: the github watermark's PURE decision layer
 * (docs/design/tickfit1-github-watermark.md D2/D2b).
 *
 * The watermark covers the FILES and COMMIT-PAGINATION legs only — the tree and the commit
 * history can change ONLY via a push (`pushed_at`) or a default-branch switch
 * (`default_branch`; settings changes bump `updated_at`) — solid remote semantics with no
 * false-negative surface. The ISSUES pass is deliberately NOT watermarked (design round 2:
 * issue `updated_at` is not proven to bump on every normalized field, and the issues pass is
 * the cheap leg). Comparison is EQUALITY on the remote's own values — never our clock — so a
 * regression (force-push to older history, repo restore) is inequality and full-passes.
 *
 * Named bounded race (accepted, spec D2): a push landing in the same clock-second as the
 * recorded `pushed_at` after the pass's fetch keeps equality and is missed until the next
 * push.
 */
import { createHash } from "node:crypto";
import type { IdentityMap } from "@/lib/identity/resolve";

/**
 * Bump when the BEHAVIOR of the watermarked legs changes (Fable diff M1): a new default
 * glob set, a normalizeGithubFiles fix, a changed attribution rule — anything that would
 * produce different rows from the SAME remote state. Without this, a quiet repo keeps
 * skipping on an equal cursor and never receives the corrected behavior until its next
 * push/config/roster change — a silent pin to superseded code.
 */
export const GITHUB_CURSOR_VERSION = 1;

/** Flatten the identity map to stable strings (sorted by the hash below) — every channel the
 *  files/commit legs resolve authors through, so an alias/roster change busts the cursor. */
export function identityMapEntries(map: IdentityMap): string[] {
  const out: string[] = [];
  for (const [k, v] of map.byEmail) out.push(`email:${k}=${v}`);
  for (const [k, v] of map.byHandle) out.push(`handle:${k}=${v}`);
  for (const [k, v] of map.byProviderId) out.push(`provider:${k}=${v}`);
  for (const d of map.emailDomains) out.push(`domain:${d}`);
  return out;
}

export interface GithubRepoProbe {
  pushedAt: string | null;
  updatedAt: string | null;
  defaultBranch: string | null;
}

export interface GithubRepoCursor extends GithubRepoProbe {
  configHash: string;
}

/**
 * Skip the files + commit legs iff EVERY part matches: probe values equal the stored ones
 * (null-safe: a null stored or probed value never matches — an empty/undeterminable repo
 * always full-passes) and the config hash is unchanged. Absent cursor → full pass.
 */
export function shouldSkipGithubRepo(
  stored: Partial<GithubRepoCursor> | null,
  probe: GithubRepoProbe | null,
  configHash: string
): boolean {
  if (!stored || !probe) return false;
  if (stored.configHash !== configHash) return false;
  for (const k of ["pushedAt", "updatedAt", "defaultBranch"] as const) {
    const a = stored[k];
    const b = probe[k];
    if (typeof a !== "string" || typeof b !== "string" || a !== b) return false;
  }
  return true;
}

/**
 * The config half of the cursor (D2b): fileGlobs + the resolved history window + the identity
 * map. Entries are SORTED before hashing — the identity map is built in DB result order with
 * no ORDER BY, and a nondeterministic hash would make the watermark silently never skip (the
 * vacuity failure the round-2 review named).
 */
export function githubRepoConfigHash(parts: {
  fileGlobs?: string[] | undefined;
  /** The STORED history anchor + days — the window's IDENTITY. Never a resolved instant:
   *  `commitSinceIso(...)` slides every tick for the default window, and hashing it would
   *  make the cursor never match (the vacuity failure, caught at build). */
  historySinceIso?: string | null | undefined;
  historyDays?: number | null | undefined;
  identityEntries: Iterable<string>;
}): string {
  const globs = [...(parts.fileGlobs ?? [])].sort();
  const identity = [...parts.identityEntries].sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: GITHUB_CURSOR_VERSION,
        globs,
        history: parts.historySinceIso ?? null,
        historyDays: parts.historyDays ?? null,
        identity,
      })
    )
    .digest("hex")
    .slice(0, 32);
}
