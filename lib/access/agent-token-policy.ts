/**
 * Mint-request policy for delegated agent tokens (AGENTUI-1) — PURE, no I/O, no framework.
 *
 * WHY THIS IS A SEPARATE MODULE, not three `if`s inside the server action:
 *
 *  1. A `"use server"` file may only export async functions, so the shared lifetime cap physically
 *     cannot live there. The form and the action must agree on that number, and the only way to have
 *     ONE constant with TWO readers is a plain module both import.
 *  2. It makes the rules testable by calling them, rather than by reaching through a server action.
 *
 * WHY THE RULES ARE HERE AT ALL, rather than in the form: a server action is a public HTTP endpoint.
 * A constraint that lives in a React component is a suggestion to anyone who uses the page and
 * nothing whatsoever to anyone who does not. The spec review put it as "the safety folds currently
 * exist only in client UX" — these are the same rules, moved to where they hold.
 *
 * SCOPE OF THIS MODULE: it constrains what may be REQUESTED. It says nothing about what an already
 * minted token can DO — that is the oracle's live triple intersection, deliberately untouched.
 */

/** Hard ceiling on a token's lifetime. A credential with no horizon is the one nobody revokes. */
export const MAX_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** What the mint form pre-fills. Short enough to force a renewal decision, long enough to be usable. */
export const DEFAULT_TOKEN_LIFETIME_DAYS = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MintRequest {
  memberId: string;
  onBehalfOf?: string | null;
  /** `null`/absent = inherit the launcher's projects. A populated array = restrict to those. */
  projectScope?: string[] | null;
  name?: string;
  expiresAt?: string | null;
}

export type PolicyResult = { ok: true } | { ok: false; error: string };

/**
 * `now` is a parameter, not `Date.now()`, so the expiry rules are testable at exact boundaries
 * without the clock making the test flaky.
 */
export function validateMintRequest(req: MintRequest, now: number): PolicyResult {
  if (!UUID_RE.test(req.memberId ?? "")) {
    return { ok: false, error: "memberId must be a member uuid" };
  }

  // ACTING-AS: refused outright in v1. `on_behalf_of` makes a delegated query answer in the
  // represented person's first-person identity while quota, cost and audit stay with the launcher —
  // and no owner→agent authorization or consent model exists anywhere yet. Omitting the control from
  // the form would leave this reachable by anyone posting to the action directly; refusing it here is
  // what actually makes v1 self-only.
  if (req.onBehalfOf != null) {
    return { ok: false, error: "acting-as is not available in this version — tokens are self-only" };
  }

  // SCOPE: `null`/absent means inherit, and is legal — but it must be the caller's DELIBERATE choice,
  // which the form makes explicit. `[]` is a legal DB state ("sees nothing") that is never a legal
  // REQUEST: the only way to produce it is an empty multi-select, i.e. an accident that mints a token
  // which silently reads nothing.
  if (req.projectScope != null) {
    if (req.projectScope.length === 0) {
      return {
        ok: false,
        error: "projectScope must name at least one project, or be omitted to inherit the launcher's access",
      };
    }
    if (req.projectScope.some((p) => !UUID_RE.test(p))) {
      return { ok: false, error: "projectScope must contain project uuids" };
    }
  }

  // EXPIRY: required. `mintAgentToken` stores `expiresAt ?? null`, and a null expiry never expires —
  // so "absent" must be refused rather than quietly becoming forever.
  if (req.expiresAt == null || req.expiresAt === "") {
    return { ok: false, error: "expiresAt is required" };
  }
  const at = Date.parse(req.expiresAt);
  if (Number.isNaN(at)) {
    return { ok: false, error: "expiresAt must be an ISO timestamp" };
  }
  if (at <= now) {
    return { ok: false, error: "expiresAt must be in the future" };
  }
  if (at > now + MAX_TOKEN_LIFETIME_MS) {
    return { ok: false, error: "expiresAt is beyond the 365-day maximum" };
  }

  return { ok: true };
}
