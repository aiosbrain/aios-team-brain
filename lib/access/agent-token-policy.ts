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

/** Upper bound on a single token's scope list — a sanity cap, not a security control. */
export const MAX_PROJECT_SCOPE = 200;

/** What the mint form pre-fills. Short enough to force a renewal decision, long enough to be usable. */
export const DEFAULT_TOKEN_LIFETIME_DAYS = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO-8601 instant, with Z or a numeric offset. Deliberately stricter than `Date.parse`. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

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
  // A server action receives whatever the caller sends. Everything below is a TYPE check before a
  // VALUE check, because `RegExp.test` and `Date.parse` both coerce: `["<uuid>"]` stringifies to a
  // valid uuid and would otherwise pass as a memberId.
  if (req == null || typeof req !== "object" || Array.isArray(req)) {
    return { ok: false, error: "invalid request" };
  }
  if (typeof req.memberId !== "string" || !UUID_RE.test(req.memberId)) {
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
  if (req.name != null && typeof req.name !== "string") {
    return { ok: false, error: "name must be a string" };
  }
  if (req.projectScope != null) {
    // A direct caller can send anything. Without this, a string or an object with a `length` throws
    // inside `.some(...)` and the boundary returns an opaque 500 instead of a refusal.
    if (!Array.isArray(req.projectScope)) {
      return { ok: false, error: "projectScope must be an array of project uuids" };
    }
    if (req.projectScope.length > MAX_PROJECT_SCOPE) {
      return { ok: false, error: `projectScope may name at most ${MAX_PROJECT_SCOPE} projects` };
    }
    if (new Set(req.projectScope).size !== req.projectScope.length) {
      return { ok: false, error: "projectScope must not repeat a project" };
    }
    if (req.projectScope.length === 0) {
      return {
        ok: false,
        error: "projectScope must name at least one project, or be omitted to inherit the launcher's access",
      };
    }
      if (req.projectScope.some((p) => typeof p !== "string" || !UUID_RE.test(p))) {
      return { ok: false, error: "projectScope must contain project uuids" };
    }
  }

  // EXPIRY: required. `mintAgentToken` stores `expiresAt ?? null`, and a null expiry never expires —
  // so "absent" must be refused rather than quietly becoming forever.
  if (req.expiresAt == null || req.expiresAt === "") {
    return { ok: false, error: "expiresAt is required" };
  }
  // `Date.parse` accepts plenty that is not ISO-8601 ("12/31/2026" parses), and coerces arrays.
  // The contract says ISO, so require the shape before trusting the parse.
  if (typeof req.expiresAt !== "string" || !ISO_RE.test(req.expiresAt)) {
    return { ok: false, error: "expiresAt must be an ISO timestamp" };
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

/**
 * The mint form's submit rule, extracted as a pure function so it can be pinned by tests without a
 * DOM harness — and so the "silent `null` inherits everything" hazard both spec reviewers flagged is
 * covered by an assertion rather than by reading the JSX.
 *
 * `scope === null` means the admin has TOUCHED NOTHING. It must not be submittable: `null` would
 * inherit the launcher's full visibility, which is the fail-open direction.
 */
export type ScopeChoice = null | { kind: "inherit" } | { kind: "restrict"; projectIds: string[] };

export function canSubmitMint(input: {
  memberId: string;
  expiry: string;
  scope: ScopeChoice;
}): boolean {
  if (!input.memberId) return false;
  if (!input.expiry) return false;
  if (input.scope === null) return false;
  if (input.scope.kind === "restrict" && input.scope.projectIds.length === 0) return false;
  return true;
}

/**
 * The instant the form should submit for a chosen calendar date.
 *
 * WHY THIS EXISTS: the form offered `today + 365 days` as its max date and submitted it at
 * 23:59:59Z — which is up to a day BEYOND the exact 365-day cap, so the action refused the very
 * value its own picker allowed. The spec claims the form cannot request what the action refuses;
 * this is what makes that true, and it lives beside the cap so the two cannot drift.
 */
export function expiryInstantFor(chosenDate: string, now: number): string {
  const endOfDay = Date.parse(`${chosenDate}T23:59:59.000Z`);
  const capped = Math.min(Number.isNaN(endOfDay) ? now : endOfDay, now + MAX_TOKEN_LIFETIME_MS);
  return new Date(capped).toISOString();
}
