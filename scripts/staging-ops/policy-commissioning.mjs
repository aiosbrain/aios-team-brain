#!/usr/bin/env node
/**
 * AIO-1124 — the bounded protected-policy commissioning runner.
 *
 * WHAT THIS IS FOR. `main-policy.mjs` builds the release rulesets and `verifyEffectiveMainPolicy`
 * evaluates them, but every existing test asserts a MODEL of GitHub's rules. Nothing has ever
 * measured what GitHub actually does when the normal App, the emergency App and a human admin each
 * push, force-push, delete and merge against that policy. This runner performs exactly one bounded,
 * manually dispatched, disposable experiment that measures it — and then deletes everything it made.
 *
 * WHAT IT IS NOT, AND CANNOT BECOME. It never promotes main, never mutates main/staging protection,
 * never cuts a tag, never deploys, and never accepts a release. It cannot be pointed at another
 * repository, ref, endpoint or ruleset: every target is DERIVED internally from the GitHub run ID
 * and attempt, and the request boundary independently enforces a verb+endpoint+body allowlist, so
 * routing a call through a helper cannot reach a target the guard would refuse.
 *
 * THE THREE ROLES, AND WHY THEY ARE SEPARATE (PC-02).
 *   local      the operator's existing `gh` identity. Administers disposable resources, runs the
 *              human/admin actor cases, and owns cleanup. Never uploaded into Actions.
 *   normal     a protected `staging-release` job holding only the normal App key.
 *   emergency  a protected `staging-emergency` job holding only the emergency App key.
 *   fixture    a credential-free job with `checks: write` only. It is the SECOND, independently
 *              measured producer identity (the GitHub Actions app) used to manufacture the
 *              wrong-producer control case. It holds no App secret; see {@link runFixtureChecks}.
 *
 * HOW THE CLOUD JOBS LEARN THE PLAN WITHOUT TRUSTING A CALLER (PC-03). The local setup phase
 * publishes a manifest commit at ONE fixed derived ref (`…-pr-head`) containing a non-executable
 * `COMMISSIONING.json` and a harmless marker — no workflow files, no secrets. Each protected job
 * derives that ref name itself from its own trusted run metadata, fetches it, and independently
 * verifies the COMPLETE synthetic commit graph (parents, trees, and that no file outside the two
 * allowed names exists) before believing any SHA in it. The manifest can therefore only ever be
 * CHECKED against internally derived values; it can never supply a target, an endpoint, a command
 * or a URL. This is the simplest handoff that needs no new credential: the local operator can
 * create a ref with the `gh` identity it already has, and a protected job can read it with the
 * metadata-scoped `GITHUB_TOKEN` it already gets. An Actions artifact would have been simpler still,
 * except that only the run itself can upload one, and the local operator is not in the run.
 *
 * WHAT AN HONEST RESULT LOOKS LIKE. A denial counts only when the provider REFUSED and the ref is
 * unchanged; a timeout, a 404, a rate limit and a generic credential failure are `inconclusive`,
 * never proof of enforcement. An acceptance counts only when an independent GET readback shows the
 * exact expected descendant. Every case carries a precondition that makes success distinguishable
 * from a no-op — a force flag on an actual fast-forward proves nothing, so the force cases request
 * a strict ANCESTOR or an unrelated commit. Incomplete measurement is its own verdict throughout.
 *
 * @see docs/RELEASING.md §5 for the operator sequence and docs/OPS.md §12 for the runbook.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { isDirectEntry as directEntry } from "./direct-entry.mjs";
import { buildMainRulesets, REQUIRED_MAIN_CONTEXTS, verifyEffectiveMainPolicy } from "./main-policy.mjs";
import { createInstallationToken } from "./release-controller.mjs";
import { acquireJournalLock, assertPrivateDirectory, openJournal, readJournal, writeJournalSnapshot } from "./commissioning-journal.mjs";

// ──────────────────────────────────────────────────────────────────────────────
// 1. Fixed targets. Nothing below is configurable, and nothing reads a target from input.
// ──────────────────────────────────────────────────────────────────────────────

export const COMMISSIONING_REPOSITORY = "aiosbrain/aios-team-brain";
export const COMMISSIONING_DISPATCH_REF = "refs/heads/staging";
export const COMMISSIONING_WORKFLOW_PATH = ".github/workflows/release-policy-commissioning.yml";
export const COMMISSIONING_EVENT_NAME = "workflow_dispatch";

/** The literal, non-negotiable prefix every disposable ref lives under. */
export const REF_PREFIX = "refs/heads/aios-policy-commissioning";

/** The CLOSED actor suffix enum. No wildcard, no traversal, no caller-supplied name. */
export const REF_SUFFIXES = Object.freeze(["normal", "emergency", "human", "pr-head"]);

export const PHASES = Object.freeze([
  "intent", "setup", "human-tests", "normal-tests", "emergency-tests", "collect", "cleanup", "check-evidence",
]);

/** The job name each cloud phase is only ever allowed to run under. */
export const PHASE_JOBS = Object.freeze({
  intent: "intent",
  "normal-tests": "normal",
  "emergency-tests": "emergency",
  fixture: "fixture",
});

/**
 * The two protected jobs, as the JOBS API reports them — and the state each may legally be in when
 * local setup runs (PC-03: "asserts expected protected jobs are waiting/unstarted").
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG, AND BOTH HAVE A GUARD.
 *
 *  1. `name` is the job's DISPLAY name, because that is the only name
 *     `/actions/runs/{id}/attempts/{n}/jobs` returns. Matching on the job *id* (`normal`) finds
 *     nothing, and "no job found" would read as a refusal rather than a bug.
 *     `test/guards/staging-policy-commissioning-workflow.test.ts` asserts these strings equal the
 *     workflow's `name:` values, so a rename is a red build rather than a silent never-match.
 *
 *  2. `atSetup` follows the workflow's REAL dependency graph, and the two jobs genuinely differ.
 *     GitHub does not create a job until its `needs:` are satisfied, so a job that does not exist
 *     yet is ABSENT from the jobs list — not "waiting". `emergency` needs only `intent`, which has
 *     finished by the time root has the intent artifact in hand, so it must be present and parked.
 *     `normal` needs `fixture`, and the fixture is itself waiting for THIS setup phase to publish
 *     the manifest — so at this instant `normal` has not been created. Requiring it to be `waiting`
 *     would deadlock the harness against its own ordering; treating a missing `emergency` as
 *     "unstarted" would throw away the one pre-approval observation we can actually make.
 */
export const PROTECTED_JOBS = Object.freeze([
  Object.freeze({ id: "normal", name: "Normal App actor tests (protected)", environment: "staging-release", atSetup: "parked-or-uncreated" }),
  Object.freeze({ id: "emergency", name: "Emergency App actor tests (protected)", environment: "staging-emergency", atSetup: "parked" }),
]);

/**
 * Job statuses that mean "created, and still waiting for a human". `queued`, `in_progress` and
 * `completed` all mean the environment gate has already been passed, which is the thing setup
 * exists to rule out — so they are deliberately NOT in this list.
 */
export const PARKED_JOB_STATUSES = Object.freeze(["waiting", "requested", "pending"]);

export const RESULT_SCHEMA_VERSION = 1;

/** Files a synthetic commit tree may contain. Anything else — above all a workflow — refuses. */
export const MARKER_PATH = "COMMISSIONING-MARKER.md";
export const MANIFEST_PATH = "COMMISSIONING.json";
export const ALLOWED_GRAPH_FILES = Object.freeze([MARKER_PATH]);
export const ALLOWED_MANIFEST_FILES = Object.freeze([MARKER_PATH, MANIFEST_PATH]);

const POSITIVE_DECIMAL = /^[1-9][0-9]{0,17}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

// ──────────────────────────────────────────────────────────────────────────────
// 2. Typed refusals. The CLI's exit code is a property of the error, not of a call site.
// ──────────────────────────────────────────────────────────────────────────────

/** Exit 2 — the invocation or configuration is wrong. Raised BEFORE any credential or request. */
export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; this.exitCode = 2; }
}
/** Exit 1 — something was measured and it is wrong. This is a statement about the subject. */
export class AssertionFailure extends Error {
  constructor(message, detail = null) { super(message); this.name = "AssertionFailure"; this.exitCode = 1; this.detail = detail; }
}
/** Exit 3 — we could not look, or a prerequisite is unavailable. NOT a statement about the subject. */
export class IncompleteEvidence extends Error {
  constructor(message, detail = null) { super(message); this.name = "IncompleteEvidence"; this.exitCode = 3; this.detail = detail; }
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Derived names. Every mutable target in the whole harness comes from here.
// ──────────────────────────────────────────────────────────────────────────────

export function assertRunIdentity(runId, attempt) {
  if (!POSITIVE_DECIMAL.test(String(runId ?? ""))) throw new UsageError("--run-id must be a positive decimal GitHub run ID");
  if (!POSITIVE_DECIMAL.test(String(attempt ?? ""))) throw new UsageError("--attempt must be a positive decimal run attempt");
  return { runId: String(runId), attempt: String(attempt) };
}

/** `refs/heads/aios-policy-commissioning/run-<runId>-<attempt>-<suffix>` and nothing else. */
export function derivedRef(runId, attempt, suffix) {
  assertRunIdentity(runId, attempt);
  if (!REF_SUFFIXES.includes(suffix)) throw new UsageError(`unknown commissioning ref suffix ${JSON.stringify(String(suffix))}`);
  return `${REF_PREFIX}/run-${runId}-${attempt}-${suffix}`;
}

export function derivedRefs(runId, attempt) {
  return Object.freeze(Object.fromEntries(REF_SUFFIXES.map((suffix) => [suffix, derivedRef(runId, attempt, suffix)])));
}

/** Branch name (no `refs/heads/`) — what the rules-for-branch endpoint and ruleset conditions use. */
export const branchOf = (ref) => ref.slice("refs/heads/".length);

export function derivedRulesetName(runId, attempt, actor, base) {
  assertRunIdentity(runId, attempt);
  if (!["normal", "emergency", "human"].includes(actor)) throw new UsageError(`unknown commissioning ruleset actor ${JSON.stringify(String(actor))}`);
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(String(base))) throw new UsageError("commissioning ruleset base name is not a production policy name");
  return `commissioning-${runId}-${attempt}-${actor}-${base}`;
}

/**
 * A TEST-ONLY status context, carrying run/attempt and the ORIGINAL context's ordinal.
 *
 * Deliberately never the real name. A check called `Brain unit tests (vitest)` published on a
 * synthetic commit by this harness would be indistinguishable, in every downstream query, from the
 * real lane's verdict on a real commit.
 */
export function derivedContextName(runId, attempt, ordinal) {
  assertRunIdentity(runId, attempt);
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= REQUIRED_MAIN_CONTEXTS.length) {
    throw new UsageError("commissioning context ordinal is outside the production required-context list");
  }
  return `TEST-ONLY commissioning ${runId}-${attempt} context ${ordinal}`;
}

export function derivedContextNames(runId, attempt) {
  return REQUIRED_MAIN_CONTEXTS.map((_, ordinal) => derivedContextName(runId, attempt, ordinal));
}

/**
 * The target guard. Refuses main, staging, tags, traversal, wildcards, encoded and double-encoded
 * spellings, and any ref that is not EXACTLY one this run derived.
 *
 * Encoding is checked before comparison because `refs/heads/ma%69n` and `%2e%2e` decode to targets
 * this list would otherwise never see. A ref that changes when decoded is refused outright rather
 * than normalised: there is no legitimate reason for one of our derived names to arrive encoded.
 */
export function assertDerivedRef(ref, { runId, attempt }) {
  const value = String(ref ?? "");
  if (!value) throw new UsageError("a commissioning target ref is required");
  if (value.length > 200) throw new UsageError("commissioning target ref is implausibly long");
  if (/[^A-Za-z0-9/_.-]/.test(value)) throw new UsageError("commissioning target ref contains characters outside the derived-name alphabet");
  let decoded = value;
  for (let round = 0; round < 3; round += 1) {
    let next;
    try { next = decodeURIComponent(decoded); } catch { throw new UsageError("commissioning target ref is not decodable"); }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded !== value) throw new UsageError("commissioning target ref is percent-encoded; only the exact derived spelling is accepted");
  if (value.includes("..") || value.includes("*") || value.includes("//")) throw new UsageError("commissioning target ref contains traversal or wildcard syntax");
  if (value === "refs/heads/main" || value === "refs/heads/staging" || value.startsWith("refs/tags/")) {
    throw new UsageError(`commissioning refuses to target ${value}`);
  }
  const allowed = Object.values(derivedRefs(runId, attempt));
  if (!allowed.includes(value)) throw new UsageError("commissioning target ref is not one this run derived");
  return value;
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. The request boundary. An INDEPENDENT verb + endpoint + body allowlist.
//
// This is deliberately not "the target guard, applied again". The target guard answers "is this ref
// ours?"; this answers "is this request one of the fixed operations this role is allowed to make at
// all?". Routing a call through a helper can bypass a caller-side check; it cannot bypass this,
// because every transport applies it to the literal method, path and body it is about to send.
// ──────────────────────────────────────────────────────────────────────────────

const REPO = COMMISSIONING_REPOSITORY;
const ORG = COMMISSIONING_REPOSITORY.split("/")[0];
const ALLOWED_QUERY_KEYS = new Set(["per_page", "page"]);

/**
 * Escape a fixed identifier for LITERAL use inside a pattern. `aiosbrain/aios-team-brain` happens to
 * contain no regex metacharacter today, so this changes nothing now — which is the point: it makes
 * the guard's correctness independent of that accident. A repository or organisation whose name
 * contained a `.` would otherwise widen every pattern below into a single-character wildcard.
 */
const literal = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const R = literal(REPO);
const O = literal(ORG);

/**
 * The CLOSED set of API scopes any commissioning operation may live under. Exported so the guard
 * suite can assert it BEHAVIOURALLY — that no spelling in {@link ALLOWED_OPERATIONS} can match a
 * path outside these four — rather than by eyeballing the table.
 */
export const ALLOWED_REQUEST_SCOPES = Object.freeze([`/repos/${REPO}`, `/orgs/${ORG}`, "/user", "/installation"]);

const isSha = (value) => FULL_SHA.test(String(value ?? ""));
const knownSha = (value, ctx) => isSha(value) && ctx.graphShas?.has(String(value));

function noBody(body) {
  if (body !== undefined && body !== null) throw new UsageError("this commissioning endpoint takes no request body");
  return true;
}

/**
 * The CLOSED operation list. `id` is what appears in evidence; `roles` is which execution role may
 * issue it; `body` is a validator, not a serializer — it refuses rather than repairs.
 *
 * NOTE THE ABSENCE OF `intent`. The intent phase holds no credential and makes NO request (PC-03),
 * so it appears in no row here: the request boundary refuses everything it could attempt, and the
 * provider re-measurement of what it asserted happens in the authenticated phases that follow.
 */
export const ALLOWED_OPERATIONS = Object.freeze([
  // ── metadata and identity reads ─────────────────────────────────────────────
  { id: "read-repository", method: "GET", roles: ["local", "normal", "emergency", "fixture"], path: `/repos/${REPO}`, body: noBody },
  { id: "read-viewer", method: "GET", roles: ["local"], path: "/user", body: noBody },
  { id: "read-collaborator-permission", method: "GET", roles: ["local"], pattern: new RegExp(`^/repos/${R}/collaborators/[A-Za-z0-9-]{1,39}/permission$`), body: noBody },
  { id: "read-installation-repositories", method: "GET", roles: ["normal", "emergency"], path: "/installation/repositories", body: noBody },
  // ATTEMPT-scoped, and there is deliberately no run-scoped counterpart: `/actions/runs/<id>`
  // describes the LATEST attempt, so reading it would silently describe a rerun rather than the
  // attempt whose derived resources this run owns.
  { id: "read-workflow-run-attempt", method: "GET", roles: ["local"], pattern: new RegExp(`^/repos/${R}/actions/runs/[1-9][0-9]{0,17}/attempts/[1-9][0-9]{0,17}$`), body: noBody },
  { id: "read-workflow-run-jobs", method: "GET", roles: ["local"], pattern: new RegExp(`^/repos/${R}/actions/runs/[1-9][0-9]{0,17}/attempts/[1-9][0-9]{0,17}/jobs$`), body: noBody },
  { id: "read-workflow-run-approvals", method: "GET", roles: ["local"], pattern: new RegExp(`^/repos/${R}/actions/runs/[1-9][0-9]{0,17}/approvals$`), body: noBody },

  // ── baseline reads. Production refs and protections are READ here and never written. ─────────
  { id: "read-main-ref", method: "GET", roles: ["local"], path: `/repos/${REPO}/git/ref/heads/main`, body: noBody },
  { id: "read-staging-ref", method: "GET", roles: ["local"], path: `/repos/${REPO}/git/ref/heads/staging`, body: noBody },
  { id: "read-main-protection", method: "GET", roles: ["local"], path: `/repos/${REPO}/branches/main/protection`, body: noBody },
  { id: "read-main-applicable-rules", method: "GET", roles: ["local"], path: `/repos/${REPO}/rules/branches/main`, body: noBody },
  { id: "list-repository-rulesets", method: "GET", roles: ["local"], path: `/repos/${REPO}/rulesets`, body: noBody },

  // ── the disposable subject ──────────────────────────────────────────────────
  {
    id: "read-derived-ref", method: "GET", roles: ["local", "normal", "emergency", "fixture"],
    pattern: new RegExp(`^/repos/${R}/git/ref/heads/(.+)$`),
    check: (match, ctx) => assertDerivedRef(`refs/heads/${match[1]}`, ctx), body: noBody,
  },
  {
    id: "read-derived-branch-rules", method: "GET", roles: ["local", "normal", "emergency"],
    pattern: new RegExp(`^/repos/${R}/rules/branches/(.+)$`),
    check: (match, ctx) => assertDerivedRef(`refs/heads/${decodeURIComponent(match[1])}`, ctx), body: noBody,
  },
  {
    id: "read-derived-branch-protection", method: "GET", roles: ["local"],
    pattern: new RegExp(`^/repos/${R}/branches/(.+)/protection$`),
    check: (match, ctx) => assertDerivedRef(`refs/heads/${match[1]}`, ctx), body: noBody,
  },
  { id: "read-repository-ruleset", method: "GET", roles: ["local", "normal", "emergency"], pattern: new RegExp(`^/repos/${R}/rulesets/[1-9][0-9]{0,17}$`), body: noBody },
  { id: "read-organization-ruleset", method: "GET", roles: ["local", "normal", "emergency"], pattern: new RegExp(`^/orgs/${O}/rulesets/[1-9][0-9]{0,17}$`), body: noBody },
  {
    id: "read-synthetic-commit", method: "GET", roles: ["local", "normal", "emergency", "fixture"],
    pattern: new RegExp(`^/repos/${R}/git/commits/([0-9a-f]{40})$`), body: noBody,
  },
  {
    id: "read-synthetic-tree", method: "GET", roles: ["local", "normal", "emergency", "fixture"],
    pattern: new RegExp(`^/repos/${R}/git/trees/([0-9a-f]{40})$`), body: noBody,
  },
  {
    id: "read-synthetic-blob-contents", method: "GET", roles: ["local", "normal", "emergency", "fixture"],
    pattern: new RegExp(`^/repos/${R}/git/blobs/([0-9a-f]{40})$`), body: noBody,
  },
  {
    id: "read-synthetic-check-runs", method: "GET", roles: ["local", "normal", "emergency"],
    pattern: new RegExp(`^/repos/${R}/commits/([0-9a-f]{40})/check-runs$`),
    check: (match, ctx) => { if (!knownSha(match[1], ctx)) throw new UsageError("check runs may only be read for a verified synthetic commit"); }, body: noBody,
  },
  { id: "read-pull-request", method: "GET", roles: ["local"], pattern: new RegExp(`^/repos/${R}/pulls/[1-9][0-9]{0,9}$`), body: noBody },

  // ── local-operator writes: create the disposable graph, then the disposable rulesets ─────────
  {
    id: "create-tree", method: "POST", roles: ["local"], path: `/repos/${REPO}/git/trees`,
    body: (body) => {
      const entries = Array.isArray(body?.tree) ? body.tree : null;
      if (!entries?.length) throw new UsageError("a synthetic tree must declare its entries");
      for (const entry of entries) {
        if (!ALLOWED_MANIFEST_FILES.includes(entry?.path)) throw new UsageError(`a synthetic tree may not contain ${JSON.stringify(String(entry?.path))}`);
        if (entry.mode !== "100644" || entry.type !== "blob") throw new UsageError("a synthetic tree entry must be a plain non-executable blob");
        if (typeof entry.content !== "string") throw new UsageError("a synthetic tree entry must carry inline content");
      }
      if (body.base_tree !== undefined) throw new UsageError("a synthetic tree is built from nothing; it never extends a repository tree");
      return true;
    },
  },
  {
    id: "create-commit", method: "POST", roles: ["local"], path: `/repos/${REPO}/git/commits`,
    body: (body, ctx) => {
      if (!isSha(body?.tree)) throw new UsageError("a synthetic commit needs its measured tree SHA");
      if (typeof body?.message !== "string" || !body.message.startsWith("AIO-1124 synthetic commissioning")) {
        throw new UsageError("a synthetic commit must label itself as AIO-1124 synthetic commissioning");
      }
      for (const parent of body?.parents ?? []) {
        if (!knownSha(parent, ctx)) throw new UsageError("a synthetic commit may only descend from a commit this run created");
      }
      return true;
    },
  },
  {
    id: "create-derived-ref", method: "POST", roles: ["local"], path: `/repos/${REPO}/git/refs`,
    body: (body, ctx) => {
      assertDerivedRef(body?.ref, ctx);
      if (!knownSha(body?.sha, ctx)) throw new UsageError("a derived ref may only be created at a commit this run created");
      return true;
    },
  },
  {
    id: "create-disposable-ruleset", method: "POST", roles: ["local"], path: `/repos/${REPO}/rulesets`,
    body: (body, ctx) => {
      if (!ctx.rulesetNames?.has(String(body?.name))) throw new UsageError("a disposable ruleset must carry a name this run derived");
      const include = body?.conditions?.ref_name?.include;
      if (!Array.isArray(include) || include.length !== 1) throw new UsageError("a disposable ruleset targets exactly one derived ref");
      assertDerivedRef(include[0], ctx);
      if (body?.enforcement !== "active") throw new UsageError("a disposable ruleset must be active; an evaluate-mode ruleset measures nothing");
      return true;
    },
  },
  {
    id: "delete-disposable-ruleset", method: "DELETE", roles: ["local"],
    pattern: new RegExp(`^/repos/${R}/rulesets/([1-9][0-9]{0,17})$`),
    check: (match, ctx) => {
      if (!ctx.rulesetIds?.has(Number(match[1]))) throw new UsageError("cleanup may only delete a ruleset ID this run journaled");
    }, body: noBody,
  },

  // ── the actor matrix itself. Three roles, the same two verbs, always a derived ref. ─────────
  {
    id: "update-derived-ref", method: "PATCH", roles: ["local", "normal", "emergency"],
    pattern: new RegExp(`^/repos/${R}/git/refs/heads/(.+)$`),
    check: (match, ctx) => assertDerivedRef(`refs/heads/${match[1]}`, ctx),
    body: (body, ctx) => {
      if (!knownSha(body?.sha, ctx)) throw new UsageError("a derived ref may only be moved to a commit this run created");
      if (typeof body?.force !== "boolean") throw new UsageError("a derived ref update must state its force flag explicitly");
      return true;
    },
  },
  {
    id: "delete-derived-ref", method: "DELETE", roles: ["local", "normal", "emergency"],
    pattern: new RegExp(`^/repos/${R}/git/refs/heads/(.+)$`),
    check: (match, ctx) => assertDerivedRef(`refs/heads/${match[1]}`, ctx), body: noBody,
  },
  {
    id: "publish-test-only-check", method: "POST", roles: ["normal", "fixture"], path: `/repos/${REPO}/check-runs`,
    body: (body, ctx) => {
      if (!ctx.contextNames?.has(String(body?.name))) throw new UsageError("only a TEST-ONLY context this run derived may be published");
      if (!knownSha(body?.head_sha, ctx)) throw new UsageError("a TEST-ONLY check may only be attached to a verified synthetic commit");
      if (!["success", "failure"].includes(String(body?.conclusion))) throw new UsageError("a TEST-ONLY check must conclude success or failure");
      return true;
    },
  },

  // ── the one synthetic pull request, between two derived refs ────────────────
  {
    id: "create-synthetic-pull", method: "POST", roles: ["local"], path: `/repos/${REPO}/pulls`,
    body: (body, ctx) => {
      assertDerivedRef(`refs/heads/${String(body?.base)}`, ctx);
      assertDerivedRef(`refs/heads/${String(body?.head)}`, ctx);
      if (body.base === body.head) throw new UsageError("the synthetic pull request needs a distinct base and head");
      if (!String(body?.title ?? "").startsWith("AIO-1124 synthetic commissioning")) throw new UsageError("the synthetic pull request must label itself as AIO-1124 synthetic commissioning");
      // A work-sync trailer here would file this disposable experiment against a real task.
      if (/AIOS-Work:/i.test(`${body?.title ?? ""}\n${body?.body ?? ""}`)) throw new UsageError("the synthetic pull request must not carry an AIOS work-sync trailer");
      return true;
    },
  },
  {
    id: "merge-synthetic-pull", method: "PUT", roles: ["local"],
    pattern: new RegExp(`^/repos/${R}/pulls/([1-9][0-9]{0,9})/merge$`),
    check: (match, ctx) => { if (Number(match[1]) !== ctx.pullNumber) throw new UsageError("only this run's own synthetic pull request may be merged against"); },
    body: (body) => { if (body !== undefined && Object.keys(body ?? {}).length > 1) throw new UsageError("the synthetic merge attempt takes no extra parameters"); return true; },
  },
  {
    id: "close-synthetic-pull", method: "PATCH", roles: ["local"],
    pattern: new RegExp(`^/repos/${R}/pulls/([1-9][0-9]{0,9})$`),
    check: (match, ctx) => { if (Number(match[1]) !== ctx.pullNumber) throw new UsageError("only this run's own synthetic pull request may be closed"); },
    body: (body) => { if (body?.state !== "closed" || Object.keys(body).length !== 1) throw new UsageError("the synthetic pull request may only be closed"); return true; },
  },
]);

/**
 * Refuse before the network. Returns the matched operation ID, which is what evidence records —
 * never a raw path, so evidence cannot become a place to read targets back out of.
 */
export function assertAllowedRequest({ method, path: requestPath, body }, ctx) {
  const verb = String(method ?? "").toUpperCase();
  const raw = String(requestPath ?? "");
  if (!ctx?.role) throw new UsageError("every commissioning request must declare its execution role");
  if (!raw.startsWith("/")) throw new UsageError("a commissioning request path must be a repository-relative API path");
  if (/^https?:/i.test(raw) || raw.startsWith("//")) throw new UsageError("commissioning refuses an absolute or protocol-relative request target");
  const [pathname, query = ""] = raw.split("?");
  if (pathname.includes("..")) throw new UsageError("commissioning refuses a traversal in a request path");
  for (const pair of query ? query.split("&") : []) {
    const key = pair.split("=")[0];
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new UsageError(`commissioning refuses the query parameter ${JSON.stringify(key)}`);
  }
  for (const operation of ALLOWED_OPERATIONS) {
    if (operation.method !== verb) continue;
    const match = operation.path ? (operation.path === pathname ? [pathname] : null) : operation.pattern.exec(pathname);
    if (!match) continue;
    if (!operation.roles.includes(ctx.role)) {
      throw new UsageError(`the ${ctx.role} role may not issue ${operation.id}`);
    }
    operation.check?.(match, ctx);
    operation.body(body, ctx);
    return operation.id;
  }
  throw new UsageError(`commissioning refuses ${verb} on an endpoint outside its allowlist`);
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. Redaction and provider diagnostics.
//
// Everything this harness emits is destined for an artifact a human attaches to a ticket. Two rules
// govern it: no credential value may survive any failure path (a subprocess writes whatever it
// likes to stderr, and a provider error body is written by the provider), and no diagnostic text is
// echoed unless it matched a CLOSED allowlist of provider messages. An unrecognised diagnostic
// collapses to its category — never to a fabricated cause.
// ──────────────────────────────────────────────────────────────────────────────

const SENTINEL_ENV = /(TOKEN|SECRET|PRIVATE_KEY|PASSWORD|CREDENTIAL)/i;

export function collectSentinels(env = process.env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!SENTINEL_ENV.test(name)) continue;
    const text = String(value ?? "");
    // A short value would mask innocuous substrings everywhere; real key material is long.
    if (text.length >= 8) values.add(text);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function createRedactor(sentinels = []) {
  return (input) => {
    let out = String(input ?? "");
    for (const sentinel of sentinels) {
      if (sentinel) out = out.split(sentinel).join("[redacted-commissioning-secret]");
    }
    out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
    out = out.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted-token]");
    out = out.replace(/(authorization:\s*(?:bearer|token)\s+)\S+/gi, "$1[redacted]");
    out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]");
    return out;
  };
}

/**
 * The CLOSED provider-diagnostic allowlist.
 *
 * `policyDenial: true` means the message is evidence that a RULE refused the operation.
 * `policyDenial: false` means the request failed for a reason that says nothing about the policy —
 * a bad credential, a missing permission, a rate limit. Collapsing the second into the first is the
 * single easiest way to manufacture a passing enforcement result out of a broken token.
 */
export const DIAGNOSTIC_PATTERNS = Object.freeze([
  { id: "repository-rule-violation", policyDenial: true, pattern: /repository rule violations found/i },
  { id: "protected-ref-update-restricted", policyDenial: true, pattern: /cannot (?:update|force-push to|delete) this protected ref/i },
  { id: "required-status-check-missing", policyDenial: true, pattern: /required status check/i },
  { id: "pull-request-required", policyDenial: true, pattern: /changes must be made through a pull request/i },
  { id: "non-fast-forward-rejected", policyDenial: true, pattern: /(?:not a fast forward|non-fast-forward)/i },
  { id: "review-required", policyDenial: true, pattern: /at least \d+ approving review/i },
  { id: "credential-failure", policyDenial: false, pattern: /bad credentials|requires authentication/i },
  { id: "permission-failure", policyDenial: false, pattern: /resource not accessible by (?:integration|personal access token)/i },
  { id: "rate-limited", policyDenial: false, pattern: /rate limit|secondary rate/i },
  { id: "not-found", policyDenial: false, pattern: /^not found$/i },
]);

/**
 * @returns {{status:number, category:string, ruleIds:string[], policyDenial:boolean}} identifiers
 *   only. The provider's message text never leaves this function.
 */
export function classifyDiagnostic(status, text) {
  const value = String(text ?? "");
  const matched = DIAGNOSTIC_PATTERNS.filter((entry) => entry.pattern.test(value));
  if (!matched.length) return { status, category: "unclassified", ruleIds: [], policyDenial: false };
  return {
    status,
    category: matched[0].id,
    ruleIds: matched.map((entry) => entry.id),
    policyDenial: matched.some((entry) => entry.policyDenial),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. Transports. Two of them, one shape: `(method, path, body) → {status, body, diagnostic}`.
//    Neither ever throws for an HTTP status — a refusal IS the measurement.
// ──────────────────────────────────────────────────────────────────────────────

const MAX_TRANSPORT_BYTES = 1024 * 1024;

/**
 * One bounded `gh api` invocation with the request body on PRIVATE STDIN.
 *
 * The body never becomes an argv word: argv is world-readable in the process table, and this is the
 * process that also holds the operator's administrative credential. `-i` is what makes the HTTP
 * status recoverable — `gh` exits non-zero on a 4xx and the status is otherwise unobservable, which
 * would leave every denial looking like a tool failure.
 */
export async function runGhProcess(args, { input, timeoutMs = 20_000, spawnImpl = spawn, env = process.env } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new UsageError("a gh request deadline must be 1..120000ms");
  const child = spawnImpl("gh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let terminated = null;
  const collect = (target) => (chunk) => {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_TRANSPORT_BYTES) { terminated = "output exceeded the commissioning transport maximum"; child.kill("SIGKILL"); return; }
    target.push(value);
  };
  child.stdout?.on("data", collect(stdout));
  child.stderr?.on("data", collect(stderr));
  const timer = setTimeout(() => { terminated = `gh request exceeded ${timeoutMs}ms`; child.kill("SIGKILL"); }, timeoutMs);
  timer.unref?.();
  child.stdin?.on("error", () => {});
  if (input !== undefined) child.stdin?.end(input);
  else child.stdin?.end();
  const outcome = await new Promise((resolve) => {
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; if (!child.pid) resolve({ spawnError, code: null }); });
    child.once("close", (code) => resolve({ spawnError, code }));
  });
  clearTimeout(timer);
  return {
    code: outcome.code,
    spawnError: outcome.spawnError ?? null,
    terminated,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

/** `HTTP/2 403 Forbidden` … blank line … body. Absent status line ⇒ a transport failure, not a 0. */
export function parseGhResponse({ stdout }) {
  const crlf = stdout.indexOf("\r\n\r\n");
  const lf = stdout.indexOf("\n\n");
  let index = -1;
  let width = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) { index = crlf; width = 4; }
  else if (lf >= 0) { index = lf; width = 2; }
  const head = index >= 0 ? stdout.slice(0, index) : stdout;
  const rest = index >= 0 ? stdout.slice(index + width) : "";
  const status = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(head)?.[1];
  // No status line means `gh` never got as far as an HTTP response. `null`, not 0 — the caller
  // turns that into a transport failure, which is a different thing from a provider refusal.
  return { status: status ? Number(status) : null, text: rest };
}

export function createLocalGhTransport({ spawnImpl = spawn, timeoutMs = 20_000, redact = createRedactor(), env = process.env } = {}) {
  return async (method, requestPath, body) => {
    const args = ["api", "-i", "--method", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", requestPath];
    if (body !== undefined && body !== null) args.push("--input", "-");
    const run = await runGhProcess(args, { input: body === undefined || body === null ? undefined : JSON.stringify(body), timeoutMs, spawnImpl, env });
    if (run.terminated) return { status: 0, body: null, diagnostic: { status: 0, category: "transport-timeout", ruleIds: [], policyDenial: false } };
    if (run.spawnError) return { status: 0, body: null, diagnostic: { status: 0, category: "transport-unavailable", ruleIds: [], policyDenial: false } };
    const { status, text } = parseGhResponse(run);
    if (status === null) {
      // Never conflate "gh could not run" with "the provider refused". Both are exit-nonzero for
      // gh; only one is a statement about the policy. The captured output is redacted and dropped.
      redact(run.stderr);
      return { status: 0, body: null, diagnostic: { status: 0, category: "transport-unavailable", ruleIds: [], policyDenial: false } };
    }
    let parsed = null;
    try { parsed = text.trim() ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status, body: status >= 400 ? null : parsed, diagnostic: classifyDiagnostic(status, redact(text)) };
  };
}

export function createTokenTransport({ token, fetchImpl = fetch, timeoutMs = 15_000, baseUrl = "https://api.github.com", redact = createRedactor() }) {
  if (!token) throw new UsageError("a commissioning API transport requires a token");
  return async (method, requestPath, body) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${requestPath}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined || body === null ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return { status: 0, body: null, diagnostic: { status: 0, category: timedOut ? "transport-timeout" : "transport-unavailable", ruleIds: [], policyDenial: false } };
    }
    const text = await response.text().catch(() => "");
    let parsed = null;
    try { parsed = text.trim() ? JSON.parse(text) : null; } catch { parsed = null; }
    return {
      status: response.status,
      body: response.ok ? parsed : null,
      diagnostic: classifyDiagnostic(response.status, redact(text)),
    };
  };
}

/**
 * Bind a transport to one execution role and one run's derived targets. Every request in the whole
 * harness goes through this; there is no unguarded path to either transport.
 */
export function createGuardedRequest(transport, ctx) {
  if (!ctx?.role || !ctx?.runId || !ctx?.attempt) throw new UsageError("a guarded commissioning request needs its role and run identity");
  const issued = [];
  const request = async (method, requestPath, body) => {
    const operation = assertAllowedRequest({ method, path: requestPath, body }, ctx);
    const result = await transport(method, requestPath, body);
    issued.push(operation);
    return { ...result, operation };
  };
  request.issued = issued;
  request.context = ctx;
  return request;
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. Run context. Everything the harness believes about WHERE it is running is asserted here,
//    from the platform's own variables, before a credential is touched.
// ──────────────────────────────────────────────────────────────────────────────

const positiveInt = (value, label) => {
  if (!POSITIVE_DECIMAL.test(String(value ?? ""))) throw new UsageError(`${label} must be a positive decimal identifier`);
  return Number(value);
};

/**
 * Validate the immutable dispatch identity. `GITHUB_WORKFLOW_REF` is the load-bearing one: it names
 * the workflow FILE and the ref it was dispatched from, so a job in some other workflow that
 * happened to be handed these variables cannot pass. `GITHUB_SHA` is the immutable tree the job
 * checked out — never a moving ref, never a supplied candidate.
 */
export function assertRunContext(env, { runId, attempt, role }) {
  assertRunIdentity(runId, attempt);
  const need = (name) => {
    const value = String(env?.[name] ?? "").trim();
    if (!value) throw new UsageError(`${name} is required for commissioning role ${role}`);
    return value;
  };
  if (need("GITHUB_REPOSITORY") !== COMMISSIONING_REPOSITORY) throw new UsageError(`commissioning runs only in ${COMMISSIONING_REPOSITORY}`);
  if (need("GITHUB_EVENT_NAME") !== COMMISSIONING_EVENT_NAME) throw new UsageError("commissioning runs only from workflow_dispatch");
  if (need("GITHUB_REF") !== COMMISSIONING_DISPATCH_REF) throw new UsageError(`commissioning dispatches only from ${COMMISSIONING_DISPATCH_REF}`);
  const workflowSha = need("GITHUB_SHA");
  if (!FULL_SHA.test(workflowSha)) throw new UsageError("GITHUB_SHA must be the immutable full dispatch commit SHA");
  const expectedWorkflowRef = `${COMMISSIONING_REPOSITORY}/${COMMISSIONING_WORKFLOW_PATH}@${COMMISSIONING_DISPATCH_REF}`;
  if (need("GITHUB_WORKFLOW_REF") !== expectedWorkflowRef) throw new UsageError("GITHUB_WORKFLOW_REF is not the reviewed commissioning workflow at the fixed dispatch ref");
  if (need("GITHUB_RUN_ID") !== String(runId)) throw new UsageError("GITHUB_RUN_ID does not match the run this phase was invoked for");
  if (need("GITHUB_RUN_ATTEMPT") !== String(attempt)) throw new UsageError("GITHUB_RUN_ATTEMPT does not match the attempt this phase was invoked for");
  const expectedJob = PHASE_JOBS[role === "fixture" ? "fixture" : role];
  if (expectedJob && need("GITHUB_JOB") !== expectedJob) throw new UsageError(`this phase runs only in the ${expectedJob} job`);
  const repositoryId = positiveInt(env?.COMMISSIONING_REPOSITORY_ID, "COMMISSIONING_REPOSITORY_ID");
  // `GITHUB_REPOSITORY_ID` is injected by the platform and is not settable by a workflow author, so
  // it is the one identity fact a CREDENTIAL-FREE job can cross-check without a provider call — the
  // whole reason the intent phase can assert the fixed repository at all. A repository renamed or
  // transferred under the same full name would disagree here, before anything is created.
  if (positiveInt(env?.GITHUB_REPOSITORY_ID, "GITHUB_REPOSITORY_ID") !== repositoryId) {
    throw new UsageError("GITHUB_REPOSITORY_ID does not match COMMISSIONING_REPOSITORY_ID; this is not the repository this run is configured for");
  }
  const normalAppId = positiveInt(env?.COMMISSIONING_NORMAL_APP_ID, "COMMISSIONING_NORMAL_APP_ID");
  const emergencyAppId = positiveInt(env?.COMMISSIONING_EMERGENCY_APP_ID, "COMMISSIONING_EMERGENCY_APP_ID");
  if (normalAppId === emergencyAppId) throw new UsageError("the normal and emergency Apps must be distinct numeric identities");
  return Object.freeze({
    runId: String(runId), attempt: String(attempt), role, workflowSha, repositoryId, normalAppId, emergencyAppId,
    actor: String(env?.GITHUB_ACTOR ?? "").trim() || null,
    producerIds: parseProducerIds(env?.COMMISSIONING_PRODUCER_IDS_JSON),
  });
}

/**
 * The twelve REAL production producers, complete or not at all.
 *
 * A partial map cannot produce a production-shape subject: `buildMainRulesets` would throw, and
 * inventing the missing IDs would make the whole comparison a statement about numbers we made up.
 */
export function parseProducerIds(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw ?? "")); } catch { throw new UsageError("COMMISSIONING_PRODUCER_IDS_JSON must be a JSON object of context → producer integration ID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("COMMISSIONING_PRODUCER_IDS_JSON must be a JSON object");
  const keys = Object.keys(parsed);
  const missing = REQUIRED_MAIN_CONTEXTS.filter((context) => !Number.isInteger(Number(parsed[context])) || Number(parsed[context]) <= 0);
  const unknown = keys.filter((key) => !REQUIRED_MAIN_CONTEXTS.includes(key));
  if (missing.length) throw new IncompleteEvidence(`the production producer map is incomplete (${missing.length} of ${REQUIRED_MAIN_CONTEXTS.length} contexts); commissioning refuses to invent producer IDs`, { missing });
  if (unknown.length) throw new UsageError("the production producer map names a context outside the required list");
  return Object.freeze(Object.fromEntries(REQUIRED_MAIN_CONTEXTS.map((context) => [context, Number(parsed[context])])));
}

// ──────────────────────────────────────────────────────────────────────────────
// 8. The synthetic commit graph and the manifest that carries it to the protected jobs.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The graph, with EXPLICIT parent relationships, chosen so that every live case has a precondition
 * that makes success distinguishable from a no-op:
 *
 *   A ── B ── C                 A is the base the App refs start at; C is where the HUMAN ref starts,
 *   │         ├── H1 H2 P       already advanced, so a human rewind to B is a genuine rewind rather
 *   ├── N1 N2 N3 N4 E1          than a force flag on a fast-forward.
 *   D (unrelated, no parent)    D is divergent from everything, so a force to D can only be a
 *                               divergent update.
 *
 * N1..N4/H1..H2 are SEPARATE descendants rather than a chain because check state is per-commit:
 * running the green case on the same commit as the missing-check case would let the first case's
 * checks satisfy the second, and every denial after it would be unfalsifiable.
 */
export function buildGraphPlan(runId, attempt) {
  assertRunIdentity(runId, attempt);
  const node = (key, parents, purpose) => ({ key, parents, purpose });
  return Object.freeze([
    node("A", [], "base"),
    node("B", ["A"], "intermediate descendant"),
    node("C", ["B"], "advanced human base"),
    node("D", [], "unrelated divergent commit"),
    node("N1", ["A"], "normal actor: a required check is absent"),
    node("N2", ["A"], "normal actor: a required check completed as failure"),
    node("N3", ["A"], "normal actor: every required check is green from the WRONG producer"),
    node("N4", ["A"], "normal actor: every required check is green from the expected producer"),
    node("E1", ["A"], "emergency actor: no checks at all"),
    node("H1", ["C"], "human actor: a required check is absent"),
    node("H2", ["C"], "human actor: every required check is green"),
    node("P", ["C"], "manifest and synthetic pull-request head"),
  ]);
}

export const graphNodeContent = (runId, attempt, node) =>
  `# AIO-1124 synthetic commissioning\n\nDisposable marker for run ${runId} attempt ${attempt}, node ${node.key}.\nPurpose: ${node.purpose}.\nThis file is inert. It is deleted with the rest of the run.\n`;

/** Stable, key-sorted JSON. Used for every hash so an ordering difference is never a content one. */
export function canonicalJson(value) {
  const walk = (input) => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, walk(input[key])]));
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

export const canonicalHash = (value) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/**
 * The plan the protected jobs verify against. It carries IDENTITIES and HASHES only: no endpoint,
 * no command, no URL, no credential, and no target a job does not derive for itself.
 */
export function buildManifest({ runId, attempt, workflowSha, repositoryId, normalAppId, emergencyAppId, graphShas, contextNames, rulesetPlan, productionPolicyHash }) {
  const plan = buildGraphPlan(runId, attempt);
  for (const node of plan) {
    if (node.key === "P") continue;
    if (!FULL_SHA.test(String(graphShas?.[node.key] ?? ""))) throw new AssertionFailure(`the synthetic graph is missing measured node ${node.key}`);
  }
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    issue: "AIO-1124",
    repository: COMMISSIONING_REPOSITORY,
    repository_id: repositoryId,
    run_id: String(runId),
    attempt: String(attempt),
    workflow_path: COMMISSIONING_WORKFLOW_PATH,
    workflow_sha: workflowSha,
    normal_app_id: normalAppId,
    emergency_app_id: emergencyAppId,
    // `P` is deliberately absent: a commit cannot contain its own SHA. Jobs derive its REF and read
    // the object at it, which is the same binding by a different route.
    graph: Object.fromEntries(plan.filter((n) => n.key !== "P").map((n) => [n.key, { sha: graphShas[n.key], parents: n.parents, purpose: n.purpose }])),
    refs: derivedRefs(runId, attempt),
    test_contexts: contextNames,
    policy_plan: rulesetPlan,
    production_policy_hash: productionPolicyHash,
  };
}

/**
 * Independently verify the complete synthetic graph from the provider, before believing any SHA in
 * a manifest. Checks EVERY node: that the object exists, that its parents are exactly the planned
 * ones, and that its tree contains only the allowed inert files — above all, no workflow.
 */
export async function verifySyntheticGraph({ request, manifest, runId, attempt }) {
  const plan = buildGraphPlan(runId, attempt);
  const verified = {};
  for (const node of plan) {
    if (node.key === "P") continue;
    const sha = String(manifest?.graph?.[node.key]?.sha ?? "");
    if (!FULL_SHA.test(sha)) throw new IncompleteEvidence(`the manifest does not carry a full SHA for synthetic node ${node.key}`);
    const commit = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/commits/${sha}`);
    if (commit.status !== 200 || !commit.body) throw new IncompleteEvidence(`synthetic node ${node.key} could not be read from the provider`);
    const expectedParents = node.parents.map((key) => String(manifest.graph[key]?.sha ?? ""));
    const actualParents = (commit.body.parents ?? []).map((parent) => String(parent?.sha ?? ""));
    if (canonicalJson(actualParents) !== canonicalJson(expectedParents)) {
      throw new AssertionFailure(`synthetic node ${node.key} does not have the parent relationship the plan declares`);
    }
    if (!String(commit.body.message ?? "").startsWith("AIO-1124 synthetic commissioning")) {
      throw new AssertionFailure(`synthetic node ${node.key} is not an AIO-1124 synthetic commissioning commit`);
    }
    await assertInertTree({ request, treeSha: String(commit.body.tree?.sha ?? ""), allowed: ALLOWED_GRAPH_FILES, label: node.key });
    verified[node.key] = sha;
  }
  return verified;
}

/** A tree is inert when it is flat and every entry is a plain blob from the allowed name list. */
export async function assertInertTree({ request, treeSha, allowed, label }) {
  if (!FULL_SHA.test(treeSha)) throw new IncompleteEvidence(`synthetic node ${label} carries no readable tree`);
  const tree = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/trees/${treeSha}`);
  if (tree.status !== 200 || !tree.body) throw new IncompleteEvidence(`the tree of synthetic node ${label} could not be read`);
  if (tree.body.truncated === true) throw new IncompleteEvidence(`the tree of synthetic node ${label} was truncated; its contents are unmeasured`);
  const entries = tree.body.tree ?? [];
  for (const entry of entries) {
    if (entry?.type !== "blob" || entry?.mode !== "100644") throw new AssertionFailure(`synthetic node ${label} contains a non-plain entry`);
    if (!allowed.includes(entry.path)) throw new AssertionFailure(`synthetic node ${label} contains the unexpected file ${JSON.stringify(String(entry.path))}`);
  }
  const paths = entries.map((entry) => entry.path).sort();
  if (canonicalJson(paths) !== canonicalJson([...allowed].sort())) {
    throw new AssertionFailure(`synthetic node ${label} does not contain exactly the allowed inert files`);
  }
  return paths;
}

/**
 * Fetch the manifest from the fixed derived ref, prove the commit carrying it is inert, and bind
 * every field a job can derive for itself. A manifest that disagrees with the job's own trusted run
 * metadata is refused; it is never allowed to correct it.
 */
export async function readManifestFromRef({ request, runId, attempt, context }) {
  const ref = derivedRef(runId, attempt, "pr-head");
  const head = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/ref/heads/${branchOf(ref)}`);
  if (head.status === 404) {
    // The ONE retryable shape: setup has not published the manifest ref yet. Tagged so the bounded
    // wait below can distinguish "not yet" from "the manifest is wrong", which must never be retried.
    throw new IncompleteEvidence("the commissioning manifest ref is not present; local setup has not completed", { retryable: true });
  }
  if (head.status !== 200 || !head.body?.object?.sha) throw new IncompleteEvidence(`the commissioning manifest ref could not be read (${head.status})`);
  const commitSha = String(head.body.object.sha);
  const commit = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/commits/${commitSha}`);
  if (commit.status !== 200 || !commit.body) throw new IncompleteEvidence("the commissioning manifest commit could not be read");
  const paths = await assertInertTree({ request, treeSha: String(commit.body.tree?.sha ?? ""), allowed: ALLOWED_MANIFEST_FILES, label: "manifest" });
  if (!paths.includes(MANIFEST_PATH)) throw new IncompleteEvidence("the commissioning manifest commit does not carry a manifest");
  const tree = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/trees/${String(commit.body.tree.sha)}`);
  const blobSha = (tree.body?.tree ?? []).find((entry) => entry.path === MANIFEST_PATH)?.sha;
  const blob = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/blobs/${String(blobSha)}`);
  if (blob.status !== 200 || blob.body?.encoding !== "base64") throw new IncompleteEvidence("the commissioning manifest blob could not be read");
  let manifest;
  try { manifest = JSON.parse(Buffer.from(String(blob.body.content), "base64").toString("utf8")); }
  catch { throw new AssertionFailure("the commissioning manifest is not valid JSON"); }
  assertManifestBinding(manifest, { runId, attempt, context, manifestCommitSha: commitSha });
  return { manifest, manifestCommitSha: commitSha };
}

/**
 * The fixture job's BOUNDED wait for local setup to publish the manifest.
 *
 * WHY A WAIT EXISTS AT ALL. The ordering is genuinely concurrent and cannot be expressed with
 * `needs:`. `normal`'s accepted case requires the fixture's TEST-ONLY checks already green, so
 * `normal` needs `fixture`; the fixture can only mint checks on commits local setup has created, so
 * the fixture must follow setup; and setup must run while the protected jobs are still parked for a
 * human. Making the fixture wait is what breaks that cycle WITHOUT giving it a protected
 * environment or an App key — it holds `checks: write` and nothing else, and a job that can mint a
 * check must not be able to move a ref.
 *
 * WHY IT IS BOUNDED, AND REFUSES RATHER THAN HANGING. The deadline is the runner's own, and it
 * exits `IncompleteEvidence` (exit 3) with its artifact intact. Letting the job's
 * `timeout-minutes` kill it instead would lose the `always()` upload — and PC-07 measures evidence
 * durability rather than assuming it.
 *
 * ONLY the retryable shape is retried. A manifest that exists but disagrees with this job's trusted
 * run metadata, or a commit that is not inert, is an AssertionFailure on the first read and must
 * NOT be polled: re-reading it would just wait for someone to fix a ref we already refused.
 */
export async function awaitManifestFromRef({
  request, runId, attempt, context,
  deadlineMs = 25 * 60_000, intervalMs = 15_000,
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new UsageError("a manifest wait deadline must be a positive whole number of milliseconds");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new UsageError("a manifest poll interval must be a positive whole number of milliseconds");
  const started = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const result = await readManifestFromRef({ request, runId, attempt, context });
      return { ...result, waited_ms: now() - started, polls: attempts };
    } catch (error) {
      if (error?.detail?.retryable !== true) throw error;
      const elapsed = now() - started;
      if (elapsed + intervalMs > deadlineMs) {
        throw new IncompleteEvidence(
          `local setup did not publish the commissioning manifest within ${deadlineMs}ms (${attempts} polls); this job measured nothing`,
          { polls: attempts, waited_ms: elapsed },
        );
      }
      await sleep(intervalMs);
    }
  }
}

/** Every binding a job can check for itself. The manifest may agree; it may never override. */
export function assertManifestBinding(manifest, { runId, attempt, context, manifestCommitSha }) {
  const mismatch = (field) => { throw new AssertionFailure(`the commissioning manifest disagrees with this job's trusted ${field}`); };
  if (manifest?.schema_version !== RESULT_SCHEMA_VERSION) throw new AssertionFailure("the commissioning manifest has an unsupported schema version");
  if (manifest.repository !== COMMISSIONING_REPOSITORY) mismatch("repository");
  if (String(manifest.run_id) !== String(runId)) mismatch("run ID");
  if (String(manifest.attempt) !== String(attempt)) mismatch("run attempt");
  if (manifest.workflow_path !== COMMISSIONING_WORKFLOW_PATH) mismatch("workflow path");
  if (context) {
    if (manifest.workflow_sha !== context.workflowSha) mismatch("immutable workflow SHA");
    if (Number(manifest.repository_id) !== context.repositoryId) mismatch("repository ID");
    if (Number(manifest.normal_app_id) !== context.normalAppId) mismatch("normal App ID");
    if (Number(manifest.emergency_app_id) !== context.emergencyAppId) mismatch("emergency App ID");
  }
  if (canonicalJson(manifest.refs) !== canonicalJson(derivedRefs(runId, attempt))) mismatch("derived ref set");
  if (canonicalJson(manifest.test_contexts) !== canonicalJson(derivedContextNames(runId, attempt))) mismatch("derived TEST-ONLY context set");
  if (manifestCommitSha && Object.values(manifest.graph ?? {}).some((node) => node?.sha === manifestCommitSha)) {
    throw new AssertionFailure("the commissioning manifest claims its own commit as a graph node");
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// 9. The production-shape subject, its CLOSED disposable transformation, and the inverse.
//
// The subject is the raw `buildMainRulesets` output for the measured Apps and the real twelve-
// producer map. Only four substitutions are permitted on the way to a disposable ruleset, and each
// has an exact inverse. Everything else — enforcement mode, strict checks,
// do_not_enforce_on_create, the bypass matrix, the update/pull_request rules — travels unchanged,
// because a semantic difference introduced by the transformation would make the whole measurement
// a statement about a policy nobody runs.
// ──────────────────────────────────────────────────────────────────────────────

export const TRANSFORMATIONS = Object.freeze(["ruleset-name", "exact-ref-condition", "required-context-name", "check-producer-id"]);

export function transformToDisposable(productionRulesets, { runId, attempt, actor, normalAppId }) {
  const targetRef = derivedRef(runId, attempt, actor === "human" ? "human" : actor);
  const contexts = derivedContextNames(runId, attempt);
  return productionRulesets.map((ruleset) => {
    const copy = structuredClone(ruleset);
    copy.name = derivedRulesetName(runId, attempt, actor, ruleset.name);
    copy.conditions = { ...copy.conditions, ref_name: { ...copy.conditions.ref_name, include: [targetRef] } };
    copy.rules = copy.rules.map((rule) => {
      if (rule.type !== "required_status_checks") return rule;
      const checks = rule.parameters.required_status_checks;
      return {
        ...rule,
        parameters: {
          ...rule.parameters,
          required_status_checks: checks.map((check, ordinal) => ({ context: contexts[ordinal], integration_id: normalAppId })),
        },
      };
    });
    return copy;
  });
}

/**
 * The exact inverse, applied ONLY to rulesets this run journaled as its own.
 *
 * It refuses rather than repairs: a value that is not exactly what the forward transformation would
 * have produced means the provider is holding something other than what we asked for, and papering
 * over that is how a "compatible" verdict gets manufactured. Unknown provider fields inside rules
 * and conditions are preserved untouched — dropping them is exactly how a semantic difference
 * becomes invisible.
 */
export function invertDisposable(ruleset, { runId, attempt, actor, producerIds, normalAppId }) {
  const prefix = `commissioning-${runId}-${attempt}-${actor}-`;
  const name = String(ruleset?.name ?? "");
  if (!name.startsWith(prefix)) throw new AssertionFailure(`ruleset ${JSON.stringify(name)} is not a disposable ruleset this run created for the ${actor} actor`);
  const targetRef = derivedRef(runId, attempt, actor === "human" ? "human" : actor);
  const contexts = derivedContextNames(runId, attempt);
  const copy = structuredClone(ruleset);
  copy.name = name.slice(prefix.length);
  const include = copy.conditions?.ref_name?.include;
  if (!Array.isArray(include) || include.length !== 1 || include[0] !== targetRef) {
    throw new AssertionFailure(`disposable ruleset ${name} does not target exactly this run's ${actor} ref`);
  }
  copy.conditions = { ...copy.conditions, ref_name: { ...copy.conditions.ref_name, include: ["refs/heads/main"] } };
  copy.rules = (copy.rules ?? []).map((rule) => {
    if (rule?.type !== "required_status_checks") return rule;
    const checks = rule.parameters?.required_status_checks ?? [];
    return {
      ...rule,
      parameters: {
        ...rule.parameters,
        required_status_checks: checks.map((check, ordinal) => {
          if (check?.context !== contexts[ordinal]) throw new AssertionFailure(`disposable ruleset ${name} carries an unexpected required context at ordinal ${ordinal}`);
          if (Number(check?.integration_id) !== Number(normalAppId)) throw new AssertionFailure(`disposable ruleset ${name} carries an unexpected producer at ordinal ${ordinal}`);
          const context = REQUIRED_MAIN_CONTEXTS[ordinal];
          return { ...check, context, integration_id: producerIds[context] };
        }),
      },
    };
  });
  return copy;
}

/**
 * A BOUNDED structural difference report. Field paths and difference kinds only — no values, since
 * a provider body is not something this harness republishes.
 */
export function describeDifferences(actual, wanted, base = "", out = [], limit = 25) {
  if (out.length >= limit) return out;
  const kindOf = (value) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);
  if (kindOf(actual) !== kindOf(wanted)) { out.push({ path: base || ".", kind: "type" }); return out; }
  if (Array.isArray(wanted)) {
    if (actual.length !== wanted.length) { out.push({ path: base || ".", kind: "length" }); return out; }
    const sorted = (list) => list.map((entry) => canonicalJson(entry)).sort();
    if (canonicalJson(actual) !== canonicalJson(wanted) && canonicalJson(sorted(actual)) === canonicalJson(sorted(wanted))) {
      out.push({ path: base || ".", kind: "reordered" });
      return out;
    }
    wanted.forEach((entry, index) => describeDifferences(actual[index], entry, `${base}[${index}]`, out, limit));
    return out;
  }
  if (wanted && typeof wanted === "object") {
    for (const key of Object.keys(wanted)) {
      if (!(key in actual)) { out.push({ path: `${base}.${key}`, kind: "missing" }); continue; }
      describeDifferences(actual[key], wanted[key], `${base}.${key}`, out, limit);
    }
    for (const key of Object.keys(actual)) {
      if (!(key in wanted)) out.push({ path: `${base}.${key}`, kind: "added" });
      if (out.length >= limit) break;
    }
    return out;
  }
  if (actual !== wanted) out.push({ path: base || ".", kind: "changed" });
  return out;
}

/** Byte-identical, semantically identical, or identical-but-for-provider-normalisation. */
export function compareToDesired(actual, wanted) {
  const differences = describeDifferences(actual, wanted);
  const byteEqual = JSON.stringify(actual) === JSON.stringify(wanted);
  const semanticallyEqual = differences.length === 0;
  const additiveOnly = differences.length > 0 && differences.every((entry) => entry.kind === "added");
  return {
    differences, byteEqual, semanticallyEqual,
    keyOrderingOnly: semanticallyEqual && !byteEqual,
    normalizationOnly: (semanticallyEqual && !byteEqual) || additiveOnly,
  };
}

/**
 * Ask the provider which rules ACTUALLY apply to the disposable branch, and resolve every distinct
 * applicable ruleset to its full definition — repository or organization sourced.
 *
 * Deliberately a separate implementation from `verify-main-policy.mjs`'s: that one is bound to
 * `main`, to a raw `fetch` and to a token, and it THROWS on any non-200. This one runs over the
 * guarded transport, is bound to a derived branch, and must distinguish an inherited rule it cannot
 * read (incomplete) from a branch that genuinely carries none. Sharing the code would mean widening
 * the production verifier's contract for a disposable experiment.
 */
export async function readApplicableBranchRulesets({ request, branch }) {
  const encoded = encodeURIComponent(branch);
  const rules = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rules/branches/${encoded}?per_page=${PAGE_SIZE}&page=${page}`);
    if (response.status !== 200 || !Array.isArray(response.body)) {
      throw new IncompleteEvidence(`the applicable rules for ${branch} could not be measured (${response.status})`);
    }
    rules.push(...response.body);
    if (response.body.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) throw new IncompleteEvidence(`the applicable rules for ${branch} exceeded ${MAX_PAGES} pages; the measurement is incomplete`);
  }
  const byId = new Map();
  for (const rule of rules) {
    const id = rule?.ruleset_id;
    if (!Number.isInteger(id)) throw new IncompleteEvidence("an applicable rule carries no ruleset identity, so its ruleset cannot be measured");
    if (byId.has(id)) continue;
    const sourceType = String(rule?.ruleset_source_type ?? "");
    if (sourceType === "Repository") byId.set(id, `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${id}`);
    else if (sourceType === "Organization") byId.set(id, `/orgs/${ORG}/rulesets/${id}`);
    // An unsupported source is not "no policy"; it is policy this build cannot read.
    else throw new IncompleteEvidence(`applicable ruleset ${id} has an unsupported source type; its definition cannot be measured`);
  }
  const rulesets = [];
  for (const [id, endpoint] of byId) {
    const detail = await request("GET", endpoint);
    if (detail.status !== 200 || !detail.body) throw new IncompleteEvidence(`applicable ruleset ${id} returned no readable definition`);
    rulesets.push(detail.body);
  }
  return { rulesets, applicabilityMeasured: true, ruleCount: rules.length };
}

/**
 * The compatibility verdict (PC-04).
 *
 * Three outcomes, and only three. `measurement-incomplete` is not a soft `mismatch`: it says
 * nothing about the policy. A `mismatch` STAYS a mismatch even when the only difference is provider
 * default expansion or key ordering — this harness reports that concrete gap so root can commission
 * a reviewed correction, and never loosens the production verifier to make it green.
 */
export function evaluateDisposableCompatibility({ measuredRulesets, applicabilityMeasured, actor, ctx, classicProtection, expected }) {
  if (applicabilityMeasured !== true) {
    return { verdict: "measurement-incomplete", reason: "applicability was inferred rather than measured", differences: [], foreign: [] };
  }
  const prefix = `commissioning-${ctx.runId}-${ctx.attempt}-${actor}-`;
  const owned = measuredRulesets.filter((ruleset) => String(ruleset?.name ?? "").startsWith(prefix));
  const foreign = measuredRulesets.filter((ruleset) => !String(ruleset?.name ?? "").startsWith(prefix));
  const desired = buildMainRulesets(expected);
  if (owned.length !== desired.length) {
    return {
      verdict: "mismatch", reason: `the provider reports ${owned.length} of this run's ${desired.length} disposable rulesets as applicable to the ${actor} ref`,
      differences: [], foreign: foreign.map((ruleset) => String(ruleset?.name ?? "unnamed")),
    };
  }
  let inverted;
  try {
    inverted = owned.map((ruleset) => invertDisposable(ruleset, { runId: ctx.runId, attempt: ctx.attempt, actor, producerIds: expected.producerIds, normalAppId: ctx.normalAppId }));
  } catch (error) {
    if (error instanceof AssertionFailure) {
      return { verdict: "mismatch", reason: error.message, differences: [], foreign: foreign.map((r) => String(r?.name ?? "unnamed")) };
    }
    throw error;
  }
  // Foreign applicable rulesets travel to the verifier UNCHANGED. An extra restriction on the
  // disposable branch is evaluated, never dropped as harmless because our three exist.
  const verdictFromVerifier = verifyEffectiveMainPolicy({
    applicableRulesets: [...inverted, ...foreign], classicProtection, expected, applicabilityMeasured: true,
  });
  const differences = [];
  let normalizationOnly = inverted.length > 0 && foreign.length === 0;
  for (const wanted of desired) {
    const actual = inverted.find((ruleset) => ruleset.name === wanted.name);
    if (!actual) { differences.push({ ruleset: wanted.name, path: ".", kind: "missing" }); normalizationOnly = false; continue; }
    for (const key of ["target", "enforcement", "conditions", "bypass_actors", "rules"]) {
      const comparison = compareToDesired(actual[key], wanted[key]);
      if (comparison.byteEqual) continue;
      if (!comparison.normalizationOnly) normalizationOnly = false;
      for (const entry of comparison.differences.slice(0, 8)) differences.push({ ruleset: wanted.name, path: `${key}${entry.path}`, kind: entry.kind });
      if (comparison.keyOrderingOnly) differences.push({ ruleset: wanted.name, path: key, kind: "key-ordering" });
    }
  }
  return {
    verdict: verdictFromVerifier.ok ? "compatible" : "mismatch",
    reason: verdictFromVerifier.ok ? null : "the production verifier rejected the inverse-transformed provider objects",
    verifierErrors: (verdictFromVerifier.errors ?? []).slice(0, 12),
    differences: differences.slice(0, 25),
    // Named, not acted on. The production verifier is NOT loosened here; this tells root which of
    // the two possible corrections (verifier normalisation, or a real policy difference) applies.
    gap: verdictFromVerifier.ok ? null : (normalizationOnly ? "provider-normalization" : "semantic"),
    foreign: foreign.map((ruleset) => String(ruleset?.name ?? "unnamed")),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 10. The actor matrix (PC-05).
// ──────────────────────────────────────────────────────────────────────────────

/** Every commit reachable from `key`, computed from the PLAN — not from anything the provider says. */
export function ancestorsOf(key, plan = null) {
  const nodes = plan ?? buildGraphPlan("1", "1");
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const seen = new Set();
  const walk = (current) => {
    for (const parent of byKey.get(current)?.parents ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      walk(parent);
    }
  };
  walk(key);
  return seen;
}

const isStrictDescendant = (descendant, ancestor) => descendant !== ancestor && ancestorsOf(descendant).has(ancestor);

/**
 * The required live cases, in execution order.
 *
 * Order is load-bearing twice over. Each actor's PERMITTED POSITIVE operation runs before its
 * denial cases, so a later 403 cannot be a token that never worked. And each force case runs after
 * the update that advanced its ref, so "rewind an advanced ref" is a rewind rather than a no-op.
 */
export function buildActorMatrix() {
  const update = (id, actor, ref, from, to, expected, checks) => ({ id, actor, ref, operation: "update", force: false, from, to, expected, checks });
  const force = (id, actor, ref, from, to) => ({ id, actor, ref, operation: "force", force: true, from, to, expected: "denied", checks: "irrelevant" });
  const remove = (id, actor, ref, from) => ({ id, actor, ref, operation: "delete", force: false, from, to: null, expected: "denied", checks: "irrelevant" });
  return Object.freeze([
    // ── normal App. Its PERMITTED POSITIVE operation is publishing the TEST-ONLY checks on its
    //    scoped fixture, which happens before any of these; a later refusal therefore cannot be a
    //    token that never worked. The acceptance comes last because the ref advances to N4 and the
    //    isolated per-case commits below it would stop being fast-forwards.
    update("normal-update-missing-check", "normal", "normal", "A", "N1", "denied", "one-required-check-absent"),
    update("normal-update-failed-check", "normal", "normal", "A", "N2", "denied", "one-required-check-failed"),
    update("normal-update-wrong-producer", "normal", "normal", "A", "N3", "denied", "all-green-wrong-producer"),
    update("normal-update-all-green", "normal", "normal", "A", "N4", "accepted", "all-green-expected-producer"),
    force("normal-force-rewind", "normal", "normal", "N4", "A"),
    force("normal-force-divergent", "normal", "normal", "N4", "D"),
    remove("normal-delete", "normal", "normal", "N4"),

    // ── emergency App. Its acceptance is the case AND the liveness proof. ────────
    update("emergency-update-no-checks", "emergency", "emergency", "A", "E1", "accepted", "none"),
    force("emergency-force-rewind", "emergency", "emergency", "E1", "A"),
    force("emergency-force-divergent", "emergency", "emergency", "E1", "D"),
    remove("emergency-delete", "emergency", "emergency", "E1"),

    // ── local human/admin. Its ref starts ADVANCED at C so a rewind is a real rewind. ─────────
    update("human-update-missing-checks", "human", "human", "C", "H1", "denied", "one-required-check-absent"),
    update("human-update-all-green", "human", "human", "C", "H2", "denied", "all-green-expected-producer"),
    force("human-force-rewind", "human", "human", "C", "B"),
    force("human-force-divergent", "human", "human", "C", "D"),
    remove("human-delete", "human", "human", "C"),
    // The merge must be refused by the WRITER policy, not incidentally by a red check: an unrelated
    // CI failure would deny the merge while proving nothing about who may write to the ref.
    {
      id: "human-pull-request-merge", actor: "human", ref: "human", operation: "merge", force: false,
      from: "C", to: "P", expected: "denied", checks: "irrelevant", requiresRuleId: "protected-ref-update-restricted",
    },
  ]);
}

export const casesForActor = (actor) => buildActorMatrix().filter((kase) => kase.actor === actor);

/**
 * The no-op trap (PC-01: "every live case must have a precondition that would make success
 * distinguishable from a no-op").
 *
 * A force-push whose target is a DESCENDANT of the current head is an ordinary fast-forward that
 * happens to carry `force: true`. A `non_fast_forward` rule does not refuse it, so a case built
 * that way would be recorded as an acceptance and prove nothing about force. This refuses to
 * measure it at all.
 */
export function assertCasePrecondition(kase, { beforeSha, graphShas }) {
  const expectedBefore = graphShas?.[kase.from];
  if (!FULL_SHA.test(String(expectedBefore ?? ""))) throw new IncompleteEvidence(`case ${kase.id} has no measured starting commit`);
  if (String(beforeSha) !== String(expectedBefore)) {
    throw new IncompleteEvidence(`case ${kase.id} expected its ref at synthetic node ${kase.from}; the provider reports a different commit, so this run is interrupted rather than failed`);
  }
  if (kase.operation === "update") {
    if (!isStrictDescendant(kase.to, kase.from)) throw new AssertionFailure(`case ${kase.id} is not a fast-forward and would not measure what it claims`);
  } else if (kase.operation === "force") {
    if (isStrictDescendant(kase.to, kase.from)) {
      throw new AssertionFailure(`case ${kase.id} would force-push to a descendant, which is an ordinary fast-forward wearing a force flag and proves nothing`);
    }
    if (kase.to === kase.from) throw new AssertionFailure(`case ${kase.id} would force a ref to where it already is`);
  } else if (kase.operation === "merge") {
    if (!isStrictDescendant(kase.to, kase.from)) throw new AssertionFailure(`case ${kase.id} needs a pull-request head that descends from its base`);
  }
  return true;
}

export const CASE_OUTCOMES = Object.freeze([
  "denied", "accepted", "inconclusive", "unexpected-success", "unexpected-denial", "unexpected-mutation",
]);

/**
 * Turn one provider response plus an independent readback into a verdict.
 *
 * The two rules this exists to enforce: a DENIAL requires a provider refusal that a rule
 * diagnostic explains AND an unchanged ref — a 401, a 404, a rate limit or an unclassified error is
 * `inconclusive`, because each of them is equally consistent with the policy not existing. An
 * ACCEPTANCE requires the exact expected descendant on an independent GET, never the mutation
 * response's own word for it.
 */
export function classifyCaseOutcome({ expected, response, beforeSha, afterSha, requestedSha, operation, requiresRuleId = null }) {
  const status = Number(response?.status ?? 0);
  const diagnostic = response?.diagnostic ?? { category: "unclassified", policyDenial: false, ruleIds: [] };
  const changed = String(beforeSha) !== String(afterSha);
  if (expected === "denied") {
    if (status >= 200 && status < 300) return { outcome: "unexpected-success", halt: true, reason: "the provider accepted an operation the policy must refuse" };
    if (changed) return { outcome: "unexpected-mutation", halt: true, reason: "the ref moved despite a non-success response" };
    if (status >= 400 && status < 500 && diagnostic.policyDenial === true) {
      if (requiresRuleId && !(diagnostic.ruleIds ?? []).includes(requiresRuleId)) {
        return { outcome: "inconclusive", halt: false, reason: `the refusal is a policy denial but not the ${requiresRuleId} rule this case must isolate` };
      }
      return { outcome: "denied", halt: false, reason: null };
    }
    return {
      outcome: "inconclusive", halt: false,
      reason: status === 0 ? "the request did not complete; a transport failure is not evidence of enforcement"
        : `the refusal (${status}, ${diagnostic.category}) is not attributable to a policy rule`,
    };
  }
  if (status >= 200 && status < 300 && operation !== "delete" && String(afterSha) === String(requestedSha)) {
    return { outcome: "accepted", halt: false, reason: null };
  }
  if (status >= 200 && status < 300) return { outcome: "unexpected-mutation", halt: true, reason: "the provider reported success but the independent readback does not show the requested commit" };
  if (status === 0 && String(afterSha) === String(requestedSha)) {
    // The request may have reached GitHub even when its response did not reach us. Read back once;
    // never repeat a mutation against an ambiguous outcome.
    return { outcome: "accepted", halt: false, reason: "confirmed by readback after an ambiguous response; the mutation was not retried" };
  }
  if (status >= 400 && status < 500) return { outcome: "unexpected-denial", halt: false, reason: `the provider refused an operation the policy must permit (${status}, ${diagnostic.category})` };
  return { outcome: "inconclusive", halt: false, reason: "the request did not complete and the readback does not show the requested commit" };
}

/** Read a derived ref's current commit. `null` means measured-absent (404), not unknown. */
export async function readDerivedRefSha({ request, ref }) {
  const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/ref/heads/${branchOf(ref)}`);
  if (response.status === 404) return null;
  if (response.status !== 200 || !response.body?.object?.sha) throw new IncompleteEvidence(`the state of ${ref} could not be measured (${response.status})`);
  return String(response.body.object.sha);
}

/**
 * Execute one case: measure before, refuse a no-op, journal INTENT, issue exactly one request,
 * journal the RESULT, measure after independently, then classify. Never retries a mutation.
 */
export async function runActorCase({ request, kase, ctx, graphShas, journal, pullNumber = null }) {
  const ref = derivedRef(ctx.runId, ctx.attempt, kase.ref);
  const beforeSha = await readDerivedRefSha({ request, ref });
  assertCasePrecondition(kase, { beforeSha, graphShas });
  const requestedSha = kase.to ? graphShas[kase.to] : null;
  // The case DECLARES a check state; measure that it is actually in place before issuing the
  // mutation. Without this, a denial recorded for "a required check is absent" could equally be a
  // denial from a check publication that had not happened yet, and the two are indistinguishable
  // in the result.
  const checkState = kase.to && kase.checks !== "irrelevant"
    ? await assertCheckState({ request, headSha: graphShas[kase.to], expectation: kase.checks, ctx })
    : { expectation: kase.checks, measured: false };
  const intent = {
    case: kase.id, actor: kase.actor, operation: kase.operation, ref, force: kase.force,
    before_sha: beforeSha, requested_sha: requestedSha, expected: kase.expected, checks: kase.checks,
  };
  journal?.append("mutation-intent", intent);
  let response;
  if (kase.operation === "delete") {
    response = await request("DELETE", `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/${branchOf(ref)}`);
  } else if (kase.operation === "merge") {
    if (!Number.isInteger(pullNumber)) throw new IncompleteEvidence("the synthetic pull request was not created; its merge case cannot be measured");
    response = await request("PUT", `/repos/${COMMISSIONING_REPOSITORY}/pulls/${pullNumber}/merge`, {});
  } else {
    response = await request("PATCH", `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/${branchOf(ref)}`, { sha: requestedSha, force: kase.force });
  }
  journal?.append("mutation-result", { case: kase.id, status: response.status, diagnostic: response.diagnostic, operation_id: response.operation });
  const afterSha = await readDerivedRefSha({ request, ref });
  journal?.append("readback", { case: kase.id, ref, after_sha: afterSha });
  const verdict = classifyCaseOutcome({ expected: kase.expected, response, beforeSha, afterSha, requestedSha, operation: kase.operation, requiresRuleId: kase.requiresRuleId ?? null });
  const record = {
    case: kase.id, actor: kase.actor, operation: kase.operation, ref, force: kase.force,
    expected: kase.expected, before_sha: beforeSha, requested_sha: requestedSha, after_sha: afterSha,
    http_status: response.status, diagnostic: response.diagnostic, outcome: verdict.outcome, check_state: checkState,
    passed: verdict.outcome === kase.expected, reason: verdict.reason,
  };
  journal?.append("case-outcome", record);
  return { record, halt: verdict.halt };
}

/**
 * Run one actor's whole set, stopping IMMEDIATELY on an unexpected success or an unexpected
 * mutation (PC-07): once an actor has demonstrably done something the policy must forbid, every
 * later case runs against a state nobody planned, and continuing would be taking further unsafe
 * actions with a credential that has just been shown to be over-privileged.
 */
export async function runActorCases({ request, actor, ctx, graphShas, journal, pullNumber = null }) {
  const records = [];
  let halted = null;
  for (const kase of casesForActor(actor)) {
    if (halted) { records.push({ case: kase.id, actor, outcome: "not-run", passed: false, reason: `halted after ${halted}` }); continue; }
    try {
      const { record, halt } = await runActorCase({ request, kase, ctx, graphShas, journal, pullNumber });
      records.push(record);
      if (halt) halted = record.case;
    } catch (error) {
      if (error instanceof IncompleteEvidence) {
        // "I could not measure this case yet" does not invalidate the independent cases after it,
        // and each of them re-reads the ref state for itself. Record it and carry on.
        records.push({ case: kase.id, actor, outcome: "inconclusive", passed: false, reason: error.message });
        continue;
      }
      if (error instanceof AssertionFailure) {
        // A precondition that cannot hold means the plan itself is wrong here; stop this actor.
        records.push({ case: kase.id, actor, outcome: "inconclusive", passed: false, reason: error.message });
        halted = kase.id;
        continue;
      }
      throw error;
    }
  }
  return { records, halted };
}

// ──────────────────────────────────────────────────────────────────────────────
// 11. TEST-ONLY check publication.
// ──────────────────────────────────────────────────────────────────────────────

/** Which TEST-ONLY contexts each check-bearing synthetic commit gets, and from which producer. */
export function checkPublicationPlan(runId, attempt) {
  const contexts = derivedContextNames(runId, attempt);
  const last = contexts.length - 1;
  const green = (ordinals) => ordinals.map((ordinal) => ({ ordinal, name: contexts[ordinal], conclusion: "success" }));
  return Object.freeze({
    // Published by the NORMAL App — the producer the disposable policy actually requires.
    normal: Object.freeze([
      { node: "N1", checks: green([...contexts.keys()].filter((ordinal) => ordinal !== last)) },
      { node: "N2", checks: [...green([...contexts.keys()].filter((ordinal) => ordinal !== last)), { ordinal: last, name: contexts[last], conclusion: "failure" }] },
      { node: "N4", checks: green([...contexts.keys()]) },
      // The HUMAN pair, and the reason both nodes are published rather than just the green one: H1
      // carries eleven of the twelve required contexts and H2 carries all twelve, so the two cases
      // differ in EXACTLY one check. A human denied on an empty commit could be a denial about
      // checks; a human denied at 11/12 and again at 12/12 can only be the writer policy.
      { node: "H1", checks: green([...contexts.keys()].filter((ordinal) => ordinal !== last)) },
      { node: "H2", checks: green([...contexts.keys()]) },
    ]),
    // Published by the credential-free fixture job — the GitHub Actions app, i.e. the WRONG
    // producer. This is the entire point of that job: a second independently measured identity.
    fixture: Object.freeze([{ node: "N3", checks: green([...contexts.keys()]) }]),
  });
}

async function publishChecks({ request, entries, graphShas, journal, producer }) {
  const published = [];
  const observedAppIds = new Set();
  for (const entry of entries) {
    const headSha = graphShas[entry.node];
    if (!FULL_SHA.test(String(headSha ?? ""))) throw new IncompleteEvidence(`no verified synthetic commit for check target ${entry.node}`);
    for (const check of entry.checks) {
      const response = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/check-runs`, {
        name: check.name, head_sha: headSha, status: "completed", conclusion: check.conclusion,
        output: { title: check.name, summary: "AIO-1124 synthetic commissioning. TEST-ONLY: this check describes a disposable commit and no product lane." },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new IncompleteEvidence(`the ${producer} producer could not publish a TEST-ONLY check (${response.status}, ${response.diagnostic.category})`);
      }
      const appId = Number(response.body?.app?.id);
      if (Number.isInteger(appId)) observedAppIds.add(appId);
      published.push({ node: entry.node, head_sha: headSha, context_ordinal: check.ordinal, conclusion: check.conclusion, producer });
    }
  }
  journal?.append("resource-created", { kind: "test-only-checks", producer, count: published.length });
  // The provider's own statement of WHICH identity published. This is the second independently
  // measured producer the wrong-producer control needs; asserting it would be self-attestation.
  return { published, observedAppIds: [...observedAppIds].sort((a, b) => a - b) };
}

/**
 * The credential-free synthetic-check fixture (PC-02).
 *
 * Invoked by a fixed import from the `fixture` job, which holds `checks: write` and NO App secret.
 * It exists to give the wrong-producer control case a SECOND, independently measured producer
 * identity — the GitHub Actions app — rather than asserting that a producer mismatch would be
 * refused. Everything it publishes is a TEST-ONLY context on a synthetic commit it has verified for
 * itself; it can reach no other commit, because the request allowlist only accepts a head SHA that
 * appears in the graph it just verified.
 */
export async function runFixtureChecks(env = process.env, {
  fetchImpl = fetch, now = () => new Date(), writeResult = writeEvidenceFile, wait = {},
} = {}) {
  const runId = String(env.GITHUB_RUN_ID ?? "");
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? "");
  const ctx = assertRunContext(env, { runId, attempt, role: "fixture" });
  const evidenceDir = assertCloudOutputDirectory(env.COMMISSIONING_EVIDENCE_DIR);
  const token = String(env.GITHUB_TOKEN ?? "");
  if (!token) throw new UsageError("the fixture job needs its checks-scoped GITHUB_TOKEN");
  const redact = createRedactor(collectSentinels(env));
  const bootstrap = createGuardedRequest(createTokenTransport({ token, fetchImpl, redact }), {
    role: "fixture", runId, attempt, graphShas: new Set(), contextNames: new Set(), rulesetIds: new Set(), rulesetNames: new Set(),
  });
  const { manifest, waited_ms: waitedMs, polls } = await awaitManifestFromRef({ request: bootstrap, runId, attempt, context: ctx, ...wait });
  const verified = await verifySyntheticGraph({ request: bootstrap, manifest, runId, attempt });
  const request = createGuardedRequest(createTokenTransport({ token, fetchImpl, redact }), {
    role: "fixture", runId, attempt,
    graphShas: new Set(Object.values(verified)),
    contextNames: new Set(derivedContextNames(runId, attempt)),
    rulesetIds: new Set(), rulesetNames: new Set(),
  });
  const plan = checkPublicationPlan(runId, attempt);
  const { published, observedAppIds } = await publishChecks({ request, entries: plan.fixture, graphShas: verified, producer: "github-actions-wrong-producer" });
  if (observedAppIds.includes(ctx.normalAppId)) {
    throw new AssertionFailure("the fixture job published as the NORMAL App; it would not isolate a producer mismatch and holds no App secret, so this is a misconfiguration");
  }
  const result = {
    schema_version: RESULT_SCHEMA_VERSION, run_id: runId, attempt, phase: "fixture-checks", status: "published",
    role: "fixture", workflow_sha: ctx.workflowSha, published_at: now().toISOString(),
    published: published.map(({ node, head_sha, context_ordinal, conclusion }) => ({ node, head_sha, context_ordinal, conclusion })),
    producer: "github-actions", measured_producer_app_ids: observedAppIds,
    manifest_wait: { waited_ms: waitedMs, polls },
    note: "TEST-ONLY contexts on synthetic commits; no App secret is present in this job",
  };
  const evidencePath = writeResult(evidenceDir, evidenceSlug(runId, attempt, "fixture"), result);
  return { ...result, evidence_path: evidencePath };
}

// ──────────────────────────────────────────────────────────────────────────────
// 12. Output. Local phases write into a private directory; cloud jobs write a sanitized artifact.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A cloud evidence directory is the runner workspace, so it cannot be required to be 0700 the way
 * the LOCAL journal directory is. What it must be is an absolute real directory that is not a
 * symlink — a path input here selects a local output and must never become a way to write through
 * a link into somewhere else. The files themselves are still written 0600.
 */
export function assertCloudOutputDirectory(dir) {
  if (typeof dir !== "string" || !dir.trim()) throw new UsageError("an evidence directory is required");
  if (!path.isAbsolute(dir)) throw new UsageError("the evidence directory must be an absolute path");
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new UsageError("the evidence directory must not be a symlink");
  if (!statSync(dir).isDirectory()) throw new UsageError("the evidence directory path is not a directory");
  return dir;
}

/**
 * THE ONE PLACE AN EVIDENCE FILE'S NAME IS SPELLED.
 *
 * The workflow uploads four of these by EXACT path, so a name invented at a call site is not a
 * cosmetic difference — it is an `if-no-files-found: error` upload of a file that was never written,
 * i.e. a red job whose evidence is simply missing. That is the exact mismatch this table exists to
 * make impossible, and `test/guards/staging-policy-commissioning-workflow.test.ts` asserts the
 * workflow's paths against {@link evidenceFileName} rather than against a second hand-copied list.
 *
 * Every name carries the run ID and attempt, because a rerun derives FRESH resources (PC-03): a
 * bare `intent.json` would let a second attempt's packet overwrite the first's and read as one
 * clean run.
 */
export const EVIDENCE_KEYS = Object.freeze({
  intent: "intent",
  setup: "setup",
  fixture: "fixture-checks",
  human: "human-tests",
  normal: "normal-tests",
  emergency: "emergency-tests",
  approvals: "approvals",
  environment: "environment-controls",
  cleanup: "cleanup",
  collect: "collect",
  "check-evidence": "check-evidence",
});

export function evidenceSlug(runId, attempt, key) {
  const slug = EVIDENCE_KEYS[key];
  if (!slug) throw new UsageError(`unknown commissioning evidence key ${JSON.stringify(String(key))}`);
  const { runId: id, attempt: n } = assertRunIdentity(runId, attempt);
  return `${id}-${n}-${slug}`;
}

/**
 * The exact basename the workflow must upload for a given cloud job.
 *
 * Deliberately does NOT validate its arguments, because the workflow guard calls it with GitHub's
 * expression strings (`${{ github.run_id }}`) to compare against the YAML's `path:`. Every code path
 * that actually WRITES a file goes through {@link evidenceSlug}, which does validate.
 */
export const evidenceFileName = (runId, attempt, key) => `commissioning-${runId}-${attempt}-${EVIDENCE_KEYS[key]}.json`;

export function writeEvidenceFile(dir, name, payload) {
  if (!/^[0-9]+-[0-9]+-[a-z-]+$/.test(String(name))) throw new UsageError("an evidence file name is derived, never supplied");
  const target = path.join(dir, `commissioning-${name}.json`);
  let existing;
  try { existing = lstatSync(target); } catch { existing = null; }
  if (existing?.isSymbolicLink()) throw new UsageError("refusing to write evidence through a symlink");
  const fd = openSync(target, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return target;
}

export function readEvidenceFile(dir, name) {
  try { return JSON.parse(readFileSync(path.join(dir, `commissioning-${name}.json`), "utf8")); }
  catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────────────
// 13. Phases.
// ──────────────────────────────────────────────────────────────────────────────

const closedResult = ({ runId, attempt, phase, status, evidencePath, extra = {} }) => ({
  schema_version: RESULT_SCHEMA_VERSION, run_id: String(runId), attempt: String(attempt),
  phase, status, evidence_path: evidencePath, ...extra,
});

/** Assert the observed TEST-ONLY check state on a synthetic commit MATCHES what the case claims. */
export async function assertCheckState({ request, headSha, expectation, ctx }) {
  if (expectation === "irrelevant") return { expectation, measured: false };
  const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/commits/${headSha}/check-runs?per_page=${PAGE_SIZE}`);
  if (response.status !== 200 || !response.body) throw new IncompleteEvidence(`the check state of ${headSha.slice(0, 12)} could not be measured (${response.status})`);
  const contexts = derivedContextNames(ctx.runId, ctx.attempt);
  const runs = (response.body.check_runs ?? []).filter((run) => contexts.includes(run?.name));
  const byName = new Map(runs.map((run) => [run.name, run]));
  const last = contexts.length - 1;
  const green = (name, producer) => {
    const run = byName.get(name);
    return run?.status === "completed" && run?.conclusion === "success" && (producer === undefined || Number(run?.app?.id) === producer);
  };
  const producers = [...new Set(runs.map((run) => Number(run?.app?.id)).filter(Number.isInteger))];
  const fail = (why) => { throw new IncompleteEvidence(`the case's declared check state is not yet in place (${why}); this case cannot be measured`); };
  if (expectation === "none") {
    if (runs.length) fail("TEST-ONLY checks are present where the case requires none");
  } else if (expectation === "all-green-expected-producer") {
    if (!contexts.every((name) => green(name, ctx.normalAppId))) fail("not every required TEST-ONLY context is green from the expected producer");
  } else if (expectation === "one-required-check-absent") {
    if (byName.has(contexts[last])) fail("the context the case requires to be absent is present");
    if (!contexts.slice(0, last).every((name) => green(name, ctx.normalAppId))) fail("the remaining contexts are not green from the expected producer");
  } else if (expectation === "one-required-check-failed") {
    if (byName.get(contexts[last])?.conclusion !== "failure") fail("the context the case requires to have failed is not a completed failure");
    if (!contexts.slice(0, last).every((name) => green(name, ctx.normalAppId))) fail("the remaining contexts are not green from the expected producer");
  } else if (expectation === "all-green-wrong-producer") {
    if (!contexts.every((name) => green(name))) fail("not every required TEST-ONLY context is green");
    if (producers.includes(ctx.normalAppId)) fail("the expected producer also published here, so a denial would not isolate the producer mismatch");
  } else {
    throw new UsageError(`unknown declared check state ${JSON.stringify(String(expectation))}`);
  }
  return { expectation, measured: true, producers, present: runs.length };
}

/**
 * PC-03 intent: the credential-free preflight record of immutable identity and derived names.
 *
 * THIS PHASE MAKES NO REQUEST, AND THAT IS THE DESIGN, not a shortcut. Everything it asserts is
 * platform-injected into the job's environment and cross-checked there by {@link assertRunContext}:
 * the repository AND its numeric ID, the event, the dispatch ref, the workflow FILE and ref
 * (`GITHUB_WORKFLOW_REF`), the immutable `GITHUB_SHA`, the run ID and the attempt. A provider call
 * here would need a credential, and the first artifact in the evidence chain is precisely the one
 * that should not have been produced with one.
 *
 * The trade is explicit and is carried in the artifact: these are the job's CLAIMS about its own
 * identity, not a provider measurement of them. Local `setup` re-measures every one of them against
 * the provider before it creates anything ({@link localContext}), and each protected job re-derives
 * the same names from its own trusted run metadata. So nothing downstream ever trusts this file —
 * it is checked against the provider, and against independent derivation, in three later phases.
 */
export async function runIntentPhase({ runId, attempt, evidenceDir, env }) {
  const ctx = assertRunContext(env, { runId, attempt, role: "intent" });
  const dir = assertCloudOutputDirectory(evidenceDir);
  const intent = {
    schema_version: RESULT_SCHEMA_VERSION, issue: "AIO-1124", phase: "intent",
    repository: COMMISSIONING_REPOSITORY, repository_id: ctx.repositoryId,
    run_id: String(runId), attempt: String(attempt), workflow_path: COMMISSIONING_WORKFLOW_PATH,
    workflow_sha: ctx.workflowSha, dispatch_ref: COMMISSIONING_DISPATCH_REF, event: COMMISSIONING_EVENT_NAME,
    // GITHUB_ACTOR is the DISPATCHER, which may be an App. It is never the human approval evidence;
    // that comes from the protected environments' own review history, read in `collect`.
    dispatcher: ctx.actor, dispatcher_is_human: null,
    normal_app_id: ctx.normalAppId, emergency_app_id: ctx.emergencyAppId,
    // Not the IDs: their canonical digest, so the local operator's map can be proved identical to
    // the one this job was configured with without republishing the production producer inventory.
    producer_ids_hash: canonicalHash(ctx.producerIds),
    derived_refs: derivedRefs(runId, attempt),
    derived_ruleset_names: derivedRulesetNames(runId, attempt),
    derived_contexts: derivedContextNames(runId, attempt),
    graph_plan: buildGraphPlan(runId, attempt),
    // Stated in the artifact so a reader cannot mistake a credential-free claim for a measurement.
    credentials_held: "none",
    provider_measured: false,
    provider_remeasurement_required_in: Object.freeze(["setup", "normal-tests", "emergency-tests"]),
  };
  const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, "intent"), intent);
  return closedResult({
    runId, attempt, phase: "intent", status: "recorded", evidencePath,
    extra: { workflow_sha: ctx.workflowSha, provider_measured: false },
  });
}

export function derivedRulesetNames(runId, attempt) {
  const bases = buildMainRulesets({ normalAppId: 1, emergencyAppId: 2, producerIds: Object.fromEntries(REQUIRED_MAIN_CONTEXTS.map((c) => [c, 3])) }).map((r) => r.name);
  return Object.freeze(Object.fromEntries(["normal", "emergency", "human"].map((actor) => [actor, bases.map((base) => derivedRulesetName(runId, attempt, actor, base))])));
}

/**
 * The LOCAL operator's context. It does not come from `GITHUB_*` variables — the operator is not in
 * the run — so it is rebuilt from the credential-free intent artifact and then re-measured against
 * the provider's own record of the run. The intent file is evidence, not authority: every field it
 * carries is either derived independently here or checked against the provider.
 */
export async function localContext({ request, runId, attempt, evidenceDir, env }) {
  const intent = readEvidenceFile(evidenceDir, evidenceSlug(runId, attempt, "intent"));
  if (!intent) throw new IncompleteEvidence("the run's intent artifact is not in the evidence directory; download it before local setup");
  if (intent.schema_version !== RESULT_SCHEMA_VERSION || intent.repository !== COMMISSIONING_REPOSITORY) throw new AssertionFailure("the intent artifact is not this harness's");
  if (String(intent.run_id) !== String(runId) || String(intent.attempt) !== String(attempt)) throw new AssertionFailure("the intent artifact belongs to a different run or attempt");
  if (canonicalJson(intent.derived_refs) !== canonicalJson(derivedRefs(runId, attempt))) throw new AssertionFailure("the intent artifact's derived refs are not the ones this run derives");
  if (canonicalJson(intent.derived_contexts) !== canonicalJson(derivedContextNames(runId, attempt))) throw new AssertionFailure("the intent artifact's TEST-ONLY contexts are not the ones this run derives");
  if (!FULL_SHA.test(String(intent.workflow_sha))) throw new AssertionFailure("the intent artifact carries no immutable workflow SHA");
  const producerIds = parseProducerIds(env?.COMMISSIONING_PRODUCER_IDS_JSON);
  if (canonicalHash(producerIds) !== intent.producer_ids_hash) {
    throw new AssertionFailure("the local production producer map is not the one the intent job measured");
  }
  const repository = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}`);
  if (repository.status !== 200 || !repository.body) throw new IncompleteEvidence("the repository identity could not be measured locally");
  if (Number(repository.body.id) !== Number(intent.repository_id)) throw new AssertionFailure("the measured repository ID is not the one the intent job recorded");
  const attemptRun = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`);
  if (attemptRun.status !== 200 || !attemptRun.body) throw new IncompleteEvidence("the workflow run attempt could not be measured locally");
  if (String(attemptRun.body.head_sha) !== String(intent.workflow_sha)) throw new AssertionFailure("the run's head SHA is not the immutable SHA the intent job recorded");
  if (String(attemptRun.body.path) !== COMMISSIONING_WORKFLOW_PATH) throw new AssertionFailure("the run is not the reviewed commissioning workflow");
  if (String(attemptRun.body.event) !== COMMISSIONING_EVENT_NAME) throw new AssertionFailure("the run was not dispatched manually");
  if (String(attemptRun.body.head_branch ?? "") !== branchOf(COMMISSIONING_DISPATCH_REF)) throw new AssertionFailure("the run was not dispatched from the fixed staging branch");
  return Object.freeze({
    runId: String(runId), attempt: String(attempt), role: "local",
    workflowSha: String(intent.workflow_sha), repositoryId: Number(intent.repository_id),
    normalAppId: Number(intent.normal_app_id), emergencyAppId: Number(intent.emergency_app_id),
    producerIds, intent, actor: null,
    /**
     * The provider re-measurement the credential-free intent phase deliberately did not make.
     * Recorded as its own evidence field because PC-03 asks for the identity to be MEASURED, and
     * after that phase became credential-free this is the only place it happens before anything is
     * created. `check-evidence` requires `confirmed: true`, so a setup that somehow skipped it
     * cannot pass as though the intent artifact had proved it.
     */
    remeasuredIntent: Object.freeze({
      confirmed: true,
      measured_repository_id: Number(repository.body.id),
      measured_head_sha: String(attemptRun.body.head_sha),
      measured_workflow_path: String(attemptRun.body.path),
      measured_event: String(attemptRun.body.event),
      measured_head_branch: String(attemptRun.body.head_branch ?? ""),
      matches_intent: true,
    }),
  });
}

/** The operator's own identity and administrative standing, measured, before anything is created. */
export async function assertLocalOperator({ request }) {
  const viewer = await request("GET", "/user");
  if (viewer.status !== 200 || !viewer.body?.login) throw new IncompleteEvidence("the local gh identity could not be measured");
  const login = String(viewer.body.login);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new AssertionFailure("the local gh identity is not a plain user login");
  if (viewer.body.type && String(viewer.body.type) !== "User") throw new AssertionFailure("the local operator credential is not a user identity");
  const permission = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/collaborators/${login}/permission`);
  if (permission.status !== 200 || !permission.body) throw new IncompleteEvidence("the local operator's repository permission could not be measured");
  if (String(permission.body.permission) !== "admin") throw new AssertionFailure("the local operator does not hold repository admin, which the human/admin actor cases require");
  return { login, permission: "admin", id: Number(viewer.body.id) || null };
}

/**
 * Neither protected job may have passed its environment gate when setup runs: a job that has
 * already started was approved against a plan that did not exist yet. See {@link PROTECTED_JOBS}
 * for why the two jobs are held to DIFFERENT expectations, and why "absent" is a legal state for
 * exactly one of them.
 */
export async function assertProtectedJobsWaiting({ request, runId, attempt }) {
  const jobs = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}&page=1`);
  if (jobs.status !== 200 || !Array.isArray(jobs.body?.jobs)) throw new IncompleteEvidence("the run's jobs could not be measured");
  if (Number(jobs.body.total_count ?? jobs.body.jobs.length) > jobs.body.jobs.length) {
    throw new IncompleteEvidence("the run's job list is paginated beyond the first page; the protected jobs' states are unmeasured");
  }
  const observed = {};
  for (const spec of PROTECTED_JOBS) {
    const job = jobs.body.jobs.find((entry) => String(entry?.name ?? "") === spec.name);
    if (!job) {
      if (spec.atSetup !== "parked-or-uncreated") {
        throw new IncompleteEvidence(`the ${spec.id} protected job is absent from this run, and its dependencies say it should already be parked for approval`);
      }
      // Not yet created because its `needs:` include the fixture, which is waiting for this phase.
      // Recorded as its own state, never collapsed into "waiting" — `collect` requires the ACTUAL
      // later approval for this environment, so an uncreated job here cannot become evidence.
      observed[spec.id] = "uncreated";
      continue;
    }
    const status = String(job.status ?? "unknown");
    if (!PARKED_JOB_STATUSES.includes(status)) {
      throw new AssertionFailure(`the ${spec.id} protected job is ${status}; it has already left the waiting state and cannot have been approved against a plan that did not exist`);
    }
    observed[spec.id] = status;
  }
  return observed;
}

/**
 * The production state this run must leave EXACTLY as it found it (PC-07).
 *
 * `excludeRulesetIds` is the run's OWN journaled rulesets, and it exists to keep two different
 * verdicts apart. At baseline time nothing of ours exists, so the inventory naturally excludes
 * them; if the "after" measurement counted a ruleset of ours that cleanup REFUSED to delete, every
 * cleanup refusal would surface as "production state moved during this run" — an interrupted result
 * blaming somebody else's change for our own leftover. A foreign ruleset appearing during the run
 * still drifts, which is the case this check is actually for.
 */
export async function measureProductionBaseline({ request, excludeRulesetIds = new Set() }) {
  const mainRef = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/ref/heads/main`);
  const stagingRef = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/ref/heads/staging`);
  if (mainRef.status !== 200 || stagingRef.status !== 200) throw new IncompleteEvidence("the production branch state could not be measured");
  const protection = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/branches/main/protection`);
  if (protection.status !== 200 && protection.status !== 404) throw new IncompleteEvidence("main's classic protection could not be measured");
  const applicable = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rules/branches/main?per_page=${PAGE_SIZE}&page=1`);
  if (applicable.status !== 200 || !Array.isArray(applicable.body)) throw new IncompleteEvidence("main's applicable rules could not be measured");
  const rulesets = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets?per_page=${PAGE_SIZE}&page=1`);
  if (rulesets.status !== 200 || !Array.isArray(rulesets.body)) throw new IncompleteEvidence("the repository ruleset inventory could not be measured");
  const inventory = rulesets.body
    .filter((ruleset) => !excludeRulesetIds.has(Number(ruleset.id)))
    .map((ruleset) => ({ id: Number(ruleset.id), name: String(ruleset.name), target: String(ruleset.target ?? ""), enforcement: String(ruleset.enforcement ?? "") }));
  const tagRulesets = {};
  for (const entry of inventory.filter((ruleset) => ruleset.target === "tag")) {
    const detail = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${entry.id}`);
    if (detail.status !== 200 || !detail.body) throw new IncompleteEvidence(`tag ruleset ${entry.id} could not be measured; the v* protection baseline is incomplete`);
    tagRulesets[entry.id] = canonicalHash(detail.body);
  }
  return {
    main_sha: String(mainRef.body.object.sha),
    staging_sha: String(stagingRef.body.object.sha),
    main_classic_protection_hash: canonicalHash(protection.status === 404 ? null : protection.body),
    main_classic_protection_present: protection.status === 200,
    main_applicable_rules_hash: canonicalHash(applicable.body),
    repository_ruleset_inventory_hash: canonicalHash(inventory),
    tag_ruleset_hashes: tagRulesets,
  };
}

/** A collision refuses. It never adopts a resource it did not create, and never deletes one. */
export async function assertNoCollision({ request, ctx }) {
  for (const suffix of REF_SUFFIXES) {
    const ref = derivedRef(ctx.runId, ctx.attempt, suffix);
    const existing = await readDerivedRefSha({ request, ref });
    if (existing) throw new AssertionFailure(`${ref} already exists; commissioning refuses to adopt or delete a resource it did not create`);
  }
  const rulesets = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets?per_page=${PAGE_SIZE}&page=1`);
  if (rulesets.status !== 200 || !Array.isArray(rulesets.body)) throw new IncompleteEvidence("the repository ruleset inventory could not be measured for collision");
  const derived = new Set(Object.values(derivedRulesetNames(ctx.runId, ctx.attempt)).flat());
  for (const ruleset of rulesets.body) {
    if (derived.has(String(ruleset?.name))) throw new AssertionFailure(`a ruleset named ${String(ruleset.name)} already exists; commissioning refuses to adopt it`);
  }
  return true;
}

/** The disposable rulesets this run intends to create, per actor, with their canonical digests. */
export function buildDisposablePlan(ctx) {
  const production = buildMainRulesets({ normalAppId: ctx.normalAppId, emergencyAppId: ctx.emergencyAppId, producerIds: ctx.producerIds });
  const plan = {};
  for (const actor of ["normal", "emergency", "human"]) {
    plan[actor] = transformToDisposable(production, { runId: ctx.runId, attempt: ctx.attempt, actor, normalAppId: ctx.normalAppId })
      .map((ruleset) => ({ name: ruleset.name, target_ref: ruleset.conditions.ref_name.include[0], hash: canonicalHash(ruleset), body: ruleset }));
  }
  return { production, productionHash: canonicalHash(production), plan };
}

const journaledResources = (records, kind) => records.filter((record) => record.type === "resource-created" && record.data?.kind === kind).map((record) => record.data);

/** Create the synthetic graph, resuming from whatever the verified journal already recorded. */
export async function createSyntheticGraph({ request, ctx, journal, guardCtx, manifestInputs }) {
  const plan = buildGraphPlan(ctx.runId, ctx.attempt);
  const existing = Object.fromEntries(journaledResources(journal.read(), "commit").map((entry) => [entry.node, entry.sha]));
  const shas = {};
  for (const [key, sha] of Object.entries(existing)) {
    // A journaled commit must still be there and still be what we recorded, or this is a partial
    // setup nobody can resume from safely.
    const commit = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/commits/${sha}`);
    if (commit.status !== 200) throw new IncompleteEvidence(`journaled synthetic commit ${key} is no longer readable; this attempt is not resumable`);
    shas[key] = sha;
    guardCtx.graphShas.add(sha);
  }
  for (const node of plan) {
    if (shas[node.key]) continue;
    const files = [{ path: MARKER_PATH, mode: "100644", type: "blob", content: graphNodeContent(ctx.runId, ctx.attempt, node) }];
    if (node.key === "P") {
      const manifest = buildManifest({ ...manifestInputs, graphShas: shas });
      files.push({ path: MANIFEST_PATH, mode: "100644", type: "blob", content: `${JSON.stringify(manifest, null, 2)}\n` });
    }
    journal.append("mutation-intent", { kind: "commit", node: node.key, parents: node.parents.map((key) => shas[key]) });
    const tree = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/git/trees`, { tree: files });
    if (tree.status < 200 || tree.status >= 300 || !tree.body?.sha) throw new IncompleteEvidence(`the synthetic tree for node ${node.key} could not be created (${tree.status})`);
    const commit = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/git/commits`, {
      message: `AIO-1124 synthetic commissioning ${ctx.runId}-${ctx.attempt} node ${node.key}`,
      tree: tree.body.sha, parents: node.parents.map((key) => shas[key]),
    });
    if (commit.status < 200 || commit.status >= 300 || !commit.body?.sha) throw new IncompleteEvidence(`the synthetic commit for node ${node.key} could not be created (${commit.status})`);
    shas[node.key] = String(commit.body.sha);
    guardCtx.graphShas.add(shas[node.key]);
    journal.append("resource-created", { kind: "commit", node: node.key, sha: shas[node.key], tree: String(tree.body.sha) });
  }
  return shas;
}

export const REF_START_NODES = Object.freeze({ normal: "A", emergency: "A", human: "C", "pr-head": "P" });

export async function createDerivedRefs({ request, ctx, journal, shas }) {
  const created = Object.fromEntries(journaledResources(journal.read(), "ref").map((entry) => [entry.suffix, entry]));
  const refs = {};
  for (const suffix of REF_SUFFIXES) {
    const ref = derivedRef(ctx.runId, ctx.attempt, suffix);
    const startSha = shas[REF_START_NODES[suffix]];
    const present = await readDerivedRefSha({ request, ref });
    if (created[suffix]) {
      if (!present) throw new IncompleteEvidence(`journaled ref ${ref} has been removed; this attempt is not resumable`);
      refs[suffix] = { ref, start_node: REF_START_NODES[suffix], start_sha: startSha, current_sha: present };
      continue;
    }
    if (present) throw new AssertionFailure(`${ref} exists but this run never created it; commissioning refuses to adopt it`);
    journal.append("mutation-intent", { kind: "ref", suffix, ref, sha: startSha });
    const response = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/git/refs`, { ref, sha: startSha });
    if (response.status < 200 || response.status >= 300) throw new IncompleteEvidence(`${ref} could not be created (${response.status})`);
    const readback = await readDerivedRefSha({ request, ref });
    if (readback !== startSha) throw new AssertionFailure(`${ref} did not read back at its intended starting commit`);
    journal.append("resource-created", { kind: "ref", suffix, ref, start_node: REF_START_NODES[suffix], sha: startSha });
    refs[suffix] = { ref, start_node: REF_START_NODES[suffix], start_sha: startSha, current_sha: startSha };
  }
  return refs;
}

export async function createDisposableRulesets({ request, journal, plan, guardCtx }) {
  const created = journaledResources(journal.read(), "ruleset");
  const byName = new Map(created.map((entry) => [entry.name, entry]));
  const result = {};
  for (const actor of ["normal", "emergency", "human"]) {
    result[actor] = [];
    for (const entry of plan[actor]) {
      if (byName.has(entry.name)) {
        const known = byName.get(entry.name);
        const detail = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${known.id}`);
        if (detail.status !== 200 || String(detail.body?.name) !== entry.name) {
          throw new IncompleteEvidence(`journaled ruleset ${entry.name} no longer reads back as itself; this attempt is not resumable`);
        }
        guardCtx.rulesetIds.add(Number(known.id));
        result[actor].push(known);
        continue;
      }
      journal.append("mutation-intent", { kind: "ruleset", actor, name: entry.name, target_ref: entry.target_ref, hash: entry.hash });
      const response = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/rulesets`, entry.body);
      if (response.status < 200 || response.status >= 300 || !Number.isInteger(Number(response.body?.id))) {
        throw new IncompleteEvidence(`the disposable ruleset ${entry.name} could not be created (${response.status})`);
      }
      const record = { kind: "ruleset", actor, id: Number(response.body.id), name: entry.name, target_ref: entry.target_ref, hash: entry.hash };
      guardCtx.rulesetIds.add(record.id);
      journal.append("resource-created", record);
      result[actor].push(record);
    }
  }
  return result;
}

export async function createSyntheticPull({ request, ctx, journal }) {
  const existing = journaledResources(journal.read(), "pull-request")[0];
  const base = branchOf(derivedRef(ctx.runId, ctx.attempt, "human"));
  const head = branchOf(derivedRef(ctx.runId, ctx.attempt, "pr-head"));
  if (existing) return existing;
  journal.append("mutation-intent", { kind: "pull-request", base, head });
  const response = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/pulls`, {
    title: `AIO-1124 synthetic commissioning ${ctx.runId}-${ctx.attempt}`,
    head, base,
    body: "AIO-1124 synthetic commissioning. Disposable: this pull request exists only to measure whether the writer policy refuses an ordinary merge into a protected disposable ref. It is closed by the run's cleanup phase and references no real task.",
  });
  if (response.status < 200 || response.status >= 300 || !Number.isInteger(Number(response.body?.number))) {
    throw new IncompleteEvidence(`the synthetic pull request could not be created (${response.status})`);
  }
  const record = { kind: "pull-request", number: Number(response.body.number), base, head };
  // A pull request an automation could retarget is not the subject we measured. Bind it now.
  if (String(response.body.base?.ref) !== base || String(response.body.head?.ref) !== head) {
    throw new AssertionFailure("the synthetic pull request did not read back with the exact derived base and head");
  }
  journal.append("resource-created", record);
  return record;
}

/** The one place a local phase opens its lock, its journal and its guarded `gh` transport. */
async function openLocalSession({ runId, attempt, evidenceDir, env, deps }) {
  const dir = assertPrivateDirectory(evidenceDir);
  const redact = createRedactor(collectSentinels(env));
  const guardCtx = {
    role: "local", runId: String(runId), attempt: String(attempt),
    graphShas: new Set(), contextNames: new Set(derivedContextNames(runId, attempt)),
    rulesetIds: new Set(), rulesetNames: new Set(Object.values(derivedRulesetNames(runId, attempt)).flat()),
    pullNumber: null,
  };
  const transport = deps.transport ?? createLocalGhTransport({ spawnImpl: deps.spawnImpl ?? spawn, redact, env });
  const request = createGuardedRequest(transport, guardCtx);
  const ctx = await localContext({ request, runId, attempt, evidenceDir: dir, env });
  const lock = acquireJournalLock({ dir, runId, attempt, now: deps.now });
  try {
    const journal = openJournal({ dir, runId, attempt, source: ctx.workflowSha, lock, now: deps.now });
    const existing = journal.read();
    if (existing.length && existing[0].source !== ctx.workflowSha) {
      throw new AssertionFailure("this run's journal was opened against a different immutable source; it is not this commissioning run's evidence");
    }
    for (const entry of journaledResources(existing, "commit")) guardCtx.graphShas.add(entry.sha);
    for (const entry of journaledResources(existing, "ruleset")) guardCtx.rulesetIds.add(Number(entry.id));
    guardCtx.pullNumber = journaledResources(existing, "pull-request")[0]?.number ?? null;
    return { dir, ctx, request, guardCtx, journal, lock, records: existing };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/** PC-03/PC-04 setup. Creates nothing until every precondition has been measured. */
export async function runSetupPhase({ runId, attempt, evidenceDir, env, deps = {} }) {
  const session = await openLocalSession({ runId, attempt, evidenceDir, env, deps });
  const { dir, ctx, request, guardCtx, journal, lock } = session;
  try {
    const operator = await assertLocalOperator({ request });
    const jobs = await assertProtectedJobsWaiting({ request, runId, attempt });
    // The PRE-APPROVAL snapshot, measured HERE — before anything is created — because it is a
    // precondition, not a report. Its value is that it should be EMPTY: it is what proves the human
    // approval `collect` later reads was given AFTER this plan existed and could be inspected. It
    // is NOT the approval evidence itself; capturing that at this point would be capturing the
    // absence of one. Measuring it after creating the disposable resources would mean refusing a
    // run whose refs and rulesets already existed.
    const approvals = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/approvals`);
    const preApproval = summarizeApprovals(approvals);
    if (!preApproval.measured) throw new IncompleteEvidence(`the run's pre-approval history could not be measured (${preApproval.reason})`);
    const premature = preApproval.entries.filter((entry) => entry.state === "approved"
      && entry.environments.some((environment) => PROTECTED_JOBS.some((spec) => spec.environment === environment)));
    if (premature.length) {
      throw new AssertionFailure(`a protected environment was already approved before setup published the plan (${premature.map((entry) => entry.environments.join("/")).join(", ")}); the approval cannot have been given against a plan that did not exist`);
    }
    let baseline = session.records.find((record) => record.type === "baseline-measured")?.data ?? null;
    if (!baseline) {
      journal.append("run-opened", { operator_login: operator.login, workflow_sha: ctx.workflowSha, repository_id: ctx.repositoryId });
      baseline = await measureProductionBaseline({ request });
      journal.append("baseline-measured", baseline);
      await assertNoCollision({ request, ctx });
    }
    const { productionHash, plan } = buildDisposablePlan(ctx);
    const shas = await createSyntheticGraph({
      request, ctx, journal, guardCtx,
      manifestInputs: {
        runId, attempt, workflowSha: ctx.workflowSha, repositoryId: ctx.repositoryId,
        normalAppId: ctx.normalAppId, emergencyAppId: ctx.emergencyAppId,
        contextNames: derivedContextNames(runId, attempt),
        rulesetPlan: Object.fromEntries(Object.entries(plan).map(([actor, entries]) => [actor, entries.map(({ name, target_ref, hash }) => ({ name, target_ref, hash }))])),
        productionPolicyHash: productionHash,
      },
    });
    const refs = await createDerivedRefs({ request, ctx, journal, shas });
    const rulesets = await createDisposableRulesets({ request, journal, plan, guardCtx });
    const pull = await createSyntheticPull({ request, ctx, journal });
    guardCtx.pullNumber = pull.number;

    // Provider applicability, per actor, resolved to complete definitions and evaluated against the
    // production verifier through the closed inverse transformation.
    const compatibility = {};
    for (const actor of ["normal", "emergency", "human"]) {
      const branch = branchOf(derivedRef(runId, attempt, actor));
      const measured = await readApplicableBranchRulesets({ request, branch });
      const protection = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/branches/${branch}/protection`);
      if (protection.status !== 200 && protection.status !== 404) throw new IncompleteEvidence(`the classic protection of ${branch} could not be measured`);
      compatibility[actor] = {
        ...evaluateDisposableCompatibility({
          measuredRulesets: measured.rulesets, applicabilityMeasured: measured.applicabilityMeasured,
          actor, ctx, classicProtection: protection.status === 404 ? null : protection.body,
          expected: { normalAppId: ctx.normalAppId, emergencyAppId: ctx.emergencyAppId, producerIds: ctx.producerIds },
        }),
        applicable_rule_count: measured.ruleCount,
        classic_protection_present: protection.status === 200,
      };
    }
    const evidence = {
      schema_version: RESULT_SCHEMA_VERSION, phase: "setup", issue: "AIO-1124",
      run_id: String(runId), attempt: String(attempt), workflow_sha: ctx.workflowSha,
      repository: COMMISSIONING_REPOSITORY, repository_id: ctx.repositoryId,
      operator: { login: operator.login, permission: operator.permission },
      intent_remeasured: ctx.remeasuredIntent,
      protected_jobs_at_setup: jobs,
      production_baseline: baseline,
      production_policy_hash: productionHash,
      synthetic_graph: shas, derived_refs: refs,
      disposable_rulesets: Object.fromEntries(Object.entries(rulesets).map(([actor, list]) => [actor, list.map(({ id, name, target_ref, hash }) => ({ id, name, target_ref, hash }))])),
      synthetic_pull_request: { number: pull.number, base: pull.base, head: pull.head },
      compatibility,
      approval_history_before_approval: preApproval,
      transformations: TRANSFORMATIONS,
      note: "Live cases demonstrate policy MECHANICS on disposable refs. They do not demonstrate that the real twelve production producers ran; that is a separate activation gate.",
    };
    const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, "setup"), evidence);
    writeJournalSnapshot({ dir, runId, attempt, snapshot: { generated_from: "verified journal", records: journal.read().length, resources: evidence.disposable_rulesets, refs, graph: shas, pull_request: pull.number } });
    const incompatible = Object.entries(compatibility).filter(([, value]) => value.verdict !== "compatible");
    if (incompatible.some(([, value]) => value.verdict === "measurement-incomplete")) {
      throw new IncompleteEvidence("the disposable policy's provider applicability could not be measured completely", { evidencePath });
    }
    if (incompatible.length) {
      // Fail CLOSED and name the gap. The production verifier is not loosened to make this green;
      // root commissions a reviewed correction, and cleanup still runs against the journal.
      throw new AssertionFailure(`the transformed policy is not compatible with the production verifier (${incompatible.map(([actor, value]) => `${actor}: ${value.gap ?? "mismatch"}`).join(", ")})`, { evidencePath });
    }
    return closedResult({ runId, attempt, phase: "setup", status: "prepared", evidencePath });
  } finally {
    lock.release();
  }
}

/** Reviewer history for the protected environments. GITHUB_ACTOR is the dispatcher, never this. */
export function summarizeApprovals(response) {
  if (response?.status !== 200 || !Array.isArray(response.body)) {
    return { measured: false, reason: `the run's environment approval history could not be measured (${response?.status ?? "no response"})`, entries: [] };
  }
  return {
    measured: true,
    entries: response.body.map((entry) => ({
      state: String(entry?.state ?? "unknown"),
      reviewer_login: String(entry?.user?.login ?? "unknown"),
      reviewer_type: String(entry?.user?.type ?? "unknown"),
      environments: (entry?.environments ?? []).map((environment) => String(environment?.name ?? "unknown")),
    })),
  };
}

/** PC-05, the local human/admin half. */
export async function runHumanTestsPhase({ runId, attempt, evidenceDir, env, deps = {} }) {
  const session = await openLocalSession({ runId, attempt, evidenceDir, env, deps });
  const { dir, ctx, request, guardCtx, journal, lock, records } = session;
  try {
    const setup = readEvidenceFile(dir, evidenceSlug(runId, attempt, "setup"));
    if (!setup) throw new IncompleteEvidence("local setup has not completed for this run");
    const shas = Object.fromEntries(journaledResources(records, "commit").map((entry) => [entry.node, entry.sha]));
    if (!Object.keys(shas).length) throw new IncompleteEvidence("the journal records no synthetic commits for this run");
    const operator = await assertLocalOperator({ request });
    const { records: caseRecords, halted } = await runActorCases({
      request, actor: "human", ctx, graphShas: shas, journal, pullNumber: guardCtx.pullNumber,
    });
    const evidence = {
      schema_version: RESULT_SCHEMA_VERSION, phase: "human-tests", run_id: String(runId), attempt: String(attempt),
      workflow_sha: ctx.workflowSha, actor: { kind: "human-admin", login: operator.login, permission: operator.permission },
      cases: caseRecords, halted_after: halted,
    };
    const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, "human"), evidence);
    return finishTestPhase({ runId, attempt, phase: "human-tests", caseRecords, halted, evidencePath });
  } finally {
    lock.release();
  }
}

function finishTestPhase({ runId, attempt, phase, caseRecords, halted, evidencePath }) {
  const failed = caseRecords.filter((record) => record.passed !== true);
  if (!failed.length) return closedResult({ runId, attempt, phase, status: "passed", evidencePath });
  const onlyInconclusive = failed.every((record) => record.outcome === "inconclusive" || record.outcome === "not-run");
  if (onlyInconclusive && !halted) {
    throw new IncompleteEvidence(`${failed.length} of ${caseRecords.length} ${phase} cases could not be measured`, { evidencePath });
  }
  throw new AssertionFailure(`${failed.length} of ${caseRecords.length} ${phase} cases did not record their expected provider outcome`, { evidencePath });
}

/** The installation must be scoped to exactly this repository, measured from the provider. */
export async function assertInstallationScope({ request, ctx }) {
  const response = await request("GET", "/installation/repositories");
  if (response.status !== 200 || !response.body) throw new IncompleteEvidence("the App installation's repository selection could not be measured");
  if (String(response.body.repository_selection ?? "") !== "selected") {
    throw new AssertionFailure("the App installation is not limited to selected repositories; a release identity installed org-wide is out of scope for commissioning");
  }
  const repositories = response.body.repositories ?? [];
  if (repositories.length !== 1 || Number(response.body.total_count) !== 1) {
    throw new AssertionFailure("the App installation covers more than this repository");
  }
  if (Number(repositories[0]?.id) !== ctx.repositoryId) throw new AssertionFailure("the App installation is not scoped to this repository");
  return { repository_selection: "selected", total_count: 1, repository_id: ctx.repositoryId };
}

/**
 * Each protected job proves for ITSELF that the planned policy is actually in force on its ref.
 *
 * Without this an acceptance is unfalsifiable: a job running against a branch with no ruleset
 * accepts everything, and "the emergency App pushed successfully" would be recorded as evidence of
 * a bypass that was never tested.
 */
export async function assertPlannedPolicyInForce({ request, ctx, actor, manifest }) {
  const branch = branchOf(derivedRef(ctx.runId, ctx.attempt, actor));
  const measured = await readApplicableBranchRulesets({ request, branch });
  const planned = (manifest?.policy_plan?.[actor] ?? []).map((entry) => String(entry.name)).sort();
  const observed = measured.rulesets.map((ruleset) => String(ruleset?.name ?? "unnamed")).sort();
  if (!planned.length) throw new AssertionFailure("the manifest declares no disposable policy for this actor");
  if (canonicalJson(observed) !== canonicalJson(planned)) {
    throw new AssertionFailure(`the policy applying to this job's ref is not the planned disposable policy (${observed.length} applicable, ${planned.length} planned)`);
  }
  for (const ruleset of measured.rulesets) {
    if (String(ruleset?.enforcement) !== "active") throw new AssertionFailure(`applicable ruleset ${String(ruleset?.name)} is not active; it would enforce nothing`);
  }
  return { branch, applicable: observed, rule_count: measured.ruleCount };
}

/** PC-05, the protected-job half. One role, one App key, one job. */
export async function runCloudTestsPhase({ role, runId, attempt, evidenceDir, env, deps = {} }) {
  const ctx = assertRunContext(env, { runId, attempt, role });
  const dir = assertCloudOutputDirectory(evidenceDir);
  const redact = createRedactor(collectSentinels(env));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const makeRequest = (transport, extra) => createGuardedRequest(transport, {
    role, runId: String(runId), attempt: String(attempt),
    graphShas: new Set(), contextNames: new Set(), rulesetIds: new Set(), rulesetNames: new Set(), ...extra,
  });
  const metadataToken = String(env.GITHUB_TOKEN ?? "");
  if (!metadataToken) throw new UsageError("the protected job needs its metadata-scoped GITHUB_TOKEN to read the plan");
  const metadata = makeRequest(deps.metadataTransport ?? createTokenTransport({ token: metadataToken, fetchImpl, redact }), {});
  // Read ONCE, with no bounded wait — unlike the fixture job. This job only starts after a human
  // approved it, and root approves only after verifying the setup readback, so an absent manifest
  // here is not "not yet": it means the plan this approval was given against is not there. Waiting
  // would convert that into a delay, and then into an artifact that looks like a normal run.
  const { manifest, manifestCommitSha } = await readManifestFromRef({ request: metadata, runId, attempt, context: ctx });
  const verified = await verifySyntheticGraph({ request: metadata, manifest, runId, attempt });

  const names = role === "normal"
    ? { appId: env.RELEASE_APP_ID, installationId: env.RELEASE_APP_INSTALLATION_ID, privateKey: env.RELEASE_APP_PRIVATE_KEY, expected: ctx.normalAppId, forbidden: "EMERGENCY_APP_PRIVATE_KEY" }
    : { appId: env.EMERGENCY_APP_ID, installationId: env.EMERGENCY_APP_INSTALLATION_ID, privateKey: env.EMERGENCY_APP_PRIVATE_KEY, expected: ctx.emergencyAppId, forbidden: "RELEASE_APP_PRIVATE_KEY" };
  if (env[names.forbidden]) throw new AssertionFailure(`the ${role} job can see ${names.forbidden}; the two release identities must not share a job`);
  if (Number(names.appId) !== names.expected) throw new AssertionFailure(`the ${role} job's App ID is not the identity this commissioning run was configured for`);
  if (!names.privateKey || !names.installationId) throw new UsageError(`the ${role} job is missing its App installation credentials`);
  // The exchange itself is the identity proof: GitHub validates the JWT signature against the
  // public key of the App named as its ISSUER, so a token only exists if this private key belongs
  // to App `names.appId`. There is no installation-token endpoint that reports back an App number.
  const token = await (deps.createInstallationToken ?? createInstallationToken)({
    appId: names.appId, installationId: names.installationId, privateKey: names.privateKey, fetchImpl,
  });
  const guard = {
    graphShas: new Set(Object.values(verified)),
    contextNames: new Set(derivedContextNames(runId, attempt)),
  };
  const request = makeRequest(deps.appTransport ?? createTokenTransport({ token, fetchImpl, redact }), guard);
  const installation = await assertInstallationScope({ request, ctx });
  const policy = await assertPlannedPolicyInForce({ request: metadata, ctx, actor: role, manifest });

  let publication = null;
  if (role === "normal") {
    // The permitted POSITIVE write, issued before any denial case, so a later 403 cannot be a
    // token that never worked. It is also what the wrong-producer case is contrasted against.
    const result = await publishChecks({ request, entries: checkPublicationPlan(runId, attempt).normal, graphShas: verified, producer: "normal-app" });
    if (!result.observedAppIds.includes(ctx.normalAppId)) {
      throw new AssertionFailure("the checks this job published were not attributed to the expected normal App");
    }
    publication = { count: result.published.length, measured_producer_app_ids: result.observedAppIds, nodes: [...new Set(result.published.map((entry) => entry.node))] };
  }
  const { records, halted } = await runActorCases({ request, actor: role, ctx, graphShas: verified });
  const evidence = {
    schema_version: RESULT_SCHEMA_VERSION, phase: `${role}-tests`, run_id: String(runId), attempt: String(attempt),
    workflow_sha: ctx.workflowSha, manifest_commit_sha: manifestCommitSha,
    actor: {
      kind: `${role}-app`, app_id: names.expected, installation: installation,
      app_identity_proof: "installation-token-exchange-validated-the-JWT-issuer-App-ID",
      // Named honestly: the reused finite-deadline token helper does not surface the installation
      // token's permission set, so the App's GRANTS are an owner provisioning fact verified out of
      // band. `check-evidence` carries this forward as an activation blocker rather than a pass.
      installation_permissions: "unverified-by-this-harness",
    },
    dispatcher: ctx.actor, dispatcher_is_the_approver: false,
    policy_in_force: policy, check_publication: publication, cases: records, halted_after: halted,
  };
  const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, role), evidence);
  return finishTestPhase({ runId, attempt, phase: `${role}-tests`, caseRecords: records, halted, evidencePath });
}

// ──────────────────────────────────────────────────────────────────────────────
// 14. Cleanup, collection and the authoritative completeness check.
// ──────────────────────────────────────────────────────────────────────────────

/** PC-07 cleanup: rulesets, then refs, then the synthetic pull request. Never by wildcard. */
export async function runCleanupPhase({ runId, attempt, evidenceDir, env, deps = {} }) {
  const session = await openLocalSession({ runId, attempt, evidenceDir, env, deps });
  const { dir, ctx, request, guardCtx, journal, lock, records } = session;
  try {
    const baseline = records.find((record) => record.type === "baseline-measured")?.data;
    if (!baseline) throw new IncompleteEvidence("this run has no journaled production baseline; cleanup cannot prove it changed nothing");
    const outcomes = [];
    let refused = 0;

    for (const owned of journaledResources(records, "ruleset")) {
      const detail = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${owned.id}`);
      if (detail.status === 404) { outcomes.push({ kind: "ruleset", id: owned.id, name: owned.name, result: "already-absent" }); continue; }
      if (detail.status !== 200 || !detail.body) { outcomes.push({ kind: "ruleset", id: owned.id, name: owned.name, result: "unreadable" }); refused += 1; continue; }
      const include = detail.body?.conditions?.ref_name?.include ?? [];
      // Fingerprint, not prefix: the name AND the exact single derived target this run journaled.
      if (String(detail.body.name) !== owned.name || include.length !== 1 || include[0] !== owned.target_ref) {
        outcomes.push({ kind: "ruleset", id: owned.id, name: owned.name, result: "refused-ownership-mismatch" });
        refused += 1;
        continue;
      }
      journal.append("cleanup-intent", { kind: "ruleset", id: owned.id, name: owned.name });
      const response = await request("DELETE", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${owned.id}`);
      const readback = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${owned.id}`);
      const removed = readback.status === 404;
      journal.append("cleanup-result", { kind: "ruleset", id: owned.id, status: response.status, removed });
      outcomes.push({ kind: "ruleset", id: owned.id, name: owned.name, result: removed ? "removed" : "still-present" });
      if (!removed) refused += 1;
    }

    for (const owned of journaledResources(records, "ref")) {
      const current = await readDerivedRefSha({ request, ref: owned.ref });
      if (current === null) { outcomes.push({ kind: "ref", ref: owned.ref, result: "already-absent" }); continue; }
      if (!guardCtx.graphShas.has(current)) {
        // Something outside this run wrote here. Deleting it would destroy evidence that is not ours.
        outcomes.push({ kind: "ref", ref: owned.ref, result: "refused-unowned-content" });
        refused += 1;
        continue;
      }
      journal.append("cleanup-intent", { kind: "ref", ref: owned.ref, sha: current });
      const response = await request("DELETE", `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/${branchOf(owned.ref)}`);
      const readback = await readDerivedRefSha({ request, ref: owned.ref });
      journal.append("cleanup-result", { kind: "ref", ref: owned.ref, status: response.status, removed: readback === null });
      outcomes.push({ kind: "ref", ref: owned.ref, result: readback === null ? "removed" : "still-present" });
      if (readback !== null) refused += 1;
    }

    const pull = journaledResources(records, "pull-request")[0];
    if (pull) {
      const detail = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/pulls/${pull.number}`);
      if (detail.status !== 200 || !detail.body) { outcomes.push({ kind: "pull-request", number: pull.number, result: "unreadable" }); refused += 1; }
      else if (String(detail.body.base?.ref) !== pull.base || String(detail.body.head?.ref) !== pull.head) {
        outcomes.push({ kind: "pull-request", number: pull.number, result: "refused-retargeted" });
        refused += 1;
      } else if (String(detail.body.state) === "closed") {
        outcomes.push({ kind: "pull-request", number: pull.number, result: "already-closed" });
      } else {
        journal.append("cleanup-intent", { kind: "pull-request", number: pull.number });
        const response = await request("PATCH", `/repos/${COMMISSIONING_REPOSITORY}/pulls/${pull.number}`, { state: "closed" });
        const readback = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/pulls/${pull.number}`);
        const closed = String(readback.body?.state) === "closed";
        journal.append("cleanup-result", { kind: "pull-request", number: pull.number, status: response.status, closed });
        outcomes.push({ kind: "pull-request", number: pull.number, result: closed ? "closed" : "still-open" });
        if (!closed) refused += 1;
      }
    }

    const after = await measureProductionBaseline({
      request,
      excludeRulesetIds: new Set(journaledResources(records, "ruleset").map((owned) => Number(owned.id))),
    });
    const drift = Object.keys(baseline).filter((key) => canonicalJson(baseline[key]) !== canonicalJson(after[key]));
    journal.append("run-closed", { cleanup_refusals: refused, production_drift: drift });
    const evidence = {
      schema_version: RESULT_SCHEMA_VERSION, phase: "cleanup", run_id: String(runId), attempt: String(attempt),
      workflow_sha: ctx.workflowSha, outcomes, refusals: refused,
      production_baseline_before: baseline, production_baseline_after: after, production_drift: drift,
    };
    const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, "cleanup"), evidence);
    if (drift.length) {
      // Concurrent legitimate source movement is INTERRUPTED, requiring reconciliation — never an
      // automatic rollback of somebody else's change.
      throw new IncompleteEvidence(`production state moved during this run (${drift.join(", ")}); the result is interrupted and needs root reconciliation`, { evidencePath });
    }
    if (refused) throw new AssertionFailure(`${refused} owned resource(s) could not be removed or did not match their journaled fingerprint`, { evidencePath });
    return closedResult({ runId, attempt, phase: "cleanup", status: "cleaned", evidencePath });
  } finally {
    lock.release();
  }
}

/**
 * The CLOSED set of protected-environment controls PC-06 requires, and the file that carries them.
 *
 * None of these can be produced by this harness. It cannot impersonate a second reviewer, it cannot
 * read `prevent_self_review` back from the environments API, and a skipped off-branch job proves
 * workflow ADMISSION rather than environment branch policy. So each is operator-supplied evidence
 * from a separately reviewed, root-staged observation, and each is named individually — a single
 * `verified: true` flag would let one observation stand in for seven.
 *
 * Every key must be present and `verified`. Anything else — absent, `unverified`, or a value that is
 * not one of the two words — is a BLOCKER, so an incomplete file cannot round up to a pass.
 */
export const ENVIRONMENT_CONTROL_KEYS = Object.freeze([
  "required_reviewer_is_owner",
  "prevent_self_review_enabled",
  "branch_policy_limits_to_staging",
  "administrators_cannot_bypass",
  "self_review_refused",
  "unauthorized_reviewer_refused",
  "off_branch_environment_reference_refused",
  // The off-branch environment probe. PC-06 allows a separately staged no-secrets probe from a
  // disposable ref, but this workflow's admission is FIXED to `refs/heads/staging` — so within it the
  // case cannot be produced, and the spec's instruction is to report it unverified rather than widen
  // admission to arbitrary refs. That is what this key is: the honest gap, named.
  //
  // The two release Apps' GRANTS. The finite-deadline token helper this harness reuses does not
  // surface an installation token's permission set, and there is no endpoint that reports it back
  // for someone else's installation — so these are owner provisioning facts, read out of band and
  // attached here. They live in this list rather than as a hardcoded blocker for a specific reason:
  // a blocker nothing can ever satisfy would make `check-evidence` incapable of returning 0, and an
  // exit code that is always 3 stops carrying information long before anybody stops reading it.
  "normal_app_permissions_confirmed",
  "emergency_app_permissions_confirmed",
]);

/**
 * Every evidence file's identity, checked before ANY field in it is believed.
 *
 * A file that is present but belongs to another run, another attempt or another phase is worse than
 * an absent one: absence blocks loudly, whereas a mis-bound file would contribute PASSING gates
 * measured against a different subject. A copy of last week's green packet dropped into this run's
 * directory is exactly the shape this refuses.
 */
export function validateEvidenceBinding(payload, { runId, attempt, phase }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "is not a JSON object";
  if (payload.schema_version !== RESULT_SCHEMA_VERSION) return `declares schema version ${JSON.stringify(payload.schema_version ?? null)}, not ${RESULT_SCHEMA_VERSION}`;
  if (String(payload.run_id) !== String(runId)) return `belongs to run ${JSON.stringify(String(payload.run_id ?? ""))}`;
  if (String(payload.attempt) !== String(attempt)) return `belongs to attempt ${JSON.stringify(String(payload.attempt ?? ""))}`;
  if (String(payload.phase) !== phase) return `records phase ${JSON.stringify(String(payload.phase ?? ""))}, not ${phase}`;
  return null;
}

/** Which evidence file each gate needs, the phase name it must declare, and whether it is required. */
const EVIDENCE_MANIFEST = Object.freeze([
  { key: "intent", gate: "PC-03", phase: "intent", required: true },
  { key: "setup", gate: "PC-03", phase: "setup", required: true },
  { key: "fixture", gate: "PC-02", phase: "fixture-checks", required: true },
  { key: "human", gate: "PC-05", phase: "human-tests", required: true },
  { key: "normal", gate: "PC-05", phase: "normal-tests", required: true },
  { key: "emergency", gate: "PC-05", phase: "emergency-tests", required: true },
  { key: "approvals", gate: "PC-06", phase: "approvals", required: true },
  { key: "environment", gate: "PC-06", phase: "environment-controls", required: true },
  { key: "cleanup", gate: "PC-07", phase: "cleanup", required: true },
]);

/**
 * The authoritative completeness assessment (PC-07/PC-08). Every gate reports, and a gate that
 * could not be measured is `unverified` — which BLOCKS, and is never rendered as a pass.
 *
 * THREE KINDS OF BLOCKER, deliberately distinct in the output: `failed` is a measured statement
 * about the subject, `unverified` is "we could not look or nobody has looked yet", and `invalid` is
 * "a file claiming to be this evidence is not this evidence". Only an empty blocker list is a pass,
 * so the distinction changes the exit code (1 vs 3) and the story, never the verdict.
 */
export function assessEvidence({ dir, runId, attempt }) {
  const blockers = [];
  const block = (gate, kind, detail) => { blockers.push({ gate, kind, detail }); };
  let journalRecords = null;
  let journalError = null;
  try { journalRecords = readJournal({ dir, runId, attempt }); }
  catch (error) { journalError = error instanceof Error ? error.message : String(error); }
  if (journalError) block("PC-07", "failed", `the local journal chain does not verify: ${journalError}`);
  else if (!journalRecords.length) block("PC-07", "unverified", "the local journal is empty; no local phase has run");

  // Read, then VALIDATE. A file that fails its binding is discarded before any gate reads a field
  // out of it, so a mis-bound packet can only ever subtract confidence, never add it.
  const files = {};
  for (const entry of EVIDENCE_MANIFEST) {
    const payload = readEvidenceFile(dir, evidenceSlug(runId, attempt, entry.key));
    if (!payload) {
      if (entry.required) block(entry.gate, "unverified", `the ${EVIDENCE_KEYS[entry.key]} evidence file is absent`);
      files[entry.key] = null;
      continue;
    }
    const problem = validateEvidenceBinding(payload, { runId, attempt, phase: entry.phase });
    if (problem) {
      block(entry.gate, "invalid", `the ${EVIDENCE_KEYS[entry.key]} evidence file ${problem}`);
      files[entry.key] = null;
      continue;
    }
    files[entry.key] = payload;
  }

  if (files.intent) {
    // The intent phase is credential-free by design, so it must SAY so rather than look measured.
    if (files.intent.provider_measured !== false) block("PC-03", "invalid", "the intent evidence claims a provider measurement the credential-free intent phase does not make");
    if (files.intent.workflow_sha && files.setup && files.setup.workflow_sha !== files.intent.workflow_sha) {
      block("PC-03", "failed", "the setup evidence and the intent evidence disagree about the immutable workflow SHA");
    }
  }
  if (files.setup) {
    // Because intent measures nothing, THIS is where the run's identity was checked against the
    // provider. A setup file without it is not a pass with a caveat; it is an unproved identity.
    if (files.setup.intent_remeasured?.confirmed !== true) {
      block("PC-03", "unverified", "the setup evidence does not record a provider re-measurement of the credential-free intent's identity claims");
    }
    for (const [actor, value] of Object.entries(files.setup.compatibility ?? {})) {
      if (value?.verdict === "compatible") continue;
      block("PC-04", value?.verdict === "measurement-incomplete" ? "unverified" : "failed", `the ${actor} disposable policy is ${value?.verdict ?? "unreported"}${value?.gap ? ` (${value.gap} gap)` : ""}`);
    }
    const preApproval = files.setup.approval_history_before_approval;
    if (preApproval?.measured !== true) block("PC-06", "unverified", "the pre-approval snapshot was not measured, so a later approval cannot be shown to postdate the plan");
    else if ((preApproval.entries ?? []).some((entry) => entry.state === "approved")) {
      block("PC-06", "failed", "a protected environment was already approved before setup published the plan");
    }
  }

  // PC-06, the ACTUAL human approval — from the approvals file `collect` wrote after the protected
  // jobs ran, never from setup's pre-approval snapshot.
  if (files.approvals) {
    for (const spec of PROTECTED_JOBS) {
      const environment = files.approvals.environments?.[spec.environment];
      if (!environment) { block("PC-06", "unverified", `the approval evidence records nothing for ${spec.environment}`); continue; }
      if (environment.approval_measured !== true) {
        block("PC-06", "unverified", `${spec.environment}'s approval history could not be measured${environment.approval_measurement_reason ? ` (${environment.approval_measurement_reason})` : ""}`);
        continue;
      }
      if (environment.approved !== true) { block("PC-06", "unverified", `no human approval is recorded for ${spec.environment}`); continue; }
      if (!(environment.reviewers ?? []).length) { block("PC-06", "unverified", `${spec.environment} is recorded as approved with no reviewer identity`); continue; }
      // A dispatcher that approves its own run is a self-review: the run happened, but it is not
      // the two-identity evidence PC-06 asks for.
      if (environment.reviewers.some((reviewer) => reviewer.is_dispatcher === true)) {
        block("PC-06", "failed", `${spec.environment} was approved by the dispatcher itself; that is a self-review, not independent approval`);
      }
      if (environment.job_state_measured !== true) block("PC-06", "unverified", `the ${spec.id} job's final state could not be measured`);
      else if (environment.job_status !== "completed") block("PC-06", "unverified", `the ${spec.id} job is ${environment.job_status}; its approval did not lead to a completed actor phase`);
    }
  }

  // PC-05: every case in the matrix must be accounted for by its actor's evidence, and passed.
  const observed = new Map();
  for (const key of ["human", "normal", "emergency"]) {
    for (const record of files[key]?.cases ?? []) observed.set(String(record.case), record);
  }
  for (const kase of buildActorMatrix()) {
    const record = observed.get(kase.id);
    if (!record) { block("PC-05", "unverified", `case ${kase.id} has no recorded outcome`); continue; }
    if (record.passed === true) continue;
    block("PC-05", record.outcome === "inconclusive" || record.outcome === "not-run" ? "unverified" : "failed", `case ${kase.id} recorded ${record.outcome}`);
  }

  if (files.cleanup) {
    if ((files.cleanup.production_drift ?? []).length) block("PC-07", "failed", "production state moved during the run");
    if (Number(files.cleanup.refusals ?? 0) > 0) block("PC-07", "failed", `${files.cleanup.refusals} owned resource(s) remain or did not match their fingerprint`);
    const leftovers = (files.cleanup.outcomes ?? []).filter((entry) => !["removed", "already-absent", "closed", "already-closed"].includes(entry.result));
    if (leftovers.length) block("PC-07", "failed", `${leftovers.length} owned resource(s) were not removed`);
  }

  // PC-06 negative controls, per named control. Absent evidence stays UNVERIFIED and blocks
  // activation, by design — see ENVIRONMENT_CONTROL_KEYS.
  if (files.environment) {
    for (const key of ENVIRONMENT_CONTROL_KEYS) {
      const control = files.environment.controls?.[key];
      const status = String(control?.status ?? "absent");
      if (status === "verified") {
        if (!String(control?.evidence ?? "").trim()) block("PC-06", "unverified", `the ${key} control is marked verified with no evidence reference`);
        continue;
      }
      block("PC-06", "unverified", `the protected-environment control ${key} is ${status}`);
    }
    const unknown = Object.keys(files.environment.controls ?? {}).filter((key) => !ENVIRONMENT_CONTROL_KEYS.includes(key));
    if (unknown.length) block("PC-06", "invalid", `the environment-controls evidence declares ${unknown.length} control(s) outside the closed PC-06 list`);
  }
  // The mirror of the two `*_app_permissions_confirmed` controls: the actor evidence must keep
  // SAYING that it did not measure the App's grants. A file that claimed otherwise would be
  // claiming a measurement no code here performs, which is worse than the gap it papers over.
  for (const role of ["normal", "emergency"]) {
    if (!files[role]) continue;
    if (files[role].actor?.installation_permissions !== "unverified-by-this-harness") {
      block("PC-06", "invalid", `the ${role} actor evidence claims a measurement of the App's installation permissions that this harness does not perform`);
    }
  }
  return { blockers, files, journal_records: journalRecords?.length ?? 0 };
}

function evidenceResult({ runId, attempt, phase, dir, deps }) {
  const assessment = assessEvidence({ dir, runId, attempt });
  const summary = {
    schema_version: RESULT_SCHEMA_VERSION, phase, run_id: String(runId), attempt: String(attempt),
    assessed_at: (deps.now ?? (() => new Date()))().toISOString(),
    journal_records: assessment.journal_records,
    present: Object.fromEntries(Object.entries(assessment.files).map(([name, value]) => [name, Boolean(value)])),
    blockers: assessment.blockers,
    verdict: assessment.blockers.length ? "not-activation-evidence" : "complete",
    note: "A complete actor matrix is not authorization to change main policy. Activation is a separate, root-owned decision with its own gates.",
  };
  const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, phase), summary);
  if (!assessment.blockers.length) return closedResult({ runId, attempt, phase, status: "passed", evidencePath });
  const failed = assessment.blockers.filter((entry) => entry.kind === "failed");
  if (failed.length) throw new AssertionFailure(`${failed.length} measured gate failure(s) and ${assessment.blockers.length - failed.length} unverified gate(s)`, { evidencePath, blockers: assessment.blockers });
  throw new IncompleteEvidence(`${assessment.blockers.length} gate(s) remain unverified`, { evidencePath, blockers: assessment.blockers });
}

/**
 * The PC-06 human-approval evidence, measured when it can exist — which is only here.
 *
 * WHY NOT IN SETUP. Setup runs BEFORE the approvals it would need to record. Its snapshot of the
 * approval history is a snapshot of an absence, and reusing it as approval evidence would be
 * recording the impossible: a human decision captured before the human was asked. So setup asserts
 * the snapshot is EMPTY (which is what proves this approval came later, against a plan that could be
 * inspected), and the approval itself is read here, after the protected jobs have run.
 *
 * A measurement failure is recorded as `measured: false` with its reason. It is never written down
 * as "no approval": {@link assessEvidence} turns an unmeasured approval into an UNVERIFIED blocker,
 * which is a different verdict from a refused one and must stay that way.
 */
export async function collectApprovalEvidence({ request, runId, attempt, ctx, now = () => new Date() }) {
  const dispatcher = String(ctx?.intent?.dispatcher ?? "") || null;
  const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/approvals`);
  const history = summarizeApprovals(response);
  const jobs = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}&page=1`);
  const jobsMeasured = jobs.status === 200 && Array.isArray(jobs.body?.jobs);
  const environments = {};
  for (const spec of PROTECTED_JOBS) {
    const approvals = history.measured
      ? history.entries.filter((entry) => entry.state === "approved" && entry.environments.includes(spec.environment))
      : [];
    const job = jobsMeasured ? jobs.body.jobs.find((entry) => String(entry?.name ?? "") === spec.name) : null;
    environments[spec.environment] = {
      job: spec.id,
      approval_measured: history.measured,
      approval_measurement_reason: history.measured ? null : history.reason,
      approved: history.measured ? approvals.length > 0 : null,
      // The APPROVER, which is the human evidence. The dispatcher is a separate identity and may be
      // an App; an approval by the dispatcher is a self-review and is reported as one.
      reviewers: approvals.map((entry) => ({
        login: entry.reviewer_login, type: entry.reviewer_type,
        is_dispatcher: dispatcher !== null && entry.reviewer_login === dispatcher,
      })),
      job_state_measured: jobsMeasured,
      // `null` when the jobs list could not be read, and "uncreated" when the job is genuinely
      // absent. Neither is collapsed into a state, because "never ran" and "we could not look" are
      // different facts and only one of them is about the subject.
      job_status: jobsMeasured ? String(job?.status ?? "uncreated") : null,
      job_conclusion: jobsMeasured ? (job?.conclusion === undefined ? null : String(job?.conclusion ?? "none")) : null,
    };
  }
  return {
    schema_version: RESULT_SCHEMA_VERSION, phase: "approvals", run_id: String(runId), attempt: String(attempt),
    workflow_sha: ctx.workflowSha, collected_at: now().toISOString(),
    dispatcher, dispatcher_is_the_approver: Object.values(environments).some((entry) => entry.reviewers.some((reviewer) => reviewer.is_dispatcher)),
    approval_history: history, environments,
    note: "This records the approvals GitHub itself holds for this run. It is not evidence that the environments' reviewer/self-review/branch-policy CONTROLS were tested; those are the PC-06 negative controls.",
  };
}

/**
 * `collect` is the one evidence phase that TALKS TO THE PROVIDER, because the human approval it must
 * record does not exist in any file this harness wrote. It gathers, writes the approval evidence,
 * and then runs the same assessment as `check-evidence` — which stays purely offline, so the
 * authoritative completeness check reads only durable evidence and can be re-run by a reviewer who
 * never touches a credential.
 */
export async function runCollectPhase({ runId, attempt, evidenceDir, env = process.env, deps = {} }) {
  const session = await openLocalSession({ runId, attempt, evidenceDir, env, deps });
  const { dir, ctx, request, lock } = session;
  try {
    const approvals = await collectApprovalEvidence({ request, runId, attempt, ctx, now: deps.now });
    writeEvidenceFile(dir, evidenceSlug(runId, attempt, "approvals"), approvals);
    return evidenceResult({ runId, attempt, phase: "collect", dir, deps });
  } finally {
    lock.release();
  }
}

export function runCheckEvidencePhase({ runId, attempt, evidenceDir, deps = {} }) {
  return evidenceResult({ runId, attempt, phase: "check-evidence", dir: assertPrivateDirectory(evidenceDir), deps });
}

// ──────────────────────────────────────────────────────────────────────────────
// 15. The closed CLI.
// ──────────────────────────────────────────────────────────────────────────────

const FLAGS = Object.freeze(["--run-id", "--attempt", "--evidence-dir"]);

/**
 * A closed interface: one phase word and exactly three flags. There is deliberately no ref, repo,
 * URL, endpoint or actor override — the actor is fixed by the protected job or the verified local
 * identity, and every target is derived. An unknown flag exits 2 before anything else happens.
 */
export function parseArgs(argv) {
  const args = [...argv];
  const phase = args.shift();
  if (!PHASES.includes(phase)) throw new UsageError(`usage: policy-commissioning.mjs <${PHASES.join("|")}> --run-id <n> --attempt <n> --evidence-dir <dir>`);
  const values = {};
  while (args.length) {
    const flag = args.shift();
    if (!FLAGS.includes(flag)) throw new UsageError(`unknown argument ${JSON.stringify(String(flag))}`);
    if (values[flag] !== undefined) throw new UsageError(`${flag} was given more than once`);
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    values[flag] = value;
  }
  for (const flag of FLAGS) if (values[flag] === undefined) throw new UsageError(`${flag} is required`);
  const { runId, attempt } = assertRunIdentity(values["--run-id"], values["--attempt"]);
  const evidenceDir = values["--evidence-dir"];
  if (!path.isAbsolute(evidenceDir)) throw new UsageError("--evidence-dir must be an absolute local directory");
  if (/[\0\n]/.test(evidenceDir)) throw new UsageError("--evidence-dir is not a plain local path");
  return { phase, runId, attempt, evidenceDir };
}

export async function runPhase({ phase, runId, attempt, evidenceDir, env = process.env, deps = {} }) {
  if (phase === "intent") return runIntentPhase({ runId, attempt, evidenceDir, env, deps });
  if (phase === "setup") return runSetupPhase({ runId, attempt, evidenceDir, env, deps });
  if (phase === "human-tests") return runHumanTestsPhase({ runId, attempt, evidenceDir, env, deps });
  if (phase === "normal-tests") return runCloudTestsPhase({ role: "normal", runId, attempt, evidenceDir, env, deps });
  if (phase === "emergency-tests") return runCloudTestsPhase({ role: "emergency", runId, attempt, evidenceDir, env, deps });
  if (phase === "collect") return runCollectPhase({ runId, attempt, evidenceDir, env, deps });
  if (phase === "cleanup") return runCleanupPhase({ runId, attempt, evidenceDir, env, deps });
  if (phase === "check-evidence") return runCheckEvidencePhase({ runId, attempt, evidenceDir, deps });
  throw new UsageError(`unsupported commissioning phase ${JSON.stringify(String(phase))}`);
}

const EXIT_STATUS = Object.freeze({ 1: "failed", 2: "refused", 3: "incomplete" });

/**
 * Emits exactly ONE closed sanitized JSON object and returns the process exit code. The redactor
 * runs over the serialized output, not only over the pieces we expected to be risky: the failure
 * paths that matter are the ones a provider or a subprocess wrote.
 */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const write = deps.write ?? ((text) => process.stdout.write(text));
  const redact = createRedactor(collectSentinels(env));
  let parsed = null;
  try {
    parsed = parseArgs(argv);
    const result = await runPhase({ ...parsed, env, deps });
    write(`${redact(JSON.stringify(result, null, 2))}\n`);
    return 0;
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    const payload = closedResult({
      runId: parsed?.runId ?? "0", attempt: parsed?.attempt ?? "0",
      phase: parsed?.phase ?? "unknown", status: EXIT_STATUS[exitCode] ?? "failed",
      evidencePath: error?.detail?.evidencePath ?? null,
      extra: {
        errors: [redact(error instanceof Error ? error.message : String(error))],
        ...(error?.detail?.blockers ? { blockers: error.detail.blockers } : {}),
      },
    });
    write(`${redact(JSON.stringify(payload, null, 2))}\n`);
    return exitCode;
  }
}

export function isDirectEntry(entry = process.argv[1], moduleUrl = import.meta.url) {
  return directEntry(moduleUrl, entry);
}

if (isDirectEntry()) {
  main().then((code) => { process.exitCode = code; });
}
