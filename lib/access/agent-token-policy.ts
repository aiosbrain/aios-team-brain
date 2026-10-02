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
 *
 * AUDITFIX-19: the scope rule itself lives in `./agent-token-scope` (shared with the guarded writer,
 * which re-parses independently), and `validateMintRequest` now RETURNS the normalized request. The
 * action consumes that copy — for its visibility checks and for the writer call — never the raw input.
 */

import {
  INVALID_REQUEST,
  MAX_PROJECT_SCOPE,
  UUID_RE,
  isRequestObject,
  parseTokenMintScope,
  type ScopeParseResult,
  type TokenMintScope,
} from "@/lib/access/agent-token-scope";

export { MAX_PROJECT_SCOPE, type TokenMintScope };

/** Hard ceiling on a token's lifetime. A credential with no horizon is the one nobody revokes. */
export const MAX_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** What the mint form pre-fills. Short enough to force a renewal decision, long enough to be usable. */
export const DEFAULT_TOKEN_LIFETIME_DAYS = 90;

/** ISO-8601 instant, with Z or a numeric offset. Deliberately stricter than `Date.parse`. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface MintRequest {
  memberId: string;
  /** REQUIRED deliberate choice (AUDITFIX-19). There is no legacy `projectScope` and no default. */
  scope: TokenMintScope;
  onBehalfOf?: string | null;
  name?: string;
  expiresAt?: string | null;
}

/** The request the action actually uses: every field captured once and validated. */
export interface NormalizedMintRequest {
  memberId: string;
  /** Acting-as is refused by this policy, so the normalized request is always self-only. */
  onBehalfOf: null;
  scope: TokenMintScope;
  name: string | undefined;
  expiresAt: string;
}

export type PolicyResult = { ok: true; request: NormalizedMintRequest } | { ok: false; error: string };

type CheckResult = { ok: true } | { ok: false; error: string };

/** The request's scalar fields, each read exactly once from the caller's object. */
type CapturedFields = { memberId: unknown; onBehalfOf: unknown; name: unknown; expiresAt: unknown };

type Captured = { ok: true; fields: CapturedFields; scope: ScopeParseResult } | { ok: false; error: string };

/**
 * The ONLY stage that touches the caller's object: whole-request guard, one read of each scalar field,
 * then the scope parse. Any synchronous throw from it (a getter, a proxy trap, a revoked proxy) is the
 * fixed invalid-request refusal — the thrown value is never inspected or echoed. Everything after this
 * works on the captured values, which cannot throw.
 */
function captureRequest(req: unknown): Captured {
  try {
    // A server action receives whatever the caller sends.
    if (!isRequestObject(req)) return { ok: false, error: INVALID_REQUEST };
    const fields: CapturedFields = {
      memberId: req.memberId,
      onBehalfOf: req.onBehalfOf,
      name: req.name,
      expiresAt: req.expiresAt,
    };
    return { ok: true, fields, scope: parseTokenMintScope(req) };
  } catch {
    return { ok: false, error: INVALID_REQUEST };
  }
}

/** Identity legs: the launcher, and the acting-as leg v1 refuses outright. */
function checkIdentity(req: CapturedFields): CheckResult {
  if (typeof req.memberId !== "string" || !UUID_RE.test(req.memberId)) {
    return { ok: false, error: "memberId must be a member uuid" };
  }
  // ACTING-AS: refused server-side, not merely hidden. `on_behalf_of` makes a delegated query answer
  // in the represented person's first-person identity while quota, cost and audit stay with the
  // launcher, and no owner→agent authorization or consent model exists anywhere yet. Omitting the
  // control from the form would leave this reachable by anyone posting to the action directly.
  if (req.onBehalfOf != null) {
    return { ok: false, error: "acting-as is not available in this version — tokens are self-only" };
  }
  if (req.name != null && typeof req.name !== "string") {
    return { ok: false, error: "name must be a string" };
  }
  return { ok: true };
}

/**
 * Expiry: REQUIRED and bounded. `mintAgentToken` stores `expiresAt ?? null` and a null expiry never
 * expires, so "absent" must be refused rather than quietly becoming forever.
 */
function checkExpiry(req: CapturedFields, now: number): CheckResult {
  if (req.expiresAt == null || req.expiresAt === "") {
    return { ok: false, error: "expiresAt is required" };
  }
  // `Date.parse` accepts plenty that is not ISO-8601 ("12/31/2026" parses) and coerces arrays, so
  // require the shape before trusting the parse.
  if (typeof req.expiresAt !== "string" || !ISO_RE.test(req.expiresAt)) {
    return { ok: false, error: "expiresAt must be an ISO timestamp" };
  }
  const at = Date.parse(req.expiresAt);
  if (Number.isNaN(at)) return { ok: false, error: "expiresAt must be an ISO timestamp" };
  if (at <= now) return { ok: false, error: "expiresAt must be in the future" };
  if (at > now + MAX_TOKEN_LIFETIME_MS) {
    return { ok: false, error: "expiresAt is beyond the 365-day maximum" };
  }
  return { ok: true };
}

/**
 * `now` is a parameter, not `Date.now()`, so the expiry rules are testable at exact boundaries
 * without the clock making the test flaky. Split into three checks because a single chain of guard
 * clauses crossed the complexity ceiling.
 *
 * AUDITFIX-19: the whole request is shape-guarded BEFORE any field is read; then the scalar fields
 * are captured once and the scope is parsed into its own copy (the legacy-key / inherited-scope rules
 * run against the real request object). Everything after this function consumes the returned
 * `request`, so a caller that mutates its object later cannot change what was validated. A request
 * whose reads throw is refused, never rethrown (`captureRequest`).
 */
export function validateMintRequest(req: unknown, now: number): PolicyResult {
  const capture = captureRequest(req);
  if (!capture.ok) return capture;
  const { fields: captured, scope } = capture;
  const identity = checkIdentity(captured);
  if (!identity.ok) return identity;
  if (!scope.ok) return scope;
  const expiry = checkExpiry(captured, now);
  if (!expiry.ok) return expiry;
  return {
    ok: true,
    request: {
      memberId: captured.memberId as string,
      onBehalfOf: null,
      scope: scope.scope,
      name: typeof captured.name === "string" ? captured.name.slice(0, 200) : undefined,
      expiresAt: captured.expiresAt as string,
    },
  };
}

/**
 * The mint form's submit rule, extracted as a pure function so it can be pinned by tests without a
 * DOM harness — and so the "silent `null` inherits everything" hazard both spec reviewers flagged is
 * covered by an assertion rather than by reading the JSX.
 *
 * `scope === null` means the admin has TOUCHED NOTHING. It must not be submittable, and it is never
 * sent: the form only ever transmits one of the two deliberate choices (see `mintRequestFor`).
 */
export type ScopeChoice = null | { kind: "all-reachable" } | { kind: "projects"; projectIds: string[] };

export function canSubmitMint(input: {
  memberId: string;
  expiry: string;
  scope: ScopeChoice;
}): boolean {
  if (!input.memberId) return false;
  if (!input.expiry) return false;
  if (input.scope === null) return false;
  if (input.scope.kind === "projects" && input.scope.projectIds.length === 0) return false;
  return true;
}

/**
 * AUDITFIX-19: the EXACT request the form sends, built here so the mapping is a tested function and
 * not JSX. Untouched or empty-selection state yields `null` (nothing to send); a deliberate choice
 * maps one-to-one onto the request contract. The legacy `projectScope` key is never emitted.
 */
export function mintRequestFor(
  form: { memberId: string; name: string; expiry: string; scope: ScopeChoice },
  now: number
): MintRequest | null {
  if (form.scope === null || !canSubmitMint(form)) return null;
  const scope: TokenMintScope =
    form.scope.kind === "all-reachable"
      ? { kind: "all-reachable" }
      : { kind: "projects", projectIds: [...form.scope.projectIds] };
  return {
    memberId: form.memberId,
    name: form.name,
    // End of the chosen day, CLAMPED to the cap — picking the max offered date used to submit an
    // instant ~12h past the exact 365-day limit, which the action then refused.
    expiresAt: expiryInstantFor(form.expiry, now),
    scope,
  };
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
