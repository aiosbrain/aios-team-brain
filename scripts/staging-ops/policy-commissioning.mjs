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
/**
 * ⚠️ `release-controller.mjs` is DELIBERATELY NOT IMPORTED AT MODULE SCOPE (F1).
 *
 * It eagerly imports `jose`, and this module is the entrypoint for jobs that install NOTHING: the
 * witness publisher runs with no `npm ci` by design, because the one job whose whole purpose is to
 * move bytes it did not compute should not carry a dependency tree. A static import here therefore
 * made the publisher exit 1 with `ERR_MODULE_NOT_FOUND: Cannot find package 'jose'` at module load —
 * before admission, before envelope validation, before anything could refuse honestly — which
 * blocked every witness publication including the prerequisite transport rehearsal's response.
 *
 * The fix is a LAZY resolution at the one call site that actually exchanges a credential
 * ({@link mintActorCredential}), not a second token implementation: `createInstallationToken` stays
 * the only installation-token path and its behaviour is unchanged. The rule this encodes is that
 * this module's STATIC import closure must remain node built-ins plus dependency-free repository
 * modules; anything needing a package is resolved inside admitted credential-bearing execution.
 * `test/staging-policy-commissioning.test.ts` runs the actual fixed publisher command from a clean
 * archive with no `node_modules`, because a string assertion that the workflow contains no npm
 * command does not establish this property.
 */
const resolveInstallationTokenHelper = async () => (await import("./release-controller.mjs")).createInstallationToken;
import {
  acquireJournalLock, assertPrivateDirectory, openJournal, readJournal, recordWitnessEventOnce,
  writeJournalSnapshot,
} from "./commissioning-journal.mjs";
import {
  CHALLENGE_DIRECTIONS, CLOUD_CASE_SEQUENCE, COMMISSION_DOMAIN,
  REHEARSAL_CASE_ID, REHEARSAL_DOMAIN, REHEARSAL_ROLE, REHEARSAL_TARGET,
  REQUIRED_WITNESS_PUBLICATIONS, assertCaseStage, bytesDigest, caseOrdinal, freshNonce,
  nonceDigest, openCaseStateStore, roleForCase,
} from "./commissioning-case.mjs";
import {
  BINDING_FIELDS,
  CHALLENGE_TTL_MS, MAX_ARCHIVE_BYTES, MAX_DISPATCH_ENVELOPE_BYTES, MAX_ENTRY_BYTES,
  MAX_OBSERVATION_TO_MUTATION_MS, MAX_POLICY_READ_SPAN_MS, MAX_WITNESS_PROCESS_MS, OWNER_LOGIN,
  OWNER_USER_ID, OWNER_USER_TYPE, POLL_INTERVAL_MS, PUBLISHER_DISCOVERY_CEILING, REHEARSAL_JOB_ID,
  WITNESS_ENTRY_NAME, WITNESS_JOB_ID, WITNESS_MAX_PAGES, WITNESS_MODES, WITNESS_PAGE_SIZE,
  assertChallengeShape, assertObservationProximity, assertPublisherArtifactProvenance,
  assertPublisherContext, assertResponseBinding, assertResponseShape, buildChallenge, buildGovernedSnapshot,
  buildResponse, bytesSha256, canonicalHash as witnessCanonicalHash, canonicalJson as witnessCanonicalJson,
  challengeArtifactName, mutationRequestClass, publishWitnessResponse, readSingleEntryZip, readWitnessEnvelopeFromEvent,
  responseArtifactName, serializeDispatchEnvelope, validateGovernedSnapshot,
} from "./commissioning-witness.mjs";
import {
  OFFBRANCH_CONTROL, OFFBRANCH_SCHEMA_VERSION, PROBE_BRANCH, PROBE_ENVIRONMENTS, PROBE_REF, PROBE_REPOSITORY,
  PROBE_WORKFLOW_FILE, PROBE_WORKFLOW_PATH, commissioningIdentity, crossCheckOffBranchPair, probeJournalName,
  validateOffBranchRecord,
} from "./offbranch-probe.mjs";

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
  "intent", "setup", "human-tests", "normal-tests", "emergency-tests", "collect", "cleanup", "check-evidence", "witness",
]);

/**
 * THE CLOSED ROLE TABLE (PC-02/F7). Role, public finalizer phase, `GITHUB_JOB` and environment are
 * DISTINCT FIELDS, and the previous build's bug was to treat two of them as one.
 *
 * `PHASE_JOBS` used to be keyed by the PHASE word (`normal-tests`) while `runCloudTestsPhase` looked
 * it up by the ROLE word (`normal`). Both lookups returned `undefined`, and the guard was written
 * `if (expectedJob) …` — so the one check that stops a protected role from running in a job that was
 * never reviewed to hold its key silently did nothing, for either role. The lesson is not "fix the
 * key"; it is that a lookup which can return `undefined` must never gate a credential. Hence
 * {@link assertRoleBinding}, which refuses a role it does not know rather than skipping the check.
 */
export const ROLE_BINDINGS = Object.freeze({
  normal: Object.freeze({ role: "normal", finalizer_phase: "normal-tests", job: "normal", environment: "staging-release", mode: "commission", actor: true }),
  emergency: Object.freeze({ role: "emergency", finalizer_phase: "emergency-tests", job: "emergency", environment: "staging-emergency", mode: "commission", actor: true }),
  // Non-actor roles. Neither may pass actor credential admission, and saying so here — rather than
  // in a conditional at the call site — is what makes that a property of the table.
  intent: Object.freeze({ role: "intent", finalizer_phase: "intent", job: "intent", environment: null, mode: "commission", actor: false }),
  fixture: Object.freeze({ role: "fixture", finalizer_phase: null, job: "fixture", environment: null, mode: "commission", actor: false }),
  "witness-publisher": Object.freeze({ role: "witness-publisher", finalizer_phase: null, job: WITNESS_JOB_ID, environment: null, mode: "policy-witness", actor: false }),
  rehearsal: Object.freeze({ role: REHEARSAL_ROLE, finalizer_phase: null, job: REHEARSAL_JOB_ID, environment: null, mode: "transport-rehearsal", actor: false }),
});

/** The two roles that hold an App key. Everything else is refused actor admission by name. */
export const ACTOR_ROLES = Object.freeze(["normal", "emergency"]);

/**
 * Re-exported so the guard suites and the docs read ONE definition of each.
 *
 * The workflow guard asserts the YAML's per-case steps against `CLOUD_CASE_SEQUENCE` and the
 * publication count against `REQUIRED_WITNESS_PUBLICATIONS`; a second hand-copied list would be the
 * exact drift those guards exist to catch.
 */
export {
  CLOUD_CASE_SEQUENCE, REQUIRED_WITNESS_PUBLICATIONS, REHEARSAL_CASE_ID, REHEARSAL_ROLE,
  COMMISSION_STAGES, REHEARSAL_STAGES, CASE_STAGES, caseOrdinal, roleForCase,
} from "./commissioning-case.mjs";
export {
  OWNER_LOGIN, OWNER_USER_ID, OWNER_USER_TYPE, WITNESS_JOB_ID, REHEARSAL_JOB_ID, WITNESS_MODES,
  MAX_DISPATCH_ENVELOPE_BYTES, MAX_ARCHIVE_BYTES, MAX_ENTRY_BYTES, CHALLENGE_TTL_MS,
  MAX_POLICY_READ_SPAN_MS, MAX_OBSERVATION_TO_MUTATION_MS, PUBLISHER_DISCOVERY_CEILING,
  challengeArtifactName, formatChallengeArtifactName, responseArtifactName, readSingleEntryZip, projectGovernedRuleset,
  buildChallenge, buildResponse, assertResponseBinding, serializeDispatchEnvelope,
  validateGovernedSnapshot, assertPublisherContext, assertPublisherArtifactProvenance,
  readWitnessEnvelopeFromEvent, publishWitnessResponse, buildGovernedSnapshot, crc32,
  assertChallengeShape, assertResponseShape, assertObservationProximity, WITNESS_ENTRY_NAME,
  GOVERNED_RULE_PARAMETERS, EXCLUDED_RULESET_FIELDS, BINDING_FIELDS, POLL_INTERVAL_MS,
  MAX_WITNESS_PROCESS_MS, mutationRequestClass,
} from "./commissioning-witness.mjs";

/**
 * Resolve a role's complete binding, or refuse.
 *
 * Every field is required to be present, so an incomplete row is a build failure rather than a
 * skipped check. This is the function every credential path calls before it touches a secret.
 */
export function assertRoleBinding(role) {
  const binding = ROLE_BINDINGS[String(role)];
  if (!binding) throw new UsageError(`commissioning has no role binding for ${JSON.stringify(String(role))}; a role without a reviewed job binding is refused before any credential`);
  if (!binding.job || !binding.mode) throw new UsageError(`the commissioning role binding for ${String(role)} is incomplete`);
  if (binding.actor && !binding.environment) throw new UsageError(`the commissioning actor role ${String(role)} declares no protected environment`);
  return binding;
}

/** Kept as the phase → job projection of the table above, derived rather than retyped. */
export const PHASE_JOBS = Object.freeze(Object.fromEntries(
  Object.values(ROLE_BINDINGS).filter((binding) => binding.finalizer_phase).map((binding) => [binding.finalizer_phase, binding.job]),
));

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
 * The two NON-PROTECTED transport jobs' DISPLAY names (F11).
 *
 * Same reason as {@link PROTECTED_JOBS}: `/jobs` reports the display name, so matching on the job
 * ID finds nothing and "no job found" would read as a refusal rather than a bug. These exist
 * because the rehearsal previously admitted itself by COUNTING one non-skipped job, which says
 * nothing about which job that was. The workflow guard asserts both strings against the YAML.
 */
/**
 * The credential-free intent job's DISPLAY name, and the artifact it publishes.
 *
 * Both are fixed by the reviewed workflow. The publisher derives the artifact name from the run and
 * attempt it MEASURED, never from a string in the envelope it was handed.
 */
export const INTENT_JOB_NAME = "Commissioning intent (credential-free)";
export const intentArtifactName = (runId, attempt) => `policy-commissioning-intent-${String(runId)}-${String(attempt)}`;
export const intentArtifactEntry = (runId, attempt) => `commissioning-${String(runId)}-${String(attempt)}-intent.json`;

export const WITNESS_JOB_NAME = "Local policy witness publisher (no secrets)";
export const REHEARSAL_JOB_NAME = "Transport rehearsal (inert, no secrets)";

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
/**
 * The CANONICAL bounded pagination: at most 10 pages of 100 per endpoint, from ONE definition (F15).
 *
 * This build permitted 20 and a test blessed 20, which is not the accepted contract — and a limit
 * that differs from the one the contract states is not a safety bound, it is a second contract. The
 * witness module states the same two numbers for its own reads; both are re-exported so the guard
 * suites assert one pair of values rather than three copies.
 */
const MAX_PAGES = WITNESS_MAX_PAGES;
const PAGE_SIZE = WITNESS_PAGE_SIZE;
export { WITNESS_MAX_PAGES as MAX_PAGES, WITNESS_PAGE_SIZE as PAGE_SIZE } from "./commissioning-witness.mjs";
/** The canonical job/process bound the workflow's `timeout-minutes` must equal (F15). */
export const MAX_JOB_MINUTES = 30;

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

/**
 * THE ONE PROVIDER-IDENTIFIER PARSER (F7). Positive integer, or `null`. Never `0`.
 *
 * ── WHY A ONE-LINE NULL GUARD WOULD NOT HAVE BEEN ENOUGH ────────────────────────────────────────
 *
 * The create paths deliberately persist `id: null` / `number: null` when a response carries no
 * identity — that is correct, and it is what makes a lost response distinguishable from a refused
 * one. Recovery then applied `Number(...)`, and `Number(null)` is `0`, which is an INTEGER. So
 * `Number.isInteger(id)` was true, the discovery branch was skipped, and the two recovery paths did
 * the two worst things available to them: the ruleset path issued a forbidden `/rulesets/0` with no
 * provider read behind it, and the pull-request path journalled an OWNED pull request number zero
 * without making a single provider call. Both are reproduced from the production-shaped intent and
 * result stream.
 *
 * The original create code had the same shape from the other side: it treated ANY integer as an
 * identity, zero included. So the fix is one parser, used by creation, recovery, unresolved
 * accounting and cleanup alike — every place an identity is read out of a provider body or a
 * journal record — and the ABSENCE of an identity is a distinct, preserved state rather than a
 * number that happens to be falsy.
 */
export function positiveProviderId(value) {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  // A decimal STRING is the other shape a provider and a journal both produce. Anything else —
  // `null`, `undefined`, a float, a negative, `"0"`, `"1e3"`, an object — is an absent identity.
  if (typeof value === "string" && POSITIVE_DECIMAL.test(value)) return Number(value);
  return null;
}

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
/**
 * The DEFAULT query allowlist. Pagination and nothing else.
 *
 * An operation may widen it only by declaring its own `query` set, and the artifact lookup is the one
 * that does: `?name=` is what makes discovery deterministic instead of "take the newest artifact
 * whose name looks right", which is the selection rule the canonical revision forbids.
 */
const ALLOWED_QUERY_KEYS = Object.freeze(["per_page", "page"]);

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
export const ALLOWED_REQUEST_SCOPES = Object.freeze([`/repos/${REPO}`, `/orgs/${ORG}`, "/user", "/installation", "/app"]);

/** The workflow FILE name the dispatch API addresses. The path form would need `%2F` escaping. */
export const COMMISSIONING_WORKFLOW_FILE = "release-policy-commissioning.yml";

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
  { id: "read-repository", method: "GET", roles: ["local", "normal", "emergency", "fixture", "rehearsal", "witness-publisher", "probe"], path: `/repos/${REPO}`, body: noBody },
  { id: "read-viewer", method: "GET", roles: ["local", "probe"], path: "/user", body: noBody },
  { id: "read-collaborator-permission", method: "GET", roles: ["local", "probe"], pattern: new RegExp(`^/repos/${R}/collaborators/[A-Za-z0-9-]{1,39}/permission$`), body: noBody },
  // The token-side binding: which repositories THIS installation token can actually reach. Its
  // documented response is `total_count` + `repositories` and nothing else — notably NOT
  // `repository_selection`, which is installation metadata and is read from the JWT endpoint below.
  { id: "read-installation-repositories", method: "GET", roles: ["normal", "emergency"], path: "/installation/repositories", body: noBody },

  // ── the App's own GRANTS, read with the App JWT BEFORE any credential is exercised (PC-04) ────
  // `GET /app` reports the App's identity and its declared permissions; `GET /app/installations/<id>`
  // reports that installation's `app_id`, `permissions`, `repository_selection` and `suspended_at`.
  // Both are reads, both are refusable before a single write, and neither needs the private key to
  // leave the protected job.
  { id: "read-app", method: "GET", roles: ["normal", "emergency"], path: "/app", body: noBody },
  {
    id: "read-app-installation", method: "GET", roles: ["normal", "emergency"],
    pattern: /^\/app\/installations\/([1-9][0-9]{0,17})$/,
    // Bound to the ONE installation this job holds credentials for. Without this the endpoint would
    // read any installation of the App, including one on a repository outside this run's scope.
    check: (match, ctx) => {
      if (!POSITIVE_DECIMAL.test(String(ctx.installationId ?? ""))) throw new UsageError("an App installation read needs this job's own measured installation ID");
      if (match[1] !== String(ctx.installationId)) throw new UsageError("commissioning reads only the installation this job holds credentials for");
    },
    body: noBody,
  },
  // ATTEMPT-scoped, and there is deliberately no run-scoped counterpart: `/actions/runs/<id>`
  // describes the LATEST attempt, so reading it would silently describe a rerun rather than the
  // attempt whose derived resources this run owns.
  // ATTEMPT-scoped for the ORIGINAL run, and also how every witness-transport participant measures a
  // run's identity: the publisher checks its own, the local witness checks the publisher's, and the
  // actor checks the publisher run that owns the artifact it is about to consume.
  { id: "read-workflow-run-attempt", method: "GET", roles: ["local", "normal", "emergency", "rehearsal", "witness-publisher", "probe"], pattern: new RegExp(`^/repos/${R}/actions/runs/[1-9][0-9]{0,17}/attempts/[1-9][0-9]{0,17}$`), body: noBody },
  { id: "read-workflow-run-jobs", method: "GET", roles: ["local", "normal", "emergency", "rehearsal", "witness-publisher", "probe"], pattern: new RegExp(`^/repos/${R}/actions/runs/[1-9][0-9]{0,17}/attempts/[1-9][0-9]{0,17}/jobs$`), body: noBody },
  { id: "read-workflow-run-approvals", method: "GET", roles: ["local", "probe"], pattern: new RegExp(`^/repos/${R}/actions/runs/[1-9][0-9]{0,17}/approvals$`), body: noBody },

  // ── the F1 witness transport: artifacts in, one bounded dispatch out ───────────────────────────
  // Discovery is by EXACT NAME, which is why `name` is the one query key widened beyond pagination.
  // "List and take the newest match" is the selection rule the canonical revision forbids, and a
  // deterministic name plus a refusal on duplicates is what replaces it.
  {
    id: "list-artifacts-by-name", method: "GET", roles: ["local", "normal", "emergency", "rehearsal", "witness-publisher"],
    path: `/repos/${REPO}/actions/artifacts`, query: Object.freeze(["per_page", "page", "name"]), body: noBody,
  },
  {
    // A BINARY read, bounded by {@link MAX_ARCHIVE_BYTES} at the transport and re-checked by the
    // single-entry archive reader. It is the one operation whose response is not JSON.
    id: "download-artifact-archive", method: "GET", roles: ["local", "normal", "emergency", "rehearsal", "witness-publisher"],
    pattern: new RegExp(`^/repos/${R}/actions/artifacts/[1-9][0-9]{0,17}/zip$`), body: noBody,
  },
  {
    // The ONE write the local witness makes, and it writes no repository state: it dispatches THIS
    // reviewed workflow, at the fixed branch, in the one mode whose only admitted job is the
    // non-protected publisher. There is no ref, repo, workflow or code selection to supply.
    id: "dispatch-witness-workflow", method: "POST", roles: ["local"],
    path: `/repos/${REPO}/actions/workflows/${COMMISSIONING_WORKFLOW_FILE}/dispatches`,
    body: (body) => {
      const keys = Object.keys(body ?? {}).sort();
      if (canonicalJson(keys) !== canonicalJson(["inputs", "ref"])) throw new UsageError("a witness dispatch carries exactly a ref and its closed inputs");
      if (body.ref !== branchOf(COMMISSIONING_DISPATCH_REF)) throw new UsageError(`a witness dispatch runs only at ${branchOf(COMMISSIONING_DISPATCH_REF)}`);
      const inputs = body.inputs;
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new UsageError("a witness dispatch needs its closed inputs object");
      const inputKeys = Object.keys(inputs).sort();
      if (canonicalJson(inputKeys) !== canonicalJson(["mode", "witness_envelope"])) throw new UsageError("a witness dispatch supplies exactly the mode and the witness envelope");
      if (inputs.mode !== "policy-witness") throw new UsageError("the local witness dispatches only policy-witness mode; it never dispatches a commissioning or rehearsal run");
      if (typeof inputs.witness_envelope !== "string" || !inputs.witness_envelope.trim()) throw new UsageError("a witness dispatch needs its envelope as a string");
      // Bounded AFTER serialization, including JSON overhead — the transport-crosscheck's note.
      const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
      if (bytes > MAX_DISPATCH_ENVELOPE_BYTES) throw new UsageError(`a witness dispatch envelope is bounded to ${MAX_DISPATCH_ENVELOPE_BYTES} serialized bytes`);
      return true;
    },
  },

  // ── baseline reads. Production refs and protections are READ here and never written. ─────────
  { id: "read-main-ref", method: "GET", roles: ["local"], path: `/repos/${REPO}/git/ref/heads/main`, body: noBody },
  {
    // WIDENED, deliberately and minimally (F3). Every participant in the witness transport has to be
    // able to resolve the live dispatch branch and compare it to the immutable trusted source: the
    // canonical requires that check at original dispatch, at local witness dispatch, at publisher
    // execution and at response consumption, and a role that cannot READ `staging` cannot make it.
    // This is a fixed read-only GET of one hardcoded ref — it grants no target and no write, and it
    // is the only admission this correction adds. See {@link assertSourceContinuity}.
    id: "read-staging-ref", method: "GET", roles: ["local", "normal", "emergency", "rehearsal", "witness-publisher", "probe"],
    path: `/repos/${REPO}/git/ref/heads/staging`, body: noBody,
  },
  { id: "read-main-protection", method: "GET", roles: ["local"], path: `/repos/${REPO}/branches/main/protection`, body: noBody },
  { id: "read-main-applicable-rules", method: "GET", roles: ["local"], path: `/repos/${REPO}/rules/branches/main`, body: noBody },
  // PC-07's protection scope is main AND staging: staging is the dispatch branch and the
  // contribution base, and a run that changed its protection while measuring only main would report
  // "production unchanged" about half of production.
  { id: "read-staging-protection", method: "GET", roles: ["local"], path: `/repos/${REPO}/branches/staging/protection`, body: noBody },
  { id: "read-staging-applicable-rules", method: "GET", roles: ["local"], path: `/repos/${REPO}/rules/branches/staging`, body: noBody },
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
    // LOCAL only. The classic-protection dimension is measured by the operator, who holds admin —
    // see `assertPlannedPolicyInForce` for why the protected jobs deliberately do not read it.
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
  {
    // RECONCILIATION ONLY (F5): find the synthetic pull request a lost create response may have made,
    // rather than POSTing a second one. The whole query string must be EXACTLY the one derived from
    // this run's own head ref — not merely composed of allowed keys — so this cannot become a way to
    // enumerate the repository's pull requests.
    id: "list-synthetic-pulls-by-head", method: "GET", roles: ["local"],
    path: `/repos/${REPO}/pulls`, query: Object.freeze(["per_page", "page", "state", "head"]),
    check: (_match, ctx, query) => {
      const head = branchOf(derivedRef(ctx.runId, ctx.attempt, "pr-head"));
      const expected = `per_page=100&page=1&state=all&head=${ORG}:${head}`;
      if (String(query ?? "") !== expected) throw new UsageError("a synthetic pull-request reconciliation reads exactly this run's own derived head, and nothing else");
    },
    body: noBody,
  },

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
    // The head-SHA condition is REQUIRED, not optional. It is the provider-side half of the
    // retarget guard: if the pull request's head moved between the readback and this call, GitHub
    // itself refuses with 409 rather than merging something nobody measured.
    body: (body, ctx) => {
      const keys = Object.keys(body ?? {});
      if (keys.length !== 1 || keys[0] !== "sha") throw new UsageError("the synthetic merge attempt takes exactly the measured head SHA and nothing else");
      if (!knownSha(body.sha, ctx)) throw new UsageError("the synthetic merge may only be conditioned on a commit this run created");
      return true;
    },
  },
  {
    id: "close-synthetic-pull", method: "PATCH", roles: ["local"],
    pattern: new RegExp(`^/repos/${R}/pulls/([1-9][0-9]{0,9})$`),
    check: (match, ctx) => { if (Number(match[1]) !== ctx.pullNumber) throw new UsageError("only this run's own synthetic pull request may be closed"); },
    body: (body) => { if (body?.state !== "closed" || Object.keys(body).length !== 1) throw new UsageError("the synthetic pull request may only be closed"); return true; },
  },

  // ── PC-06's staged off-branch probe: the `probe` role, and ONLY that role ─────────────────────
  // Every target below is a fixed literal or an identity this probe already journaled — the one
  // workflow, the one disposable ref, the probe run it reconciled, the check runs that run's own jobs
  // named, the two protected environments. Nothing here reaches another ref, run, check or endpoint,
  // no row takes a caller-chosen URL, and the commissioning roles gain none of these rows.
  ...probeOperations(),
]);

/**
 * The staged probe's closed operations (accepted PC-06 API-only design). A function only so the
 * table above can spread them; every row is static and names fixed literals.
 */
function probeOperations() {
  const pageQuery = (query, prefix) => {
    const match = new RegExp(`^${prefix}per_page=${PAGE_SIZE}&page=([1-9][0-9]?)$`).exec(String(query ?? ""));
    if (!match || Number(match[1]) > MAX_PAGES) throw new UsageError(`a probe read is paged at exactly ${PAGE_SIZE} per page within ${MAX_PAGES} pages`);
  };
  const ownRun = (match, ctx) => {
    if (!POSITIVE_DECIMAL.test(String(ctx.probeRunId ?? "")) || match[1] !== String(ctx.probeRunId)) {
      throw new UsageError("a probe run read or cancellation names only the one probe run this probe journaled");
    }
  };
  const ownCheck = (match, ctx) => {
    if (!(ctx.probeCheckIds instanceof Set) || !ctx.probeCheckIds.has(match[1])) {
      throw new UsageError("a probe check read names only a check run the probe's own jobs linked");
    }
  };
  const environment = `(${PROBE_ENVIRONMENTS.map(literal).join("|")})`;
  return [
    { id: "read-probe-ref", method: "GET", roles: ["probe"], path: `/repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`, body: noBody },
    {
      id: "create-probe-ref", method: "POST", roles: ["probe"], path: `/repos/${REPO}/git/refs`,
      body: (body, ctx) => {
        if (canonicalJson(Object.keys(body ?? {}).sort()) !== canonicalJson(["ref", "sha"])) throw new UsageError("a probe ref is created with exactly its ref and SHA");
        if (body.ref !== PROBE_REF) throw new UsageError("only the one fixed probe ref may be created");
        if (!isSha(body.sha) || body.sha !== ctx.probeSha) throw new UsageError("the probe ref is created only at the reviewed commissioning source");
        return true;
      },
    },
    {
      id: "dispatch-probe-workflow", method: "POST", roles: ["probe"], path: `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/dispatches`,
      body: (body) => {
        if (canonicalJson(body) !== canonicalJson({ ref: PROBE_BRANCH })) throw new UsageError("the probe dispatch carries exactly the fixed probe ref and no inputs");
        return true;
      },
    },
    { id: "read-probe-workflow", method: "GET", roles: ["probe"], path: `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}`, body: noBody },
    {
      id: "read-probe-workflow-source", method: "GET", roles: ["probe"], path: `/repos/${REPO}/contents/${PROBE_WORKFLOW_PATH}`, query: Object.freeze(["ref"]),
      check: (_match, ctx, query) => {
        if (!isSha(ctx.probeSha) || String(query ?? "") !== `ref=${ctx.probeSha}`) throw new UsageError("the probe workflow source is read only at the reviewed commissioning SHA");
      },
      body: noBody,
    },
    {
      id: "list-probe-runs", method: "GET", roles: ["probe"], path: `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`,
      query: Object.freeze(["branch", "event", "per_page", "page"]),
      check: (_match, _ctx, query) => pageQuery(query, `branch=${literal(PROBE_BRANCH)}&event=workflow_dispatch&`), body: noBody,
    },
    { id: "read-probe-run", method: "GET", roles: ["probe"], pattern: new RegExp(`^/repos/${R}/actions/runs/([1-9][0-9]{0,17})$`), check: ownRun, body: noBody },
    {
      id: "read-probe-run-jobs", method: "GET", roles: ["probe"], pattern: new RegExp(`^/repos/${R}/actions/runs/([1-9][0-9]{0,17})/jobs$`),
      query: Object.freeze(["filter", "per_page", "page"]),
      check: (match, ctx, query) => { ownRun(match, ctx); pageQuery(query, "filter=all&"); }, body: noBody,
    },
    { id: "cancel-probe-run", method: "POST", roles: ["probe"], pattern: new RegExp(`^/repos/${R}/actions/runs/([1-9][0-9]{0,17})/cancel$`), check: ownRun, body: noBody },
    { id: "read-probe-check-run", method: "GET", roles: ["probe"], pattern: new RegExp(`^/repos/${R}/check-runs/([1-9][0-9]{0,17})$`), check: ownCheck, body: noBody },
    {
      id: "read-probe-check-annotations", method: "GET", roles: ["probe"], pattern: new RegExp(`^/repos/${R}/check-runs/([1-9][0-9]{0,17})/annotations$`),
      check: (match, ctx, query) => { ownCheck(match, ctx); pageQuery(query, ""); }, body: noBody,
    },
    { id: "read-protected-environment", method: "GET", roles: ["probe"], pattern: new RegExp(`^/repos/${R}/environments/${environment}$`), body: noBody },
    {
      id: "list-environment-branch-policies", method: "GET", roles: ["probe"],
      pattern: new RegExp(`^/repos/${R}/environments/${environment}/deployment-branch-policies$`),
      check: (_match, _ctx, query) => pageQuery(query, ""), body: noBody,
    },
  ];
}

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
  for (const operation of ALLOWED_OPERATIONS) {
    if (operation.method !== verb) continue;
    const match = operation.path ? (operation.path === pathname ? [pathname] : null) : operation.pattern.exec(pathname);
    if (!match) continue;
    if (!operation.roles.includes(ctx.role)) {
      throw new UsageError(`the ${ctx.role} role may not issue ${operation.id}`);
    }
    // PER-OPERATION query allowlist. Pagination by default; anything wider is declared on the one
    // operation that needs it, so widening it for artifact lookup does not widen it everywhere.
    const allowedQuery = operation.query ?? ALLOWED_QUERY_KEYS;
    for (const pair of query ? query.split("&") : []) {
      const key = pair.split("=")[0];
      if (!allowedQuery.includes(key)) throw new UsageError(`commissioning refuses the query parameter ${JSON.stringify(key)}`);
    }
    operation.check?.(match, ctx, query);
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

/**
 * A redactor that can LEARN a secret it did not start with.
 *
 * The env sentinels are the App private keys. The two credentials that matter most at runtime — the
 * App JWT and the installation token — are minted mid-phase and exist in no environment variable, so
 * a redactor fixed at construction would not cover their literal values. `redact.add(value)` is
 * called the moment each is created, before it is ever handed to a transport. The generic JWT and
 * `gh*_` patterns below are the backstop, not the mechanism.
 */
export function createRedactor(sentinels = []) {
  const values = [...sentinels];
  const redact = (input) => {
    let out = String(input ?? "");
    for (const sentinel of values) {
      if (sentinel) out = out.split(sentinel).join("[redacted-commissioning-secret]");
    }
    out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]");
    out = out.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted-token]");
    out = out.replace(/(authorization:\s*(?:bearer|token)\s+)\S+/gi, "$1[redacted]");
    out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]");
    return out;
  };
  // Longest first, so a credential that contains another is masked whole rather than in pieces.
  redact.add = (value) => {
    const text = String(value ?? "");
    if (text.length >= 8 && !values.includes(text)) {
      values.push(text);
      values.sort((a, b) => b.length - a.length);
    }
    return redact;
  };
  return redact;
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
export async function runGhProcess(args, { input, timeoutMs = 20_000, spawnImpl = spawn, env = process.env, maxBytes = MAX_TRANSPORT_BYTES } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new UsageError("a gh request deadline must be 1..120000ms");
  const child = spawnImpl("gh", args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let terminated = null;
  let terminatedBy = null;
  const collect = (target) => (chunk) => {
    // Once the bound has tripped nothing more is buffered: the process is being killed, and the
    // bytes that race the kill are exactly the ones the bound exists to refuse.
    if (terminated) return;
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) { terminated = "output exceeded the commissioning transport maximum"; terminatedBy = "oversize"; child.kill("SIGKILL"); return; }
    target.push(value);
  };
  child.stdout?.on("data", collect(stdout));
  child.stderr?.on("data", collect(stderr));
  const timer = setTimeout(() => { if (!terminated) { terminated = `gh request exceeded ${timeoutMs}ms`; terminatedBy = "timeout"; } child.kill("SIGKILL"); }, timeoutMs);
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
  const raw = Buffer.concat(stdout);
  return {
    code: outcome.code,
    spawnError: outcome.spawnError ?? null,
    terminated,
    terminatedBy,
    stdout: raw.toString("utf8"),
    // The SAME bytes, unconverted. An artifact archive is binary, and `toString("utf8")` on a ZIP
    // silently replaces every invalid sequence — which reads as a corrupt archive rather than as the
    // decoding mistake it is.
    stdoutBytes: raw,
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
  // `headersComplete` is false when the stream stopped inside the head: a status line followed by
  // nothing is a response that never finished, not an empty body.
  return { status: status ? Number(status) : null, text: rest, headersComplete: index >= 0 };
}

/**
 * ── THE COMPLETED-RESPONSE CONTRACT: ONE OWNER, AT THE TRANSPORT (R02-1) ─────────────────────────
 *
 * Both JSON transports return `{status, body, diagnostic, complete, incomplete, measured_status}`,
 * and `complete: true` is a positive statement that ALL of these were measured:
 *
 *  - an HTTP status line and the end of the response head;
 *  - the whole body, collected under {@link MAX_TRANSPORT_BYTES} — collection stops at the bound,
 *    it is never buffered first and checked afterwards;
 *  - body completion: the fetch body stream ended without error, or the `gh` process exited with the
 *    code that goes with the status it printed (0 below 400; `gh` exits 1 on an HTTP error);
 *  - a valid UTF-8 body that parses as a JSON object or array — the only exception is a 204/205,
 *    which must be EMPTY, because an empty 204 is a complete answer and not a failed read;
 *  - the endpoint's documented success shape ({@link RESPONSE_SHAPES}, applied by the guard).
 *
 * Anything short of that is INCOMPLETE, and an incomplete response is normalised here — the only
 * place that saw the bytes — to status 0 with the reason retained. The measured status line stays on
 * the record as `measured_status` (provenance, never a class), and the provider text of an unfinished
 * body is never read as a diagnostic: a truncated "Cannot update this protected ref" is not a policy
 * denial. Downstream code cannot recover completion that was erased, so it is not erased: every
 * consumer that branches on `status` sees the one value that is decisive nowhere, and every decisive
 * class ({@link mutationRequestClass}) additionally requires `complete === true` on the record.
 */
export const RESPONSE_INCOMPLETE_REASONS = Object.freeze([
  "transport-timeout", "transport-unavailable", "headers-incomplete", "process-incomplete", "body-read-failed",
  "body-oversize", "body-encoding-invalid", "body-missing", "body-unexpected", "body-malformed", "shape-invalid",
  "completion-unstated",
]);

export function incompleteResponse(reason, measuredStatus = null) {
  const why = RESPONSE_INCOMPLETE_REASONS.includes(reason) ? reason : "transport-unavailable";
  const category = why === "transport-timeout" || why === "transport-unavailable" ? why : "response-incomplete";
  return {
    status: 0, body: null, complete: false, incomplete: why,
    measured_status: Number.isInteger(measuredStatus) && measuredStatus > 0 ? measuredStatus : null,
    diagnostic: { status: 0, category, ruleIds: [], policyDenial: false },
  };
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A status and the COMPLETE body bytes → a completed response, or an incomplete one. Never a guess. */
export function completedJsonResponse(status, bytes, redact = createRedactor(), { retainRaw = false } = {}) {
  if (!Number.isInteger(status) || status < 100 || status > 599) return incompleteResponse("headers-incomplete");
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length > MAX_TRANSPORT_BYTES) return incompleteResponse("body-oversize", status);
  let text;
  try { text = STRICT_UTF8.decode(buffer); } catch { return incompleteResponse("body-encoding-invalid", status); }
  if (status === 204 || status === 205) {
    if (buffer.length) return incompleteResponse("body-unexpected", status);
    return { status, body: null, complete: true, incomplete: null, measured_status: status, diagnostic: classifyDiagnostic(status, "") };
  }
  if (!text.trim()) return incompleteResponse("body-missing", status);
  let parsed;
  try { parsed = JSON.parse(text); } catch { return incompleteResponse("body-malformed", status); }
  if (parsed === null || typeof parsed !== "object") return incompleteResponse("body-malformed", status);
  // A provider error is a JSON OBJECT carrying its message; anything else is not an error body.
  if (status >= 400 && Array.isArray(parsed)) return incompleteResponse("body-malformed", status);
  return {
    status, body: status >= 400 ? null : parsed, complete: true, incomplete: null, measured_status: status,
    diagnostic: classifyDiagnostic(status, redact(text)),
    /**
     * OPT-IN raw retention, for the PC-06 probe collector only: the exact completed body text, so a
     * retained capture is the provider's bytes rather than a re-serialization. Never set on a body the
     * redactor would alter — that text is not retained, and the collector treats it as uncapturable.
     */
    ...(retainRaw ? { raw_text: redact(text) === text ? text : null } : {}),
  };
}

/**
 * The fetch body, read INCREMENTALLY and abandoned at the bound. A declared length beyond it is
 * refused before a byte is read; the running total is what actually stops the transfer, because a
 * declared length is exactly the value a broken or adversarial sender controls.
 */
async function readBoundedFetchBody(response, maxBytes) {
  const declared = Number(response?.headers?.get?.("content-length") ?? Number.NaN);
  const stream = response?.body;
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await stream?.cancel?.(); } catch { /* nothing to release */ }
    return { failure: "body-oversize" };
  }
  // The fetch standard's own representation of "this response has no body" (a 204, for instance).
  if (stream === null) return { bytes: Buffer.alloc(0) };
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > maxBytes) return { failure: "body-oversize" };
        chunks.push(chunk);
      }
    } catch {
      return { failure: "body-read-failed" };
    } finally {
      try { await reader.cancel(); } catch { /* an already-finished reader has nothing to cancel */ }
    }
    return { bytes: Buffer.concat(chunks, received) };
  }
  // A body with no readable stream (a test double). The read is still checked against the bound,
  // and a read that rejects is a failed read — never an empty body.
  try {
    const whole = typeof response?.arrayBuffer === "function" ? Buffer.from(await response.arrayBuffer()) : Buffer.from(String(await response.text()), "utf8");
    return whole.length > maxBytes ? { failure: "body-oversize" } : { bytes: whole };
  } catch {
    return { failure: "body-read-failed" };
  }
}

export function createLocalGhTransport({ spawnImpl = spawn, timeoutMs = 20_000, redact = createRedactor(), env = process.env, retainRaw = false } = {}) {
  return async (method, requestPath, body) => {
    const args = ["api", "-i", "--method", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", requestPath];
    if (body !== undefined && body !== null) args.push("--input", "-");
    const run = await runGhProcess(args, { input: body === undefined || body === null ? undefined : JSON.stringify(body), timeoutMs, spawnImpl, env });
    if (run.terminated) {
      redact(run.stderr);
      return incompleteResponse(run.terminatedBy === "oversize" ? "body-oversize" : "transport-timeout", parseGhResponse(run).status);
    }
    if (run.spawnError) return incompleteResponse("transport-unavailable");
    // Decoded STRICTLY from the raw bytes: the lossy `stdout` string replaces an invalid sequence
    // with U+FFFD, which would let a corrupted body parse as a different, valid one.
    let decoded;
    try { decoded = STRICT_UTF8.decode(run.stdoutBytes ?? Buffer.from(run.stdout ?? "", "utf8")); } catch { decoded = null; }
    const { status, text, headersComplete } = parseGhResponse({ stdout: decoded ?? run.stdout ?? "" });
    if (status === null) {
      // Never conflate "gh could not run" with "the provider refused". Both are exit-nonzero for
      // gh; only one is a statement about the policy. The captured output is redacted and dropped.
      redact(run.stderr);
      return incompleteResponse("transport-unavailable");
    }
    if (decoded === null) return incompleteResponse("body-encoding-invalid", status);
    if (!headersComplete) return incompleteResponse("headers-incomplete", status);
    // The process exit is part of the response: `gh` exits 0 for a success it finished and 1 for an
    // HTTP error. A success status followed by any other exit, or an error status followed by
    // anything but 0/1 (a signal, a crash), is a response that stopped part-way.
    const exitMatches = status < 400 ? run.code === 0 : run.code === 0 || run.code === 1;
    if (!exitMatches) { redact(run.stderr); return incompleteResponse("process-incomplete", status); }
    return completedJsonResponse(status, Buffer.from(text, "utf8"), redact, { retainRaw });
  };
}

/**
 * The LOCAL binary transport: `gh api` for an artifact archive, bytes preserved.
 *
 * `-i` is deliberately absent here, unlike every other local request. Interleaving headers with a ZIP
 * on one stream would mean parsing a binary body out of a text head, and an archive download that
 * fails is `inconclusive` in every case that uses it — it is never a statement about the policy — so
 * the exit code alone carries enough. The bound is applied by the collector, before the buffer grows.
 */
export function createLocalGhArchiveTransport({ spawnImpl = spawn, timeoutMs = 30_000, redact = createRedactor(), env = process.env, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  return async (method, requestPath) => {
    if (method !== "GET") throw new UsageError("the local archive transport reads only");
    const run = await runGhProcess(
      ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", requestPath],
      { timeoutMs, spawnImpl, env, maxBytes },
    );
    if (run.terminated || run.spawnError || run.code !== 0) {
      redact(run.stderr);
      return { status: 0, bytes: null, diagnostic: { status: 0, category: run.terminated ? "transport-timeout" : "transport-unavailable", ruleIds: [], policyDenial: false } };
    }
    return { status: 200, bytes: run.stdoutBytes, diagnostic: { status: 200, category: "ok", ruleIds: [], policyDenial: false } };
  };
}

export function createTokenTransport({ token, fetchImpl = fetch, timeoutMs = 15_000, baseUrl = "https://api.github.com", redact = createRedactor(), maxBytes = MAX_TRANSPORT_BYTES }) {
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
      return incompleteResponse(timedOut ? "transport-timeout" : "transport-unavailable");
    }
    const status = Number(response?.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) return incompleteResponse("headers-incomplete");
    // A body read that rejects, or one that crosses the bound, is an unfinished response — never an
    // empty one. This used to become `""`, and a 200 with no body then classified as `accepted`.
    const read = await readBoundedFetchBody(response, maxBytes);
    if (read.failure) return incompleteResponse(read.failure, status);
    return completedJsonResponse(status, read.bytes, redact);
  };
}

/**
 * The ONE binary transport, for artifact archives, bounded before a byte is buffered.
 *
 * Separate from {@link createTokenTransport} because everything else in this harness is JSON and the
 * JSON transport must not learn to return opaque bytes. `redirect: "error"` matters more here than
 * anywhere else: GitHub answers the archive endpoint with a 302 to blob storage, so following it
 * automatically would send the Authorization header to a host this allowlist never approved. The
 * redirect is therefore read as a LOCATION and re-fetched WITHOUT credentials.
 */
export function createArchiveTransport({ token, fetchImpl = fetch, timeoutMs = 20_000, baseUrl = "https://api.github.com", maxBytes = MAX_ARCHIVE_BYTES }) {
  if (!token) throw new UsageError("an archive transport requires a token");
  /**
   * Consume the body INCREMENTALLY and abort at the cap (F15).
   *
   * `arrayBuffer()` buffers the whole response before anything can be checked, so a missing or
   * understated `Content-Length` meant the memory/download bound was enforced only AFTER the bytes
   * had already been received — which is not a bound during receipt, and the declared-length check
   * in front of it is exactly the value an adversarial or broken sender controls. The declared
   * length is still refused up front when it is present and too large; the running total is what
   * actually stops the transfer, and the reader is cancelled rather than drained.
   */
  const bounded = async (response) => {
    const declared = Number(response.headers?.get?.("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new IncompleteEvidence(`the witness artifact archive declares ${declared} bytes, beyond the ${maxBytes}-byte bound`);
    }
    const stream = response.body;
    if (!stream || typeof stream.getReader !== "function") {
      // A body with no readable stream (a test double, or a runtime without one). The whole-body
      // read is still bounded, and it is the fallback rather than the path.
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) throw new IncompleteEvidence(`the witness artifact archive is ${buffer.length} bytes, beyond the ${maxBytes}-byte bound`);
      return buffer;
    }
    const reader = stream.getReader();
    const chunks = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > maxBytes) {
          throw new IncompleteEvidence(
            `the witness artifact archive exceeded the ${maxBytes}-byte bound while being received (${received} bytes read); the download was aborted`,
          );
        }
        chunks.push(chunk);
      }
    } finally {
      // Cancel rather than let the remainder arrive: aborting is the point of the bound.
      try { await reader.cancel(); } catch { /* an already-finished reader has nothing to cancel */ }
    }
    return Buffer.concat(chunks, received);
  };
  return async (method, requestPath) => {
    if (method !== "GET") throw new UsageError("the archive transport reads only");
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${requestPath}`, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return { status: 0, bytes: null, diagnostic: { status: 0, category: timedOut ? "transport-timeout" : "transport-unavailable", ruleIds: [], policyDenial: false } };
    }
    if (response.status === 302 || response.status === 301 || response.status === 307) {
      const location = String(response.headers?.get?.("location") ?? "");
      if (!/^https:\/\/[A-Za-z0-9.-]+\//.test(location)) {
        return { status: 0, bytes: null, diagnostic: { status: 0, category: "transport-unavailable", ruleIds: [], policyDenial: false } };
      }
      // No Authorization header on the follow-up: the storage URL is already a capability, and
      // sending a provider credential to an unlisted host is the leak this branch exists to avoid.
      const followed = await fetchImpl(location, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (!followed.ok) return { status: followed.status, bytes: null, diagnostic: { status: followed.status, category: "unclassified", ruleIds: [], policyDenial: false } };
      return { status: 200, bytes: await bounded(followed), diagnostic: { status: 200, category: "ok", ruleIds: [], policyDenial: false } };
    }
    if (!response.ok) return { status: response.status, bytes: null, diagnostic: { status: response.status, category: "unclassified", ruleIds: [], policyDenial: false } };
    return { status: 200, bytes: await bounded(response), diagnostic: { status: 200, category: "ok", ruleIds: [], policyDenial: false } };
  };
}

/**
 * Bind a transport to one execution role and one run's derived targets. Every request in the whole
 * harness goes through this; there is no unguarded path to either transport.
 */
/**
 * The documented SUCCESS shape of each write, and of every JSON read by default (R02-1).
 *
 * A 2xx is only a complete answer from the endpoint that was asked when its body is the thing that
 * endpoint returns. A delete or a dispatch answers 204 with NO body; a ref update answers the ref
 * with its object SHA; a create answers the identity it created. A "success" in any other shape — a
 * 200 where 204 is documented, a ref update with no SHA, a ruleset create with no ID — did not come
 * from a completed request to this endpoint, so it is incomplete: never accepted, never refused.
 * The body is validated, not rewritten: every field the provider returned stays on it.
 */
const positiveIdField = (field) => (body) => Number.isSafeInteger(body?.[field]) && body[field] > 0;
const refObjectShape = (body) => isSha(body?.object?.sha);
const emptyAnswer = (body, status) => status === 204 && body === null;
export const RESPONSE_SHAPES = Object.freeze({
  "create-tree": (body) => isSha(body?.sha),
  "create-commit": (body) => isSha(body?.sha),
  "create-derived-ref": refObjectShape,
  "update-derived-ref": refObjectShape,
  "delete-derived-ref": emptyAnswer,
  "create-disposable-ruleset": positiveIdField("id"),
  "delete-disposable-ruleset": emptyAnswer,
  "publish-test-only-check": positiveIdField("id"),
  "create-synthetic-pull": positiveIdField("number"),
  "merge-synthetic-pull": (body) => isSha(body?.sha) && body?.merged === true,
  "close-synthetic-pull": positiveIdField("number"),
  "dispatch-witness-workflow": emptyAnswer,
  "create-probe-ref": refObjectShape,
  "dispatch-probe-workflow": emptyAnswer,
  // `POST …/cancel` answers 202 with an empty JSON object.
  "cancel-probe-run": (body, status) => status === 202 && body !== null && typeof body === "object" && !Array.isArray(body),
});
/** The operations whose response is bytes, bounded and validated by their own archive reader. */
const BINARY_OPERATIONS = Object.freeze(["download-artifact-archive"]);
const defaultJsonShape = (body) => body !== null && typeof body === "object";

/** Hold a transport result to the completed-response contract for the operation it answered. */
export function conformResponse(operation, result) {
  if (BINARY_OPERATIONS.includes(operation)) return result;
  // A transport that does not STATE completion has not measured it. That is not a pass-through for
  // a well-formed-looking status: the status is exactly the part that cannot vouch for itself.
  if (result?.complete !== true) {
    if (result?.complete === false && result?.status === 0) return result;
    const reason = result?.complete === false ? result?.incomplete : "completion-unstated";
    return incompleteResponse(reason, Number.isInteger(result?.measured_status) ? result.measured_status : result?.status);
  }
  const status = Number(result.status);
  if (status >= 200 && status < 300) {
    const shape = RESPONSE_SHAPES[operation] ?? defaultJsonShape;
    if (!shape(result.body ?? null, status)) return incompleteResponse("shape-invalid", status);
  }
  return result;
}

/**
 * The completion facts every PERSISTED mutation result carries beside its status, so no journal,
 * state file, challenge or evidence packet can be read back as a bare status. A record without
 * them is read as incomplete by {@link mutationRequestClass}.
 */
export function responseEvidence(response) {
  const complete = response?.complete === true;
  return {
    response_complete: complete,
    response_incomplete: complete ? null : (RESPONSE_INCOMPLETE_REASONS.includes(response?.incomplete) ? response.incomplete : "completion-unstated"),
    measured_status: Number.isInteger(response?.measured_status) && response.measured_status > 0 ? response.measured_status : null,
  };
}

export function createGuardedRequest(transport, ctx) {
  if (!ctx?.role || !ctx?.runId || !ctx?.attempt) throw new UsageError("a guarded commissioning request needs its role and run identity");
  const issued = [];
  const request = async (method, requestPath, body) => {
    const operation = assertAllowedRequest({ method, path: requestPath, body }, ctx);
    const result = await transport(method, requestPath, body);
    issued.push(operation);
    return { ...conformResponse(operation, result), operation };
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
  const binding = assertRoleBinding(role);
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
  // THE COMPLETE BINDING, always checked — never `if (expectedJob)`. See {@link ROLE_BINDINGS}.
  if (need("GITHUB_JOB") !== binding.job) {
    throw new UsageError(`the ${role} role runs only in the ${binding.job} job, not ${JSON.stringify(String(env?.GITHUB_JOB ?? ""))}`);
  }
  // MODE ADMISSION, runner-side. The workflow's `if:` already admits each job in exactly one mode;
  // this is the second, independent statement of it, so a job reached in the wrong mode refuses even
  // if an expression were edited. An unknown or empty mode matches no role.
  const mode = need("COMMISSIONING_MODE");
  if (!WITNESS_MODES.includes(mode)) throw new UsageError(`commissioning refuses the unknown mode ${JSON.stringify(mode)}`);
  if (mode !== binding.mode) throw new UsageError(`the ${role} role runs only in ${binding.mode} mode, not ${JSON.stringify(mode)}`);
  const repositoryId = positiveInt(env?.COMMISSIONING_REPOSITORY_ID, "COMMISSIONING_REPOSITORY_ID");
  // `GITHUB_REPOSITORY_ID` is injected by the platform and is not settable by a workflow author, so
  // it is the one identity fact a CREDENTIAL-FREE job can cross-check without a provider call — the
  // whole reason the intent phase can assert the fixed repository at all. A repository renamed or
  // transferred under the same full name would disagree here, before anything is created.
  if (positiveInt(env?.GITHUB_REPOSITORY_ID, "GITHUB_REPOSITORY_ID") !== repositoryId) {
    throw new UsageError("GITHUB_REPOSITORY_ID does not match COMMISSIONING_REPOSITORY_ID; this is not the repository this run is configured for");
  }
  // The release identity set belongs to COMMISSIONING mode. The publisher and the rehearsal hold no
  // App identity at all — requiring one of them would mean handing the transport jobs facts they have
  // no use for, and would make the inert rehearsal depend on a provisioned release App.
  let normalAppId = null;
  let emergencyAppId = null;
  let producerIds = null;
  let plannedInstallations = null;
  if (binding.mode === "commission") {
    normalAppId = positiveInt(env?.COMMISSIONING_NORMAL_APP_ID, "COMMISSIONING_NORMAL_APP_ID");
    emergencyAppId = positiveInt(env?.COMMISSIONING_EMERGENCY_APP_ID, "COMMISSIONING_EMERGENCY_APP_ID");
    if (normalAppId === emergencyAppId) throw new UsageError("the normal and emergency Apps must be distinct numeric identities");
    producerIds = parseProducerIds(env?.COMMISSIONING_PRODUCER_IDS_JSON);
    /**
     * THE PLANNED INSTALLATION IDENTITIES (PC-02/PC-04, corrected).
     *
     * They were absent from every immutable input, so the only "expectation" available anywhere was
     * the value the protected job itself was configured with — and `measureAppGrants` then recorded
     * that same requested value back as though it had been measured. A record cannot be its own
     * expectation, so the identity is planned HERE, in the credential-free configuration that the
     * intent artifact publishes, and every later boundary compares against the plan.
     *
     * They are nonsecret numeric identifiers, not keys or tokens. Real values are an owner
     * provisioning prerequisite; absence refuses at run time rather than defaulting.
     */
    const normalInstallationId = positiveInt(env?.COMMISSIONING_NORMAL_INSTALLATION_ID, "COMMISSIONING_NORMAL_INSTALLATION_ID");
    const emergencyInstallationId = positiveInt(env?.COMMISSIONING_EMERGENCY_INSTALLATION_ID, "COMMISSIONING_EMERGENCY_INSTALLATION_ID");
    if (normalInstallationId === emergencyInstallationId) {
      throw new UsageError("the normal and emergency installations must be distinct numeric identities");
    }
    plannedInstallations = Object.freeze({ normal: String(normalInstallationId), emergency: String(emergencyInstallationId) });
  }
  return Object.freeze({
    runId: String(runId), attempt: String(attempt), role, mode, binding, workflowSha, repositoryId,
    normalAppId, emergencyAppId, plannedInstallations,
    actor: String(env?.GITHUB_ACTOR ?? "").trim() || null,
    producerIds,
  });
}

/**
 * THE ONE PROVIDER-MEASURED SOURCE AND LIFECYCLE CHECK (F3).
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────────────────────────
 *
 * The canonical contract requires that, at ORIGINAL DISPATCH, at LOCAL WITNESS DISPATCH, at
 * PUBLISHER EXECUTION and at RESPONSE CONSUMPTION, the harness resolve `staging` and require the
 * original trusted workflow SHA — and that a measured default branch of `staging` be part of the
 * repository identity. Nothing in this build did either. The only staging read was inside the
 * production baseline, which recorded the SHA and never compared it to the trusted source, and
 * `default_branch` was read by no code at all. A complete run therefore returned NO BLOCKERS on a
 * fixture whose live staging head (`cccc…`) was a different commit from the workflow SHA it claimed
 * to have run (`aaaa…`): the source could move after setup, dispatch a DIFFERENT workflow tree, and
 * nothing would interrupt the attempt.
 *
 * The test that used to be called "MOVED source" changed a challenge's declared SHA string. That is
 * a caller-supplied field. This resolves the LIVE REF through the provider, which is the only thing
 * a moved branch actually changes.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────────────────────────
 *
 * It is a bounded read-only comparison at fixed boundaries, not a lock on the branch and not a
 * continuous watch: a move BETWEEN two boundaries is caught at the next one, which is the same
 * bounded-window guarantee the pre/post witness pair has, and the evidence says so rather than
 * implying continuity nobody measured.
 */
export async function assertSourceContinuity({ request, expected, label = "this commissioning attempt", mode = "enforce" }) {
  const repository = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}`);
  if (repository.status !== 200 || !repository.body) {
    throw new IncompleteEvidence(`${label}'s repository identity could not be measured (${repository.status})`, { retryable: true });
  }
  if (String(repository.body.full_name ?? "") !== COMMISSIONING_REPOSITORY) {
    throw new AssertionFailure(`${label} is measuring ${JSON.stringify(String(repository.body.full_name ?? ""))}, not the fixed commissioning repository`);
  }
  if (expected?.repositoryId !== undefined && expected.repositoryId !== null
    && Number(repository.body.id) !== Number(expected.repositoryId)) {
    throw new AssertionFailure(`${label}'s measured repository ID is not the one this attempt is bound to`);
  }
  // The DEFAULT BRANCH, measured. The canonical states that GitHub reports staging as the default
  // branch and that normal reviewed staging merge is what supplies workflow availability; a
  // repository whose default branch moved is not the configuration this attempt was reviewed for.
  const defaultBranch = String(repository.body.default_branch ?? "");
  if (defaultBranch !== branchOf(COMMISSIONING_DISPATCH_REF)) {
    throw new AssertionFailure(
      `${label} measured the default branch ${JSON.stringify(defaultBranch || "unreported")}, not ${branchOf(COMMISSIONING_DISPATCH_REF)}`,
    );
  }
  const stagingRef = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/ref/heads/staging`);
  if (stagingRef.status !== 200 || !stagingRef.body?.object?.sha) {
    throw new IncompleteEvidence(`${label}'s live staging head could not be measured (${stagingRef.status})`, { retryable: true });
  }
  const stagingSha = String(stagingRef.body.object.sha);
  if (!FULL_SHA.test(stagingSha)) throw new IncompleteEvidence(`${label}'s live staging head is not a full commit SHA`);
  const moved = String(expected?.workflowSha ?? "") !== stagingSha;
  /**
   * ── `enforce` STOPS THE ATTEMPT; `observe` RECORDS THE MOVE AND LETS REMEDIATION RUN ──────────
   *
   * The canonical's sentence is "movement interrupts the attempt, WITH CLEANUP and root
   * reconciliation" — so a source move must stop the forward work (setup, witness dispatch,
   * publisher execution, response consumption) and must NOT stop the phase whose whole job is to
   * remove what the run created. An enforcing check in every local phase would have made a
   * legitimate merge to staging mid-window leave the disposable rulesets and refs in place
   * permanently, with no supported way to remove them: the remedy would have become the casualty.
   *
   * `observe` therefore measures and REPORTS the move rather than throwing. Cleanup and collect use
   * it; their own production-baseline comparison still ends the run as interrupted — after the
   * owned resources are gone — which is the outcome the canonical asks for.
   */
  if (moved && mode === "enforce") {
    // INTERRUPTED, not failed. Reverting somebody else's legitimate merge is not this harness's
    // business; stopping and handing the reconciliation to root is.
    throw new IncompleteEvidence(
      `${label}'s live staging head (${stagingSha.slice(0, 12)}) is no longer the immutable trusted source this attempt is bound to (${String(expected?.workflowSha ?? "").slice(0, 12)}); the attempt is interrupted and needs cleanup and root reconciliation`,
      { moved: true, measured_staging_sha: stagingSha, trusted_source_sha: String(expected?.workflowSha ?? "") },
    );
  }
  return Object.freeze({
    measured: true,
    mode,
    moved,
    repository_id: Number(repository.body.id),
    repository_full_name: COMMISSIONING_REPOSITORY,
    default_branch: defaultBranch,
    staging_sha: stagingSha,
    trusted_source_sha: String(expected?.workflowSha ?? ""),
    // The bound this check does and does not carry, stated where it is recorded.
    guarantee: "the live dispatch branch equalled the immutable trusted source AT THIS BOUNDARY; movement between boundaries is caught at the next one",
  });
}

/**
 * The provider's own state for ONE named job in THIS attempt (F11).
 *
 * Extracted from {@link assertActorJobActive} so the rehearsal stops admitting itself by COUNTING
 * one non-skipped job — a count says nothing about WHICH job ran, and the rehearsal's whole claim is
 * that the exact reviewed `transport-rehearsal` job is the one active in a rehearsal source run.
 */
export async function assertNamedJobActive({ request, runId, attempt, jobName, label, allowCompleted = false }) {
  const jobs = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}&page=1`);
  if (jobs.status !== 200 || !Array.isArray(jobs.body?.jobs)) throw new IncompleteEvidence(`the ${label} job's state could not be measured`, { retryable: true });
  const rows = jobs.body.jobs;
  if (Number(jobs.body.total_count ?? rows.length) > rows.length) {
    throw new IncompleteEvidence(`the ${label} run's job list is paginated beyond the first page; its job states are unmeasured`);
  }
  const job = rows.find((entry) => String(entry?.name ?? "") === jobName);
  if (!job) throw new IncompleteEvidence(`the ${label} job has not been created in this attempt`, { retryable: true });
  const active = ["in_progress", "queued"].includes(String(job.status));
  const completed = allowCompleted && String(job.status) === "completed";
  if (!active && !completed) {
    throw new AssertionFailure(`the ${label} job is ${String(job.status)}; a witness response is served only to a job that is actually running this attempt`);
  }
  // EXCLUSIVITY where the mode demands it: every OTHER job in the run must have been skipped.
  const executed = rows.filter((entry) => String(entry?.conclusion ?? "") !== "skipped");
  return {
    job_id: positiveProviderId(job.id),
    job_name: jobName,
    job_status: String(job.status),
    job_conclusion: job.conclusion === undefined ? null : String(job.conclusion ?? "none"),
    job_run_attempt: positiveProviderId(job.run_attempt),
    executed_job_names: executed.map((entry) => String(entry?.name ?? "")).sort(),
  };
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

/**
 * Stable, key-sorted JSON. Used for every hash so an ordering difference is never a content one.
 *
 * Re-exported from the witness module rather than defined twice: the challenge/response digests are
 * computed on one side of the transport and checked on the other, so two implementations that agreed
 * today and drifted tomorrow would fail every binding for a reason nobody could locate.
 */
export const canonicalJson = witnessCanonicalJson;
export const canonicalHash = witnessCanonicalHash;

/**
 * THE ONE graph digest every side of the transport computes.
 *
 * It covers exactly the nodes a protected job can INDEPENDENTLY VERIFY — which is every planned node
 * except `P`, because a commit cannot contain its own SHA and `P` is therefore absent from the
 * manifest by construction. Local setup, the cloud challenge and the offline completeness gate all
 * call this, so the digest is a binding rather than three hashes that happened to agree.
 */
export function graphBindingDigest(graphShas, runId, attempt) {
  const plan = buildGraphPlan(runId, attempt);
  return canonicalHash(Object.fromEntries(
    plan.filter((node) => node.key !== "P").map((node) => [node.key, String(graphShas?.[node.key] ?? "")]),
  ));
}

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

/**
 * THE STRICT COMPARISON AN ADOPTION MAY REST ON, and the reason it is not {@link compareToDesired}.
 *
 * `compareToDesired` reports a difference set where EVERY entry is `added` as `normalizationOnly`.
 * That is a reasonable thing for a difference REPORTER to say, and a disastrous thing for an
 * OWNERSHIP PROOF to say: a ruleset whose `update` rule acquired `update_allows_fetch_and_merge:
 * true` differs from the intended policy only by an added key, so the permissive reading called a
 * semantic change benign and authorised adoption — and therefore deletion — of a policy nobody
 * intended.
 *
 * So this accepts exactly two things: byte equality, and key REORDERING. Nothing else. Every added
 * field refuses, whatever its value, including one that happens to equal the provider's documented
 * default.
 *
 * ── WHY EVEN A BENIGN DEFAULT EXPANSION REFUSES ─────────────────────────────────────────────────
 *
 * Because the gate standing beside this one already does. The setup compatibility check runs the
 * UNCHANGED production verifier, whose `sameJson` rejects any added parameter, so an adoption rule
 * that tolerated `update_allows_fetch_and_merge: false` would contradict the verifier three lines
 * away. PC-04 prescribes the outcome directly: "if provider-default expansion/order makes existing
 * raw JSON verifier reject equivalent rules, REPORT THE CONCRETE GAP; this harness must not silently
 * loosen the production verifier or claim PASS." A real expansion is therefore a named
 * `provider-normalization` gap for root, never a silent adoption.
 */
export function compareToIntendedGoverned(actual, wanted) {
  const differences = describeDifferences(actual, wanted);
  const byteEqual = JSON.stringify(actual) === JSON.stringify(wanted);
  const semanticallyEqual = differences.length === 0;
  return {
    differences,
    byteEqual,
    equal: byteEqual || semanticallyEqual,
    basis: byteEqual ? "byte-equal" : (semanticallyEqual ? "key-ordering-only" : null),
    // Distinguishes the gap KIND for the refusal message; it never authorises anything.
    addedOnly: differences.length > 0 && differences.every((entry) => entry.kind === "added"),
  };
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
 * Read every page, or refuse.
 *
 * The rule that makes this honest is the LAST one: a response that exactly fills a page and is
 * followed by no further page is INDISTINGUISHABLE from a truncated read, so it is treated as
 * incomplete rather than assumed complete. A single page-1 read — which is what the production
 * baseline used to do — silently drops a later-page tag ruleset, and the before/after comparison then
 * reports "unchanged" about a set it never saw all of.
 */
export async function readAllPages({ request, endpoint, label }) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await request("GET", `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`);
    if (response.status !== 200 || !Array.isArray(response.body)) {
      throw new IncompleteEvidence(`${label} could not be measured (${response.status})`);
    }
    rows.push(...response.body);
    if (response.body.length < PAGE_SIZE) return rows;
    if (page === MAX_PAGES) throw new IncompleteEvidence(`${label} exceeded ${MAX_PAGES} pages; the measurement is incomplete`);
  }
  throw new IncompleteEvidence(`${label} did not terminate within ${MAX_PAGES} pages`);
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
  const rules = await readAllPages({
    request, endpoint: `/repos/${COMMISSIONING_REPOSITORY}/rules/branches/${encoded}`,
    label: `the applicable rules for ${branch}`,
  });
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
 *
 * ── AN AMBIGUOUS MUTATION IS NEVER AN OUTCOME (R1) ──────────────────────────────────────────────
 *
 * A request whose response never arrived (status 0) used to be recorded as `accepted`, non-halting,
 * whenever the single readback showed the requested commit — and the next actor case then started.
 * The canonical rule is the opposite: an ambiguous mutation STOPS further actor mutations. The
 * readback is still measured and retained as reconciliation evidence, but it cannot turn a request
 * of unknown fate into a measured provider result: the ref could equally have been moved by some
 * other writer, and "the provider accepted this request" is the claim the case exists to prove.
 * So an ambiguous request is `inconclusive` and halts, whatever the readback shows, for every
 * expectation.
 *
 * The ambiguous class is not status 0 alone. A 5xx (or a 408, or any status that is neither a
 * measured 2xx nor a measured 4xx) says the request reached something that then failed, which is
 * equally consistent with the write having been applied: a gateway can time out on an upstream that
 * committed. {@link mutationRequestClass} owns the class; a MEASURED 4xx refusal stays a decisive
 * answer, and whether a rule caused it is still judged by the diagnostic and the unchanged ref.
 */
export function classifyCaseOutcome({ expected, response, beforeSha, afterSha, requestedSha, operation, requiresRuleId = null }) {
  const status = response?.status ?? null;
  const requestClass = mutationRequestClass(status, response?.complete);
  const statusLabel = response?.complete === true
    ? (Number.isInteger(status) ? String(status) : "no status")
    : `incomplete response: ${String(response?.incomplete ?? "completion-unstated")}${Number.isInteger(response?.measured_status) ? `, status line ${response.measured_status}` : ""}`;
  const diagnostic = response?.diagnostic ?? { category: "unclassified", policyDenial: false, ruleIds: [] };
  const changed = String(beforeSha) !== String(afterSha);
  const ambiguousVerdict = (readbackNote) => ({
    outcome: "inconclusive", halt: true, ambiguous: true,
    reason: `the request has no decisive provider outcome (${statusLabel}), so whether it was applied is unknown; ${readbackNote}. The readback is retained as reconciliation evidence only, the mutation is never retried, and no further actor mutation runs`,
  });
  if (expected === "denied") {
    if (requestClass === "accepted") return { outcome: "unexpected-success", halt: true, reason: "the provider accepted an operation the policy must refuse" };
    if (changed) return { outcome: "unexpected-mutation", halt: true, reason: "the ref moved despite a non-success response" };
    if (requestClass === "ambiguous") return ambiguousVerdict("the readback shows the ref unchanged, which an undecided request cannot attribute to enforcement");
    if (diagnostic.policyDenial === true) {
      if (requiresRuleId && !(diagnostic.ruleIds ?? []).includes(requiresRuleId)) {
        return { outcome: "inconclusive", halt: false, reason: `the refusal is a policy denial but not the ${requiresRuleId} rule this case must isolate` };
      }
      return { outcome: "denied", halt: false, reason: null };
    }
    return {
      outcome: "inconclusive", halt: false,
      reason: `the refusal (${status}, ${diagnostic.category}) is not attributable to a policy rule`,
    };
  }
  if (requestClass === "accepted" && operation !== "delete" && String(afterSha) === String(requestedSha)) {
    return { outcome: "accepted", halt: false, reason: null };
  }
  if (requestClass === "accepted") return { outcome: "unexpected-mutation", halt: true, reason: "the provider reported success but the independent readback does not show the requested commit" };
  if (requestClass === "ambiguous") {
    return ambiguousVerdict(String(afterSha) === String(requestedSha)
      ? "the readback shows the requested commit, which proves where the ref is but not that this request put it there"
      : "the readback does not show the requested commit");
  }
  // A measured 4xx: the provider decisively declined a write the policy must permit.
  return { outcome: "unexpected-denial", halt: false, reason: `the provider refused an operation the policy must permit (${status}, ${diagnostic.category})` };
}

/** Read a derived ref's current commit. `null` means measured-absent (404), not unknown. */
export async function readDerivedRefSha({ request, ref }) {
  const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/ref/heads/${branchOf(ref)}`);
  if (response.status === 404) return null;
  if (response.status !== 200 || !response.body?.object?.sha) throw new IncompleteEvidence(`the state of ${ref} could not be measured (${response.status})`);
  return String(response.body.object.sha);
}

/**
 * Re-read the synthetic pull request's ACTUAL current target, immediately before the merge attempt.
 *
 * WHY THE CREATION-TIME CHECK IS NOT ENOUGH. `createSyntheticPull` verifies the base and head it got
 * back, but that was during setup — and a pull request is retargetable afterwards, by a human, by a
 * bot, or by a repository automation nobody remembered. The merge case then issues
 * `PUT /pulls/<n>/merge` with the LOCAL ADMIN credential. If the base had been moved to `staging` or
 * `main` in the meantime, that call is a real merge into a production ref, and the case's own
 * readback — which looks at the disposable human ref — could not detect it: the ref it reads would
 * be untouched, and the outcome would be recorded as a clean policy denial.
 *
 * So every field is re-measured here and bound to internally derived values, and the merge itself
 * carries the measured head SHA as a condition so the provider refuses if the head moves in the gap.
 */
export async function assertSyntheticPullTarget({ request, ctx, pull, graphShas }) {
  if (!Number.isInteger(pull?.number)) throw new IncompleteEvidence("the synthetic pull request was not created; its merge case cannot be measured");
  const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/pulls/${pull.number}`);
  if (response.status !== 200 || !response.body) throw new IncompleteEvidence(`the synthetic pull request could not be re-read before its merge attempt (${response.status})`);
  const body = response.body;
  const refuse = (why) => { throw new AssertionFailure(`the synthetic pull request ${why}; commissioning refuses to merge against a target it did not measure`); };

  if (Number(body.number) !== pull.number) refuse("does not read back as the number this run journaled");
  if (String(body.state) !== "open") refuse(`is ${String(body.state)} rather than open`);
  // BOTH repositories, by full name. A cross-repository pull request would put the merge in a
  // repository this harness has no business writing to at all.
  for (const [side, repo] of [["base", body.base?.repo?.full_name], ["head", body.head?.repo?.full_name]]) {
    if (String(repo ?? "") !== COMMISSIONING_REPOSITORY) refuse(`has its ${side} in ${JSON.stringify(String(repo ?? ""))}`);
  }
  // The exact refs this run journaled, each also proved to be one of its own derived names.
  const expected = { base: pull.base, head: pull.head };
  for (const side of ["base", "head"]) {
    const observed = String(body[side]?.ref ?? "");
    // The derivation check is wrapped rather than allowed to raise its own UsageError: a retargeted
    // pull request is a MEASURED refusal about the subject, and it has to reach the case record as
    // one. Letting exit-2 escape here would abandon the phase before its evidence was written — the
    // one artifact a reviewer needs in exactly this situation.
    try { assertDerivedRef(`refs/heads/${observed}`, ctx); }
    catch { refuse(`has been retargeted: its ${side} is now ${JSON.stringify(observed)}, which is not a ref this run derived`); }
    if (observed !== expected[side]) refuse(`has been retargeted: its ${side} is now ${JSON.stringify(observed)}, not ${JSON.stringify(expected[side])}`);
  }
  const headSha = String(body.head?.sha ?? "");
  if (!FULL_SHA.test(headSha)) refuse("reports no measurable head commit");
  const expectedHead = graphShas?.[REF_START_NODES["pr-head"]];
  if (headSha !== String(expectedHead ?? "")) refuse(`head is ${headSha.slice(0, 12)}, not the synthetic commit this run created at its head ref`);
  return { number: pull.number, base: expected.base, head: expected.head, head_sha: headSha };
}

/**
 * The LOCAL-HUMAN actor roles this direct path may execute (F14).
 *
 * Cloud actors are absent by NAME, not by a conditional at a call site, because the alternate path
 * is the whole finding: the fixed CLI phases correctly route a cloud case through the staged
 * `prepare → await-and-execute → await-and-finalize` machinery — role/job admission, a fresh
 * witness, a just-in-time token with its own proof, a durable mutation-used marker — while these
 * older exported functions still accepted a normal or emergency case and issued the mutation with
 * none of it. A direct exported emergency case returned `accepted` with ZERO witness artifacts.
 *
 * That is not a claim that importing a function grants credentials. It is a second, supported cloud
 * mutation implementation in a harness whose accepted internal-helper contract says cloud actors
 * use the admitted staged execution — and two implementations of the same mutation is exactly the
 * maintenance hazard that lets one of them quietly stop matching the reviewed one.
 */
export const DIRECT_EXECUTION_ACTORS = Object.freeze(["human"]);

/**
 * Refuse a cloud actor BEFORE a request, a credential or a journal write (F14).
 *
 * The legitimate caller of the direct path is the local human phase, which measures the policy
 * directly under admin and needs no witness at all.
 */
export function assertDirectExecutionAdmitted(kase, ctx) {
  if (!DIRECT_EXECUTION_ACTORS.includes(String(kase?.actor))) {
    throw new UsageError(
      `the ${String(kase?.actor)} actor may not execute directly: a cloud actor case runs only through the admitted staged path (prepare → await-and-execute → await-and-finalize), which binds a fresh witness, a role/job admission and a durable once-only mutation marker`,
    );
  }
  if (String(ctx?.role ?? "") !== "local") {
    throw new UsageError(`direct case execution runs only in the verified local operator's process, not as ${JSON.stringify(String(ctx?.role ?? ""))}`);
  }
  return true;
}

/**
 * Execute one case: measure before, refuse a no-op, journal INTENT, issue exactly one request,
 * journal the RESULT, measure after independently, then classify. Never retries a mutation.
 *
 * LOCAL-HUMAN CASES ONLY — see {@link assertDirectExecutionAdmitted}.
 */
export async function runActorCase({ request, kase, ctx, graphShas, journal, pull = null }) {
  assertDirectExecutionAdmitted(kase, ctx);
  // ADMISSION FROM THE VERIFIED JOURNAL, before any request (R2). A case with ANY journaled mutation
  // history in this run/attempt is never issued again, whatever that history says: a settled one has
  // its outcome, and an unresolved one is exactly the ambiguous state that must not be retried.
  assertHumanCaseUnissued(journal, kase);
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
  // The merge case's target is re-measured BEFORE the intent is journaled, so a retargeted pull
  // request refuses without a mutation intent ever being recorded against it.
  const target = kase.operation === "merge" ? await assertSyntheticPullTarget({ request, ctx, pull, graphShas }) : null;
  const intent = {
    case: kase.id, actor: kase.actor, operation: kase.operation, ref, force: kase.force,
    before_sha: beforeSha, requested_sha: requestedSha, expected: kase.expected, checks: kase.checks,
    ...(target ? { pull_number: target.number, pull_base: target.base, pull_head: target.head, pull_head_sha: target.head_sha } : {}),
  };
  // Re-admitted against the chain as it stands at the instant the intent is written: the reads above
  // took time, and the intent is the durable fact that makes this request once-only.
  assertHumanCaseUnissued(journal, kase);
  journal.append("mutation-intent", intent);
  let response;
  if (kase.operation === "delete") {
    response = await request("DELETE", `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/${branchOf(ref)}`);
  } else if (kase.operation === "merge") {
    // `sha` is the provider-side half of the guard above: GitHub refuses with 409 if the head moved
    // between that readback and this call.
    response = await request("PUT", `/repos/${COMMISSIONING_REPOSITORY}/pulls/${target.number}/merge`, { sha: target.head_sha });
  } else {
    response = await request("PATCH", `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/${branchOf(ref)}`, { sha: requestedSha, force: kase.force });
  }
  journal.append("mutation-result", { case: kase.id, status: response.status, ...responseEvidence(response), diagnostic: response.diagnostic, operation_id: response.operation });
  const afterSha = await readDerivedRefSha({ request, ref });
  journal.append("readback", { case: kase.id, ref, after_sha: afterSha });
  const verdict = classifyCaseOutcome({ expected: kase.expected, response, beforeSha, afterSha, requestedSha, operation: kase.operation, requiresRuleId: kase.requiresRuleId ?? null });
  const record = {
    case: kase.id, actor: kase.actor, operation: kase.operation, ref, force: kase.force,
    expected: kase.expected, before_sha: beforeSha, requested_sha: requestedSha, after_sha: afterSha,
    http_status: response.status, ...responseEvidence(response), diagnostic: response.diagnostic, outcome: verdict.outcome, check_state: checkState,
    passed: verdict.outcome === kase.expected, reason: verdict.reason,
    ...(target ? { pull_target: target } : {}),
  };
  journal.append("case-outcome", record);
  return { record, halt: verdict.halt };
}

/**
 * ── THE HUMAN CASE HISTORY: ONE OWNER FOR RUNTIME ADMISSION AND OFFLINE ASSESSMENT (R2) ─────────
 *
 * The local human cases write four events per mutation to the verified resource journal: intent
 * (fsynced before the request), result, readback and outcome. That append-only chain — not the
 * derived human evidence file, which every phase run rewrites — is the authority on whether a case
 * was issued, how often, and what happened.
 *
 * The defect this replaces: admission never read the chain. Re-running `human-tests` against the
 * same run/attempt issued every case AGAIN, including one whose first request timed out; a readback
 * that failed after a request was issued was recorded as "could not measure yet" and the later
 * cases carried on; and the final assessment checked case uniqueness inside the rewritten file,
 * which a second run had just replaced. Two PATCHes for one case, with the first one masked.
 *
 * These functions are the ONE place the history is interpreted. `runActorCase`/`runActorCases`
 * admit from them before any request, and `assessEvidence` joins every recorded human case to them.
 */
export const HUMAN_CASE_EVENTS = Object.freeze(["mutation-intent", "mutation-result", "readback", "case-outcome"]);

/** Every case-scoped event in chain order. Create intents carry a `kind` and no `case`, so they never match. */
export function humanCaseEvents(records) {
  const out = [];
  (Array.isArray(records) ? records : []).forEach((record, position) => {
    if (!HUMAN_CASE_EVENTS.includes(String(record?.type))) return;
    const caseId = record?.data?.case;
    if (typeof caseId !== "string" || !caseId) return;
    out.push({ position, seq: record.seq ?? null, type: String(record.type), case: caseId, data: record.data });
  });
  return out;
}

/**
 * Interpret ONE case's journaled history.
 *
 *  - `none`       — nothing was ever issued for it; it may be admitted.
 *  - `settled`    — exactly one complete intent → result → readback → outcome sequence whose outcome
 *                   the canonical classifier re-derives from the journaled values. Never reissued.
 *  - `unresolved` — one intent without its complete sequence: a crash after the fsynced intent, or a
 *                   readback that failed after the request left. The request's fate is unknown.
 *  - `invalid`    — a duplicate intent (a replay), events out of order or disagreeing with each other,
 *                   or an outcome the recorded values do not support.
 *
 * `blocking` is true for everything that must stop further actor mutations: unresolved, invalid, and
 * a settled outcome the classifier says halts (an ambiguous mutation, an unexpected success).
 */
export function assessHumanCaseHistory(events, kase, { runId, attempt }) {
  const own = (events ?? []).filter((event) => event.case === kase.id);
  if (!own.length) return { case: kase.id, state: "none", blocking: false, problems: [], record: null, verdict: null, first_position: null };
  const problems = [];
  const intents = own.filter((event) => event.type === "mutation-intent");
  const firstPosition = own[0].position;
  const result = (state, extra = {}) => ({
    case: kase.id, state, problems, record: null, verdict: null, first_position: firstPosition,
    blocking: state !== "none", ...extra,
  });
  if (intents.length === 0) {
    problems.push(`has journaled ${own[0].type} history with no mutation intent before it`);
    return result("invalid");
  }
  if (intents.length > 1) {
    problems.push(`was issued ${intents.length} times; a case is issued exactly once per attempt, and a repeated mutation is never an outcome`);
    return result("invalid");
  }
  if (own[0].type !== "mutation-intent") problems.push(`has a journaled ${own[0].type} before its mutation intent`);
  const expectedOrder = HUMAN_CASE_EVENTS.slice(0, own.length);
  if (own.length > HUMAN_CASE_EVENTS.length || own.some((event, index) => event.type !== expectedOrder[index])) {
    problems.push(`has journaled events out of their intent → result → readback → outcome order (${own.map((event) => event.type).join(", ")})`);
  }
  if (problems.length) return result("invalid");

  const intent = own[0].data;
  const ref = derivedRef(runId, attempt, kase.ref);
  if (String(intent.actor) !== kase.actor || String(intent.operation) !== kase.operation || intent.force !== kase.force
    || String(intent.expected) !== kase.expected || String(intent.ref) !== ref) {
    problems.push("has a journaled intent that is not this case's closed actor/operation/force/expectation/ref");
    return result("invalid");
  }
  if (own.length < HUMAN_CASE_EVENTS.length) {
    problems.push(`was issued and never settled: its journal stops after ${own.at(-1).type}, so the request's outcome is unknown and it is never retried`);
    return result("unresolved");
  }
  const [, mutation, readback, outcome] = own.map((event) => event.data);
  if (String(readback.ref) !== ref) problems.push("has a journaled readback of a different ref");
  const verdict = classifyCaseOutcome({
    expected: kase.expected,
    // The journaled completion facts, never the status alone (R02-1): a result event without
    // `response_complete: true` re-derives as the ambiguous request it was.
    response: {
      status: mutation.status, diagnostic: mutation.diagnostic, complete: mutation.response_complete === true,
      incomplete: mutation.response_incomplete ?? null, measured_status: mutation.measured_status ?? null,
    },
    beforeSha: intent.before_sha, afterSha: readback.after_sha, requestedSha: intent.requested_sha,
    operation: kase.operation, requiresRuleId: kase.requiresRuleId ?? null,
  });
  const bound = {
    case: kase.id, actor: kase.actor, operation: kase.operation, ref, force: kase.force, expected: kase.expected,
    before_sha: intent.before_sha, requested_sha: intent.requested_sha, after_sha: readback.after_sha,
    http_status: mutation.status, ...responseEvidence({ complete: mutation.response_complete, incomplete: mutation.response_incomplete, measured_status: mutation.measured_status }),
    outcome: verdict.outcome, passed: verdict.outcome === kase.expected,
  };
  for (const [field, value] of Object.entries(bound)) {
    if (canonicalJson(outcome?.[field] ?? null) !== canonicalJson(value ?? null)) {
      problems.push(`has a journaled outcome whose ${field} is not the one its own intent/result/readback history derives`);
    }
  }
  if (problems.length) return result("invalid");
  return result("settled", { record: outcome, verdict, blocking: verdict.halt === true });
}

/** Every human case, assessed against the chain; plus the chain-level facts no single case owns. */
export function assessHumanCaseJournal(records, { runId, attempt }) {
  const events = humanCaseEvents(records);
  const matrix = casesForActor("human");
  const known = new Set(matrix.map((kase) => kase.id));
  const problems = [];
  const foreign = [...new Set(events.filter((event) => !known.has(event.case)).map((event) => event.case))];
  // A case-scoped event for anything outside the closed human matrix is a hidden attempt: cloud jobs
  // never append to this journal, so there is no legitimate writer of one.
  if (foreign.length) problems.push(`the verified journal records mutation history for ${foreign.map((id) => JSON.stringify(id)).join(", ")}, which is not a local human case`);
  const cases = Object.fromEntries(matrix.map((kase) => [kase.id, assessHumanCaseHistory(events, kase, { runId, attempt })]));
  // Anything issued AFTER a blocking case began was issued while further actor mutations were forbidden.
  const blockers = Object.values(cases).filter((entry) => entry.blocking && entry.first_position !== null);
  for (const blocker of blockers) {
    const later = [...new Set(events
      .filter((event) => event.type === "mutation-intent" && event.case !== blocker.case && event.position > blocker.first_position)
      .map((event) => event.case))];
    if (later.length) {
      problems.push(`the verified journal records ${later.join(", ")} issued after ${blocker.case} (${blocker.state}) had already stopped further actor mutations`);
    }
  }
  return { cases, problems, blocking: blockers.map((entry) => entry.case) };
}

/** Refuse a case that already has ANY journaled history — the runtime half of the one owner above. */
function assertHumanCaseUnissued(journal, kase) {
  if (typeof journal?.read !== "function" || typeof journal?.append !== "function") {
    throw new UsageError("a local human case is admitted only from the verified run/attempt journal, which must be open for this run");
  }
  const prior = humanCaseEvents(journal.read()).filter((event) => event.case === kase.id);
  if (prior.length) {
    throw new AssertionFailure(
      `case ${kase.id} already has ${prior.length} journaled mutation event(s) in this run/attempt; a case is issued exactly once, and a request whose outcome was lost is reconciled, never repeated`,
    );
  }
  return true;
}

/**
 * Run one actor's whole set, stopping IMMEDIATELY on an unexpected success or an unexpected
 * mutation (PC-07): once an actor has demonstrably done something the policy must forbid, every
 * later case runs against a state nobody planned, and continuing would be taking further unsafe
 * actions with a credential that has just been shown to be over-privileged.
 */
export async function runActorCases({ request, actor, ctx, graphShas, journal, pull = null }) {
  if (!DIRECT_EXECUTION_ACTORS.includes(String(actor))) {
    throw new UsageError(`the ${String(actor)} actor's cases run only through the admitted staged cloud path, never through direct execution`);
  }
  if (typeof journal?.read !== "function") {
    throw new UsageError("local human cases are admitted only from the verified run/attempt journal, which must be open for this run");
  }
  const records = [];
  let halted = null;
  const history = () => assessHumanCaseJournal(journal.read(), { runId: ctx.runId, attempt: ctx.attempt });
  for (const kase of casesForActor(actor)) {
    // ADMISSION FROM THE CHAIN, re-read before every case (R2). A resumed phase takes an already
    // settled case's outcome from its journaled history instead of issuing it again, and ANY
    // blocking history — an unresolved or replayed case anywhere in this attempt, or an outcome that
    // halts — stops every further mutation, in this process and in every later one.
    const journaled = history();
    const own = journaled.cases[kase.id];
    if (own.state === "settled") {
      records.push(own.record);
      if (own.blocking) halted = halted ?? kase.id;
      continue;
    }
    const unissued = own.state === "none";
    if (halted) {
      records.push({ case: kase.id, actor, outcome: unissued ? "not-run" : "inconclusive", passed: false, reason: `halted after ${halted}${unissued ? "" : `; ${own.problems.join("; ")}`}` });
      continue;
    }
    const reasons = [
      ...journaled.problems,
      ...journaled.blocking.map((id) => journaled.cases[id])
        .map((entry) => `${entry.case} ${entry.state === "settled" ? `recorded ${entry.record.outcome}, which halts this actor` : entry.problems.join("; ")}`),
    ];
    if (reasons.length) {
      records.push({ case: kase.id, actor, outcome: unissued ? "not-run" : "inconclusive", passed: false, reason: `no further actor mutation runs in this attempt: ${reasons.join("; ")}` });
      halted = journaled.blocking[0] ?? kase.id;
      continue;
    }
    try {
      const { record, halt } = await runActorCase({ request, kase, ctx, graphShas, journal, pull });
      records.push(record);
      if (halt) halted = record.case;
    } catch (error) {
      // A failure AFTER the intent was journaled is not "could not measure this yet": the request may
      // have left, and its outcome is now unknown. The chain says which it was, not the error class.
      if (history().cases[kase.id].state !== "none" && (error instanceof IncompleteEvidence || error instanceof AssertionFailure)) {
        records.push({ case: kase.id, actor, outcome: "inconclusive", passed: false, reason: `${error.message} — after its mutation intent was journaled, so the request's outcome is unknown and no further actor mutation runs in this attempt` });
        halted = kase.id;
        continue;
      }
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
  // The F1 transport's three: the publisher job's own record, the local witness process's summary,
  // and the separately scoped inert rehearsal.
  witness: "witness-publication",
  "witness-process": "witness",
  rehearsal: "transport-rehearsal",
  /**
   * The PRIVATE production input/subject record (PC-04). LOCAL ONLY, mode 0600.
   *
   * It carries the exact validated twelve-context producer map and the raw `buildMainRulesets`
   * output it produced, so an offline reader can REGENERATE the production subject and its hash
   * instead of accepting a digest the packet asserts about itself. The published intent continues to
   * expose only the producer-map digest; this file is never uploaded, dispatched, put in the
   * manifest, or logged.
   */
  "production-inputs": "production-inputs",
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

export const CHECK_EXPECTATIONS = Object.freeze([
  "irrelevant", "none", "all-green-expected-producer",
  "one-required-check-absent", "one-required-check-failed", "all-green-wrong-producer",
]);

/**
 * THE ONE CHECK-STATE EVALUATOR (F12). Runtime and offline both call it, and neither has its own.
 *
 * ── WHY THIS IS AN EXTRACTION RATHER THAN A NEW LAYER ───────────────────────────────────────────
 *
 * This ladder existed TWICE: once in {@link assertCheckState}, which measures the rows, and once in
 * {@link recomputeCheckState}, which judges a recorded measurement offline. Two copies of a rule are
 * two rules, and they had already drifted in the way that mattered least visibly and most: NEITHER
 * required the failing check to come from the expected producer. So a `failure` published by the
 * Actions App, with every other context green from the normal App, satisfied
 * `one-required-check-failed` — and the denial that followed could equally be explained by the
 * expected producer being ABSENT, which is a different case that this run tests separately. The
 * red, missing and wrong-producer cases have to stay independently falsifiable or none of the three
 * proves anything.
 *
 * `rows` is the normalised per-context measurement: `{ ordinal, name, present, status, conclusion,
 * app_id, duplicates }`. Returns the reasons the measurement does not satisfy `expectation`; empty
 * means it does.
 */
export function evaluateCheckState(rows, { runId, attempt, expectation, normalAppId }) {
  if (!CHECK_EXPECTATIONS.includes(String(expectation))) {
    return [`declares the unknown check expectation ${JSON.stringify(String(expectation))}`];
  }
  if (expectation === "irrelevant") return [];
  const problems = [];
  const contexts = derivedContextNames(runId, attempt);
  const byOrdinal = new Map((Array.isArray(rows) ? rows : []).map((row) => [Number(row?.ordinal), row]));
  for (const [ordinal, name] of contexts.entries()) {
    const row = byOrdinal.get(ordinal);
    if (!row) { problems.push(`has no measurement for context ordinal ${ordinal}`); continue; }
    if (String(row.name) !== name) problems.push(`names ${JSON.stringify(String(row.name ?? ""))} at context ordinal ${ordinal}`);
    // A duplicate listing is not a detail: a name map lets the LAST row decide, so two rows for one
    // context mean the verdict depends on listing order. That is unmeasurable, not merely untidy.
    if (Number(row.duplicates ?? 1) !== 1) problems.push(`measured ${Number(row.duplicates ?? 1)} check runs for context ordinal ${ordinal}; a duplicate listing makes the state ambiguous`);
  }
  const last = contexts.length - 1;
  /** A context is green only when it is COMPLETED, SUCCESS and — when named — from that producer. */
  const green = (ordinal, producer) => {
    const row = byOrdinal.get(ordinal);
    return Boolean(row?.present) && String(row?.status) === "completed" && String(row?.conclusion) === "success"
      && (producer === undefined || Number(row?.app_id) === Number(producer));
  };
  /** A context is a genuine red only when it is COMPLETED, FAILURE and from the EXPECTED producer. */
  const redFromExpectedProducer = (ordinal, producer) => {
    const row = byOrdinal.get(ordinal);
    return Boolean(row?.present) && String(row?.status) === "completed" && String(row?.conclusion) === "failure"
      && Number(row?.app_id) === Number(producer);
  };
  const allButLast = [...contexts.keys()].filter((ordinal) => ordinal !== last);
  if (expectation === "none") {
    const present = [...byOrdinal.values()].filter((row) => row?.present);
    if (present.length) problems.push(`measured ${present.length} TEST-ONLY check(s) where the case requires none`);
  } else if (expectation === "all-green-expected-producer") {
    if (![...contexts.keys()].every((ordinal) => green(ordinal, normalAppId))) problems.push("did not measure every required context green from the expected producer");
  } else if (expectation === "one-required-check-absent") {
    if (byOrdinal.get(last)?.present) problems.push("measured the context the case requires to be absent as present");
    if (!allButLast.every((ordinal) => green(ordinal, normalAppId))) problems.push("did not measure the remaining contexts green from the expected producer");
  } else if (expectation === "one-required-check-failed") {
    // BOTH halves. A failure from the wrong producer is the missing-check case wearing a red badge.
    if (!redFromExpectedProducer(last, normalAppId)) {
      problems.push("did not measure the context the case requires to have failed as a completed failure FROM THE EXPECTED PRODUCER");
    }
    if (!allButLast.every((ordinal) => green(ordinal, normalAppId))) problems.push("did not measure the remaining contexts green from the expected producer");
  } else if (expectation === "all-green-wrong-producer") {
    if (![...contexts.keys()].every((ordinal) => green(ordinal))) problems.push("did not measure every required context green");
    if ([...byOrdinal.values()].some((row) => Number(row?.app_id) === Number(normalAppId))) {
      problems.push("measured the expected producer publishing here, so a denial would not isolate the producer mismatch");
    }
  }
  return problems;
}

/**
 * Read a synthetic commit's TEST-ONLY check runs to COMPLETION, bounded (F12/F15).
 *
 * The endpoint answers `{ total_count, check_runs }` rather than a bare array, so it cannot go
 * through {@link readAllPages} — and a single `per_page=100` read was silently treating "the first
 * hundred" as "all of them". A listing this build cannot see the end of is incomplete evidence, not
 * a measurement with a caveat.
 */
export async function readCheckRuns({ request, headSha }) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/commits/${headSha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`);
    if (response.status !== 200 || !response.body) throw new IncompleteEvidence(`the check state of ${String(headSha).slice(0, 12)} could not be measured (${response.status})`);
    const batch = Array.isArray(response.body.check_runs) ? response.body.check_runs : null;
    if (!batch) throw new IncompleteEvidence(`the check listing for ${String(headSha).slice(0, 12)} is not the documented shape`);
    rows.push(...batch);
    const total = Number(response.body.total_count);
    if (Number.isFinite(total) && rows.length >= total) return rows;
    if (batch.length < PAGE_SIZE) return rows;
    if (page === MAX_PAGES) throw new IncompleteEvidence(`the check listing for ${String(headSha).slice(0, 12)} exceeded ${MAX_PAGES} pages; the measurement is incomplete`);
  }
  throw new IncompleteEvidence(`the check listing for ${String(headSha).slice(0, 12)} did not terminate within ${MAX_PAGES} pages`);
}

/** Assert the observed TEST-ONLY check state on a synthetic commit MATCHES what the case claims. */
export async function assertCheckState({ request, headSha, expectation, ctx }) {
  if (expectation === "irrelevant") return { expectation, measured: false };
  if (!CHECK_EXPECTATIONS.includes(String(expectation))) throw new UsageError(`unknown declared check state ${JSON.stringify(String(expectation))}`);
  const listing = await readCheckRuns({ request, headSha });
  const contexts = derivedContextNames(ctx.runId, ctx.attempt);
  const runs = listing.filter((run) => contexts.includes(run?.name));
  // The per-context rows, INCLUDING how many runs carried each name — the input the one evaluator
  // takes, and the same shape the offline gate reconstructs from the record.
  const rows = contexts.map((name, ordinal) => {
    const matching = runs.filter((run) => String(run?.name) === name);
    const run = matching[0];
    return {
      ordinal, name,
      present: matching.length > 0,
      status: run ? String(run.status ?? "") : null,
      conclusion: run ? String(run.conclusion ?? "") : null,
      app_id: run && Number.isInteger(Number(run?.app?.id)) ? Number(run.app.id) : null,
      duplicates: matching.length === 0 ? 1 : matching.length,
    };
  });
  const problems = evaluateCheckState(rows, { runId: ctx.runId, attempt: ctx.attempt, expectation, normalAppId: ctx.normalAppId });
  if (problems.length) {
    throw new IncompleteEvidence(`the case's declared check state is not yet in place (${problems.join("; ")}); this case cannot be measured`);
  }
  return {
    expectation, measured: true,
    producers: [...new Set(runs.map((run) => Number(run?.app?.id)).filter(Number.isInteger))],
    present: runs.length,
    head_sha: String(headSha),
    // The PER-CONTEXT measurement, not just a count and a boolean (F3). The offline completeness
    // gate recomputes the declared expectation from exactly these rows through the SAME evaluator,
    // so `measured: true` next to a contradictory expectation is not sufficient for anything.
    contexts: rows,
  };
}

/**
 * Recompute whether a recorded per-context check measurement actually satisfies its own declared
 * expectation (F3). Returns the reasons it does not.
 *
 * The previous gate accepted any `check_state` carrying `measured: true`, regardless of the
 * expectation next to it — so a record could claim `all-green-expected-producer` while its
 * measurement showed nothing green, and the case still counted.
 */
export function recomputeCheckState(state, { runId, attempt, expectation, normalAppId, headSha = null }) {
  const problems = [];
  if (expectation === "irrelevant") {
    if (state && state.measured === true) problems.push("records a measured check state for a case whose checks are irrelevant");
    return problems;
  }
  if (!state || typeof state !== "object") return ["carries no check-state measurement"];
  if (String(state.expectation) !== String(expectation)) problems.push(`claims the check expectation ${JSON.stringify(String(state.expectation ?? ""))}`);
  if (state.measured !== true) return [...problems, "does not record that its declared check state was measured before the mutation"];
  /**
   * THE EXACT COMMIT THE CHECK STATE WAS MEASURED ON.
   *
   * A per-context measurement is only about a case if it was taken on the commit that case
   * requested. Without this, a record could carry a perfectly consistent green measurement of some
   * OTHER synthetic commit — the four `N*` nodes deliberately have different check states, which is
   * precisely what makes the missing/red/wrong-producer cases separable — and satisfy this gate.
   */
  if (headSha !== null && String(state.head_sha ?? "") !== String(headSha)) {
    problems.push(`records a check state measured on ${JSON.stringify(String(state.head_sha ?? "no commit"))} rather than on the commit this case requested`);
  }
  const contexts = derivedContextNames(runId, attempt);
  const rows = Array.isArray(state.contexts) ? state.contexts : null;
  if (!rows) return [...problems, "carries no per-context check measurement to recompute from"];
  if (rows.length !== contexts.length) problems.push(`measured ${rows.length} of ${contexts.length} required contexts`);
  // THE SAME EVALUATOR the runtime measurement used. The record supplies the rows; the rule lives in
  // exactly one place, so the producer/status semantics cannot drift between the two paths again.
  return [...problems, ...evaluateCheckState(rows, { runId, attempt, expectation, normalAppId })];
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
    // The PLANNED installations, in the immutable credential-free artifact, so every later boundary
    // has an expectation that does not come from the record it is checking. Nonsecret identifiers.
    normal_installation_id: ctx.plannedInstallations.normal,
    emergency_installation_id: ctx.plannedInstallations.emergency,
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
export async function localContext({ request, runId, attempt, evidenceDir, env, sourceContinuity = "enforce" }) {
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
  // THE SHARED SOURCE CONTINUITY CHECK (F3), at the local boundary: repository identity, measured
  // default branch, and the live staging head still equal to the immutable trusted source. Every
  // other boundary calls the same function.
  const continuity = await assertSourceContinuity({
    request, label: "local commissioning administration", mode: sourceContinuity,
    expected: { repositoryId: Number(intent.repository_id), workflowSha: String(intent.workflow_sha) },
  });
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
    plannedInstallations: assertPlannedInstallations(intent),
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
      measured_repository_id: continuity.repository_id,
      measured_head_sha: String(attemptRun.body.head_sha),
      measured_workflow_path: String(attemptRun.body.path),
      measured_event: String(attemptRun.body.event),
      measured_head_branch: String(attemptRun.body.head_branch ?? ""),
      matches_intent: true,
    }),
    sourceContinuity: continuity,
  });
}

/**
 * The operator's own identity and administrative standing, measured, before anything is created.
 *
 * THE EXACT IDENTITY, NOT "AN ADMIN" (PC-02/F6). The previous version accepted any login that held
 * repository admin. That is a materially different claim from the one the spec makes: the whole trust
 * story of the F1 witness protocol is "the authenticated local John measured the complete policy", and
 * a second administrator — or a machine account with admin — would satisfy an any-admin check while
 * producing evidence about a different identity. So all three of the numeric ID, the login and the
 * account type are required, and the numeric ID is the one GitHub will not reissue under a rename.
 */
/**
 * The two planned installation identities an intent artifact must carry, typed and distinct.
 *
 * Parsed in ONE place so the local operator, the publisher and the offline assessor all read the
 * plan the same way, and so a missing plan is a refusal rather than an `undefined` that compares
 * equal to nothing later on.
 */
export function assertPlannedInstallations(intent) {
  const normal = positiveProviderId(intent?.normal_installation_id);
  const emergency = positiveProviderId(intent?.emergency_installation_id);
  if (normal === null || emergency === null) {
    throw new AssertionFailure("the intent artifact carries no positive planned normal and emergency installation identities");
  }
  if (normal === emergency) throw new AssertionFailure("the intent artifact plans the same installation for both release identities");
  return Object.freeze({ normal: String(normal), emergency: String(emergency) });
}

export async function assertLocalOperator({ request }) {
  const viewer = await request("GET", "/user");
  if (viewer.status !== 200 || !viewer.body?.login) throw new IncompleteEvidence("the local gh identity could not be measured");
  const login = String(viewer.body.login);
  const id = Number(viewer.body.id);
  const type = String(viewer.body.type ?? "");
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new AssertionFailure("the local gh identity is not a plain user login");
  if (type !== OWNER_USER_TYPE) throw new AssertionFailure(`the local operator credential is a ${JSON.stringify(type)} identity, not the ${OWNER_USER_TYPE} this harness names`);
  if (!Number.isInteger(id) || id !== OWNER_USER_ID || login !== OWNER_LOGIN) {
    throw new AssertionFailure(
      `the local gh identity is ${JSON.stringify(login)} (#${Number.isInteger(id) ? id : "unmeasured"}); commissioning runs only as the one authorized operator ${OWNER_LOGIN} (#${OWNER_USER_ID})`,
    );
  }
  const permission = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/collaborators/${login}/permission`);
  if (permission.status !== 200 || !permission.body) throw new IncompleteEvidence("the local operator's repository permission could not be measured");
  if (String(permission.body.permission) !== "admin") throw new AssertionFailure("the local operator does not hold repository admin, which the human/admin actor cases require");
  return { login, permission: "admin", id, type };
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
 * THREE THINGS HERE WERE PREVIOUSLY WEAKER THAN THE CLAIM THEY SUPPORT, and each is why the
 * comparison is shaped the way it is now:
 *
 *  - **Complete pagination.** Every list is read to termination through {@link readAllPages}, which
 *    refuses a full final page rather than assuming it was the last. A page-1-only inventory drops a
 *    later-page tag ruleset, and the before/after hash then reports "unchanged" about a set it never
 *    saw in full.
 *  - **Resolved definitions, not the applicability summary.** `/rules/branches/main` returns a
 *    per-rule summary; a change to a bypass actor or a ruleset condition need not alter it. So every
 *    applicable ruleset ID is resolved to its complete definition and hashed from THAT.
 *  - **Staging as well as main.** Staging is the dispatch branch and the contribution base. A run
 *    that changed its protection while measuring only main would honestly report "production
 *    unchanged" about half of production.
 *
 * `excludeRulesetIds` is the run's OWN journaled rulesets. At baseline time nothing of ours exists,
 * so the inventory naturally excludes them; if the "after" measurement counted a ruleset of ours that
 * cleanup REFUSED to delete, every cleanup refusal would surface as "production state moved during
 * this run" — an interrupted result blaming somebody else for our own leftover. A foreign ruleset
 * appearing during the run still drifts, which is the case this check is actually for.
 */
export async function measureProductionBaseline({ request, excludeRulesetIds = new Set() }) {
  const refs = {};
  for (const branch of ["main", "staging"]) {
    const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/git/ref/heads/${branch}`);
    if (response.status !== 200 || !response.body?.object?.sha) throw new IncompleteEvidence(`the ${branch} branch state could not be measured (${response.status})`);
    refs[branch] = String(response.body.object.sha);
  }

  /** Resolve a branch's applicable rules to COMPLETE ruleset definitions, then hash those. */
  const resolvedApplicable = async (branch) => {
    const rules = await readAllPages({
      request, endpoint: `/repos/${COMMISSIONING_REPOSITORY}/rules/branches/${branch}`,
      label: `${branch}'s applicable rules`,
    });
    const ids = new Map();
    for (const rule of rules) {
      const id = rule?.ruleset_id;
      if (!Number.isInteger(id)) throw new IncompleteEvidence(`an applicable rule on ${branch} carries no ruleset identity, so its definition cannot be measured`);
      if (ids.has(id)) continue;
      const sourceType = String(rule?.ruleset_source_type ?? "");
      if (sourceType === "Repository") ids.set(id, `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${id}`);
      else if (sourceType === "Organization") ids.set(id, `/orgs/${ORG}/rulesets/${id}`);
      else throw new IncompleteEvidence(`applicable ruleset ${id} on ${branch} has an unsupported source type; its definition cannot be measured`);
    }
    const definitions = {};
    for (const [id, endpoint] of [...ids].sort((a, b) => a[0] - b[0])) {
      const detail = await request("GET", endpoint);
      if (detail.status !== 200 || !detail.body) throw new IncompleteEvidence(`applicable ruleset ${id} on ${branch} returned no readable definition`);
      definitions[id] = governedFingerprint(detail.body);
    }
    return { rule_count: rules.length, ruleset_fingerprints: definitions };
  };

  const protections = {};
  for (const branch of ["main", "staging"]) {
    const response = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/branches/${branch}/protection`);
    if (response.status !== 200 && response.status !== 404) throw new IncompleteEvidence(`${branch}'s classic protection could not be measured (${response.status})`);
    protections[branch] = { present: response.status === 200, hash: canonicalHash(response.status === 404 ? null : response.body) };
  }

  const inventoryRows = await readAllPages({
    request, endpoint: `/repos/${COMMISSIONING_REPOSITORY}/rulesets`, label: "the repository ruleset inventory",
  });
  const inventory = inventoryRows
    .filter((ruleset) => !excludeRulesetIds.has(Number(ruleset.id)))
    .map((ruleset) => ({ id: Number(ruleset.id), name: String(ruleset.name), target: String(ruleset.target ?? ""), enforcement: String(ruleset.enforcement ?? "") }))
    .sort((a, b) => a.id - b.id);
  // Every tag ruleset resolved to its complete definition — this is the `v*` protection the spec
  // names, and it must survive the run byte-identically.
  const tagRulesets = {};
  for (const entry of inventory.filter((ruleset) => ruleset.target === "tag")) {
    const detail = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${entry.id}`);
    if (detail.status !== 200 || !detail.body) throw new IncompleteEvidence(`tag ruleset ${entry.id} could not be measured; the v* protection baseline is incomplete`);
    tagRulesets[entry.id] = governedFingerprint(detail.body);
  }

  return {
    main_sha: refs.main,
    staging_sha: refs.staging,
    main_classic_protection_hash: protections.main.hash,
    main_classic_protection_present: protections.main.present,
    staging_classic_protection_hash: protections.staging.hash,
    staging_classic_protection_present: protections.staging.present,
    main_applicable_rulesets_hash: canonicalHash(await resolvedApplicable("main")),
    staging_applicable_rulesets_hash: canonicalHash(await resolvedApplicable("staging")),
    repository_ruleset_inventory_hash: canonicalHash(inventory),
    tag_ruleset_hashes: tagRulesets,
  };
}

/**
 * A collision refuses. It never adopts a resource it did not create, and never deletes one.
 *
 * ── COMPLETE INVENTORY, NOT PAGE ONE (F13) ──────────────────────────────────────────────────────
 *
 * This read page 1 directly instead of using the bounded complete-pagination helper beside it. With
 * a hundred unrelated rulesets on page 1 and a conflicting exact derived name on page 2, it
 * returned true and setup POSTed a SECOND ruleset under the same name — which undermines precisely
 * the unique run-owned namespace that lost-response adoption relies on to know a resource is ours.
 *
 * {@link readAllPages} is the same pagination semantics recovery uses, and it treats a full
 * terminal page as INCOMPLETE rather than as proof of the end: absence has to be proved over a
 * complete bounded inventory before anything is created, and "I saw no collision in the part I
 * read" is not that proof.
 */
export async function assertNoCollision({ request, ctx }) {
  for (const suffix of REF_SUFFIXES) {
    const ref = derivedRef(ctx.runId, ctx.attempt, suffix);
    const existing = await readDerivedRefSha({ request, ref });
    if (existing) throw new AssertionFailure(`${ref} already exists; commissioning refuses to adopt or delete a resource it did not create`);
  }
  const inventory = await readAllPages({
    request, endpoint: `/repos/${COMMISSIONING_REPOSITORY}/rulesets`,
    label: "the repository ruleset inventory (collision check)",
  });
  const derived = new Set(Object.values(derivedRulesetNames(ctx.runId, ctx.attempt)).flat());
  for (const ruleset of inventory) {
    if (derived.has(String(ruleset?.name))) throw new AssertionFailure(`a ruleset named ${String(ruleset.name)} already exists; commissioning refuses to adopt it`);
  }
  return { measured: true, inventory_size: inventory.length };
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

/** The provider-shape fingerprints measured by a readback AFTER the create was journaled (F5). */
const journaledFingerprints = (records) => new Map(
  records.filter((record) => record.type === "resource-fingerprinted")
    .map((record) => [`${record.data?.kind}:${record.data?.key}`, String(record.data?.governed_fingerprint ?? "")]),
);

/**
 * Every reconciliation this run has already recorded, keyed the same way as the intents.
 *
 * ⚠️ The key is `record.data.key` AS WRITTEN (F7). `reconcileCreateIntents` writes `key: pending.key`
 * and `pending.key` is ALREADY an {@link intentKey} — `ruleset:<name>` — so composing
 * `${kind}:${key}` here recorded every reconciliation under `ruleset:ruleset:<name>` and no lookup
 * ever found one. A reconciliation nobody can find is a reconciliation that gets performed again,
 * which is the opposite of what the record exists to prevent.
 */
const journaledReconciliations = (records) => new Map(
  records.filter((record) => record.type === "reconciliation" && typeof record.data?.key === "string")
    .map((record) => [String(record.data.key), record.data]),
);

/** The stable key a create intent, its result and its resource record all agree about. */
export function intentKey(data) {
  if (data?.kind === "ruleset") return `ruleset:${String(data.name)}`;
  if (data?.kind === "ref") return `ref:${String(data.suffix ?? data.ref)}`;
  if (data?.kind === "pull-request") return `pull-request:${String(data.head)}`;
  if (data?.kind === "commit") return `commit:${String(data.node)}`;
  return `unknown:${String(data?.kind ?? "")}`;
}

/**
 * Every create intent whose OUTCOME this journal does not account for (F5).
 *
 * The failure this exists for: `createDisposableRulesets` journaled the intent, POSTed, and then ran
 * another fallible GET before it retained the returned ID. A 201 followed by a 503 left a ruleset
 * that existed, was owned, and appeared in the journal only as a name — so the next setup saw no
 * `resource-created` for it and POSTed a SECOND one, and cleanup could account for neither.
 *
 * ── THE STATES, AND WHY "A RESULT EXISTS" IS NOT ONE OF THEM (F7) ───────────────────────────────
 *
 * This used to mark ANY result object `result-seen`, and downstream accounting counted only
 * `response-lost`. So a create whose response arrived carrying NO USABLE IDENTITY — a 201 whose
 * body had no `id`, or an ambiguous transport result at status 0 — was silently treated as
 * resolved: not counted as unresolved, not reconciled, and not created. The most consequential
 * possible state, "something may exist and we cannot name it", was the one state that produced no
 * action at all.
 *
 * Five states now, each with a different required action, and every identity read through the ONE
 * {@link positiveProviderId} parser so an absent identity can never arrive as `0`:
 *
 *  - `created`            — a `resource-created` record exists. Resolved; excluded from the list.
 *  - `reconciled`         — a bounded readback already established the outcome. Replayed, not redone.
 *  - `identified`         — a result carrying a POSITIVE provider identity. Adopt that exact identity.
 *  - `refused`            — a result with a measured 4xx refusal ({@link mutationRequestClass}) and
 *                           no identity. Nothing was created; safe to recreate, and NOT an
 *                           unaccounted resource.
 *  - `response-ambiguous` — a result with no usable identity whose status is 2xx or has no decisive
 *                           outcome (0, 5xx, 408, …). Something may exist: a 503 can follow a
 *                           committed create. Reconcile by readback; never re-POST.
 *  - `response-lost`      — no result at all. Same treatment as ambiguous, different cause.
 *  - `ownership-unprovable` — a bounded readback FOUND the resource and could not prove its body is
 *                           the intended one. It exists, this run may own it, and nothing may adopt
 *                           or delete it. Deliberately NOT resolved: root reconciles it.
 *
 * `unresolved` below is the set that BLOCKS: everything except `created`, `reconciled` and
 * `refused`. A packet cannot be complete while one of them stands.
 */
export const RESOLVED_INTENT_STATES = Object.freeze(["created", "reconciled", "refused"]);

export function unresolvedCreateIntents(records) {
  const created = new Set(records.filter((r) => r.type === "resource-created").map((r) => intentKey(r.data)));
  const results = new Map(records.filter((r) => r.type === "mutation-result" && r.data?.kind).map((r) => [intentKey(r.data), r.data]));
  const reconciled = journaledReconciliations(records);
  const out = [];
  for (const record of records) {
    if (record.type !== "mutation-intent") continue;
    if (!["ruleset", "ref", "pull-request", "commit"].includes(record.data?.kind)) continue;
    const key = intentKey(record.data);
    if (created.has(key)) continue;
    const result = results.get(key) ?? null;
    const identity = result ? (positiveProviderId(result.id) ?? positiveProviderId(result.number)) : null;
    // Decisive only with the transport's completion fact on the result itself (R02-1).
    const resultClass = result ? mutationRequestClass(result.status, result.response_complete) : "ambiguous";
    let state;
    /**
     * AN OWNERSHIP GAP IS NOT A SETTLED RECONCILIATION (F8, corrected).
     *
     * Every reconciliation record used to map to `reconciled`, which is in
     * {@link RESOLVED_INTENT_STATES} — so the moment an adoption site journaled
     * `ownership-unprovable`, the intent it refused to adopt counted as resolved and cleanup could
     * still report `cleaned`. The refusal would have laundered itself.
     */
    const settlement = reconciled.get(key) ?? null;
    if (settlement && String(settlement.outcome) === "ownership-unprovable") state = "ownership-unprovable";
    else if (reconciled.has(key)) state = "reconciled";
    else if (!result) state = "response-lost";
    else if (identity !== null) state = "identified";
    // A ref create carries no identity of its own — its identity IS its name — so a measured 2xx
    // for a ref is `identified` by the ref it named rather than by a number it never returns.
    else if (record.data?.kind === "ref" && resultClass === "accepted") state = "identified";
    else if (resultClass === "refused") state = "refused";
    else state = "response-ambiguous";
    out.push({
      key, seq: record.seq, intent: record.data, result,
      identity,
      reconciliation: reconciled.get(key) ?? null,
      state,
      unresolved: !RESOLVED_INTENT_STATES.includes(state),
    });
  }
  return out;
}

/** The intents that BLOCK a complete packet: everything created, reconciled or refused is settled. */
export const blockingCreateIntents = (records) => unresolvedCreateIntents(records).filter((entry) => entry.unresolved);

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
  let manifest = null;
  for (const node of plan) {
    if (shas[node.key]) continue;
    const files = [{ path: MARKER_PATH, mode: "100644", type: "blob", content: graphNodeContent(ctx.runId, ctx.attempt, node) }];
    if (node.key === "P") {
      manifest = buildManifest({ ...manifestInputs, graphShas: shas });
      files.push({ path: MANIFEST_PATH, mode: "100644", type: "blob", content: `${JSON.stringify(manifest, null, 2)}\n` });
    }
    journal.append("mutation-intent", { kind: "commit", node: node.key, parents: node.parents.map((key) => shas[key]) });
    const tree = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/git/trees`, { tree: files });
    if (tree.status < 200 || tree.status >= 300 || !tree.body?.sha) throw new IncompleteEvidence(`the synthetic tree for node ${node.key} could not be created (${tree.status})`);
    const commit = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/git/commits`, {
      message: `AIO-1124 synthetic commissioning ${ctx.runId}-${ctx.attempt} node ${node.key}`,
      tree: tree.body.sha, parents: node.parents.map((key) => shas[key]),
    });
    journal.append("mutation-result", { kind: "commit", key: node.key, node: node.key, status: commit.status, ...responseEvidence(commit), sha: commit.body?.sha ? String(commit.body.sha) : null, operation_id: commit.operation });
    if (commit.status < 200 || commit.status >= 300 || !commit.body?.sha) throw new IncompleteEvidence(`the synthetic commit for node ${node.key} could not be created (${commit.status})`);
    shas[node.key] = String(commit.body.sha);
    guardCtx.graphShas.add(shas[node.key]);
    journal.append("resource-created", { kind: "commit", node: node.key, sha: shas[node.key], tree: String(tree.body.sha), provenance: "created" });
  }
  // A resumed setup finds P already journaled and never rebuilds the manifest, so it is recomputed
  // from the same inputs rather than left null: `manifest_sha256` is a binding the cloud challenges
  // check, and "we did not happen to build it this time" is not a reason for it to be absent.
  return { shas, manifest: manifest ?? buildManifest({ ...manifestInputs, graphShas: shas }) };
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
    // The RESULT, fsynced before the readback that follows (F5): a 201 whose readback then fails
    // must not leave a created ref the journal cannot name.
    journal.append("mutation-result", { kind: "ref", key: suffix, suffix, ref, status: response.status, ...responseEvidence(response), sha: startSha, operation_id: response.operation });
    if (response.status < 200 || response.status >= 300) throw new IncompleteEvidence(`${ref} could not be created (${response.status})`);
    journal.append("resource-created", { kind: "ref", suffix, ref, start_node: REF_START_NODES[suffix], sha: startSha, provenance: "created" });
    const readback = await readDerivedRefSha({ request, ref });
    if (readback !== startSha) throw new AssertionFailure(`${ref} did not read back at its intended starting commit`);
    refs[suffix] = { ref, start_node: REF_START_NODES[suffix], start_sha: startSha, current_sha: startSha };
  }
  return refs;
}

/**
 * The COMPLETE governed fingerprint of a ruleset, from the provider's own representation.
 *
 * Only the five fields that carry policy MEANING, so provider bookkeeping (`id`, `created_at`,
 * `source`) does not make a faithful readback look modified — and all five of them, so a change to
 * the rules, the bypass actors, the enforcement mode or the condition's exclusions cannot slip past
 * a check that only looked at the name and one include ref.
 */
export const GOVERNED_RULESET_FIELDS = Object.freeze(["name", "target", "enforcement", "conditions", "bypass_actors", "rules"]);

export function governedFingerprint(ruleset) {
  if (!ruleset || typeof ruleset !== "object") throw new IncompleteEvidence("a ruleset fingerprint needs the provider's own representation");
  return canonicalHash(Object.fromEntries(GOVERNED_RULESET_FIELDS.map((field) => [field, ruleset[field] ?? null])));
}

/**
 * Can the CURRENT body be proved to be the INTENDED one? (F8)
 *
 * ── THE UNSAFE MOVE THIS REPLACES ───────────────────────────────────────────────────────────────
 *
 * When a create was durable but the first fingerprint GET failed — a 201 followed by a 503 — resume
 * and cleanup both simply MEASURED the current body and installed that value as the ownership
 * fingerprint, having checked only the name and one include ref. A ruleset edited after creation
 * therefore became its own evidence of identity and was deleted: the reproduction empties a
 * ruleset's rules from exactly that journal prefix and cleanup removes it. (The simulated run later
 * notices unrelated inventory drift, but the changed ruleset is already gone; a later refusal does
 * not undo an unsafe ownership decision.)
 *
 * A new current fingerprint cannot establish that a previously UNMEASURED body was unchanged. What
 * can is the INDEPENDENTLY RETAINED intended policy: the disposable body is recomputed from the
 * immutable intent (`buildDisposablePlan`), and the provider's governed body must equal it under
 * the SAME strict contract used everywhere else — byte-equal, or different only by provider default
 * expansion and key ordering. Anything else is an explicit OWNERSHIP GAP for root reconciliation.
 *
 * Never make a deletion safe by first trusting the value being deleted.
 */
export function proveIntendedOwnership({ measured, intended }) {
  if (!measured || typeof measured !== "object") return { provable: false, reason: "the provider returned no measurable body", differences: [] };
  if (!intended || typeof intended !== "object") {
    return { provable: false, reason: "this run retains no independently derived intended body to compare against", differences: [] };
  }
  const differences = [];
  let byteEqual = true;
  let addedOnly = true;
  for (const field of GOVERNED_RULESET_FIELDS) {
    // STRICT (see {@link compareToIntendedGoverned}): byte equality or key reordering, and nothing
    // else. An added field is a difference here even when its value is the provider's own default.
    const comparison = compareToIntendedGoverned(measured[field] ?? null, intended[field] ?? null);
    if (!comparison.byteEqual) byteEqual = false;
    if (comparison.equal) continue;
    if (!comparison.addedOnly) addedOnly = false;
    for (const entry of comparison.differences.slice(0, 8)) differences.push({ path: `${field}${entry.path}`, kind: entry.kind });
  }
  if (!differences.length) {
    return {
      provable: true, reason: null, differences: [], gap: null,
      basis: byteEqual ? "byte-equal-to-the-intended-governed-body" : "equal-to-the-intended-governed-body-modulo-key-ordering",
    };
  }
  // The gap is NAMED rather than absorbed. `provider-normalization` is PC-04's "report the concrete
  // gap" case: it is still a refusal, and root commissions a reviewed correction for it.
  const gap = addedOnly ? "provider-normalization" : "semantic";
  return {
    provable: false,
    gap,
    reason: addedOnly
      ? `the provider's governed body carries ${differences.length} field(s) the intended policy does not; this harness reports the concrete provider-normalization gap rather than adopting a body the unchanged production verifier would reject`
      : `the provider's governed body differs from the intended one in ${differences.length} semantic way(s)`,
    differences: differences.slice(0, 8),
  };
}

/**
 * Create the disposable rulesets — with the CREATE RESULT journaled before any further fallible read.
 *
 * ORDER IS THE WHOLE CORRECTION (F5). Previously: intent → POST → **GET** → journal the identity. A
 * 201 followed by a 503 on that GET therefore lost the created ruleset's ID entirely, and the next
 * setup POSTed another. Now: intent → POST → journal the RESULT AND THE RETURNED ID (fsynced) →
 * journal `resource-created` → readback → journal the provider-shape fingerprint as its own event.
 * Every prefix of that sequence leaves a state cleanup can account for, and none of them leaves a
 * resource this run made that the journal cannot name.
 *
 * The fingerprint is deliberately a SEPARATE event rather than a field of the create record: the two
 * are separate fallible steps, and merging them is what made an unmeasured fingerprint indistinguishable
 * from an unowned resource.
 */
export async function createDisposableRulesets({ request, journal, plan, guardCtx }) {
  const records = journal.read();
  const created = journaledResources(records, "ruleset");
  const fingerprints = journaledFingerprints(records);
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
        const measured = governedFingerprint(detail.body);
        const recorded = fingerprints.get(`ruleset:${entry.name}`);
        if (recorded === undefined) {
          // The create was journaled but its fingerprint never was — a crash between the two steps.
          // The bounded reconciliation is NOT "measure it now and trust that" (F8): the body is
          // proved against the independently retained intended policy first, and an unprovable body
          // becomes an explicit ownership gap rather than a fingerprint.
          const proof = proveIntendedOwnership({ measured: detail.body, intended: entry.body });
          if (!proof.provable) {
            journal.append("reconciliation", {
              kind: "ruleset", key: `ruleset:${entry.name}`, outcome: "ownership-unprovable",
              id: positiveProviderId(known.id), reason: proof.reason, differences: proof.differences,
            });
            throw new AssertionFailure(
              `journaled ruleset ${entry.name} was created but never fingerprinted, and its current body cannot be proved to be the intended one (${proof.reason}); commissioning records an ownership gap for root reconciliation rather than adopting the value it would later delete`,
            );
          }
          journal.append("resource-fingerprinted", {
            kind: "ruleset", key: entry.name, id: positiveProviderId(known.id), governed_fingerprint: measured,
            measured_at_stage: "resume-reconciliation", ownership_basis: proof.basis,
          });
        } else if (measured !== recorded) {
          // A resumed setup adopts a journaled ruleset only if its COMPLETE governed body is still the
          // one it recorded. Same ID and same name is not the same policy.
          throw new AssertionFailure(`journaled ruleset ${entry.name} has been modified since this run created it; commissioning refuses to adopt it`);
        }
        if (positiveProviderId(known.id) !== null) guardCtx.rulesetIds.add(positiveProviderId(known.id));
        result[actor].push({ ...known, governed_fingerprint: recorded ?? measured });
        continue;
      }
      journal.append("mutation-intent", { kind: "ruleset", actor, name: entry.name, target_ref: entry.target_ref, hash: entry.hash });
      const response = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/rulesets`, entry.body);
      // POSITIVE or absent — never a zero that later reads as an identity (F7).
      const id = positiveProviderId(response.body?.id);
      // FSYNCED BEFORE THE NEXT FALLIBLE CALL. This event is written whether the create succeeded or
      // not, and it carries the identity when there is one, so "the response was seen" is durable.
      journal.append("mutation-result", {
        kind: "ruleset", key: entry.name, name: entry.name, status: response.status, ...responseEvidence(response),
        id, operation_id: response.operation,
      });
      if (response.status < 200 || response.status >= 300 || id === null) {
        throw new IncompleteEvidence(`the disposable ruleset ${entry.name} could not be created (${response.status})`);
      }
      const record = { kind: "ruleset", actor, id, name: entry.name, target_ref: entry.target_ref, hash: entry.hash, provenance: "created" };
      guardCtx.rulesetIds.add(id);
      journal.append("resource-created", record);
      // Read the created ruleset back and journal the fingerprint of what the PROVIDER holds, not of
      // what we sent: the provider expands defaults, so the request hash would never match a later
      // readback and the comparison would be useless in exactly the case it exists for.
      const readback = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${id}`);
      if (readback.status !== 200 || !readback.body) {
        throw new IncompleteEvidence(`the disposable ruleset ${entry.name} (id ${id}) could not be read back after creation (${readback.status}); it is journaled as owned and its fingerprint is unmeasured, so cleanup must re-measure it`);
      }
      if (String(readback.body.name) !== entry.name) {
        throw new AssertionFailure(`the disposable ruleset created for ${entry.name} reads back under a different name`);
      }
      /**
       * A SUCCESSFUL 201 DOES NOT PROVE THIS GET BODY (F8, corrected).
       *
       * This site used to fingerprint the readback after a name check alone — so the very FIRST
       * adoption, on the ordinary success path, took whatever the provider returned as the
       * definition of "what we own". A body edited between the POST and this GET therefore became
       * its own evidence of ownership, and cleanup would later delete it for matching a fingerprint
       * derived from the edit. The independent driver's own scenario is the lost-response variant of
       * exactly this; the successful-201 variant was simply never asked about.
       *
       * The request body is right here (`entry.body`), independently derived from the immutable
       * intent, so there is nothing to reconstruct: the readback must BE that body.
       */
      const proof = proveIntendedOwnership({ measured: readback.body, intended: entry.body });
      if (!proof.provable) {
        journal.append("reconciliation", {
          kind: "ruleset", key: `ruleset:${entry.name}`, outcome: "ownership-unprovable",
          id, reason: proof.reason, differences: proof.differences, gap: proof.gap,
          measured_at_stage: "creation-readback",
        });
        throw new AssertionFailure(
          `the disposable ruleset ${entry.name} was created (id ${id}) but its readback is not the intended governed body (${proof.reason}); the created identity is retained and an ownership gap is recorded for root rather than adopting the body this run would later delete`,
        );
      }
      const governed = governedFingerprint(readback.body);
      journal.append("resource-fingerprinted", {
        kind: "ruleset", key: entry.name, id, governed_fingerprint: governed,
        measured_at_stage: "creation", ownership_basis: proof.basis,
      });
      result[actor].push({ ...record, governed_fingerprint: governed });
    }
  }
  return result;
}

/**
 * Reconcile every create intent whose result this journal does not account for (F5).
 *
 * Called before setup creates anything and before cleanup decides anything. It never re-issues a
 * POST, and it never adopts a resource because its name shares a prefix with ours: the only thing it
 * will adopt is the EXACT name or ref this run's own journaled intent recorded, under a run/attempt
 * scoped namespace whose absence was already proved by the collision check.
 */
export async function reconcileCreateIntents({ request, ctx, journal }) {
  const outcomes = [];
  /**
   * The INDEPENDENTLY DERIVED intended bodies, recomputed from the immutable context rather than
   * measured from the provider. Built lazily: a run with no unresolved ruleset intent should not pay
   * for it, and a context that cannot produce a plan should fail where that matters.
   */
  let intendedRulesets = null;
  const intendedBody = (name) => {
    if (intendedRulesets === null) {
      intendedRulesets = new Map(Object.values(buildDisposablePlan(ctx).plan).flat().map((entry) => [entry.name, entry.body]));
    }
    return intendedRulesets.get(String(name)) ?? null;
  };
  for (const pending of unresolvedCreateIntents(journal.read())) {
    // A recorded ownership gap is REPLAYED, not redone: it stays unresolved and blocking, and the
    // chain does not grow a duplicate record every time cleanup runs.
    if (pending.state === "reconciled" || pending.state === "ownership-unprovable") {
      outcomes.push({ ...pending.reconciliation, replayed: true });
      continue;
    }
    const base = { kind: pending.intent.kind, key: pending.key, intent_seq: pending.seq };

    if (pending.intent.kind === "commit") {
      // An unreferenced git object is not a resource: nothing points at it, cleanup has nothing to
      // remove, and re-creating the node yields another equally inert object. Recorded rather than
      // silently skipped, because "safe" is a claim that should be visible in the chain.
      const outcome = { ...base, outcome: "unreferenced-git-object", safe_to_recreate: true };
      journal.append("reconciliation", outcome);
      outcomes.push(outcome);
      continue;
    }

    if (pending.intent.kind === "ruleset") {
      // POSITIVE identity or NOTHING (F7). `Number(null)` is 0, and a zero here meant a forbidden
      // `/rulesets/0` request issued with no provider read behind it at all.
      let id = positiveProviderId(pending.result?.id);
      if (id === null) {
        // The response was lost or carried no identity. Ask the provider for the EXACT name this
        // intent recorded, over complete pagination — not a prefix sweep.
        const inventory = await readAllPages({ request, endpoint: `/repos/${COMMISSIONING_REPOSITORY}/rulesets`, label: "the repository ruleset inventory" });
        const found = inventory.filter((ruleset) => String(ruleset?.name) === String(pending.intent.name));
        if (found.length > 1) throw new AssertionFailure(`reconciliation found ${found.length} rulesets named ${pending.intent.name}; commissioning refuses an ambiguous ownership claim`);
        id = found.length ? positiveProviderId(found[0].id) : null;
        if (found.length && id === null) {
          throw new IncompleteEvidence(`reconciliation found a ruleset named ${pending.intent.name} carrying no usable provider identity; its ownership cannot be established`);
        }
      }
      if (id === null) {
        const outcome = { ...base, outcome: "absent", safe_to_recreate: true };
        journal.append("reconciliation", outcome);
        outcomes.push(outcome);
        continue;
      }
      const detail = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${id}`);
      if (detail.status !== 200 || !detail.body) throw new IncompleteEvidence(`reconciliation could not read ruleset ${id} recorded by an unresolved intent; this attempt is not resumable`);
      if (String(detail.body.name) !== String(pending.intent.name)) {
        throw new AssertionFailure(`reconciliation found ruleset ${id} under a different name than the intent recorded; commissioning refuses to adopt it`);
      }
      /**
       * ── THE ADOPTION THE PREVIOUS PLAN MISSED ENTIRELY (F8, corrected) ──────────────────────────
       *
       * This is a FIRST FINGERPRINT ADOPTION, and until now the only thing between a lost create
       * response and `resource-fingerprinted` was a name match. That mattered more than the two
       * guarded sites, because reconciliation runs BEFORE them: `runCleanupPhase` calls it first, so
       * by the time cleanup's own `proveIntendedOwnership` branch is reached a fingerprint already
       * exists and the branch is skipped. The guarded sites were guarded; the unguarded one supplied
       * the evidence they trusted, and a ruleset whose rules had been emptied was deleted.
       *
       * The intended body is rebuilt from the immutable context, never from the resource.
       */
      const intended = intendedBody(pending.intent.name);
      const proof = proveIntendedOwnership({ measured: detail.body, intended });
      if (!proof.provable) {
        // The ID IS retained — the resource exists and root must be able to name it — but nothing is
        // adopted, nothing is fingerprinted, and the intent stays unresolved so no phase can claim
        // this run left nothing behind.
        const gap = {
          ...base, outcome: "ownership-unprovable", id,
          reason: proof.reason, differences: proof.differences, gap: proof.gap,
          measured_at_stage: "lost-response-reconciliation",
        };
        journal.append("reconciliation", gap);
        outcomes.push(gap);
        continue;
      }
      const outcome = { ...base, outcome: "adopted-from-intent", id, ownership_basis: proof.basis };
      journal.append("reconciliation", outcome);
      journal.append("resource-created", { kind: "ruleset", actor: pending.intent.actor, id, name: pending.intent.name, target_ref: pending.intent.target_ref, hash: pending.intent.hash, provenance: "reconciled-from-intent" });
      journal.append("resource-fingerprinted", {
        kind: "ruleset", key: pending.intent.name, id, governed_fingerprint: governedFingerprint(detail.body),
        measured_at_stage: "reconciliation", ownership_basis: proof.basis,
      });
      outcomes.push(outcome);
      continue;
    }

    if (pending.intent.kind === "ref") {
      const present = await readDerivedRefSha({ request, ref: pending.intent.ref });
      if (present === null) {
        const outcome = { ...base, outcome: "absent", safe_to_recreate: true };
        journal.append("reconciliation", outcome);
        outcomes.push(outcome);
        continue;
      }
      if (String(present) !== String(pending.intent.sha)) {
        throw new AssertionFailure(`reconciliation found ${pending.intent.ref} at a commit the intent did not request; commissioning refuses to adopt or delete it`);
      }
      const outcome = { ...base, outcome: "adopted-from-intent", ref: pending.intent.ref, sha: present };
      journal.append("reconciliation", outcome);
      journal.append("resource-created", { kind: "ref", suffix: pending.intent.suffix, ref: pending.intent.ref, start_node: REF_START_NODES[pending.intent.suffix], sha: present, provenance: "reconciled-from-intent" });
      outcomes.push(outcome);
      continue;
    }

    // pull-request. POSITIVE identity or a PROVIDER READ (F7): `Number(null)` was 0, an integer, so
    // this branch was skipped entirely and an owned pull request number ZERO was journalled without
    // a single provider call ever being made.
    let number = positiveProviderId(pending.result?.number);
    if (number === null) {
      const head = branchOf(derivedRef(ctx.runId, ctx.attempt, "pr-head"));
      const listed = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/pulls?per_page=100&page=1&state=all&head=${ORG}:${head}`);
      if (listed.status !== 200 || !Array.isArray(listed.body)) throw new IncompleteEvidence("reconciliation could not read this run's own synthetic pull requests");
      const matching = listed.body.filter((pull) => String(pull?.head?.ref) === head && String(pull?.base?.ref) === String(pending.intent.base));
      if (matching.length > 1) throw new AssertionFailure(`reconciliation found ${matching.length} synthetic pull requests for this run's head; commissioning refuses an ambiguous ownership claim`);
      number = matching.length ? positiveProviderId(matching[0].number) : null;
      if (matching.length && number === null) {
        throw new IncompleteEvidence("reconciliation found this run's synthetic pull request carrying no usable number; its ownership cannot be established");
      }
    }
    if (number === null) {
      const outcome = { ...base, outcome: "absent", safe_to_recreate: true };
      journal.append("reconciliation", outcome);
      outcomes.push(outcome);
      continue;
    }
    const outcome = { ...base, outcome: "adopted-from-intent", number };
    journal.append("reconciliation", outcome);
    journal.append("resource-created", { kind: "pull-request", number, base: pending.intent.base, head: pending.intent.head, provenance: "reconciled-from-intent" });
    outcomes.push(outcome);
  }
  return outcomes;
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
  const number = positiveProviderId(response.body?.number);
  // The RESULT before anything else can fail (F5). A created pull request whose number was never
  // journaled is a pull request cleanup will not close. POSITIVE identity only (F7).
  journal.append("mutation-result", { kind: "pull-request", key: head, base, head, status: response.status, ...responseEvidence(response), number, operation_id: response.operation });
  if (response.status < 200 || response.status >= 300 || number === null) {
    throw new IncompleteEvidence(`the synthetic pull request could not be created (${response.status})`);
  }
  const record = { kind: "pull-request", number, base, head, provenance: "created" };
  journal.append("resource-created", record);
  // A pull request an automation could retarget is not the subject we measured. Bind it now — after
  // the create is durable, because a refusal here must not lose the number.
  if (String(response.body.base?.ref) !== base || String(response.body.head?.ref) !== head) {
    throw new AssertionFailure("the synthetic pull request did not read back with the exact derived base and head");
  }
  return record;
}

/**
 * The one place a local phase opens its lock, its journal and its guarded `gh` transport — and, now,
 * THE ONE PLACE LOCAL MUTATION ADMISSION HAPPENS (F9).
 *
 * ── WHY THE IDENTITY CHECK MOVED HERE ───────────────────────────────────────────────────────────
 *
 * `assertLocalOperator` was called by setup and by human-tests, each at its own call site — and
 * therefore NOT by cleanup or by collect, which is precisely the shape a per-call-site rule always
 * ends up in. Cleanup is the phase that DELETES: swapping the local `gh` credential to a different
 * repository administrator between setup and cleanup still returned `cleaned`, issued thirteen
 * DELETEs, and never read `/user` at all. The identity of the operator who created the journal is
 * not evidence about the identity of the operator now deleting things.
 *
 * So admission is a property of opening a local session, and every local phase — setup, human
 * tests, cleanup, collect, and any recovery that can cause a mutation — gets the same fresh numeric
 * ID, login, type and repository-admin proof before it can reach the journal or the transport.
 */
async function openLocalSession({ runId, attempt, evidenceDir, env, deps, sourceContinuity = "enforce" }) {
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
  // FRESH, before the lock and before anything is read or written: the named local operator, by
  // numeric ID, login and type, holding repository admin right now (F9).
  const operator = await assertLocalOperator({ request });
  const ctx = await localContext({ request, runId, attempt, evidenceDir: dir, env, sourceContinuity });
  const lock = acquireJournalLock({ dir, runId, attempt, now: deps.now });
  try {
    const journal = openJournal({ dir, runId, attempt, source: ctx.workflowSha, lock, now: deps.now });
    const existing = journal.read();
    if (existing.length && existing[0].source !== ctx.workflowSha) {
      throw new AssertionFailure("this run's journal was opened against a different immutable source; it is not this commissioning run's evidence");
    }
    for (const entry of journaledResources(existing, "commit")) guardCtx.graphShas.add(entry.sha);
    for (const entry of journaledResources(existing, "ruleset")) {
      if (positiveProviderId(entry.id) !== null) guardCtx.rulesetIds.add(positiveProviderId(entry.id));
    }
    guardCtx.pullNumber = positiveProviderId(journaledResources(existing, "pull-request")[0]?.number);
    return { dir, ctx, operator, request, guardCtx, journal, lock, records: existing };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/** PC-03/PC-04 setup. Creates nothing until every precondition has been measured. */
export async function runSetupPhase({ runId, attempt, evidenceDir, env, deps = {} }) {
  const session = await openLocalSession({ runId, attempt, evidenceDir, env, deps });
  const { dir, ctx, operator, request, guardCtx, journal, lock } = session;
  try {
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
      journal.append("run-opened", { operator_login: operator.login, operator_id: operator.id, workflow_sha: ctx.workflowSha, repository_id: ctx.repositoryId });
      baseline = await measureProductionBaseline({ request });
      journal.append("baseline-measured", baseline);
      await assertNoCollision({ request, ctx });
    }
    // RECONCILE BEFORE CREATING (F5). A resumed attempt whose previous run lost a create response
    // must resolve that intent by bounded readback of the exact name/ref it recorded, BEFORE any new
    // POST — otherwise the resume is the duplicate-creation path this reconciliation exists to close.
    const reconciliations = await reconcileCreateIntents({ request, ctx, journal });
    for (const entry of journaledResources(journal.read(), "ruleset")) {
      if (positiveProviderId(entry.id) !== null) guardCtx.rulesetIds.add(positiveProviderId(entry.id));
    }
    for (const entry of journaledResources(journal.read(), "commit")) guardCtx.graphShas.add(String(entry.sha));
    const { production, productionHash, plan } = buildDisposablePlan(ctx);
    /**
     * ── THE PRIVATE PRODUCTION SUBJECT, RETAINED BEFORE ANY DISPOSABLE MUTATION (PC-04) ───────────
     *
     * PC-04 requires the raw production-shape subject and its hash to be preserved, and the final
     * assessment requires the producer map and policy hash to be RECONSTRUCTED. Neither was possible
     * offline: the published intent deliberately carries only `producer_ids_hash`, so an assessor
     * had nothing to regenerate `buildMainRulesets` from and could do no better than check that the
     * packet's copies of a digest agreed with each other — which the independent driver defeated
     * with a single invented string.
     *
     * `localContext` has already parsed the exact twelve-context map and proved its canonical digest
     * against the immutable intent, so the inputs are validated before they are retained here.
     *
     * PRIVACY IS THE POINT AND THE BOUND. This file is mode 0600, local, and is never added to a
     * workflow upload path, a dispatch envelope, the public manifest or any log. The published
     * intent still exposes only the digest.
     */
    const productionInputs = {
      schema_version: RESULT_SCHEMA_VERSION, phase: "production-inputs",
      run_id: String(runId), attempt: String(attempt), workflow_sha: ctx.workflowSha,
      repository: COMMISSIONING_REPOSITORY, repository_id: ctx.repositoryId,
      normal_app_id: ctx.normalAppId, emergency_app_id: ctx.emergencyAppId,
      normal_installation_id: ctx.plannedInstallations.normal,
      emergency_installation_id: ctx.plannedInstallations.emergency,
      producer_ids: ctx.producerIds,
      producer_ids_hash: canonicalHash(ctx.producerIds),
      production_rulesets: production,
      production_policy_hash: productionHash,
      visibility: "PRIVATE local evidence, mode 0600. Never uploaded, dispatched, published in the manifest, or logged.",
    };
    const productionInputsPath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, "production-inputs"), productionInputs);
    const productionInputsDigest = canonicalHash(productionInputs);
    const boundRecord = session.records.find((record) => record.type === "production-inputs-bound")?.data ?? null;
    if (boundRecord) {
      // A RESUME may not swap the subject its predecessor was measured against.
      if (String(boundRecord.production_inputs_sha256) !== productionInputsDigest) {
        throw new AssertionFailure(
          "this run's private production inputs no longer match the digest its journal bound at setup; the production subject changed under a resumed attempt",
        );
      }
    } else {
      journal.append("production-inputs-bound", {
        production_inputs_sha256: productionInputsDigest,
        production_policy_hash: productionHash,
        producer_ids_hash: canonicalHash(ctx.producerIds),
        // The PATH is journaled, the CONTENT is not: the chain must stay publishable-safe.
        evidence_file: path.basename(productionInputsPath),
      });
    }
    const { shas, manifest } = await createSyntheticGraph({
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
      operator: { login: operator.login, permission: operator.permission, id: operator.id, type: operator.type },
      intent_remeasured: ctx.remeasuredIntent,
      protected_jobs_at_setup: jobs,
      production_baseline: baseline,
      production_policy_hash: productionHash,
      // The manifest and graph digests this attempt is bound to, recomputed by `check-evidence` from
      // the graph it records rather than believed (F4). The cloud challenges carry the same two.
      manifest_sha256: canonicalHash(manifest),
      graph_sha256: graphBindingDigest(shas, runId, attempt),
      // The digest of the PRIVATE production input/subject file, so the offline reconstruction can
      // bind file → journal → setup. The file's contents stay local; only its hash travels here.
      production_inputs_sha256: productionInputsDigest,
      // The manifest ITSELF, so its digest can be recomputed rather than believed. It carries
      // identities and hashes only — no producer map, no raw production subject.
      manifest,
      unresolved_intents: blockingCreateIntents(journal.read()).length,
      reconciliations,
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

/**
 * Reviewer history for the protected environments. GITHUB_ACTOR is the dispatcher, never this.
 *
 * The reviewer's NUMERIC ID travels alongside the login (F6): the self-review comparison and the
 * "is this the configured human reviewer" check are both identity questions, and a login is
 * renameable while an ID is not.
 */
export function summarizeApprovals(response) {
  if (response?.status !== 200 || !Array.isArray(response.body)) {
    return { measured: false, reason: `the run's environment approval history could not be measured (${response?.status ?? "no response"})`, entries: [] };
  }
  return {
    measured: true,
    entries: response.body.map((entry) => ({
      state: String(entry?.state ?? "unknown"),
      reviewer_login: String(entry?.user?.login ?? "unknown"),
      reviewer_id: Number.isInteger(Number(entry?.user?.id)) ? Number(entry.user.id) : null,
      reviewer_type: String(entry?.user?.type ?? "unknown"),
      /**
       * WHEN. The provider's own timestamp for the approval, which this summary used to DROP —
       * so an approval could not be placed in time at all, and one dated after the run it approved
       * was invisible by construction rather than by oversight.
       */
      approved_at: String(entry?.updated_at ?? entry?.created_at ?? ""),
      environments: (entry?.environments ?? []).map((environment) => String(environment?.name ?? "unknown")),
    })),
  };
}

/** PC-05, the local human/admin half. */
export async function runHumanTestsPhase({ runId, attempt, evidenceDir, env, deps = {} }) {
  const session = await openLocalSession({ runId, attempt, evidenceDir, env, deps });
  const { dir, ctx, operator, request, journal, lock, records } = session;
  try {
    const setup = readEvidenceFile(dir, evidenceSlug(runId, attempt, "setup"));
    if (!setup) throw new IncompleteEvidence("local setup has not completed for this run");
    const shas = Object.fromEntries(journaledResources(records, "commit").map((entry) => [entry.node, entry.sha]));
    if (!Object.keys(shas).length) throw new IncompleteEvidence("the journal records no synthetic commits for this run");
    const { records: caseRecords, halted } = await runActorCases({
      request, actor: "human", ctx, graphShas: shas, journal, pull: journaledResources(records, "pull-request")[0] ?? null,
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

/**
 * ── THE PHASE OUTCOME: HALT AND COMPLETENESS ARE ORTHOGONAL (R02-2) ─────────────────────────────
 *
 * `halted` is a SAFETY fact — no further actor mutation runs, and nothing is retried — and it is
 * already durable in the journal/state before this function is reached. It says nothing about
 * whether the matrix MEASURED a failure. So:
 *
 *  - any measured failure (an unexpected success, mutation or denial, a wrong measured outcome) is
 *    exit 1, even when inconclusive or not-run cases sit beside it: an unknown case never launders a
 *    measured one;
 *  - a matrix whose every failing case is inconclusive or not-run is exit 3 — including one that
 *    halted on an ambiguous mutation, which used to be reported as a measured failure.
 */
function finishTestPhase({ runId, attempt, phase, caseRecords, halted, evidencePath }) {
  const failed = caseRecords.filter((record) => record.passed !== true);
  if (!failed.length) return closedResult({ runId, attempt, phase, status: "passed", evidencePath });
  const onlyInconclusive = failed.every((record) => record.outcome === "inconclusive" || record.outcome === "not-run");
  if (onlyInconclusive) {
    const stop = halted ? `; ${halted} left the outcome unknown and stopped every later ${phase} mutation, which is never retried` : "";
    throw new IncompleteEvidence(`${failed.length} of ${caseRecords.length} ${phase} cases could not be measured${stop}`, { evidencePath });
  }
  throw new AssertionFailure(`${failed.length} of ${caseRecords.length} ${phase} cases did not record their expected provider outcome`, { evidencePath });
}

/**
 * The EXACT grant each protected role's App may hold. Closed both ways: a missing permission and an
 * extra one are both refusals, and so is a permission at a level other than the one named here.
 *
 * These are the sets the owner provisioned, and they are what makes "unexpected grants refuse before
 * credentials are exercised" (PC-04) a check rather than a hope. The normal App needs `checks: write`
 * because it publishes the TEST-ONLY contexts its own accepted case requires; the emergency App does
 * not, and must not have it.
 */
export const ROLE_APP_PERMISSIONS = Object.freeze({
  normal: Object.freeze({ checks: "write", contents: "write", metadata: "read" }),
  emergency: Object.freeze({ contents: "write", metadata: "read" }),
});

/**
 * Mint the App JWT used for the grant reads below.
 *
 * WHY A SECOND TOKEN PATH EXISTS AT ALL. `release-controller.mjs`'s `createInstallationToken` is the
 * production helper and is reused UNCHANGED for the actor token — but it returns only the token
 * string and discards the exchange response, and it exposes no JWT. Measuring grants therefore needs
 * a JWT here. This mints one with the same `jose` primitives (no new dependency), keeps it inside the
 * protected job, hands it straight to the redactor, and uses it for two READ endpoints only.
 */
export async function mintAppJwt({ appId, privateKey, now = () => Date.now(), jose = null }) {
  if (!POSITIVE_DECIMAL.test(String(appId ?? ""))) throw new UsageError("an App JWT needs a positive decimal App ID");
  if (typeof privateKey !== "string" || !privateKey.trim()) throw new UsageError("an App JWT needs this job's own App private key");
  const { importPKCS8, SignJWT } = jose ?? await import("jose");
  const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "RS256");
  const seconds = Math.floor(now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(String(appId))
    // A 60-second life: this JWT is used for two reads that happen immediately, and a short window
    // is the cheapest possible limit on a credential minted from the private key.
    .setIssuedAt(seconds - 30)
    .setExpirationTime(seconds + 60)
    .sign(key);
}

/** Every permission the role's App holds that its closed set does not name, and vice versa. */
export function comparePermissions(observed, expected) {
  const actual = observed && typeof observed === "object" && !Array.isArray(observed) ? observed : null;
  if (!actual) return { ok: false, unexpected: [], missing: Object.keys(expected), wrongLevel: [] };
  const unexpected = Object.keys(actual).filter((scope) => !(scope in expected)).sort();
  const missing = Object.keys(expected).filter((scope) => !(scope in actual)).sort();
  const wrongLevel = Object.keys(expected)
    .filter((scope) => scope in actual && String(actual[scope]) !== expected[scope])
    .map((scope) => `${scope}=${String(actual[scope])} (expected ${expected[scope]})`)
    .sort();
  return { ok: !unexpected.length && !missing.length && !wrongLevel.length, unexpected, missing, wrongLevel };
}

/**
 * PC-04's grant gate: measure the App's ACTUAL identity, installation and permissions with the App
 * JWT, and refuse anything unexpected BEFORE a single credential is exercised.
 *
 * The previous version of this asked `GET /installation/repositories` for `repository_selection`.
 * That endpoint does not document it, so a perfectly valid provider response failed the check — and
 * the permission set, which PC-04 actually cares about, was never measured at all; it was labelled
 * `unverified-by-this-harness` after the writes had already happened. Both are read here, from the
 * endpoints that document them, before the actor token exists.
 */
export async function measureAppGrants({ request, role, ctx, installationId }) {
  const expected = ROLE_APP_PERMISSIONS[role];
  if (!expected) throw new UsageError(`no closed permission set is declared for commissioning role ${JSON.stringify(String(role))}`);
  const expectedAppId = role === "normal" ? ctx.normalAppId : ctx.emergencyAppId;

  const app = await request("GET", "/app");
  if (app.status !== 200 || !app.body) throw new IncompleteEvidence(`the ${role} App's own identity could not be measured (${app.status})`);
  if (Number(app.body.id) !== Number(expectedAppId)) {
    throw new AssertionFailure(`the private key in the ${role} job signs for App ${Number(app.body.id)}, not the identity this run is configured for`);
  }

  const installation = await request("GET", `/app/installations/${installationId}`);
  if (installation.status !== 200 || !installation.body) throw new IncompleteEvidence(`the ${role} App's installation could not be measured (${installation.status})`);
  /**
   * THE RETURNED IDENTITY IS THE REQUESTED ONE (PC-04, corrected).
   *
   * This function recorded `installation_id: String(installationId)` — the value it was ASKED for,
   * echoed back into the evidence as though it had been measured. Nothing ever compared the
   * provider's own `id` with it, so a redirect, a proxy or a fixture could answer for a different
   * installation and the packet would read as a measurement of the intended one.
   */
  if (Number(installation.body.id) !== Number(installationId)) {
    throw new AssertionFailure(
      `the provider answered for installation ${JSON.stringify(installation.body.id ?? null)}, not the ${String(installationId)} this job asked about`,
    );
  }
  if (Number(installation.body.app_id) !== Number(expectedAppId)) {
    throw new AssertionFailure(`installation ${String(installationId)} belongs to App ${Number(installation.body.app_id)}, not the ${role} identity`);
  }
  if (String(installation.body.repository_selection ?? "") !== "selected") {
    throw new AssertionFailure(`the ${role} App's installation is not limited to selected repositories; a release identity installed org-wide is out of scope for commissioning`);
  }
  if (installation.body.suspended_at !== null && installation.body.suspended_at !== undefined) {
    throw new AssertionFailure(`the ${role} App's installation is suspended; nothing it is asked to do would measure the policy`);
  }

  const grants = comparePermissions(installation.body.permissions, expected);
  if (!grants.ok) {
    // BEFORE any write. An over-granted release identity would make an acceptance in the matrix a
    // statement about the grant rather than about the policy.
    throw new AssertionFailure(
      `the ${role} App's installation grants are not the closed set this run requires`
      + `${grants.unexpected.length ? ` (unexpected: ${grants.unexpected.join(", ")})` : ""}`
      + `${grants.missing.length ? ` (missing: ${grants.missing.join(", ")})` : ""}`
      + `${grants.wrongLevel.length ? ` (wrong level: ${grants.wrongLevel.join(", ")})` : ""}`,
    );
  }
  // An installation cannot exceed the App that owns it. If the provider says otherwise, something
  // about this identity is not what either endpoint claims, and neither reading is usable.
  const declared = app.body.permissions && typeof app.body.permissions === "object" ? app.body.permissions : null;
  if (!declared) throw new IncompleteEvidence(`the ${role} App does not report its declared permissions; the installation grant cannot be bounded by it`);
  const beyond = Object.keys(expected).filter((scope) => !(scope in declared));
  if (beyond.length) {
    throw new AssertionFailure(`the ${role} App's installation grants ${beyond.join(", ")}, which the App itself does not declare`);
  }
  return {
    measured: true,
    app_id: Number(app.body.id),
    app_slug: typeof app.body.slug === "string" ? app.body.slug : null,
    installation_id: String(installationId),
    // The provider's OWN identity for the installation, distinct from the one we requested.
    installation_body_id: Number(installation.body.id),
    installation_app_id: Number(installation.body.app_id),
    account_login: typeof installation.body.account?.login === "string" ? installation.body.account.login : null,
    repository_selection: "selected",
    suspended: false,
    // The measured grant set, closed and equal to the expected one — recorded so a reviewer reads a
    // measurement rather than a promise.
    installation_permissions: { ...installation.body.permissions },
    app_declared_permissions: { ...declared },
    expected_permissions: { ...expected },
  };
}

/**
 * The TOKEN-side binding: which repository the installation token can actually reach.
 *
 * Deliberately asserts only what `GET /installation/repositories` documents — `total_count` and
 * `repositories`. `repository_selection` is installation metadata and is measured by
 * {@link measureAppGrants} from the endpoint that reports it.
 */
export async function assertInstallationScope({ request, ctx }) {
  const response = await request("GET", "/installation/repositories?per_page=100&page=1");
  if (response.status !== 200 || !response.body) throw new IncompleteEvidence("the repositories this installation token can reach could not be measured");
  const repositories = Array.isArray(response.body.repositories) ? response.body.repositories : null;
  if (!repositories) throw new IncompleteEvidence("the installation repository list is not the documented shape");
  if (Number(response.body.total_count) !== 1 || repositories.length !== 1) {
    throw new AssertionFailure(`this installation token reaches ${Number(response.body.total_count)} repositories; commissioning requires exactly this one`);
  }
  if (Number(repositories[0]?.id) !== ctx.repositoryId || String(repositories[0]?.full_name ?? "") !== COMMISSIONING_REPOSITORY) {
    throw new AssertionFailure("this installation token's sole repository is not the one this commissioning run is configured for");
  }
  return { total_count: 1, repository_id: ctx.repositoryId, repository_full_name: COMMISSIONING_REPOSITORY };
}

/**
 * The plan a protected job derives FOR ITSELF, and requires the manifest to agree with.
 *
 * The manifest can never supply a plan; it can only agree with one this job computed from identities
 * it measured. A manifest that disagrees is refused rather than believed.
 */
export function derivePlannedPolicy({ ctx, actor, manifest }) {
  const production = buildMainRulesets({ normalAppId: ctx.normalAppId, emergencyAppId: ctx.emergencyAppId, producerIds: ctx.producerIds });
  const derived = transformToDisposable(production, { runId: ctx.runId, attempt: ctx.attempt, actor, normalAppId: ctx.normalAppId })
    .map((ruleset) => ({ name: ruleset.name, target_ref: ruleset.conditions.ref_name.include[0], hash: canonicalHash(ruleset), body: ruleset }));
  const declared = (manifest?.policy_plan?.[actor] ?? []).map((entry) => ({
    name: String(entry?.name ?? ""), target_ref: String(entry?.target_ref ?? ""), hash: String(entry?.hash ?? ""),
  }));
  if (!declared.length) throw new AssertionFailure("the manifest declares no disposable policy for this actor");
  const sorted = (list) => canonicalJson([...list].map(({ name, target_ref, hash }) => ({ name, target_ref, hash })).sort((a, b) => a.name.localeCompare(b.name)));
  if (sorted(declared) !== sorted(derived)) {
    throw new AssertionFailure("the manifest's declared disposable policy is not the one this job derives from its own measured identities");
  }
  return derived;
}

/**
 * The closed publishable vocabulary for this actor's projection — derived, never supplied.
 *
 * Everything in it was already disclosed in the credential-free intent artifact: the generated
 * ruleset names, the one derived ref, the generated TEST-ONLY contexts, the measured producer IDs and
 * the two planned release App IDs. That is what makes the disclosure narrow by construction rather
 * than by review.
 */
export function publishableVocabulary({ ctx, actor }) {
  const targetRef = derivedRef(ctx.runId, ctx.attempt, actor === "human" ? "human" : actor);
  return {
    rulesetNames: new Set(derivedRulesetNames(ctx.runId, ctx.attempt)[actor] ?? []),
    refPatterns: new Set([targetRef]),
    contexts: new Set(derivedContextNames(ctx.runId, ctx.attempt)),
    producerIds: new Set([Number(ctx.normalAppId), ...Object.values(ctx.producerIds ?? {}).map(Number)]),
    bypassAppIds: new Set([Number(ctx.normalAppId), Number(ctx.emergencyAppId)]),
    sources: new Set([COMMISSIONING_REPOSITORY, ORG]),
  };
}

/**
 * PRECONDITION ONLY: which of the planned rulesets the provider says APPLY to this job's ref.
 *
 * ⚠️ This is deliberately NOT the compatibility verdict any more, and the reason is a documented API
 * contract rather than a suspicion. `GET /repos/{repo}/rulesets/{id}` returns `bypass_actors` only to
 * a caller with WRITE access to the ruleset, and this job holds `metadata: read`. A 200 with the
 * bypass matrix absent is therefore the CORRECT response to this credential — so the previous build,
 * which fed these bodies to the production verifier and passed `classicProtection: null` while
 * measuring no classic protection at all, produced a `compatible` verdict about a policy it had not
 * measured. The complete governed policy and the classic representation now come from the local
 * witness ({@link verifyWitnessedPolicy}); what this reads is the applicability SUMMARY — names,
 * targets and enforcement mode — which the token genuinely does expose.
 */
export async function assertPlannedPolicyApplies({ request, ctx, actor, manifest }) {
  const branch = branchOf(derivedRef(ctx.runId, ctx.attempt, actor));
  const derived = derivePlannedPolicy({ ctx, actor, manifest });
  const measured = await readApplicableBranchRulesets({ request, branch });
  const byName = new Map(measured.rulesets.map((ruleset) => [String(ruleset?.name ?? "unnamed"), ruleset]));
  for (const planned of derived) {
    const observed = byName.get(planned.name);
    if (!observed) throw new AssertionFailure(`the planned disposable ruleset ${planned.name} does not apply to this job's ref`);
    if (String(observed.enforcement) !== "active") throw new AssertionFailure(`applicable ruleset ${planned.name} is not active; it would enforce nothing`);
    const include = observed?.conditions?.ref_name?.include ?? [];
    if (include.length !== 1 || include[0] !== planned.target_ref) {
      throw new AssertionFailure(`applicable ruleset ${planned.name} no longer targets exactly this job's derived ref`);
    }
  }
  const foreign = [...byName.keys()].filter((name) => !derived.some((entry) => entry.name === name));
  return {
    branch,
    planned: derived.map((entry) => entry.name).sort(),
    applicable: [...byName.keys()].sort(),
    additional_effective_rules: foreign,
    rule_count: measured.ruleCount,
    // Named honestly: this token cannot see the bypass matrix, and the evidence says so rather than
    // implying that an absent field was measured as empty.
    bypass_visibility: "redacted-to-this-credential-by-documented-provider-contract",
    verdict: "applicability-only",
    complete_policy_source: "local-witness",
  };
}

/**
 * THE ACTOR'S POLICY VERDICT, from the local witness's complete governed measurement (F1).
 *
 * The witness snapshot carries the full governed set — including the bypass actors this job cannot
 * read — plus the measured classic representation. This function re-validates the projection against
 * the vocabulary the job derives for itself, applies the SAME closed inverse transformation the local
 * setup applies, and runs the UNCHANGED production verifier on the result.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. It proves that the complete governed policy John measured is
 * the reviewed disposable policy, bound to this case's nonce, source and time window. It does not
 * prove the policy was that at the instant of the mutation: that is what the pre/post pair bounds,
 * under administrative quiescence, and it is **not an atomic policy-at-mutation proof**.
 */
export function verifyWitnessedPolicy({ ctx, actor, manifest, snapshot }) {
  const derived = derivePlannedPolicy({ ctx, actor, manifest });
  const { governed, classicMeasured } = validateGovernedSnapshot(snapshot, publishableVocabulary({ ctx, actor }));
  const owned = governed.filter((ruleset) => derived.some((entry) => entry.name === ruleset.name));
  const foreign = governed.filter((ruleset) => !derived.some((entry) => entry.name === ruleset.name));
  if (owned.length !== derived.length) {
    return {
      verdict: "mismatch",
      reason: `the witness measured ${owned.length} of this run's ${derived.length} disposable rulesets as applicable to the ${actor} ref`,
      differences: [], foreign: foreign.map((ruleset) => String(ruleset.name)),
      classic_protection: classicMeasured, gap: "semantic",
    };
  }
  let inverted;
  try {
    inverted = owned.map((ruleset) => invertDisposable(ruleset, {
      runId: ctx.runId, attempt: ctx.attempt, actor, producerIds: ctx.producerIds, normalAppId: ctx.normalAppId,
    }));
  } catch (error) {
    if (error instanceof AssertionFailure) {
      return { verdict: "mismatch", reason: error.message, differences: [], foreign: foreign.map((r) => String(r.name)), classic_protection: classicMeasured, gap: "semantic" };
    }
    throw error;
  }
  const expected = { normalAppId: ctx.normalAppId, emergencyAppId: ctx.emergencyAppId, producerIds: ctx.producerIds };
  // The measured classic representation, not `null`: the witness proved a 404, and a proved absence
  // is a measurement. `null` here previously meant "we did not look", presented as "there is none".
  const verifierVerdict = verifyEffectiveMainPolicy({
    applicableRulesets: [...inverted, ...foreign], classicProtection: null, expected, applicabilityMeasured: true,
  });
  const wanted = buildMainRulesets(expected);
  const differences = [];
  let normalizationOnly = foreign.length === 0;
  for (const want of wanted) {
    const actual = inverted.find((ruleset) => ruleset.name === want.name);
    if (!actual) { differences.push({ ruleset: want.name, path: ".", kind: "missing" }); normalizationOnly = false; continue; }
    for (const key of GOVERNED_RULESET_FIELDS.filter((field) => field !== "name")) {
      const comparison = compareToDesired(actual[key], want[key]);
      if (comparison.byteEqual) continue;
      if (!comparison.normalizationOnly) normalizationOnly = false;
      for (const entry of comparison.differences.slice(0, 8)) differences.push({ ruleset: want.name, path: `${key}${entry.path}`, kind: entry.kind });
    }
  }
  return {
    verdict: verifierVerdict.ok ? "compatible" : "mismatch",
    reason: verifierVerdict.ok ? null : "the production verifier rejected the inverse-transformed witnessed policy",
    verifierErrors: (verifierVerdict.errors ?? []).slice(0, 12),
    differences: differences.slice(0, 25),
    gap: verifierVerdict.ok ? null : (normalizationOnly ? "provider-normalization" : "semantic"),
    foreign: foreign.map((ruleset) => String(ruleset.name)),
    classic_protection: classicMeasured,
    // The two digests that make the pre/post pair comparable at all.
    governed_fingerprint: canonicalHash(governed),
    classic_fingerprint: canonicalHash(classicMeasured),
    witness_span_ms: Number(snapshot.span_ms),
    // Stated in the evidence, every time, so no reader can upgrade it.
    guarantee: "bounded-contemporaneous-pre-post-measurement-under-administrative-quiescence; NOT an atomic policy-at-mutation proof",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 13b. The staged protected actor path (F1).
//
// A protected job can no longer run its whole matrix in one process, and that is not a refactor for
// tidiness: only an official Actions step can upload an artifact, so every challenge the local
// witness has to read means a step boundary. The five steps per case are fixed YAML — there is no
// case selector and no dynamic matrix — and the runner owns three of them:
//
//   1. prepare            measure preconditions, create the PRE nonce, write the challenge  ← here
//   2. (upload step)      publish the pre challenge
//   3. await-and-execute  consume the pre witness, verify, mint JIT, mutate ONCE, read back ← here
//   4. (upload step)      publish the post challenge
//   5. await-and-finalize consume the post witness, prove pre==post policy, record          ← here
//
// The public `normal-tests` / `emergency-tests` phases are now FINALIZERS: they assemble the evidence
// file from those states and succeed only when every assigned case succeeded.
// ──────────────────────────────────────────────────────────────────────────────

/** The two working subdirectories a cloud job derives under its evidence directory. */
export function cloudSubdirectory(evidenceDir, name) {
  if (!["challenges", "state"].includes(name)) throw new UsageError(`unknown commissioning cloud subdirectory ${JSON.stringify(String(name))}`);
  const dir = path.join(assertCloudOutputDirectory(evidenceDir), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new UsageError("a commissioning working directory must not be a symlink");
  return dir;
}

/** Write a challenge file for the fixed upload step to publish. Its name is derived on both sides. */
export function writeChallengeFile(dir, name, challenge) {
  if (!/^commissioning-challenge-[0-9]+-[0-9]+-[a-z]+-[0-9]{2}-(pre|post)$/.test(String(name))) {
    throw new UsageError("a challenge file name is derived, never supplied");
  }
  const target = path.join(dir, `${name}.json`);
  let existing;
  try { existing = lstatSync(target); } catch { existing = null; }
  if (existing) throw new AssertionFailure(`a ${name} challenge already exists; a challenge is published exactly once per case and direction`);
  const bytes = Buffer.from(`${JSON.stringify(challenge)}\n`, "utf8");
  const fd = openSync(target, "wx", 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  // The digest is of the JSON the witness will read back out of the artifact — the exact bytes,
  // trailing newline included — because that is what both sides bind.
  return { path: target, bytes, digest: bytesDigest(bytes) };
}

export function readChallengeFile(dir, name) {
  const target = path.join(dir, `${name}.json`);
  if (lstatSync(target).isSymbolicLink()) throw new UsageError("refusing to read a challenge through a symlink");
  const bytes = readFileSync(target);
  let challenge;
  try { challenge = JSON.parse(bytes.toString("utf8")); }
  catch { throw new AssertionFailure(`the retained ${name} challenge is not valid JSON`); }
  assertChallengeShape(challenge);
  return { challenge, bytes, digest: bytesDigest(bytes) };
}

/** Every binding a cloud consumer derives for itself, and requires the response to echo exactly. */
export function caseBinding({ ctx, role, caseId, direction, targetRef, installationId, manifest, graphShas, domain = COMMISSION_DOMAIN, sourceMode = "commission" }) {
  return {
    domain,
    repository: COMMISSIONING_REPOSITORY,
    repository_id: Number(ctx.repositoryId),
    source_mode: sourceMode,
    original_run_id: String(ctx.runId),
    original_attempt: String(ctx.attempt),
    workflow_path: COMMISSIONING_WORKFLOW_PATH,
    source_sha: String(ctx.workflowSha),
    role: String(role),
    job_id: assertRoleBinding(role === REHEARSAL_ROLE ? "rehearsal" : role).job,
    case_id: String(caseId),
    case_ordinal: caseOrdinal(role, caseId),
    direction: String(direction),
    target_ref: String(targetRef),
    intended_app_id: domain === REHEARSAL_DOMAIN ? null : Number(role === "normal" ? ctx.normalAppId : ctx.emergencyAppId),
    // FROM THE PLAN. `installationId` is the value the protected job was configured with, and
    // `mintActorCredential` refuses unless the two agree — so binding the plan makes the challenge
    // carry an identity the immutable intent chose rather than one the job supplied.
    intended_installation_id: domain === REHEARSAL_DOMAIN ? null : String(ctx.plannedInstallations?.[role] ?? installationId),
    manifest_sha256: domain === REHEARSAL_DOMAIN ? null : canonicalHash(manifest),
    graph_sha256: domain === REHEARSAL_DOMAIN ? null : graphBindingDigest(graphShas, ctx.runId, ctx.attempt),
  };
}

/**
 * Find the ONE response artifact answering this challenge, and pin its provenance.
 *
 * Discovery is by the exact derived name, which contains the nonce digest — so there is nothing to
 * select between. Two artifacts under that name, or a publisher run that is not exactly one
 * successful publisher job on the immutable source by the authorized identity, is a refusal.
 */
export async function findWitnessResponseArtifact({ request, ctx, binding, nonce }) {
  const name = responseArtifactName({
    runId: binding.original_run_id, attempt: binding.original_attempt, role: binding.role,
    ordinal: binding.case_ordinal, direction: binding.direction, nonce,
  });
  const listed = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/artifacts?per_page=${PAGE_SIZE}&page=1&name=${encodeURIComponent(name)}`);
  if (listed.status !== 200 || !listed.body) throw new IncompleteEvidence(`the witness response ${name} could not be looked up (${listed.status})`, { retryable: true });
  const artifacts = Array.isArray(listed.body.artifacts) ? listed.body.artifacts : null;
  if (!artifacts) throw new IncompleteEvidence("the artifact listing is not the documented shape");
  const total = Number(listed.body.total_count ?? artifacts.length);
  if (total > PUBLISHER_DISCOVERY_CEILING) {
    throw new AssertionFailure(`the witness artifact lookup for ${name} reports ${total} candidates, beyond the ${PUBLISHER_DISCOVERY_CEILING} discovery ceiling`);
  }
  const matching = artifacts.filter((artifact) => String(artifact?.name) === name);
  if (!matching.length) throw new IncompleteEvidence(`the witness response ${name} has not been published yet`, { retryable: true });
  if (matching.length > 1) throw new AssertionFailure(`${matching.length} artifacts are named ${name}; commissioning never selects between duplicate witness publications`);
  const artifact = matching[0];
  const owningRun = Number(artifact?.workflow_run?.id);
  if (!Number.isInteger(owningRun)) throw new AssertionFailure(`the witness response ${name} names no owning run`);
  const run = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${owningRun}/attempts/1`);
  if (run.status !== 200 || !run.body) throw new IncompleteEvidence(`the publisher run ${owningRun} could not be measured (${run.status})`, { retryable: true });
  const jobs = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${owningRun}/attempts/1/jobs?per_page=${PAGE_SIZE}&page=1`);
  if (jobs.status !== 200 || !Array.isArray(jobs.body?.jobs)) throw new IncompleteEvidence(`the publisher run ${owningRun}'s jobs could not be measured`, { retryable: true });
  const provenance = assertPublisherArtifactProvenance({
    artifact, run: { ...run.body, id: owningRun }, jobs: jobs.body.jobs,
    expected: { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: ctx.workflowSha },
  });
  /**
   * THE BOUNDED FACTS THE PROVENANCE VERDICT WAS DERIVED FROM (F2, corrected).
   *
   * Retaining only `provenance` retained the CONCLUSION. The offline assessor could then do nothing
   * but read it — which is why deleting the whole field produced no blocker. These are the exact
   * inputs `assertPublisherArtifactProvenance` consumes, and nothing else: no raw provider body, no
   * token, no measurement. The assessor re-runs the same function on them.
   */
  const identity = (value) => (value && typeof value === "object"
    ? { login: String(value.login ?? ""), id: Number.isInteger(Number(value.id)) ? Number(value.id) : null, type: String(value.type ?? "") }
    : null);
  const facts = {
    artifact: {
      id: Number(artifact.id), name: String(artifact.name ?? ""),
      expired: artifact.expired === true, workflow_run: { id: owningRun },
    },
    run: {
      id: owningRun, run_attempt: Number(run.body.run_attempt), event: String(run.body.event ?? ""),
      path: String(run.body.path ?? ""), head_sha: String(run.body.head_sha ?? ""),
      status: String(run.body.status ?? ""),
      conclusion: run.body.conclusion === null || run.body.conclusion === undefined ? null : String(run.body.conclusion),
      actor: identity(run.body.actor), triggering_actor: identity(run.body.triggering_actor),
    },
    jobs: jobs.body.jobs.map((job) => ({
      id: Number.isInteger(Number(job?.id)) ? Number(job.id) : null,
      conclusion: job?.conclusion === null || job?.conclusion === undefined ? null : String(job.conclusion),
    })),
  };
  return { name, artifact_id: provenance.artifact_id, provenance, provenance_facts: facts };
}

/** Download and open the pinned artifact, bounded at the transport and again in the reader. */
export async function readWitnessResponseArtifact({ requestArchive, artifactId }) {
  const download = await requestArchive("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/artifacts/${artifactId}/zip`);
  if (download.status !== 200 || !download.bytes) throw new IncompleteEvidence(`the witness artifact ${artifactId} could not be downloaded (${download.status})`, { retryable: true });
  const entry = readSingleEntryZip(download.bytes, { entryName: WITNESS_ENTRY_NAME, maxArchiveBytes: MAX_ARCHIVE_BYTES, maxEntryBytes: MAX_ENTRY_BYTES });
  let response;
  try { response = JSON.parse(entry.bytes.toString("utf8")); }
  catch { throw new AssertionFailure("the witness artifact's single entry is not valid JSON"); }
  /**
   * THE EXACT BYTES, retained alongside the parsed object.
   *
   * The entry digest is a hash of THESE bytes, and a parsed-and-re-serialized object is not
   * guaranteed to reproduce them. Without the bytes the offline assessor can only compare the
   * packet's copies of a digest with each other, which is what let a semantically-equivalent but
   * byte-different stream pass. They are the same bounded nonsecret published content the artifact
   * already exposes, so retaining them discloses nothing new.
   */
  return {
    response, entry_digest: entry.digest, archive_bytes: download.bytes.length,
    response_bytes: entry.bytes.toString("utf8"),
  };
}

/**
 * THE ONE PATH BY WHICH AN ARTIFACT BECOMES A PUBLICATION (F6).
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT THREE PLACES ───────────────────────────────────────────────
 *
 * Consumption did this properly — discover by exact derived name, pin the owning run's provenance,
 * download, open the single-entry archive, and bind the payload to this job's own nonce and exact
 * challenge bytes. The local witness's TWO reconciliation branches did not: both accepted a
 * LISTING ROW under the expected name and returned a publication from it, without reading the
 * bytes, the expiry, the owning run, the job set or the envelope digest. So the process that is
 * responsible for not publishing twice was deciding "already published" on strictly weaker
 * evidence than the consumer would accept — and doing it BEFORE the manifest/graph and active-job
 * checks, at that.
 *
 * Every caller now gets the consumer's rules.
 *
 * ── THE RECEIPT INSTANT IS READ AFTER THE RESPONSE IS IN HAND (R4) ──────────────────────────────
 *
 * Callers used to pass `receivedAt`, sampled BEFORE this function's provider lookup, run/job reads
 * and archive download. The expiry was then checked against an instant that preceded all of that
 * network time, so a lookup that began before expiry and finished after it was consumed as fresh.
 * The caller now passes its CLOCK, and it is read here, once the complete response has been
 * acquired and its closed shape validated — the instant it was actually received. A pre-sampled
 * instant is refused rather than silently used.
 */
export async function resolvePublishedResponse({
  request, requestArchive, ctx, binding, challenge, challengeDigest, receiptClock, receivedAt: presampled = undefined,
}) {
  if (presampled !== undefined) throw new UsageError("a response's receipt instant is read by the resolver after acquisition, never supplied in advance");
  if (typeof receiptClock !== "function") throw new UsageError("resolving a witness response needs the consumer's receipt clock");
  const found = await findWitnessResponseArtifact({ request, ctx, binding, nonce: challenge.nonce });
  const { response, entry_digest: entryDigest, archive_bytes: archiveBytes, response_bytes: responseBytes } = await readWitnessResponseArtifact({ requestArchive, artifactId: found.artifact_id });
  assertResponseShape(response);
  const receivedAt = String(receiptClock());
  assertResponseBinding(response, { challenge, challengeDigest, expectedBinding: binding, receivedAt });
  // The RECEIPT INSTANT is part of the binding (the expiry is checked against it), so it travels
  // with the result and is retained — the assessor re-runs the same comparison.
  return {
    response, artifact: found, entry_digest: entryDigest, archive_bytes: archiveBytes,
    response_bytes: responseBytes, received_at: String(receivedAt),
  };
}

/**
 * The bounded wait for one witness response: poll at the fixed interval until the challenge expires.
 *
 * Only the RETRYABLE shape is polled. A response that exists and does not bind — a wrong nonce, a
 * wrong source, a duplicate publication, a terminally failed publisher — is refused on its first
 * read and must never be waited on: re-reading it would be waiting for somebody to publish a better
 * one. A CORRECTLY BOUND publisher that has simply not finished yet IS retryable (F10), which is
 * the ordinary case, since an upload necessarily precedes the run that carried it finishing.
 */
export async function awaitWitnessResponse({
  request, requestArchive, ctx, binding, challenge, challengeDigest, store, caseId,
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = POLL_INTERVAL_MS,
}) {
  const expiry = Date.parse(String(challenge.expires_at));
  for (let polls = 1; ; polls += 1) {
    try {
      const resolved = await resolvePublishedResponse({
        request, requestArchive, ctx, binding, challenge, challengeDigest,
        // Read by the resolver once the response is in hand, never before the lookup (R4).
        receiptClock: () => new Date(now()).toISOString(),
      });
      // ONCE-ONLY, durably. A replayed response is refused by the store, not by memory.
      const consumed = store.consumeNonce(caseId, {
        direction: binding.direction, nonce: challenge.nonce,
        artifact_id: resolved.artifact.artifact_id, artifact_digest: resolved.entry_digest, response_digest: resolved.entry_digest,
      });
      return { ...resolved, polls, consumed };
    } catch (error) {
      if (error?.detail?.retryable !== true) throw error;
      if (now() + intervalMs > expiry) {
        throw new IncompleteEvidence(
          `the ${binding.direction} witness response for case ${caseId} did not arrive within its ${CHALLENGE_TTL_MS}ms challenge lifetime (${polls} polls); the expiry is never extended and the case is not retried`,
        );
      }
      await sleep(intervalMs);
    }
  }
}

/** The actor credential set a protected job may hold, and the counterpart it must never see. */
export function actorCredentialNames(role, env) {
  assertRoleBinding(role);
  if (!ACTOR_ROLES.includes(role)) throw new UsageError(`the ${role} role is not an actor role and may not exchange an App credential`);
  return role === "normal"
    ? { appId: env.RELEASE_APP_ID, installationId: env.RELEASE_APP_INSTALLATION_ID, privateKey: env.RELEASE_APP_PRIVATE_KEY, forbidden: "EMERGENCY_APP_PRIVATE_KEY" }
    : { appId: env.EMERGENCY_APP_ID, installationId: env.EMERGENCY_APP_INSTALLATION_ID, privateKey: env.EMERGENCY_APP_PRIVATE_KEY, forbidden: "RELEASE_APP_PRIVATE_KEY" };
}

/**
 * Mint the actor credential JUST IN TIME, prove its identity, and keep it in this process only.
 *
 * PC-05's positive-control rule, precisely: positive-write liveness is INSTALLATION-LEVEL within this
 * attempt, and this is NOT a per-token successful-write claim. What each freshly minted token proves
 * for itself is its exact intended App, installation, repository, grant set and a successful scoped
 * READ. The evidence says exactly that and no more — the previous build's phrasing let a retained
 * installation-level positive control read as though every later token had written successfully.
 */
export async function mintActorCredential({ role, ctx, env, redact, deps = {} }) {
  const names = actorCredentialNames(role, env);
  const expected = role === "normal" ? ctx.normalAppId : ctx.emergencyAppId;
  if (env[names.forbidden]) throw new AssertionFailure(`the ${role} job can see ${names.forbidden}; the two release identities must not share a job`);
  if (Number(names.appId) !== expected) throw new AssertionFailure(`the ${role} job's App ID is not the identity this commissioning run was configured for`);
  if (!names.privateKey || !names.installationId) throw new UsageError(`the ${role} job is missing its App installation credentials`);
  if (!POSITIVE_DECIMAL.test(String(names.installationId))) throw new UsageError(`the ${role} job's installation ID is not a positive decimal identifier`);
  // BEFORE THE CREDENTIAL EXCHANGE: the installation this protected job is configured with must be
  // the one the immutable intent planned for this role. The expectation comes from the plan, never
  // from the job's own configuration compared with itself.
  const plannedInstallation = String(ctx.plannedInstallations?.[role] ?? "");
  if (!POSITIVE_DECIMAL.test(plannedInstallation)) {
    throw new IncompleteEvidence(`this run plans no installation identity for the ${role} role; its credential cannot be admitted against an expectation that does not exist`);
  }
  if (String(names.installationId) !== plannedInstallation) {
    throw new AssertionFailure(
      `the ${role} job is configured with installation ${String(names.installationId)}, not the ${plannedInstallation} this run's immutable intent planned`,
    );
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const makeRequest = (transport, extra) => createGuardedRequest(transport, {
    role, runId: String(ctx.runId), attempt: String(ctx.attempt),
    graphShas: new Set(), contextNames: new Set(), rulesetIds: new Set(), rulesetNames: new Set(), ...extra,
  });

  // The App JWT authenticates two READS and nothing else. It never leaves this process and is handed
  // to the redactor the instant it exists.
  const jwt = await (deps.mintAppJwt ?? mintAppJwt)({ appId: names.appId, privateKey: names.privateKey, jose: deps.jose ?? null });
  redact.add(jwt);
  const asApp = makeRequest(deps.appJwtTransport ?? createTokenTransport({ token: jwt, fetchImpl, redact }), { installationId: String(names.installationId) });
  const grants = await measureAppGrants({ request: asApp, role, ctx, installationId: String(names.installationId) });

  // The exchange is a second, independent identity proof: GitHub validates the JWT signature against
  // the public key of the App named as its ISSUER, so a token exists only if this key is that App's.
  // Resolved HERE, inside admitted credential-bearing execution — see the module header's note on
  // why `release-controller.mjs` is not a static import. The helper itself is unchanged.
  const createInstallationToken = deps.createInstallationToken ?? await resolveInstallationTokenHelper();
  const token = await createInstallationToken({
    appId: names.appId, installationId: names.installationId, privateKey: names.privateKey, fetchImpl,
  });
  redact.add(token);
  return { names, grants, token, expected, makeRequest, fetchImpl };
}

/** The scoped READ every freshly minted token must complete before it is used for anything else. */
export async function proveTokenScopedRead({ request, ctx }) {
  const installation = await assertInstallationScope({ request, ctx });
  const repository = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}`);
  if (repository.status !== 200 || Number(repository.body?.id) !== Number(ctx.repositoryId)) {
    throw new IncompleteEvidence("this freshly minted actor token could not complete a scoped read of the commissioning repository");
  }
  return {
    installation,
    scoped_read: { operation: "read-repository", status: repository.status, repository_id: Number(repository.body.id) },
    // The exact claim, spelled out where it is recorded.
    claim: "this token proved its intended App/installation/repository/grants and one successful scoped READ; it is NOT a per-token positive-write claim",
  };
}

/** The shared per-stage preamble: identity, mode, job, manifest, verified graph and the case store. */
export async function openCloudCaseContext({ role, caseId, stage, env, deps = {} }) {
  assertCaseStage(stage, role);
  if (roleForCase(caseId) !== role) throw new UsageError(`case ${caseId} does not belong to the ${role} role`);
  const runId = String(env.GITHUB_RUN_ID ?? "");
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? "");
  // Role/mode/job admission BEFORE any credential is touched (F7).
  const ctx = assertRunContext(env, { runId, attempt, role: role === REHEARSAL_ROLE ? "rehearsal" : role });
  const evidenceDir = assertCloudOutputDirectory(env.COMMISSIONING_EVIDENCE_DIR);
  const store = openCaseStateStore({ dir: cloudSubdirectory(evidenceDir, "state"), runId, attempt, role, now: deps.now });
  const redact = createRedactor(collectSentinels(env));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const metadataToken = String(env.GITHUB_TOKEN ?? "");
  if (!metadataToken) throw new UsageError(`the ${role} job needs its read-only GITHUB_TOKEN to read run and commit metadata`);
  const metadataTransport = deps.metadataTransport ?? createTokenTransport({ token: metadataToken, fetchImpl, redact });
  /**
   * The read-only metadata request, bound to a guard context.
   *
   * It is a FACTORY rather than one instance because the graph is not known until it has been
   * verified: a check-run read is only permitted on a SHA the caller has already proved is one of
   * this run's synthetic commits, so the bootstrap request (which fetches the manifest and verifies
   * the graph) necessarily carries an empty graph set, and the working request carries the verified
   * one. Reusing the bootstrap request afterwards is how a check-run read gets refused for being
   * about a commit the caller had, in fact, just verified.
   */
  const makeMetadata = (extra = {}) => createGuardedRequest(metadataTransport, {
    role, runId, attempt, graphShas: new Set(), contextNames: new Set(), rulesetIds: new Set(), rulesetNames: new Set(), ...extra,
  });
  const requestArchive = createGuardedRequest(deps.archiveTransport ?? createArchiveTransport({ token: metadataToken, fetchImpl }), {
    role, runId, attempt, graphShas: new Set(), contextNames: new Set(), rulesetIds: new Set(), rulesetNames: new Set(),
  });
  return {
    ctx, runId, attempt, role, store, redact, fetchImpl, makeMetadata, metadata: makeMetadata(), requestArchive,
    evidenceDir, challengeDir: cloudSubdirectory(evidenceDir, "challenges"),
  };
}

/**
 * ONE case stage. The workflow calls this from a fixed step per case per stage; there is no case
 * selector, no stage argument a caller can widen and no way to reach `await-and-execute` without the
 * `prepare` that measured its preconditions.
 */
export async function runCaseStage({ stage, caseId, env = process.env, deps = {} }) {
  const role = roleForCase(caseId);
  const session = await openCloudCaseContext({ role, caseId, stage, env, deps });
  const { ctx, runId, attempt, store, redact, makeMetadata, requestArchive, challengeDir } = session;
  const kase = buildActorMatrix().find((entry) => entry.id === caseId);
  if (!kase) throw new UsageError(`case ${caseId} is not in the actor matrix`);
  const now = deps.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const ref = derivedRef(runId, attempt, kase.ref);

  // The plan, re-read and re-verified in EVERY stage. A stage that trusted the previous stage's copy
  // would be trusting a file rather than the provider.
  const bootstrap = session.metadata;
  const { manifest, manifestCommitSha } = await readManifestFromRef({ request: bootstrap, runId, attempt, context: ctx });
  const verified = await verifySyntheticGraph({ request: bootstrap, manifest, runId, attempt });
  const graphShas = verified;
  // Now that the graph is VERIFIED, the working request may read check runs on it.
  const metadata = makeMetadata({
    graphShas: new Set(Object.values(verified)),
    contextNames: new Set(derivedContextNames(runId, attempt)),
  });

  if (stage === "prepare") {
    store.requireStage(caseId, "prepare");
    store.assertPriorCasesFinalized(caseId);
    if (role === "normal") {
      // The normal App's installation-level positive control must already exist in THIS attempt.
      const liveness = store.readRoleState("liveness");
      if (!liveness || liveness.installation_positive_write !== true) {
        throw new IncompleteEvidence("the normal App's installation-level positive-write liveness has not been established in this attempt; its TEST-ONLY fixture publication runs before the first case");
      }
    }
    const applicability = await assertPlannedPolicyApplies({ request: metadata, ctx, actor: role, manifest });
    const beforeSha = await readDerivedRefSha({ request: metadata, ref });
    assertCasePrecondition(kase, { beforeSha, graphShas });
    const requestedSha = kase.to ? graphShas[kase.to] : null;
    const checkState = kase.to && kase.checks !== "irrelevant"
      ? await assertCheckState({ request: metadata, headSha: graphShas[kase.to], expectation: kase.checks, ctx })
      : { expectation: kase.checks, measured: false };
    const installationId = String(actorCredentialNames(role, env).installationId ?? "");
    const nonce = (deps.freshNonce ?? freshNonce)();
    const binding = caseBinding({ ctx, role, caseId, direction: "pre", targetRef: ref, installationId, manifest, graphShas });
    const challenge = buildChallenge({ binding, nonce, createdAt: now().toISOString(), extra: { before_sha: beforeSha, requested_sha: requestedSha } });
    const name = challengeArtifactName({ runId, attempt, role, ordinal: binding.case_ordinal, direction: "pre" });
    const written = writeChallengeFile(challengeDir, name, challenge);
    store.write(caseId, {
      stage: "prepare", status: "ok",
      pre_nonce: nonce, pre_challenge_name: name, pre_challenge_digest: written.digest,
      before_sha: beforeSha, requested_sha: requestedSha, check_state: checkState,
      applicability, manifest_commit_sha: manifestCommitSha,
      manifest_sha256: binding.manifest_sha256, graph_sha256: binding.graph_sha256,
      installation_id: installationId, prepared_at: now().toISOString(),
    });
    return {
      schema_version: RESULT_SCHEMA_VERSION, run_id: runId, attempt, phase: `${role}-case-${stage}`,
      case_id: caseId, ordinal: binding.case_ordinal, status: "prepared",
      challenge_artifact: name, challenge_path: written.path, challenge_digest: written.digest,
    };
  }

  if (stage === "await-and-execute") {
    const prior = store.requireStage(caseId, "await-and-execute");
    const { challenge, digest } = (() => {
      const read = readChallengeFile(challengeDir, String(prior.pre_challenge_name));
      if (read.digest !== String(prior.pre_challenge_digest)) throw new AssertionFailure("the retained pre challenge is not the bytes this case published");
      return { challenge: read.challenge, digest: read.digest };
    })();
    const installationId = String(prior.installation_id);
    // SOURCE CONTINUITY AT RESPONSE CONSUMPTION (F3). A witness response measured against the
    // reviewed source is not usable evidence once staging has moved: the tree the case is about to
    // mutate under would no longer be the one this attempt was reviewed for. A same-old-SHA
    // artifact consumed after a source move is exactly the case this closes.
    const continuity = await assertSourceContinuity({
      request: metadata, label: `case ${caseId}`,
      expected: { repositoryId: ctx.repositoryId, workflowSha: ctx.workflowSha },
    });
    const binding = caseBinding({ ctx, role, caseId, direction: "pre", targetRef: ref, installationId, manifest, graphShas });
    const received = await awaitWitnessResponse({
      request: metadata, requestArchive, ctx, binding, challenge, challengeDigest: digest,
      store, caseId, now: nowMs, sleep: deps.sleep, intervalMs: deps.intervalMs ?? POLL_INTERVAL_MS,
    });
    // THE VERDICT: the production verifier, on the witness's complete governed policy.
    const policy = verifyWitnessedPolicy({ ctx, actor: role, manifest, snapshot: received.response.observation });
    if (policy.verdict === "measurement-incomplete") throw new IncompleteEvidence("the witnessed policy measurement for this case is incomplete");
    if (policy.verdict !== "compatible") {
      throw new AssertionFailure(`the witnessed policy in force on this job's ref is not the reviewed disposable policy (${policy.gap ?? "mismatch"}: ${policy.reason ?? "differs"})`);
    }

    /**
     * ── THE CREDENTIAL COMES FIRST, THE FRESHNESS CHECK COMES LAST (F4) ──────────────────────────
     *
     * This used to capture `mutationStartedAt` and check the 90-second observation-to-mutation
     * bound BEFORE the App JWT identity reads, the token exchange and two scoped token reads. Those
     * are three network round trips with finite but nonzero deadlines, and the request that
     * followed used the EARLIER timestamp and never rechecked anything. A synthetic clock advancing
     * 100 seconds solely inside the mocked token exchange still returned `executed` and issued the
     * emergency PATCH, with the recorded mutation time a hundred seconds before the actual request:
     * the bound was exceeded, with no real wait, and the evidence said it was not.
     *
     * So all the fallible preparation happens first, the live preconditions are then re-measured,
     * and the freshness and expiry checks are made against a timestamp captured immediately before
     * the durable used marker and the send — which is the time the evidence records.
     */
    const credential = await mintActorCredential({ role, ctx, env, redact, deps });
    const request = credential.makeRequest(deps.appTransport ?? createTokenTransport({ token: credential.token, fetchImpl: credential.fetchImpl, redact }), {
      graphShas: new Set(Object.values(graphShas)),
      contextNames: new Set(derivedContextNames(runId, attempt)),
      installationId,
      pullNumber: kase.operation === "merge" ? positiveProviderId(prior.pull_number) : null,
    });
    const tokenProof = await proveTokenScopedRead({ request, ctx });

    // THE REQUIRED LIVE PRECONDITIONS, re-measured AFTER all of that: the ref, and the declared
    // check state. Both are read with the metadata credential, and neither mutates anything.
    const beforeSha = await readDerivedRefSha({ request: metadata, ref });
    if (String(beforeSha) !== String(prior.before_sha)) {
      throw new IncompleteEvidence(`case ${caseId}'s ref moved between prepare and execute; this run is interrupted rather than failed`);
    }
    assertCasePrecondition(kase, { beforeSha, graphShas });
    const recheckedChecks = kase.to && kase.checks !== "irrelevant"
      ? await assertCheckState({ request: metadata, headSha: graphShas[kase.to], expectation: kase.checks, ctx })
      : { expectation: kase.checks, measured: false };

    // THE ACTUAL REQUEST-START TIME, and both bounds enforced against it.
    const mutationStartedAt = now().toISOString();
    const proximityMs = assertObservationProximity({
      observedAt: received.response.observation.completed_at, actedAt: mutationStartedAt,
      label: `case ${caseId}'s mutation`,
    });
    // The challenge whose measurement authorises this mutation must still be alive AT THE MOMENT OF
    // THE MUTATION, not merely at the moment its response was consumed. The expiry is never
    // extended, and an expired one issues zero mutations.
    if (Date.parse(mutationStartedAt) > Date.parse(String(challenge.expires_at))) {
      throw new IncompleteEvidence(
        `case ${caseId}'s pre-witness challenge expired before the mutation could start; the ${CHALLENGE_TTL_MS}ms lifetime is never extended and no mutation is issued`,
      );
    }

    // FSYNC THE MARKER, THEN ISSUE EXACTLY ONE REQUEST. A crash after this point is an ambiguous
    // mutation, and the store refuses to mark a second one.
    const requestedSha = prior.requested_sha ?? null;
    store.markMutationUsed(caseId, { case_id: caseId, operation: kase.operation, ref, force: kase.force, before_sha: beforeSha, requested_sha: requestedSha });
    let response;
    if (kase.operation === "delete") {
      response = await request("DELETE", `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/${branchOf(ref)}`);
    } else {
      response = await request("PATCH", `/repos/${COMMISSIONING_REPOSITORY}/git/refs/heads/${branchOf(ref)}`, { sha: requestedSha, force: kase.force });
    }
    const afterSha = await readDerivedRefSha({ request: metadata, ref });
    const readbackAt = now().toISOString();

    const postNonce = (deps.freshNonce ?? freshNonce)();
    const postBinding = caseBinding({ ctx, role, caseId, direction: "post", targetRef: ref, installationId, manifest, graphShas });
    const postChallenge = buildChallenge({
      binding: postBinding, nonce: postNonce, createdAt: readbackAt,
      extra: {
        before_sha: beforeSha, requested_sha: requestedSha,
        request_class: mutationRequestClass(response.status, response.complete),
        request_status: Number(response.status),
        request_complete: response.complete === true,
        readback_sha: afterSha, readback_at: readbackAt,
        pre_artifact_id: received.artifact.artifact_id, pre_artifact_digest: received.entry_digest,
      },
    });
    const postName = challengeArtifactName({ runId, attempt, role, ordinal: postBinding.case_ordinal, direction: "post" });
    const postWritten = writeChallengeFile(challengeDir, postName, postChallenge);
    store.write(caseId, {
      ...store.read(caseId), stage: "await-and-execute", status: "ok",
      post_nonce: postNonce, post_challenge_name: postName, post_challenge_digest: postWritten.digest,
      pre_policy: policy, pre_artifact: received.artifact, pre_entry_digest: received.entry_digest,
      pre_observation_proximity_ms: proximityMs,
      /**
       * THE RETAINED PRE OBSERVATION (F2), not just its fingerprint.
       *
       * The finalizer used to discard the complete pre/post observations, so the authoritative
       * assessor had nothing to independently repeat the runtime verifier ON — it could only read
       * the verdict the runtime wrote about itself. The bounded nonsecret governed projection is
       * exactly what the local witness already published to an artifact anybody with Actions
       * access can read, so retaining it in this run's own evidence discloses nothing new and is
       * what makes the final assessment a re-derivation instead of a re-reading.
       */
      pre_observation: received.response.observation,
      /**
       * THE FULL CHALLENGE AND RESPONSE (F2, corrected).
       *
       * The assessor is required to re-run `assertResponseBinding` on retained bytes, and it cannot
       * do that from digests: the function needs the challenge, its digest, and the response object.
       * All three are the bounded nonsecret values already published to a readable artifact, so
       * retaining them locally discloses nothing new — it is what turns the final assessment from a
       * re-reading into a re-derivation.
       */
      pre_challenge: challenge,
      pre_challenge_digest_retained: digest,
      pre_response: received.response,
      pre_response_bytes: received.response_bytes ?? null,
      pre_received_at: received.received_at ?? null,
      pre_provenance_facts: received.artifact?.provenance_facts ?? null,
      pre_response_created_at: String(received.response.created_at),
      pre_challenge_created_at: String(challenge.created_at),
      pre_challenge_expires_at: String(challenge.expires_at),
      pre_publisher_run_id: positiveProviderId(received.artifact?.provenance?.publisher_run_id),
      source_continuity: continuity,
      rechecked_check_state: recheckedChecks,
      http_status: Number(response.status), ...responseEvidence(response), diagnostic: response.diagnostic, operation_id: response.operation,
      after_sha: afterSha, readback_at: readbackAt, mutation_started_at: mutationStartedAt,
      token_proof: tokenProof, grants: credential.grants,
    });
    return {
      schema_version: RESULT_SCHEMA_VERSION, run_id: runId, attempt, phase: `${role}-case-${stage}`,
      case_id: caseId, status: "executed", http_status: Number(response.status),
      challenge_artifact: postName, challenge_path: postWritten.path, challenge_digest: postWritten.digest,
    };
  }

  // ── await-and-finalize ──────────────────────────────────────────────────────────────────────────
  const prior = store.requireStage(caseId, "await-and-finalize");
  const postRead = readChallengeFile(challengeDir, String(prior.post_challenge_name));
  if (postRead.digest !== String(prior.post_challenge_digest)) throw new AssertionFailure("the retained post challenge is not the bytes this case published");
  // SOURCE CONTINUITY AT THE SECOND CONSUMPTION BOUNDARY (F3), for the same reason as the first.
  const finalizeContinuity = await assertSourceContinuity({
    request: metadata, label: `case ${caseId}'s post-mutation consumption`,
    expected: { repositoryId: ctx.repositoryId, workflowSha: ctx.workflowSha },
  });
  const installationId = String(prior.installation_id);
  const postBinding = caseBinding({ ctx, role, caseId, direction: "post", targetRef: ref, installationId, manifest, graphShas });
  const received = await awaitWitnessResponse({
    request: metadata, requestArchive, ctx, binding: postBinding, challenge: postRead.challenge,
    challengeDigest: postRead.digest, store, caseId, now: nowMs, sleep: deps.sleep,
    intervalMs: deps.intervalMs ?? POLL_INTERVAL_MS,
  });
  const postPolicy = verifyWitnessedPolicy({ ctx, actor: role, manifest, snapshot: received.response.observation });
  if (postPolicy.verdict !== "compatible") {
    throw new AssertionFailure(`the post-mutation witnessed policy is not the reviewed disposable policy (${postPolicy.gap ?? "mismatch"}: ${postPolicy.reason ?? "differs"})`);
  }
  // PRE == POST, on the COMPLETE governed policy and the classic representation. This pair is the
  // whole contemporaneity claim, and it is bounded rather than atomic: a transient change and
  // restoration inside the window is outside it, and the evidence says so.
  if (postPolicy.governed_fingerprint !== prior.pre_policy?.governed_fingerprint) {
    throw new AssertionFailure(`the complete governed policy changed across case ${caseId}'s mutation window; the measurement is not contemporaneous`);
  }
  if (postPolicy.classic_fingerprint !== prior.pre_policy?.classic_fingerprint) {
    throw new AssertionFailure(`the measured classic protection changed across case ${caseId}'s mutation window`);
  }
  // The post observation must START after the actor's readback and within 90s of it.
  const postProximity = assertObservationProximity({
    observedAt: prior.readback_at, actedAt: received.response.observation.started_at,
    label: `case ${caseId}'s post-mutation observation`,
  });

  const verdict = classifyCaseOutcome({
    expected: kase.expected,
    // The retained completion facts travel WITH the status. Rebuilding the response from the status
    // alone is the status-only fallback that let an unfinished 200 finalize as accepted (R02-1).
    response: {
      status: Number(prior.http_status), diagnostic: prior.diagnostic, complete: prior.response_complete === true,
      incomplete: prior.response_incomplete ?? null, measured_status: prior.measured_status ?? null,
    },
    beforeSha: prior.before_sha, afterSha: prior.after_sha, requestedSha: prior.requested_sha,
    operation: kase.operation, requiresRuleId: kase.requiresRuleId ?? null,
  });
  const record = {
    case: kase.id, actor: kase.actor, operation: kase.operation, ref, force: kase.force,
    expected: kase.expected, before_sha: prior.before_sha, requested_sha: prior.requested_sha, after_sha: prior.after_sha,
    http_status: Number(prior.http_status),
    ...responseEvidence({ complete: prior.response_complete, incomplete: prior.response_incomplete, measured_status: prior.measured_status }),
    diagnostic: prior.diagnostic, outcome: verdict.outcome,
    check_state: prior.rechecked_check_state ?? prior.check_state,
    passed: verdict.outcome === kase.expected, reason: verdict.reason,
    /**
     * ── THE COMPLETE RETAINED PER-CASE EVIDENCE (F2) ─────────────────────────────────────────────
     *
     * Every value the final assessor needs to RECONSTRUCT this case rather than read its verdict:
     * both bounded governed projections, both artifact identities and entry digests, both nonce
     * digests, the publisher runs that carried them, the exact request class/status/readback, the
     * actual measured times, this case's OWN token/installation proof and grants, and the
     * manifest/graph bindings the challenges carried.
     *
     * Nothing here is new disclosure: the projections are the same bounded nonsecret governed
     * representation the witness already published to a readable artifact, and no token, private
     * key or raw provider body is present. What changes is that the assessor can now recompute the
     * verdict, which it previously could not — the first case's record supplied the role-level
     * grants and policy and every later case's proof sat outside substantive assessment.
     */
    witness: {
      pre_artifact: prior.pre_artifact, post_artifact: received.artifact,
      pre_entry_digest: prior.pre_entry_digest, post_entry_digest: received.entry_digest,
      pre_nonce_digest: nonceDigest(String(prior.pre_nonce)), post_nonce_digest: nonceDigest(String(prior.post_nonce)),
      pre_publisher_run_id: positiveProviderId(prior.pre_publisher_run_id),
      post_publisher_run_id: positiveProviderId(received.artifact?.provenance?.publisher_run_id),
      governed_fingerprint: postPolicy.governed_fingerprint, classic_fingerprint: postPolicy.classic_fingerprint,
      pre_to_mutation_ms: prior.pre_observation_proximity_ms, readback_to_post_ms: postProximity,
      guarantee: postPolicy.guarantee,
      // The bounded projections themselves, one per direction.
      pre_observation: prior.pre_observation ?? null,
      post_observation: received.response.observation,
      pre_challenge_created_at: prior.pre_challenge_created_at ?? null,
      pre_challenge_expires_at: prior.pre_challenge_expires_at ?? null,
      post_challenge_created_at: String(postRead.challenge.created_at),
      post_challenge_expires_at: String(postRead.challenge.expires_at),
      // The retained bytes and facts for BOTH directions, so the assessor re-runs the same two
      // authoritative validators rather than reading the verdicts they produced.
      pre_challenge: prior.pre_challenge ?? null,
      pre_challenge_digest: prior.pre_challenge_digest_retained ?? null,
      pre_response: prior.pre_response ?? null,
      pre_response_bytes: prior.pre_response_bytes ?? null,
      pre_received_at: prior.pre_received_at ?? null,
      pre_provenance_facts: prior.pre_provenance_facts ?? null,
      post_challenge: postRead.challenge,
      post_challenge_digest: postRead.digest,
      post_response: received.response,
      post_response_bytes: received.response_bytes ?? null,
      post_received_at: received.received_at ?? null,
      post_provenance_facts: received.artifact?.provenance_facts ?? null,
    },
    // The exact request the case issued and what came back, so the outcome is re-derivable.
    request_class: mutationRequestClass(prior.http_status, prior.response_complete),
    mutation_started_at: prior.mutation_started_at ?? null,
    readback_at: prior.readback_at ?? null,
    // The bindings this case's challenges carried, so a case cannot be joined to another run's plan.
    manifest_sha256: prior.manifest_sha256 ?? null,
    graph_sha256: prior.graph_sha256 ?? null,
    manifest_commit_sha: prior.manifest_commit_sha ?? null,
    installation_id: String(prior.installation_id ?? ""),
    source_continuity: { pre: prior.source_continuity ?? null, post: finalizeContinuity },
    // PER CASE, never collapsed into the first record.
    policy_pre: prior.pre_policy ?? null,
    policy_in_force: postPolicy,
    token_proof: prior.token_proof,
    grants: prior.grants ?? null,
  };
  store.write(caseId, { ...store.read(caseId), stage: "await-and-finalize", status: "finalized", record, halt: verdict.halt === true });
  // The halt is durable above; the error class reports what was MEASURED (R02-2). An inconclusive
  // case — ambiguous and halting, or merely unattributable — is incomplete evidence (exit 3); an
  // unexpected success, mutation or denial is a measured failure (exit 1).
  const Outcome = verdict.outcome === "inconclusive" ? IncompleteEvidence : AssertionFailure;
  if (verdict.halt) {
    throw new Outcome(
      `case ${caseId} recorded ${verdict.outcome}: ${verdict.reason}. No further actor mutation runs in this attempt.`,
    );
  }
  if (!record.passed) throw new Outcome(`case ${caseId} recorded ${verdict.outcome}, not the expected ${kase.expected}`);
  return { schema_version: RESULT_SCHEMA_VERSION, run_id: runId, attempt, phase: `${role}-case-${stage}`, case_id: caseId, status: "finalized", outcome: verdict.outcome };
}

/**
 * The normal App's installation-level positive control: its TEST-ONLY check publication (PC-05).
 *
 * It runs ONCE, before the first case, from its own fixed step. Its scope is stated where it is
 * recorded: installation-level within this attempt. It is not evidence that any later token wrote
 * anything, and every denied case still requires its own policy diagnostics and unchanged ref.
 */
export async function runNormalCheckPublication({ env = process.env, deps = {} } = {}) {
  const role = "normal";
  const runId = String(env.GITHUB_RUN_ID ?? "");
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? "");
  const ctx = assertRunContext(env, { runId, attempt, role });
  const evidenceDir = assertCloudOutputDirectory(env.COMMISSIONING_EVIDENCE_DIR);
  const store = openCaseStateStore({ dir: cloudSubdirectory(evidenceDir, "state"), runId, attempt, role, now: deps.now });
  if (store.readRoleState("liveness")) throw new AssertionFailure("this attempt already established the normal App's installation-level liveness; it is published exactly once");
  const redact = createRedactor(collectSentinels(env));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const metadataToken = String(env.GITHUB_TOKEN ?? "");
  if (!metadataToken) throw new UsageError("the normal job needs its read-only GITHUB_TOKEN to read the plan");
  const metadata = createGuardedRequest(deps.metadataTransport ?? createTokenTransport({ token: metadataToken, fetchImpl, redact }), {
    role, runId, attempt, graphShas: new Set(), contextNames: new Set(), rulesetIds: new Set(), rulesetNames: new Set(),
  });
  const { manifest } = await readManifestFromRef({ request: metadata, runId, attempt, context: ctx });
  const verified = await verifySyntheticGraph({ request: metadata, manifest, runId, attempt });
  const credential = await mintActorCredential({ role, ctx, env, redact, deps });
  const request = credential.makeRequest(deps.appTransport ?? createTokenTransport({ token: credential.token, fetchImpl: credential.fetchImpl, redact }), {
    graphShas: new Set(Object.values(verified)),
    contextNames: new Set(derivedContextNames(runId, attempt)),
    installationId: String(credential.names.installationId),
  });
  const tokenProof = await proveTokenScopedRead({ request, ctx });
  const result = await publishChecks({ request, entries: checkPublicationPlan(runId, attempt).normal, graphShas: verified, producer: "normal-app" });
  if (!result.observedAppIds.includes(ctx.normalAppId)) {
    throw new AssertionFailure("the checks this job published were not attributed to the expected normal App");
  }
  const publication = {
    count: result.published.length,
    measured_producer_app_ids: result.observedAppIds,
    nodes: [...new Set(result.published.map((entry) => entry.node))],
    published: result.published.map(({ node, head_sha, context_ordinal, conclusion }) => ({ node, head_sha, context_ordinal, conclusion })),
  };
  store.writeRoleState("liveness", {
    installation_positive_write: true,
    scope: "installation-level within this exact attempt; NOT a per-token positive-write claim",
    publication, grants: credential.grants, token_proof: tokenProof,
  });
  return {
    schema_version: RESULT_SCHEMA_VERSION, run_id: runId, attempt, phase: "normal-check-publication",
    status: "published", ...publication, grants: credential.grants, token_proof: tokenProof,
  };
}

/**
 * PC-05's protected-job FINALIZER. It runs no case: it assembles the evidence from the durable
 * per-case states and succeeds only when every assigned case succeeded.
 */
export async function runCloudTestsPhase({ role, runId, attempt, evidenceDir, env, deps = {} }) {
  const binding = assertRoleBinding(role);
  if (!binding.actor) throw new UsageError(`the ${role} role has no actor finalizer phase`);
  const ctx = assertRunContext(env, { runId, attempt, role });
  const dir = assertCloudOutputDirectory(evidenceDir);
  const store = openCaseStateStore({ dir: cloudSubdirectory(dir, "state"), runId, attempt, role, now: deps.now });
  const foreign = store.foreignStateFiles();
  if (foreign.length) throw new AssertionFailure(`${foreign.length} case state file(s) in this job do not belong to its closed case sequence`);
  const liveness = role === "normal" ? store.readRoleState("liveness") : null;
  const states = store.readAll();
  const caseRecords = [];
  let halted = null;
  for (const { case_id: caseId, state } of states) {
    if (!state) {
      caseRecords.push({ case: caseId, actor: role, outcome: "not-run", passed: false, reason: "this case has no recorded state in this attempt" });
      continue;
    }
    if (state.status !== "finalized" || !state.record) {
      caseRecords.push({ case: caseId, actor: role, outcome: state.mutation_used === true ? "inconclusive" : "not-run", passed: false, reason: `the case stopped at stage ${String(state.stage ?? "none")} (${String(state.status ?? "unrecorded")})` });
      if (state.mutation_used === true) halted = halted ?? caseId;
      continue;
    }
    caseRecords.push(state.record);
    if (state.halt === true) halted = halted ?? caseId;
  }
  const first = states.find((entry) => entry.state?.record)?.state ?? null;
  const evidence = {
    schema_version: RESULT_SCHEMA_VERSION, phase: binding.finalizer_phase, run_id: String(runId), attempt: String(attempt),
    workflow_sha: ctx.workflowSha, manifest_commit_sha: first?.manifest_commit_sha ?? null,
    manifest_sha256: first?.manifest_sha256 ?? null, graph_sha256: first?.graph_sha256 ?? null,
    actor: {
      kind: `${role}-app`, app_id: Number(role === "normal" ? ctx.normalAppId : ctx.emergencyAppId),
      installation: first?.token_proof?.installation ?? null,
      app_identity_proof: "app-jwt-signature-and-installation-token-exchange-both-bound-the-issuer-App-ID",
      grants: first?.grants ?? null,
      // The liveness claim, at its true scope.
      positive_control: role === "normal"
        ? { kind: "installation-level-test-only-check-publication", established: liveness?.installation_positive_write === true, scope: liveness?.scope ?? null }
        : { kind: "installation-level-accepted-no-check-fast-forward", established: caseRecords.some((r) => r.case === "emergency-update-no-checks" && r.passed === true), scope: "installation-level within this exact attempt; NOT a per-token positive-write claim" },
    },
    // MEASURED, not asserted: the dispatcher is derived from provider run metadata in `collect`, and
    // this field records only what this job's environment reported, labelled as such.
    dispatcher_env_actor: ctx.actor, dispatcher_is_the_approver: null,
    policy_in_force: first?.record?.policy_in_force ?? null,
    check_publication: role === "normal" ? (liveness?.publication ?? null) : null,
    witness_publications: caseRecords.filter((record) => record.witness).length * CHALLENGE_DIRECTIONS.length,
    cases: caseRecords, halted_after: halted,
  };
  const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, role), evidence);
  return finishTestPhase({ runId, attempt, phase: binding.finalizer_phase, caseRecords, halted, evidencePath });
}

// ──────────────────────────────────────────────────────────────────────────────
// 13c. The witness publisher job, the inert transport rehearsal, and the local witness process.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The `policy-witness` job. The ONLY job admitted in `policy-witness` mode, and the only one that
 * republishes a witness response.
 *
 * It holds no App secret, no protected environment and no write scope. It re-serializes nothing: the
 * bytes it writes are the bytes it received, because the digest of those bytes is the binding the
 * actor and the local witness cross-check.
 */
/**
 * READ THE ORIGINAL RUN'S AUTHENTICATED INTENT, with the authority the publisher already holds.
 *
 * ── WHY THE PUBLISHER NEEDS THIS AT ALL ─────────────────────────────────────────────────────────
 *
 * The publisher is the hop that turns a private local measurement into an artifact anyone with
 * Actions access can read, so it is the last place an unpublishable value can be stopped. To apply
 * the closed governed projection it needs the run's VOCABULARY — the generated names, the derived
 * ref, the TEST-ONLY contexts and, above all, the two planned release App identities. Inferring
 * "any positive integer looks like an App ID" would make the identity half of that projection
 * vacuous at the one boundary that publishes.
 *
 * The intent job publishes exactly those facts, credential-free, as a single-file artifact of the
 * ORIGINAL run. The publisher job already holds `actions: read` and a `GITHUB_TOKEN`; the only thing
 * missing was three roles in this module's own operation table. No new provider grant, no new
 * dependency, no mutation: the existing bounded archive transport and the existing single-entry ZIP
 * reader do the work, at a FIXED entry name.
 *
 * ── THE TRUST BOUNDARY, STATED HONESTLY ─────────────────────────────────────────────────────────
 *
 * REST artifact metadata does NOT attest which job produced an artifact. What is established here is
 * the original run/attempt/source, the fixed intent job's own success in that attempt, exactly one
 * artifact under the derived name, its numeric ID and its bytes. The link from "that job" to "these
 * bytes" rests on the reviewed workflow's exclusive upload wiring, exactly as it does for the
 * witness response itself. Nothing below upgrades that into a job-level attestation.
 */
export async function readOriginalIntentArtifact({ request, requestArchive, runId, attempt, expected }) {
  const name = intentArtifactName(runId, attempt);
  const listed = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/artifacts?per_page=${PAGE_SIZE}&page=1&name=${encodeURIComponent(name)}`);
  if (listed.status !== 200 || !listed.body) throw new IncompleteEvidence(`the original run's intent artifact ${name} could not be looked up (${listed.status})`);
  const rows = Array.isArray(listed.body.artifacts) ? listed.body.artifacts : null;
  if (!rows) throw new IncompleteEvidence("the artifact listing is not the documented shape");
  const total = Number(listed.body.total_count ?? rows.length);
  if (total > rows.length) throw new IncompleteEvidence(`the intent artifact lookup for ${name} is paginated beyond this bounded read`);
  const matching = rows.filter((artifact) => String(artifact?.name) === name);
  if (!matching.length) throw new IncompleteEvidence(`the original run published no intent artifact named ${name}; this publisher refuses rather than publishing an unvalidated projection`);
  // NEVER "take the newest". Two artifacts under the derived name is an ambiguity, not a choice.
  if (matching.length > 1) throw new AssertionFailure(`${matching.length} artifacts are named ${name}; commissioning never selects between duplicate intent publications`);
  const artifact = matching[0];
  if (artifact.expired === true) throw new IncompleteEvidence(`the original run's intent artifact ${name} has expired`);
  const artifactId = positiveProviderId(artifact.id);
  if (artifactId === null) throw new AssertionFailure(`the intent artifact ${name} carries no positive provider identity`);
  if (Number(artifact.workflow_run?.id) !== Number(runId)) {
    throw new AssertionFailure(`the intent artifact ${name} is owned by run ${JSON.stringify(artifact.workflow_run?.id ?? null)}, not the original run it must belong to`);
  }

  // THE FIXED INTENT JOB SUCCEEDED, IN THAT EXACT ATTEMPT. An artifact whose producing job failed is
  // not evidence, and the run's job set is read to completion rather than sampled.
  const jobs = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}&page=1`);
  if (jobs.status !== 200 || !Array.isArray(jobs.body?.jobs)) throw new IncompleteEvidence("the original run's jobs could not be measured");
  const jobRows = jobs.body.jobs;
  if (Number(jobs.body.total_count ?? jobRows.length) > jobRows.length) {
    throw new IncompleteEvidence("the original run's job list is paginated beyond this bounded read; the intent job's state is unmeasured");
  }
  const intentJob = jobRows.find((job) => String(job?.name ?? "") === INTENT_JOB_NAME);
  if (!intentJob) throw new IncompleteEvidence(`the original run records no ${JSON.stringify(INTENT_JOB_NAME)} job; its intent artifact has no producing job to bind to`);
  if (String(intentJob.status ?? "") !== "completed" || String(intentJob.conclusion ?? "") !== "success") {
    throw new AssertionFailure(`the original run's intent job concluded ${JSON.stringify(String(intentJob.conclusion ?? intentJob.status ?? "none"))}, not success`);
  }
  // EXCLUSIVE WIRING: the original run is a COMMISSION run, so its publisher and rehearsal jobs must
  // not have executed in it. A run in which both a commissioning and a witness job ran is not the
  // reviewed mode separation this artifact's authority depends on.
  for (const forbidden of [WITNESS_JOB_NAME, REHEARSAL_JOB_NAME]) {
    const job = jobRows.find((row) => String(row?.name ?? "") === forbidden);
    if (job && String(job.conclusion ?? "") !== "skipped") {
      throw new AssertionFailure(`the original run executed the ${JSON.stringify(forbidden)} job; commission and witness modes are mutually exclusive by construction`);
    }
  }

  const download = await requestArchive("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/artifacts/${artifactId}/zip`);
  if (download.status !== 200 || !download.bytes) throw new IncompleteEvidence(`the intent artifact ${artifactId} could not be downloaded (${download.status})`);
  const entry = readSingleEntryZip(download.bytes, {
    entryName: intentArtifactEntry(runId, attempt), maxArchiveBytes: MAX_ARCHIVE_BYTES, maxEntryBytes: MAX_ENTRY_BYTES,
  });
  let intent;
  try { intent = JSON.parse(entry.bytes.toString("utf8")); }
  catch { throw new AssertionFailure("the intent artifact's single entry is not valid JSON"); }

  // THE CLOSED SCHEMA, plus INDEPENDENT re-derivation of everything this module can derive itself.
  // The artifact supplies the two App identities and the installation plan; it does not get to
  // supply the derived names, because those are a function of the run and attempt already measured.
  const refuse = (why) => { throw new AssertionFailure(`the original run's intent artifact ${why}`); };
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) refuse("is not a JSON object");
  if (intent.schema_version !== RESULT_SCHEMA_VERSION) refuse("declares an unsupported schema version");
  if (String(intent.phase) !== "intent") refuse(`records phase ${JSON.stringify(String(intent.phase ?? ""))}`);
  if (intent.provider_measured !== false) refuse("claims a provider measurement the credential-free intent phase does not make");
  if (String(intent.repository) !== COMMISSIONING_REPOSITORY) refuse("names another repository");
  if (String(intent.workflow_path) !== COMMISSIONING_WORKFLOW_PATH) refuse("names another workflow");
  if (String(intent.run_id) !== String(runId) || String(intent.attempt) !== String(attempt)) refuse("belongs to a different run or attempt");
  if (String(intent.workflow_sha) !== String(expected.sourceSha)) refuse("was produced against a different immutable source");
  if (Number(intent.repository_id) !== Number(expected.repositoryId)) refuse("names a different repository identity");
  if (canonicalJson(intent.derived_refs) !== canonicalJson(derivedRefs(runId, attempt))) refuse("carries derived refs this run does not derive");
  if (canonicalJson(intent.derived_contexts) !== canonicalJson(derivedContextNames(runId, attempt))) refuse("carries TEST-ONLY contexts this run does not derive");
  if (canonicalJson(intent.derived_ruleset_names) !== canonicalJson(derivedRulesetNames(runId, attempt))) refuse("carries generated ruleset names this run does not derive");
  const normalAppId = positiveProviderId(intent.normal_app_id);
  const emergencyAppId = positiveProviderId(intent.emergency_app_id);
  if (normalAppId === null || emergencyAppId === null) refuse("carries no positive normal and emergency App identities");
  if (normalAppId === emergencyAppId) refuse("names the same App as both release identities");
  return {
    intent,
    provenance: {
      artifact_id: artifactId,
      artifact_name: name,
      entry: intentArtifactEntry(runId, attempt),
      entry_digest: entry.digest,
      owning_run_id: Number(runId),
      intent_job_conclusion: "success",
      // Correlation only, and said so: see this function's header.
      intent_job_id: Number.isInteger(Number(intentJob.id)) ? Number(intentJob.id) : null,
      basis: "reviewed-immutable-workflow-exclusive-upload-wiring + api-run-attempt-and-job-state; REST artifact metadata does not attest a producing job",
    },
  };
}

export async function runWitnessPublisherJob(env = process.env, deps = {}) {
  const role = "witness-publisher";
  const runId = String(env.GITHUB_RUN_ID ?? "");
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? "");
  const ctx = assertRunContext(env, { runId, attempt, role });
  const evidenceDir = assertCloudOutputDirectory(env.COMMISSIONING_EVIDENCE_DIR);
  const redact = createRedactor(collectSentinels(env));
  const eventPath = String(env.GITHUB_EVENT_PATH ?? "");
  if (!eventPath) throw new UsageError("the witness publisher reads its envelope from GITHUB_EVENT_PATH");
  if (lstatSync(eventPath).isSymbolicLink()) throw new UsageError("refusing to read the dispatch event through a symlink");
  // DATA, not an instruction: read and parsed by this fixed checked-out code, never interpolated
  // into a shell command, a script or a logged environment block.
  const { response, envelope } = readWitnessEnvelopeFromEvent(readFileSync(eventPath, "utf8"));

  const token = String(env.GITHUB_TOKEN ?? "");
  if (!token) throw new UsageError("the witness publisher needs its read-only GITHUB_TOKEN to measure its own run");
  const publisherGuardCtx = {
    role, runId, attempt, graphShas: new Set(), contextNames: new Set(), rulesetIds: new Set(), rulesetNames: new Set(),
  };
  const request = createGuardedRequest(deps.metadataTransport ?? createTokenTransport({ token, fetchImpl: deps.fetchImpl ?? fetch, redact }), publisherGuardCtx);
  // The SAME bounded binary transport the consumers use, for the one artifact this job reads.
  const requestArchive = createGuardedRequest(
    deps.archiveTransport ?? createArchiveTransport({ token, fetchImpl: deps.fetchImpl ?? fetch }),
    publisherGuardCtx,
  );
  const run = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/attempts/1`);
  if (run.status !== 200 || !run.body) throw new IncompleteEvidence("the witness publisher could not measure its own run");
  const { sourceSha } = assertPublisherContext({
    env, run: { ...run.body, run_attempt: Number(run.body.run_attempt ?? attempt) },
    expected: { repository: COMMISSIONING_REPOSITORY, dispatchRef: COMMISSIONING_DISPATCH_REF, workflowPath: COMMISSIONING_WORKFLOW_PATH },
  });
  // SOURCE CONTINUITY AT PUBLISHER EXECUTION (F3): the live dispatch branch must still be the
  // immutable source this publisher checked out, or the response it is about to carry describes a
  // tree that is no longer the one the attempt is bound to.
  const continuity = await assertSourceContinuity({
    request, label: "the witness publisher",
    expected: { repositoryId: ctx.repositoryId, workflowSha: sourceSha },
  });
  /**
   * THE ORIGINAL SUBJECT (F11), measured rather than believed. The publisher previously read only
   * its own run; the envelope's `original_run_id`/`original_attempt` were taken on trust.
   */
  const originalRunResponse = await request(
    "GET",
    `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${String(response.original_run_id)}/attempts/${String(response.original_attempt)}`,
  );
  if (originalRunResponse.status !== 200 || !originalRunResponse.body) {
    throw new IncompleteEvidence(`the witness publisher could not measure the original run ${String(response.original_run_id)} its envelope names (${originalRunResponse.status})`);
  }
  /**
   * THE AUTHENTICATED VOCABULARY, for a COMMISSIONING publication only (F11, corrected).
   *
   * The inert rehearsal has no commissioning intent artifact by design and carries no policy
   * measurement, so it is not read for one. A commissioning response whose intent cannot be read is
   * a REFUSAL — never a fall-back to rehearsal semantics, which would let a missing artifact buy a
   * weaker check.
   */
  const rehearsalDomain = String(response.domain ?? "") === REHEARSAL_DOMAIN;
  let allowed = null;
  let intentProvenance = null;
  if (!rehearsalDomain) {
    const role = String(response.role ?? "");
    if (!ACTOR_ROLES.includes(role)) {
      throw new AssertionFailure(`the witness envelope names the role ${JSON.stringify(role)}, which is not one this commissioning run publishes for`);
    }
    const original = await readOriginalIntentArtifact({
      request, requestArchive,
      runId: String(response.original_run_id), attempt: String(response.original_attempt),
      expected: { sourceSha, repositoryId: ctx.repositoryId },
    });
    intentProvenance = original.provenance;
    // The SAME closed vocabulary the offline assessor derives, from the SAME authenticated facts.
    allowed = offlinePublishableVocabulary({
      runId: String(response.original_run_id), attempt: String(response.original_attempt), actor: role,
      normalAppId: Number(original.intent.normal_app_id), emergencyAppId: Number(original.intent.emergency_app_id),
    });
  }
  const witnessDir = path.join(evidenceDir, "witness");
  mkdirSync(witnessDir, { recursive: true, mode: 0o700 });
  const result = publishWitnessResponse({
    response, envelope, publisherRunId: runId, originalRun: originalRunResponse.body, allowed,
    expected: {
      repository: COMMISSIONING_REPOSITORY, workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha,
      dispatchBranch: branchOf(COMMISSIONING_DISPATCH_REF),
    },
    writeEntry: (name, bytes) => {
      const target = path.join(witnessDir, name);
      const fd = openSync(target, "wx", 0o600);
      try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      return target;
    },
  });
  // The fixed upload step names the artifact from this output. The name is DERIVED by reviewed code
  // from validated envelope fields; there is nothing for a caller to choose.
  const outputPath = String(env.GITHUB_OUTPUT ?? "");
  if (outputPath) {
    const fd = openSync(outputPath, "a");
    try { writeSync(fd, `artifact_name=${result.artifact_name}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  }
  writeEvidenceFile(evidenceDir, evidenceSlug(String(response.original_run_id), String(response.original_attempt), "witness"), {
    ...result, run_id: String(response.original_run_id), attempt: String(response.original_attempt),
    workflow_sha: ctx.workflowSha, source_continuity: continuity, intent_provenance: intentProvenance,
  });
  return { ...result, source_continuity: continuity, intent_provenance: intentProvenance };
}

/**
 * The CLOSED inert transport rehearsal (PC-06/F1).
 *
 * It measures the one thing that cannot otherwise be measured before a protected approval: that the
 * dispatch → publish → download → bind path actually works, within the queue and clock bounds this
 * harness imposes. So it deliberately has NO synthetic graph, NO derived ref and NO resource journal
 * to consult — requiring any of those is exactly what made a pre-approval rehearsal impossible, and
 * the transport crosscheck names it as the thing to get right. Its target is the literal `rehearsal`,
 * its domain is `rehearsal`, and every actor consumer rejects that domain before credentials.
 */
export async function runRehearsalStage({ stage, env = process.env, deps = {} }) {
  const role = REHEARSAL_ROLE;
  assertCaseStage(stage, role);
  const runId = String(env.GITHUB_RUN_ID ?? "");
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? "");
  const ctx = assertRunContext(env, { runId, attempt, role: "rehearsal" });
  for (const forbidden of ["RELEASE_APP_PRIVATE_KEY", "EMERGENCY_APP_PRIVATE_KEY"]) {
    if (env[forbidden]) throw new AssertionFailure(`the transport rehearsal can see ${forbidden}; it is a no-secrets job by design`);
  }
  const evidenceDir = assertCloudOutputDirectory(env.COMMISSIONING_EVIDENCE_DIR);
  const store = openCaseStateStore({ dir: cloudSubdirectory(evidenceDir, "state"), runId, attempt, role, now: deps.now });
  const challengeDir = cloudSubdirectory(evidenceDir, "challenges");
  const redact = createRedactor(collectSentinels(env));
  const now = deps.now ?? (() => new Date());
  const token = String(env.GITHUB_TOKEN ?? "");
  if (!token) throw new UsageError("the transport rehearsal needs its read-only GITHUB_TOKEN");
  const guard = { role, runId, attempt, graphShas: new Set(), contextNames: new Set(), rulesetIds: new Set(), rulesetNames: new Set() };
  const request = createGuardedRequest(deps.metadataTransport ?? createTokenTransport({ token, fetchImpl: deps.fetchImpl ?? fetch, redact }), guard);
  const requestArchive = createGuardedRequest(deps.archiveTransport ?? createArchiveTransport({ token, fetchImpl: deps.fetchImpl ?? fetch }), guard);
  const binding = caseBinding({
    ctx, role, caseId: REHEARSAL_CASE_ID, direction: "pre", targetRef: REHEARSAL_TARGET,
    installationId: null, manifest: null, graphShas: null, domain: REHEARSAL_DOMAIN, sourceMode: "transport-rehearsal",
  });

  if (stage === "challenge") {
    store.requireStage(REHEARSAL_CASE_ID, "challenge");
    /**
     * ITS OWN ACTUAL JOB IDENTITY, BY NAME (F11).
     *
     * This counted one non-skipped job. A count says nothing about WHICH job ran, and the
     * rehearsal's whole claim is that the exact reviewed `transport-rehearsal` job is the active
     * one in a rehearsal source run — the same check the actor makes, through the same function.
     */
    const jobState = await assertNamedJobActive({
      request, runId, attempt, jobName: REHEARSAL_JOB_NAME, label: "transport rehearsal",
    });
    if (jobState.executed_job_names.length !== 1 || jobState.executed_job_names[0] !== REHEARSAL_JOB_NAME) {
      throw new AssertionFailure(
        `a transport-rehearsal source run executes exactly the ${JSON.stringify(REHEARSAL_JOB_NAME)} job; this run executed ${jobState.executed_job_names.length ? jobState.executed_job_names.join(", ") : "no job"}`,
      );
    }
    // SOURCE CONTINUITY and the ACTOR the rehearsal claims to be running as — attempt 1, John,
    // measured from the provider rather than from `GITHUB_ACTOR` (F3/F11).
    await measureRehearsalContext({ request, runId, attempt });
    const nonce = (deps.freshNonce ?? freshNonce)();
    const challenge = buildChallenge({ binding, nonce, createdAt: now().toISOString(), extra: { before_sha: null, requested_sha: null } });
    const name = challengeArtifactName({ runId, attempt, role, ordinal: 0, direction: "pre" });
    const written = writeChallengeFile(challengeDir, name, challenge);
    store.write(REHEARSAL_CASE_ID, {
      stage: "challenge", status: "ok", pre_nonce: nonce, pre_challenge_name: name,
      pre_challenge_digest: written.digest, prepared_at: now().toISOString(),
    });
    return {
      schema_version: RESULT_SCHEMA_VERSION, run_id: runId, attempt, phase: "transport-rehearsal-challenge",
      status: "prepared", challenge_artifact: name, challenge_path: written.path, challenge_digest: written.digest,
    };
  }

  const prior = store.requireStage(REHEARSAL_CASE_ID, "consume");
  const read = readChallengeFile(challengeDir, String(prior.pre_challenge_name));
  if (read.digest !== String(prior.pre_challenge_digest)) throw new AssertionFailure("the retained rehearsal challenge is not the bytes this job published");
  const received = await awaitWitnessResponse({
    request, requestArchive, ctx, binding, challenge: read.challenge, challengeDigest: read.digest,
    store, caseId: REHEARSAL_CASE_ID, now: () => now().getTime(), sleep: deps.sleep,
    intervalMs: deps.intervalMs ?? POLL_INTERVAL_MS,
  });
  const observation = received.response.observation;
  // The inert schema variant, required rather than tolerated: a rehearsal that carried a policy
  // measurement would be a rehearsal producing enforcement evidence, which it must never do.
  if (observation?.inert !== true || observation.governed_rulesets !== undefined) {
    throw new AssertionFailure("the rehearsal response is not the inert observation variant; a rehearsal produces no policy measurement");
  }
  const proximity = assertObservationProximity({ observedAt: read.challenge.created_at, actedAt: observation.started_at, label: "the rehearsal observation" });
  const result = {
    schema_version: RESULT_SCHEMA_VERSION, phase: "transport-rehearsal", run_id: runId, attempt: String(attempt),
    workflow_sha: ctx.workflowSha, status: "rehearsed",
    domain: REHEARSAL_DOMAIN, case_id: REHEARSAL_CASE_ID, target: REHEARSAL_TARGET,
    artifact: received.artifact, entry_digest: received.entry_digest, archive_bytes: received.archive_bytes,
    nonce_digest: nonceDigest(String(prior.pre_nonce)), polls: received.polls,
    queue_latency_ms: Date.parse(observation.completed_at) - Date.parse(read.challenge.created_at),
    challenge_to_observation_ms: proximity,
    note: "Transport, queue, clock and serialization viability only. This produces NO enforcement verdict, NO policy measurement and NO actor authority, and it cannot satisfy any actor case.",
  };
  store.write(REHEARSAL_CASE_ID, { ...store.read(REHEARSAL_CASE_ID), stage: "consume", status: "finalized", record: result });
  writeEvidenceFile(evidenceDir, evidenceSlug(runId, attempt, "rehearsal"), result);
  return result;
}

/**
 * The ONE work item the local witness serves, and the exact order it serves them in.
 *
 * 22 for a commissioning attempt — eleven cloud cases (seven normal, four emergency) × pre and post —
 * and exactly one for a rehearsal source run, which can never contribute to the 22.
 */
export function witnessWorkPlan(domain) {
  if (domain === REHEARSAL_DOMAIN) return [{ role: REHEARSAL_ROLE, caseId: REHEARSAL_CASE_ID, ordinal: 0, direction: "pre" }];
  const plan = [];
  for (const role of ACTOR_ROLES) {
    for (const caseId of CLOUD_CASE_SEQUENCE[role]) {
      for (const direction of CHALLENGE_DIRECTIONS) {
        plan.push({ role, caseId, ordinal: caseOrdinal(role, caseId), direction });
      }
    }
  }
  return plan;
}

/**
 * Which kind of source run this is, PROBED rather than supplied.
 *
 * The `witness` CLI takes the same three arguments as every other phase and no network selector, so
 * the domain cannot be an option. It is determined by which first challenge the source run published,
 * and then cross-checked against the challenge's own declared `source_mode`. A run that published
 * both is a refusal: it cannot be a commissioning run and a rehearsal at once.
 */
export async function probeWitnessDomain({ request, runId, attempt }) {
  const probe = async (role, ordinal) => {
    const name = challengeArtifactName({ runId, attempt, role, ordinal, direction: "pre" });
    const listed = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/artifacts?per_page=${PAGE_SIZE}&page=1&name=${encodeURIComponent(name)}`);
    if (listed.status !== 200 || !Array.isArray(listed.body?.artifacts)) return false;
    return listed.body.artifacts.some((artifact) => String(artifact?.name) === name);
  };
  const rehearsal = await probe(REHEARSAL_ROLE, 0);
  // EITHER actor role's first challenge marks a commissioning source run. The two protected jobs
  // are independent — `emergency` needs only `intent` — so which one publishes first is a matter of
  // which human approved first, and probing only `normal` would refuse a legitimate run.
  let commission = false;
  for (const role of ACTOR_ROLES) {
    if (await probe(role, caseOrdinal(role, CLOUD_CASE_SEQUENCE[role][0]))) { commission = true; break; }
  }
  if (rehearsal && commission) throw new AssertionFailure("this source run published both a rehearsal and a commissioning challenge; it cannot be both");
  if (rehearsal) return REHEARSAL_DOMAIN;
  if (commission) return COMMISSION_DOMAIN;
  throw new IncompleteEvidence("the source run has published no first challenge yet; start the local witness after the source run's first case has published", { retryable: true });
}

/** The original protected job must be ACTIVE, in THIS attempt, with an actual approval behind it. */
export async function assertActorJobActive({ request, runId, attempt, role, allowCompleted = false }) {
  const binding = assertRoleBinding(role);
  const spec = PROTECTED_JOBS.find((entry) => entry.id === binding.job);
  if (!spec) throw new UsageError(`the ${role} role has no protected job specification`);
  // THE SHARED NAMED-JOB CHECK. `allowCompleted` exists for RECONCILIATION only: a witness that
  // restarts after the actor consumed its last post response finds that job legitimately finished,
  // and refusing there would strand a publication that already happened. It never admits a NEW
  // dispatch to a finished job, and the approval requirement below is unchanged either way.
  const job = await assertNamedJobActive({
    request, runId, attempt, jobName: spec.name, label: `${role} protected`, allowCompleted,
  });
  const approvals = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/approvals`);
  const history = summarizeApprovals(approvals);
  if (!history.measured) throw new IncompleteEvidence(`the ${role} job's environment approval history could not be measured (${history.reason})`, { retryable: true });
  const approved = history.entries.filter((entry) => entry.state === "approved" && entry.environments.includes(spec.environment));
  if (!approved.length) {
    throw new AssertionFailure(`no human approval is recorded for ${spec.environment}; the local witness does not serve a job whose protected environment was never approved`);
  }
  return { job_id: job.job_id, job_status: job.job_status, environment: spec.environment, approvals: approved };
}

/**
 * The COMPLETE local policy measurement, under the operator's admin identity, inside the 15s bound.
 *
 * This is the measurement the protected job cannot make: `bypass_actors` is returned only to a caller
 * with ruleset write access. Every applicable ruleset is resolved to its full definition over
 * complete pagination, the classic-protection dimension is measured rather than assumed, and the
 * result is projected through the closed publishable vocabulary — which REFUSES anything outside it
 * rather than trimming the projection to fit.
 */
export async function measureCompletePolicy({ request, ctx, actor, now = () => new Date() }) {
  const branch = branchOf(derivedRef(ctx.runId, ctx.attempt, actor));
  const startedAt = now().toISOString();
  const measured = await readApplicableBranchRulesets({ request, branch });
  const protection = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/branches/${branch}/protection`);
  if (protection.status !== 200 && protection.status !== 404) {
    throw new IncompleteEvidence(`the classic protection of ${branch} could not be measured (${protection.status})`);
  }
  const completedAt = now().toISOString();
  return buildGovernedSnapshot({
    rulesets: measured.rulesets,
    classicStatus: protection.status,
    classicBody: protection.status === 404 ? null : protection.body,
    allowed: publishableVocabulary({ ctx, actor }),
    startedAt, completedAt,
    pages: measured.ruleCount,
    sourceIdentities: measured.rulesets.map((ruleset) => String(ruleset?.source ?? COMMISSIONING_REPOSITORY)),
  });
}

/**
 * Serve ONE witness work item: read the challenge, measure, dispatch, and reconcile the publication.
 *
 * The dispatch is journaled INTENT-then-RESULT in the witness chain (F5), and a lost dispatch
 * response is reconciled by looking for the exact expected response artifact — never by dispatching
 * again, which would publish a second response for a nonce that is consumed once.
 */
/**
 * Every pending dispatch this witness journal records for a given expected publication (F6).
 *
 * A `dispatch-intent` with no `response-reconciled` for the same expected artifact is a dispatch
 * whose OUTCOME IS UNKNOWN — the request may have been accepted and the process may have died
 * before the upload landed, in which case the artifact is not yet present and the naive answer
 * ("no artifact, so dispatch") produces a SECOND publisher run for a nonce that is consumed once.
 */
export function pendingWitnessDispatch(records, expectedName) {
  const intents = records.filter((record) => record.type === "dispatch-intent" && String(record.data?.expected_artifact) === String(expectedName));
  if (!intents.length) return null;
  const reconciled = records.some((record) => record.type === "response-reconciled" && String(record.data?.expected_artifact) === String(expectedName));
  if (reconciled) return null;
  const intent = intents[intents.length - 1];
  const result = [...records].reverse().find((record) => record.type === "dispatch-result"
    && String(record.data?.case_id) === String(intent.data?.case_id)
    && String(record.data?.direction) === String(intent.data?.direction));
  return {
    seq: intent.seq,
    expected_artifact: String(intent.data.expected_artifact),
    envelope_digest: String(intent.data.envelope_digest ?? ""),
    nonce_digest: String(intent.data.nonce_digest ?? ""),
    case_id: String(intent.data.case_id ?? ""),
    direction: String(intent.data.direction ?? ""),
    // `null` when the process died between the intent and the result — the most ambiguous state,
    // and the one that must never be resolved by dispatching again.
    result: result ? result.data : null,
  };
}

export async function serveWitnessItem({
  request, requestArchive, ctx, journal, item, operator, domain, setupBindings,
  now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), intervalMs = POLL_INTERVAL_MS,
}) {
  const started = await beginWitnessItem({ request, requestArchive, ctx, journal, item, operator, domain, setupBindings, now });
  if (started.state === "reconciled") return started.reconciled;
  const expiry = Date.parse(String(started.challenge.expires_at));
  for (let polls = 1; ; polls += 1) {
    const reconciled = await pollWitnessPublication({ request, requestArchive, ctx, journal, item, pending: started, now, polls });
    if (reconciled) return reconciled;
    if (now().getTime() + intervalMs > expiry) {
      journal.append("reconciliation", {
        kind: "witness-dispatch", key: started.expectedName, outcome: "unpublished-within-challenge-lifetime",
        case_id: item.caseId, direction: item.direction, polls,
      });
      throw new IncompleteEvidence(`the witness response ${started.expectedName} was not published within the challenge lifetime; the dispatch is not repeated`);
    }
    await sleep(intervalMs);
  }
}

/**
 * ── HALF ONE: observe, validate, reconcile-or-dispatch, and RETURN (F5/F6) ──────────────────────
 *
 * Split out of `serveWitnessItem` so the process can serve READY WORK ACROSS ROLES instead of
 * blocking on one item until its ceiling. The blocking version is why an independently approved
 * emergency job STARVED: the work plan listed all fourteen normal responses before any of the eight
 * emergency ones, so approving emergency first published a valid expiring challenge that the
 * witness never looked at — it was waiting for normal's first challenge, which nobody had approved
 * yet — and the emergency challenge died of its own 180-second lifetime with zero dispatches. The
 * workflow explicitly allows emergency to run independently of normal, so that ordering is not a
 * misuse; it is the design.
 *
 * The fix is not a longer TTL and not a forced approval order, both of which the canonical rules
 * out. It is that "this role's next item has no challenge yet" must be a REASON TO LOOK AT THE
 * OTHER ROLE, not a reason to sleep. Per-role sequence and once-only state are untouched: each role
 * advances only its own cursor, in its own closed case order.
 */
export async function beginWitnessItem({
  request, requestArchive, ctx, journal, item, operator, domain, setupBindings, now = () => new Date(),
}) {
  const challengeName = challengeArtifactName({ runId: ctx.runId, attempt: ctx.attempt, role: item.role, ordinal: item.ordinal, direction: item.direction });
  const listed = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/artifacts?per_page=${PAGE_SIZE}&page=1&name=${encodeURIComponent(challengeName)}`);
  if (listed.status !== 200 || !Array.isArray(listed.body?.artifacts)) throw new IncompleteEvidence(`the challenge ${challengeName} could not be looked up`, { retryable: true });
  const candidates = listed.body.artifacts.filter((artifact) => String(artifact?.name) === challengeName);
  if (!candidates.length) throw new IncompleteEvidence(`the challenge ${challengeName} has not been published yet`, { retryable: true });
  if (candidates.length > 1) throw new AssertionFailure(`${candidates.length} artifacts are named ${challengeName}; a challenge is published exactly once per case and direction`);
  const artifact = candidates[0];
  if (Number(artifact?.workflow_run?.id) !== Number(ctx.runId)) {
    throw new AssertionFailure(`the challenge ${challengeName} belongs to run ${Number(artifact?.workflow_run?.id)}, not the source run this witness serves`);
  }
  const download = await requestArchive("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/artifacts/${Number(artifact.id)}/zip`);
  if (download.status !== 200 || !download.bytes) throw new IncompleteEvidence(`the challenge archive ${challengeName} could not be downloaded (${download.status})`, { retryable: true });
  const entry = readSingleEntryZip(download.bytes, { entryName: `${challengeName}.json`, maxArchiveBytes: MAX_ARCHIVE_BYTES, maxEntryBytes: MAX_ENTRY_BYTES });
  let challenge;
  try { challenge = JSON.parse(entry.bytes.toString("utf8")); }
  catch { throw new AssertionFailure(`the challenge ${challengeName} is not valid JSON`); }
  assertChallengeShape(challenge);

  // VERIFY THE CHALLENGE AGAINST WHAT THIS PROCESS KNOWS, not against what it says about itself.
  const expectDomain = domain === REHEARSAL_DOMAIN ? REHEARSAL_DOMAIN : COMMISSION_DOMAIN;
  if (String(challenge.domain) !== expectDomain) throw new AssertionFailure(`the challenge ${challengeName} declares domain ${JSON.stringify(String(challenge.domain))}`);
  if (String(challenge.source_sha) !== String(ctx.workflowSha)) throw new AssertionFailure(`the challenge ${challengeName} was created against a different immutable source`);
  if (String(challenge.original_run_id) !== String(ctx.runId) || String(challenge.original_attempt) !== String(ctx.attempt)) {
    throw new AssertionFailure(`the challenge ${challengeName} names a different original run or attempt`);
  }
  if (String(challenge.role) !== String(item.role) || String(challenge.case_id) !== String(item.caseId) || String(challenge.direction) !== String(item.direction)) {
    throw new AssertionFailure(`the challenge ${challengeName} does not describe the work item this witness expected`);
  }
  if (Number(challenge.repository_id) !== Number(ctx.repositoryId)) throw new AssertionFailure(`the challenge ${challengeName} names a different repository`);
  const receivedAt = now();
  if (receivedAt.getTime() > Date.parse(String(challenge.expires_at))) {
    throw new IncompleteEvidence(`the challenge ${challengeName} expired before this witness could serve it; the expiry is never extended`);
  }
  const expectedName = responseArtifactName({
    runId: ctx.runId, attempt: ctx.attempt, role: item.role, ordinal: item.ordinal,
    direction: item.direction, nonce: String(challenge.nonce),
  });
  const challengeBinding = Object.fromEntries(BINDING_FIELDS.map((field) => [field, challenge[field] ?? null]));
  const resolveExisting = () => resolvePublishedResponse({
    request, requestArchive, ctx, binding: challengeBinding, challenge,
    challengeDigest: entry.digest, receiptClock: () => now().toISOString(),
  });

  /**
   * ── THE SUBJECT CHECKS COME BEFORE ANY RECONCILIATION DECISION (F6) ───────────────────────────
   *
   * The "already published" shortcut used to run FIRST, so a publication was accepted or rejected
   * before this process had checked that the challenge names the manifest and graph this run
   * created, or that the actor job it serves is genuinely active and approved. Both now happen up
   * front, for both the reconcile path and the dispatch path.
   */
  let jobState = null;
  if (expectDomain === REHEARSAL_DOMAIN) {
    // The rehearsal's own job, BY NAME — the local serving branch previously skipped the active-job
    // check entirely, so it served a response to a rehearsal run whose job it never identified.
    jobState = await assertNamedJobActive({
      request, runId: ctx.runId, attempt: ctx.attempt, jobName: REHEARSAL_JOB_NAME,
      label: "transport rehearsal", allowCompleted: true,
    });
  } else {
    // The manifest/graph digests the local run recorded must be the ones the challenge carries.
    if (String(challenge.manifest_sha256) !== String(setupBindings.manifest_sha256)) throw new AssertionFailure(`the challenge ${challengeName} names a manifest this run did not publish`);
    if (String(challenge.graph_sha256) !== String(setupBindings.graph_sha256)) throw new AssertionFailure(`the challenge ${challengeName} names a synthetic graph this run did not create`);
    // A RECONCILING witness may find the actor job already completed — the actor consumes the last
    // post response and the job ends — so a completed job is admissible for reconciliation while a
    // NEW dispatch still requires an actively running, approved job. The approval requirement is
    // unchanged in both cases.
    jobState = await assertActorJobActive({ request, runId: ctx.runId, attempt: ctx.attempt, role: item.role, allowCompleted: true });
  }

  /**
   * ── PENDING DISPATCH FIRST, FROM THE DURABLE JOURNAL (F6) ─────────────────────────────────────
   *
   * The restart path only ever asked whether the expected artifact already existed. It never
   * consulted the `dispatch-intent`/`dispatch-result` records — so a first dispatch that WAS
   * accepted but whose process died before the upload left no artifact to find, and the restart
   * created a new observation and POSTed the same challenge again: one dispatch before the
   * simulated crash, two after reopening the same journal. Lost-response ambiguity had the same
   * shape.
   *
   * So the journal is consulted BEFORE any new measurement or POST. A dispatch already in flight is
   * reconciled against the exact expected artifact through the SAME validator a consumer uses; if
   * the artifact is not there yet, the item stays PENDING within its original expiry. It is never
   * restamped with a fresh nonce and never reposted.
   */
  /**
   * ── THE OBSERVATION IS RECORDED ONLY AFTER EVERY SUBJECT CHECK HAS PASSED ─────────────────────
   *
   * It used to be appended immediately after the challenge's own shape and identity checks, which
   * is BEFORE the manifest/graph subject checks and before the actor job's active-and-approved
   * state is measured. So a challenge this witness went on to REFUSE was already recorded as one it
   * had observed — a claim about itself that its own refusal contradicted, and (once the event
   * became once-only) an entry that then collided with the legitimate challenge for that key.
   *
   * ONCE-ONLY (see {@link recordWitnessEventOnce}): the append was also unconditional, so every
   * restart or re-entry recorded a second observation of a challenge that is observed once by
   * contract. A replay returns the retained record; a DIFFERENT challenge under the same key
   * refuses.
   */
  recordWitnessEventOnce({
    journal, type: "challenge-observed",
    data: {
      case_id: item.caseId, role: item.role, direction: item.direction, artifact_id: Number(artifact.id),
      challenge_digest: entry.digest, nonce_digest: nonceDigest(String(challenge.nonce)), expires_at: String(challenge.expires_at),
    },
  });

  const pending = pendingWitnessDispatch(journal.read(), expectedName);
  if (pending) {
    try {
      const resolved = await resolveExisting();
      const reconciled = {
        case_id: item.caseId, role: item.role, direction: item.direction,
        artifact_id: resolved.artifact.artifact_id,
        publisher_run_id: positiveProviderId(resolved.artifact.provenance?.publisher_run_id),
        expected_artifact: expectedName, envelope_digest: pending.envelope_digest || null,
        entry_digest: resolved.entry_digest, polls: 0,
        reconciled_without_redispatch: true, recovered_pending_dispatch_seq: pending.seq,
      };
      // ONCE-ONLY: a resumed witness that finds its own pending dispatch already published must
      // return the record it wrote before, not add a second one for the same publication.
      const settled = recordWitnessEventOnce({ journal, type: "response-reconciled", data: reconciled });
      return { state: "reconciled", reconciled: settled.record };
    } catch (error) {
      if (error?.detail?.retryable !== true) throw error;
      // Known-pending, measured-absent: distinct from "never dispatched", and resolved only by
      // waiting for the ORIGINAL dispatch's publication within the ORIGINAL expiry.
      return {
        state: "pending", challenge, challengeDigest: entry.digest, challengeBinding,
        expectedName, envelopeDigest: pending.envelope_digest || null, jobState, recoveredPendingDispatchSeq: pending.seq,
      };
    }
  }

  /**
   * ALREADY PUBLISHED, WITH NO PENDING INTENT? Then reconcile it, and do NOT dispatch (F6).
   *
   * A dispatch returns 204 with no body, so even a clean success tells this process nothing about
   * which run it created — the only answer is ever "look for the exact expected artifact". This now
   * goes through {@link resolvePublishedResponse}, so it applies the consumer's provenance, byte,
   * expiry and binding rules rather than accepting a listing row under a matching name.
   */
  try {
    const resolved = await resolveExisting();
    const reconciled = {
      case_id: item.caseId, role: item.role, direction: item.direction,
      artifact_id: resolved.artifact.artifact_id,
      publisher_run_id: positiveProviderId(resolved.artifact.provenance?.publisher_run_id),
      expected_artifact: expectedName, envelope_digest: null, entry_digest: resolved.entry_digest,
      polls: 0, reconciled_without_redispatch: true,
    };
    const settled = recordWitnessEventOnce({ journal, type: "response-reconciled", data: reconciled });
    return { state: "reconciled", reconciled: settled.record };
  } catch (error) {
    // "Not published yet" is the ordinary case and the reason to dispatch. Anything else — a
    // duplicate, a wrong-source publisher, a failed one, bytes that do not bind — is a refusal.
    if (error?.detail?.retryable !== true) throw error;
  }

  let observation;
  if (expectDomain === REHEARSAL_DOMAIN) {
    // Inert: no policy read, no graph, no resource journal. See {@link runRehearsalStage}.
    const startedAt = now().toISOString();
    observation = { started_at: startedAt, completed_at: now().toISOString(), span_ms: 0, inert: true };
  } else {
    // SOURCE CONTINUITY AT LOCAL WITNESS DISPATCH (F3), immediately before the measurement it
    // carries: a policy measured against a tree that is no longer the trusted source is not
    // evidence about the reviewed attempt.
    await assertSourceContinuity({
      request, label: "the local policy witness",
      expected: { repositoryId: ctx.repositoryId, workflowSha: ctx.workflowSha },
    });
    observation = await measureCompletePolicy({ request, ctx, actor: item.role, now });
  }

  const response = buildResponse({
    challenge, challengeDigest: entry.digest, observation,
    witnessIdentity: { login: operator.login, user_id: operator.id, type: operator.type },
    createdAt: now().toISOString(),
  });
  const envelope = serializeDispatchEnvelope({ response });

  journal.append("dispatch-intent", {
    case_id: item.caseId, role: item.role, direction: item.direction,
    expected_artifact: expectedName, envelope_bytes: envelope.bytes, envelope_digest: envelope.digest,
    nonce_digest: nonceDigest(String(challenge.nonce)), job_state: jobState,
  });
  const dispatch = await request("POST", `/repos/${COMMISSIONING_REPOSITORY}/actions/workflows/${COMMISSIONING_WORKFLOW_FILE}/dispatches`, {
    ref: branchOf(COMMISSIONING_DISPATCH_REF), inputs: envelope.inputs,
  });
  journal.append("dispatch-result", {
    case_id: item.caseId, direction: item.direction, status: Number(dispatch.status), ...responseEvidence(dispatch),
    ambiguous: mutationRequestClass(dispatch.status, dispatch.complete) === "ambiguous", operation_id: dispatch.operation,
  });
  // Only a MEASURED refusal stops here. A 5xx is the same unknown outcome as a lost response: the
  // dispatch may have been accepted, so it is pending and reconciled by the exact artifact below.
  if (mutationRequestClass(dispatch.status, dispatch.complete) === "refused") {
    throw new IncompleteEvidence(`the witness dispatch for ${expectedName} was refused (${dispatch.status})`);
  }
  // The dispatch is away. Its OUTCOME is now the scheduler's business: a dispatch returns 204 with
  // no body, so even a clean success says nothing about which run it made, and the answer is always
  // "look for the exact expected artifact" — never "dispatch again".
  return {
    state: "pending", challenge, challengeDigest: entry.digest, challengeBinding,
    expectedName, envelopeDigest: envelope.digest, jobState,
  };
}

/**
 * ── HALF TWO: ONE non-blocking look for the publication a pending dispatch is waiting for ───────
 *
 * Returns the reconciled record, or `null` for "not yet". It never sleeps and never dispatches, so
 * the scheduler above can interleave it with another role's work — which is the whole point of the
 * split. A publication that exists and does not bind is a refusal here exactly as it is anywhere
 * else, through the same validator.
 */
export async function pollWitnessPublication({ request, requestArchive, ctx, journal, item, pending, now = () => new Date(), polls = 1 }) {
  try {
    const resolved = await resolvePublishedResponse({
      request, requestArchive, ctx, binding: pending.challengeBinding,
      challenge: pending.challenge, challengeDigest: pending.challengeDigest,
      receiptClock: () => now().toISOString(),
    });
    const reconciled = {
      case_id: item.caseId, role: item.role, direction: item.direction,
      artifact_id: resolved.artifact.artifact_id,
      publisher_run_id: positiveProviderId(resolved.artifact.provenance?.publisher_run_id),
      expected_artifact: pending.expectedName, envelope_digest: pending.envelopeDigest ?? null,
      entry_digest: resolved.entry_digest, polls,
      ...(pending.recoveredPendingDispatchSeq ? { recovered_pending_dispatch_seq: pending.recoveredPendingDispatchSeq } : {}),
    };
    const settled = recordWitnessEventOnce({ journal, type: "response-reconciled", data: reconciled });
    return settled.record;
  } catch (error) {
    if (error?.detail?.retryable !== true) throw error;
    return null;
  }
}

/**
 * The `witness` phase: the local, read-only, admin-authority process that serves the whole attempt.
 *
 * It takes the SAME three arguments as every other phase and no network selector. It holds its own
 * exclusive WITNESS-journal lock, so it can run concurrently with `human-tests` — which holds the
 * resource lock — without either waiting on the other. It never appends to the resource journal.
 *
 * Its exit 0 means every expected assigned response was published and reconciled. It never means
 * global PASS: no case verdict, no approval evidence and no cleanup is in its scope.
 */
/**
 * The context a REHEARSAL witness has, measured from the provider rather than read from a file.
 *
 * A transport-rehearsal source run has no `intent` job — intent is a commissioning-mode job — so
 * there is no intent artifact for `localContext` to rebuild from, and requiring one is exactly the
 * kind of prerequisite that would make a pre-approval rehearsal impossible. What the rehearsal
 * actually needs is the repository ID and the immutable source, and both are measurable.
 */
export async function measureRehearsalContext({ request, runId, attempt }) {
  const repository = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}`);
  if (repository.status !== 200 || !Number.isInteger(Number(repository.body?.id))) {
    throw new IncompleteEvidence("the repository identity could not be measured for the rehearsal witness");
  }
  const run = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`);
  if (run.status !== 200 || !run.body) throw new IncompleteEvidence("the rehearsal source run could not be measured");
  if (String(run.body.path) !== COMMISSIONING_WORKFLOW_PATH) throw new AssertionFailure("the rehearsal source run is not the reviewed commissioning workflow");
  if (String(run.body.event) !== COMMISSIONING_EVENT_NAME) throw new AssertionFailure("the rehearsal source run was not dispatched manually");
  if (!FULL_SHA.test(String(run.body.head_sha ?? ""))) throw new IncompleteEvidence("the rehearsal source run reports no immutable head SHA");
  if (String(run.body.head_branch ?? "") !== branchOf(COMMISSIONING_DISPATCH_REF)) {
    throw new AssertionFailure("the rehearsal source run was not dispatched from the fixed staging branch");
  }
  /**
   * THE REHEARSAL'S OWN ACTOR AND ATTEMPT (F11).
   *
   * Neither the cloud rehearsal path nor this local context required a provider-measured John or
   * attempt 1, so a rehearsal source run created by `wrong-user` (#42) on attempt 2 was PREPARED
   * and ACCEPTED. The rehearsal is inert and produces no enforcement verdict — but it is still the
   * measurement root asks for before staging protected approvals, and evidence about a transport
   * exercised by someone else, on a re-run, is not that measurement. It inherits no actor approval
   * and makes no policy claim; what it must do is say honestly whose transport it measured.
   */
  if (Number(run.body.run_attempt) !== 1) {
    throw new AssertionFailure(`the rehearsal source run is attempt ${Number(run.body.run_attempt)}; a rehearsal is measured on the first attempt, never on a re-run`);
  }
  for (const field of ["actor", "triggering_actor"]) {
    const identity = run.body[field];
    if (!identity || Number(identity.id) !== OWNER_USER_ID || String(identity.login) !== OWNER_LOGIN || String(identity.type) !== OWNER_USER_TYPE) {
      throw new AssertionFailure(`the rehearsal source run's measured ${field} is not the one authorized local identity`);
    }
  }
  // The same shared source continuity check every other boundary makes (F3).
  const continuity = await assertSourceContinuity({
    request, label: "the transport rehearsal",
    expected: { repositoryId: Number(repository.body.id), workflowSha: String(run.body.head_sha) },
  });
  return Object.freeze({
    runId: String(runId), attempt: String(attempt), role: "local",
    workflowSha: String(run.body.head_sha), repositoryId: Number(repository.body.id),
    // A rehearsal has no release identity and no producer map, and says so rather than carrying nulls
    // that could be mistaken for measurements.
    normalAppId: null, emergencyAppId: null, producerIds: null, intent: null, actor: null,
    sourceContinuity: continuity,
  });
}

export async function openWitnessSession({ runId, attempt, evidenceDir, env, deps = {} }) {
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
  const requestArchive = createGuardedRequest(deps.archiveTransport ?? createLocalGhArchiveTransport({ spawnImpl: deps.spawnImpl ?? spawn, redact, env }), guardCtx);
  const operator = await assertLocalOperator({ request });

  // WHICH KIND of source run this is, before anything that depends on the answer. It is PROBED
  // rather than supplied — the `witness` CLI takes no network selector — and "no challenge yet" is
  // retryable, because the witness is deliberately started BEFORE the first case publishes.
  const domain = deps.domain ?? await probeWitnessDomain({ request, runId, attempt });

  let ctx;
  let setupBindings = { manifest_sha256: null, graph_sha256: null };
  if (domain === REHEARSAL_DOMAIN) {
    ctx = await measureRehearsalContext({ request, runId, attempt });
  } else {
    ctx = await localContext({ request, runId, attempt, evidenceDir: dir, env });
    // The RESOURCE journal, read-only and unlocked: the witness needs the created graph to bind the
    // challenges, and must not be able to write to it.
    const resourceRecords = readJournal({ dir, runId, attempt });
    for (const entry of journaledResources(resourceRecords, "commit")) guardCtx.graphShas.add(String(entry.sha));
    const setup = readEvidenceFile(dir, evidenceSlug(runId, attempt, "setup"));
    if (!setup) throw new IncompleteEvidence("local setup has not completed for this run; a commissioning witness has no plan to bind challenges against", { retryable: true });
    if (!SHA256_HEX.test(String(setup.manifest_sha256 ?? "")) || !SHA256_HEX.test(String(setup.graph_sha256 ?? ""))) {
      throw new IncompleteEvidence("the setup evidence carries no manifest and graph digests for the witness to bind against");
    }
    setupBindings = { manifest_sha256: setup.manifest_sha256, graph_sha256: setup.graph_sha256 };
  }

  // ITS OWN lock, on its OWN chain: the witness is read-only with respect to provider resources, and
  // must never wait on — or be waited on by — the resource lock that `human-tests` holds.
  const lock = acquireJournalLock({ dir, runId, attempt, kind: "witness", now: deps.now });
  try {
    const journal = openJournal({ dir, runId, attempt, kind: "witness", source: ctx.workflowSha, lock, now: deps.now });
    return { dir, ctx, operator, request, requestArchive, domain, setupBindings, lock, journal };
  } catch (error) {
    lock.release();
    throw error;
  }
}

export async function runWitnessPhase({ runId, attempt, evidenceDir, env, deps = {} }) {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now().getTime();
  const deadlineMs = deps.processDeadlineMs ?? MAX_WITNESS_PROCESS_MS;

  /**
   * THE WITNESS IS STARTED BEFORE THE WORK EXISTS, and that is the reviewed order: "start the
   * separate local witness process, then explicit protected human approvals and normal/emergency
   * actor phases". So neither "the source run has published no challenge yet" nor "local setup has
   * not finished" is a failure at start-up — both are the normal beginning of a run, and both are
   * polled within the same finite process ceiling that bounds everything else here.
   */
  let session;
  for (;;) {
    try {
      session = await openWitnessSession({ runId, attempt, evidenceDir, env, deps });
      break;
    } catch (error) {
      if (error?.detail?.retryable !== true) throw error;
      if (now().getTime() - started > deadlineMs) {
        throw new IncompleteEvidence(`the local witness reached its ${deadlineMs}ms ceiling before the source run published any challenge`);
      }
      await sleep(deps.intervalMs ?? POLL_INTERVAL_MS);
    }
  }
  const { dir, ctx, operator, request, requestArchive, domain, setupBindings, lock, journal } = session;
  const served = [];
  try {
    journal.append("witness-opened", {
      domain, operator_login: operator.login, operator_id: operator.id,
      manifest_sha256: setupBindings.manifest_sha256, graph_sha256: setupBindings.graph_sha256,
      expected_publications: domain === REHEARSAL_DOMAIN ? 1 : REQUIRED_WITNESS_PUBLICATIONS,
    });
    const plan = witnessWorkPlan(domain);
    const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
    /**
     * ── THE READY-WORK SCHEDULER (F5) ────────────────────────────────────────────────────────────
     *
     * One queue per ROLE, each in its own strict case/pre-post order, and a cursor that only that
     * role's own progress advances. Every pass looks at every role that still has work:
     *
     *   - a role whose current item has a pending dispatch gets ONE non-blocking poll;
     *   - a role whose current item has no challenge published yet is SKIPPED, not waited on;
     *   - a role whose current item is ready is begun, and may reconcile immediately.
     *
     * A pass that made no progress anywhere sleeps once and tries again. That is the whole
     * correction: the previous loop walked one flat list in plan order and BLOCKED on each entry
     * until the process ceiling, so all fourteen normal responses stood in front of the first
     * emergency one and an independently approved emergency job could never be served at all.
     *
     * What is deliberately unchanged: per-role sequence, once-only nonce consumption, the 180-second
     * challenge lifetime (never extended), and the approval requirement. Serving across roles is
     * what the workflow's own independence between `normal` and `emergency` already permits.
     */
    const roles = [...new Set(plan.map((entry) => entry.role))];
    const queues = new Map(roles.map((role) => [role, plan.filter((entry) => entry.role === role)]));
    const cursors = new Map(roles.map((role) => [role, 0]));
    const pending = new Map();
    const polls = new Map();
    const remaining = () => roles.reduce((total, role) => total + (queues.get(role).length - cursors.get(role)), 0);
    while (remaining() > 0) {
      // The process ceiling, checked before every pass: a witness that outlived its 30 minutes
      // stops and reports incomplete rather than serving a stale attempt.
      if (now().getTime() - started > deadlineMs) {
        journal.append("witness-closed", { domain, served: served.length, expected: plan.length, outcome: "process-deadline" });
        throw new IncompleteEvidence(`the local witness reached its ${deadlineMs}ms ceiling after serving ${served.length} of ${plan.length} responses`);
      }
      let progressed = false;
      for (const role of roles) {
        const queue = queues.get(role);
        const index = cursors.get(role);
        if (index >= queue.length) continue;
        const item = queue[index];
        const key = `${item.role}:${item.caseId}:${item.direction}`;
        try {
          if (!pending.has(key)) {
            const begun = await beginWitnessItem({ request, requestArchive, ctx, journal, item, operator, domain, setupBindings, now });
            if (begun.state === "reconciled") {
              served.push(begun.reconciled);
              cursors.set(role, index + 1);
              progressed = true;
              continue;
            }
            pending.set(key, begun);
            polls.set(key, 0);
            progressed = true;
          }
          const count = (polls.get(key) ?? 0) + 1;
          polls.set(key, count);
          const reconciled = await pollWitnessPublication({
            request, requestArchive, ctx, journal, item, pending: pending.get(key), now, polls: count,
          });
          if (reconciled) {
            served.push(reconciled);
            pending.delete(key);
            polls.delete(key);
            cursors.set(role, index + 1);
            progressed = true;
            continue;
          }
          // Still unpublished. Its ORIGINAL expiry bounds it, and the expiry is never extended.
          const expiry = Date.parse(String(pending.get(key).challenge.expires_at));
          if (now().getTime() + intervalMs > expiry) {
            journal.append("reconciliation", {
              kind: "witness-dispatch", key: pending.get(key).expectedName,
              outcome: "unpublished-within-challenge-lifetime", case_id: item.caseId, direction: item.direction, polls: count,
            });
            throw new IncompleteEvidence(`the witness response ${pending.get(key).expectedName} was not published within the challenge lifetime; the dispatch is not repeated`);
          }
        } catch (error) {
          // "This role's challenge is not published yet" is a reason to look at the OTHER role, not
          // a reason to stop or to sleep. Every other refusal is immediate, as before.
          if (error?.detail?.retryable !== true) throw error;
        }
      }
      if (!progressed) await sleep(intervalMs);
    }
    journal.append("witness-closed", { domain, served: served.length, expected: plan.length, outcome: "complete" });
    const evidence = {
      schema_version: RESULT_SCHEMA_VERSION, phase: "witness", run_id: String(runId), attempt: String(attempt),
      workflow_sha: ctx.workflowSha, domain,
      expected_publications: plan.length, publications: served,
      witness_identity: { login: operator.login, user_id: operator.id, type: operator.type },
      note: domain === REHEARSAL_DOMAIN
        ? "One rehearsal response. It cannot satisfy any actor case and cannot contribute to the commissioning publication count."
        : `All ${REQUIRED_WITNESS_PUBLICATIONS} assigned cloud-case responses were published and reconciled. This is NOT a global PASS: no case verdict, approval evidence or cleanup is in this phase's scope.`,
      guarantee: "bounded contemporaneous pre/post measurement under administrative quiescence; NOT an atomic policy-at-mutation proof",
    };
    const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, "witness-process"), evidence);
    writeJournalSnapshot({ dir, runId, attempt, kind: "witness", snapshot: { generated_from: "verified witness journal", records: journal.read().length, served: served.length } });
    return closedResult({ runId, attempt, phase: "witness", status: "published", evidencePath, extra: { domain, publications: served.length } });
  } finally {
    lock.release();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 14. Cleanup, collection and the authoritative completeness check.
// ──────────────────────────────────────────────────────────────────────────────

/** PC-07 cleanup: rulesets, then refs, then the synthetic pull request. Never by wildcard. */
export async function runCleanupPhase({ runId, attempt, evidenceDir, env, deps = {} }) {
  // OBSERVE, not enforce: cleanup is the remediation a source move calls for, so a moved staging
  // head is recorded and reported here rather than refusing the one phase that can remove what
  // this run created. The production-baseline comparison below still ends the run as interrupted.
  const session = await openLocalSession({ runId, attempt, evidenceDir, env, deps, sourceContinuity: "observe" });
  const { dir, ctx, operator, request, guardCtx, journal, lock, records } = session;
  try {
    const baseline = records.find((record) => record.type === "baseline-measured")?.data;
    if (!baseline) throw new IncompleteEvidence("this run has no journaled production baseline; cleanup cannot prove it changed nothing");
    // RECONCILE FIRST (F5): "exact owned IDs/fingerprints plus reconciled intent history are required
    // before cleanup". A cleanup that ran with an unresolved create intent would be a cleanup that
    // cannot say whether the resource it is not deleting exists.
    const reconciliations = await reconcileCreateIntents({ request, ctx, journal });
    const current = journal.read();
    /**
     * REFRESH THE OWNED-ID GUARD CONTEXT AFTER RECONCILIATION (F7).
     *
     * `openLocalSession` builds these sets from the journal as it stood when the session opened —
     * i.e. BEFORE the reconciliation above may have appended newly discovered resources. The
     * request boundary refuses a DELETE whose ruleset ID is not in `rulesetIds`, so a resource that
     * reconciliation had just proved this run owns could not be deleted through the very guard that
     * exists to permit exactly that. The sets are re-derived from the journal the reconciliation
     * wrote, and only from it.
     */
    for (const entry of journaledResources(current, "ruleset")) {
      const id = positiveProviderId(entry.id);
      if (id !== null) guardCtx.rulesetIds.add(id);
    }
    for (const entry of journaledResources(current, "commit")) guardCtx.graphShas.add(String(entry.sha));
    guardCtx.pullNumber = positiveProviderId(journaledResources(current, "pull-request")[0]?.number);
    /**
     * The INDEPENDENTLY DERIVED intended bodies (F8), recomputed from the immutable intent rather
     * than read back from the provider. This is what an unfingerprinted resource has to match
     * before cleanup will treat it as owned.
     */
    const intendedRulesets = new Map(
      Object.values(buildDisposablePlan(ctx).plan).flat().map((entry) => [entry.name, entry.body]),
    );
    const fingerprints = journaledFingerprints(current);
    const outcomes = [];
    let refused = 0;

    for (const owned of journaledResources(current, "ruleset")) {
      const detail = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${owned.id}`);
      if (detail.status === 404) { outcomes.push({ kind: "ruleset", id: owned.id, name: owned.name, result: "already-absent" }); continue; }
      if (detail.status !== 200 || !detail.body) { outcomes.push({ kind: "ruleset", id: owned.id, name: owned.name, result: "unreadable" }); refused += 1; continue; }
      const include = detail.body?.conditions?.ref_name?.include ?? [];
      const measured = governedFingerprint(detail.body);
      let recorded = fingerprints.get(`ruleset:${owned.name}`);
      let fingerprintStage = "creation";
      let ownershipGap = null;
      if (recorded === undefined) {
        /**
         * A create whose fingerprint readback failed (F5/F8). The resource IS owned — the journal
         * names its exact ID and name — so refusing outright would leave it behind for ever. But
         * the bounded reconciliation is NOT "measure it now": the name and one include ref were the
         * whole check, and a ruleset whose RULES had been emptied after creation satisfied both and
         * was deleted.
         *
         * The intended body is recomputed from the immutable intent, independently of anything the
         * provider now holds, and the current body must be provably that body. If it is not, the
         * ownership gap is recorded and the resource is REFUSED — left in place, named, for root.
         */
        const intended = intendedRulesets.get(owned.name) ?? null;
        const proof = proveIntendedOwnership({ measured: detail.body, intended });
        if (String(detail.body.name) === owned.name && include.length === 1 && include[0] === owned.target_ref && proof.provable) {
          journal.append("resource-fingerprinted", {
            kind: "ruleset", key: owned.name, id: positiveProviderId(owned.id), governed_fingerprint: measured,
            measured_at_stage: "cleanup-reconciliation", ownership_basis: proof.basis,
          });
          recorded = measured;
          fingerprintStage = "cleanup-reconciliation";
        } else {
          ownershipGap = proof.provable
            ? "the resource does not read back under the exact name and target the journal recorded"
            : proof.reason;
          journal.append("reconciliation", {
            kind: "ruleset", key: `ruleset:${owned.name}`, outcome: "ownership-unprovable",
            id: positiveProviderId(owned.id), reason: ownershipGap, differences: proof.differences,
          });
        }
      }
      /**
       * EXACT GOVERNED EQUALITY, EVEN WHEN A FINGERPRINT WAS RECORDED (F8, corrected).
       *
       * The fingerprint path proves "the body has not changed since we measured it". That is only
       * an ownership proof if what we measured was the INTENDED body — which is exactly what the
       * corrected adoption sites now establish. Re-proving it here costs one comparison and closes
       * the case where a fingerprint reached the journal by some path this build has not thought of:
       * the deletion decision never rests on a digest alone.
       */
      if (recorded !== undefined && ownershipGap === null) {
        const proof = proveIntendedOwnership({ measured: detail.body, intended: intendedRulesets.get(owned.name) ?? null });
        if (!proof.provable) ownershipGap = proof.reason;
      }
      // The COMPLETE governed fingerprint, not a name and one include ref. A ruleset whose rules,
      // bypass actors, enforcement mode or exclusions changed after setup is a different policy at
      // the same ID, and PC-07 requires a changed resource to be refused rather than deleted.
      const identical = ownershipGap === null
        && String(detail.body.name) === owned.name
        && include.length === 1 && include[0] === owned.target_ref
        && typeof recorded === "string" && measured === recorded;
      if (!identical) {
        outcomes.push({
          kind: "ruleset", id: owned.id, name: owned.name, result: "refused-ownership-mismatch",
          // Which half of the check refused, so a reviewer does not have to guess whether the
          // resource was retargeted, its body was edited, or its ownership was never provable.
          detail: ownershipGap
            ? `ownership gap: ${ownershipGap}`
            : (typeof recorded !== "string"
              ? "no journaled fingerprint and the identity does not match the recorded intent"
              : "fingerprint or target differs from the journaled creation readback"),
          ...(ownershipGap ? { ownership_gap: true } : {}),
        });
        refused += 1;
        continue;
      }
      journal.append("cleanup-intent", { kind: "ruleset", id: owned.id, name: owned.name });
      const response = await request("DELETE", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${owned.id}`);
      const readback = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/rulesets/${owned.id}`);
      const removed = readback.status === 404;
      journal.append("cleanup-result", { kind: "ruleset", id: owned.id, status: response.status, ...responseEvidence(response), removed });
      outcomes.push({ kind: "ruleset", id: owned.id, name: owned.name, result: removed ? "removed" : "still-present", fingerprint_stage: fingerprintStage });
      if (!removed) refused += 1;
    }

    for (const owned of journaledResources(current, "ref")) {
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
      journal.append("cleanup-result", { kind: "ref", ref: owned.ref, status: response.status, ...responseEvidence(response), removed: readback === null });
      outcomes.push({ kind: "ref", ref: owned.ref, result: readback === null ? "removed" : "still-present" });
      if (readback !== null) refused += 1;
    }

    const pull = journaledResources(current, "pull-request")[0];
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
        journal.append("cleanup-result", { kind: "pull-request", number: pull.number, status: response.status, ...responseEvidence(response), closed });
        outcomes.push({ kind: "pull-request", number: pull.number, result: closed ? "closed" : "still-open" });
        if (!closed) refused += 1;
      }
    }

    const after = await measureProductionBaseline({
      request,
      excludeRulesetIds: new Set(journaledResources(current, "ruleset").map((owned) => Number(owned.id))),
    });
    const drift = Object.keys(baseline).filter((key) => canonicalJson(baseline[key]) !== canonicalJson(after[key]));
    const stillUnresolved = blockingCreateIntents(journal.read());
    journal.append("run-closed", { cleanup_refusals: refused, production_drift: drift, unresolved_intents: stillUnresolved.length });
    const evidence = {
      schema_version: RESULT_SCHEMA_VERSION, phase: "cleanup", run_id: String(runId), attempt: String(attempt),
      workflow_sha: ctx.workflowSha, outcomes, refusals: refused,
      // WHO DELETED (F9). Cleanup made thirteen DELETE calls without ever reading `/user`; the
      // identity that ran it is now admitted by the shared local session AND recorded here, so the
      // final assessment can require that the operator who removed the resources is the one this
      // harness names rather than whoever happened to hold the credential at the end.
      operator: { login: operator.login, permission: operator.permission, id: operator.id, type: operator.type },
      source_continuity: ctx.sourceContinuity ?? null,
      production_baseline_before: baseline, production_baseline_after: after, production_drift: drift,
      // Both are recomputed by `check-evidence` from the journal and from the two baselines it
      // carries; they are published so a reviewer can re-derive them, not so a gate can read them.
      reconciliations, unresolved_intents: stillUnresolved.length,
    };
    const evidencePath = writeEvidenceFile(dir, evidenceSlug(runId, attempt, "cleanup"), evidence);
    if (drift.length) {
      // Concurrent legitimate source movement is INTERRUPTED, requiring reconciliation — never an
      // automatic rollback of somebody else's change.
      throw new IncompleteEvidence(`production state moved during this run (${drift.join(", ")}); the result is interrupted and needs root reconciliation`, { evidencePath });
    }
    if (refused) throw new AssertionFailure(`${refused} owned resource(s) could not be removed or did not match their journaled fingerprint`, { evidencePath });
    if (stillUnresolved.length) {
      throw new IncompleteEvidence(
        `${stillUnresolved.length} create intent(s) remain unresolved after reconciliation; cleanup cannot claim this run left nothing behind`,
        { evidencePath },
      );
    }
    return closedResult({ runId, attempt, phase: "cleanup", status: "cleaned", evidencePath });
  } finally {
    lock.release();
  }
}

/**
 * The CLOSED set of protected-environment controls PC-06 requires, and the proof each one needs.
 *
 * None of these can be produced by this harness. It cannot impersonate a second reviewer, it cannot
 * read `prevent_self_review` back from the environments API, and a skipped off-branch job proves
 * workflow ADMISSION rather than environment branch policy. PC-06's own instruction for that last
 * case is to report it unverified rather than widen admission to arbitrary refs, so each control is
 * operator-supplied evidence — which is exactly why the SHAPE of that evidence is checked hard.
 *
 * A `verified: true` boolean is not accepted, and neither is prose. Every verified record must NAME a
 * retained artifact inside the evidence directory and commit to its SHA-256, which
 * {@link assessEvidence} recomputes from the file on disk. That is the difference between an
 * attestation and a binding: a reviewer can re-hash the artifact, and an operator cannot satisfy the
 * gate by typing a word.
 *
 * Coverage is the CROSS PRODUCT of these controls and the two protected environments. The two
 * environments are configured separately; one of them being right says nothing whatever about the
 * other, and a single record covering "the environments" would hide precisely that.
 */
/**
 * ONE CLOSED SCHEMA PER CONTROL (F2), each naming the OUTCOME the control is supposed to have.
 *
 * ── WHY THE PREVIOUS SHAPE WAS NOT EVIDENCE ─────────────────────────────────────────────────────
 *
 * The previous validator took only the record and the directory: it never learned WHICH control it
 * was checking or which environment for. So it checked a status word, a non-empty object, a
 * parseable date and an artifact digest — and accepted a record whose observation was
 * `{"prevent_self_review": false}`, dated 2020, with the same artifact reused for every control in
 * both environments. That is the exact packet the independent review executed, and it returned
 * "accepted". A digest proves WHICH BYTES WERE RETAINED. It says nothing about whether the control
 * passed, which control it was, or when.
 *
 * ── WHAT EACH RECORD MUST NOW CARRY ─────────────────────────────────────────────────────────────
 *
 *  - the control's own `expected` outcome, EQUAL to this build's declared one — a record cannot
 *    bring its own weaker expectation;
 *  - a `measured` value that EQUALS that expectation — so a measured `false` is now a blocker;
 *  - the exact environment NUMERIC ID and name it was measured on, because the two environments are
 *    configured separately and one being right says nothing about the other;
 *  - a capture time inside this run's window, so last year's screenshot is not this run's evidence;
 *  - for a run-bound control (the three negative cases), the run ID and attempt it was produced in;
 *  - an artifact whose PARSED CONTENT names the same control, environment and measured value — which
 *    is what makes reusing one file for seven controls a refusal rather than a pass.
 *
 * `administrators_cannot_bypass` is deliberately UI-ONLY: the environments API does not return that
 * field, so an API-sourced claim about it would be a claim about something nobody read. It stays
 * explicitly UI-sourced with its capture time, exactly as the canonical revision requires, and it is
 * never manufactured from a boolean.
 */
export const ENVIRONMENT_CONTROL_SCHEMAS = Object.freeze({
  required_reviewer_is_owner: Object.freeze({
    sources: Object.freeze(["provider-api", "provider-ui"]), run_bound: false,
    expected: Object.freeze({ reviewer_login: OWNER_LOGIN, reviewer_id: OWNER_USER_ID, reviewer_type: OWNER_USER_TYPE }),
  }),
  prevent_self_review_enabled: Object.freeze({
    sources: Object.freeze(["provider-api", "provider-ui"]), run_bound: false,
    expected: Object.freeze({ prevent_self_review: true }),
  }),
  branch_policy_limits_to_staging: Object.freeze({
    sources: Object.freeze(["provider-api", "provider-ui"]), run_bound: false,
    expected: Object.freeze({ protected_branches: false, custom_branch_policies: true, branches: Object.freeze(["staging"]) }),
  }),
  administrators_cannot_bypass: Object.freeze({
    // UI ONLY. The API omits this field; a `provider-api` claim about it is unsourced by construction.
    sources: Object.freeze(["provider-ui"]), run_bound: false,
    expected: Object.freeze({ can_admins_bypass: false }),
  }),
  self_review_refused: Object.freeze({
    sources: Object.freeze(["provider-api", "provider-ui"]), run_bound: true,
    expected: Object.freeze({ attempt_outcome: "refused" }),
  }),
  unauthorized_reviewer_refused: Object.freeze({
    sources: Object.freeze(["provider-api", "provider-ui"]), run_bound: true,
    expected: Object.freeze({ attempt_outcome: "refused" }),
  }),
  // PC-06 allows a separately staged no-secrets probe from a disposable ref, but this workflow's
  // admission is FIXED to `refs/heads/staging`, so within it the case cannot be produced. The spec's
  // instruction is to report it unverified rather than widen admission. This key is that gap, named.
  off_branch_environment_reference_refused: Object.freeze({
    sources: Object.freeze(["provider-api", "provider-ui"]), run_bound: true,
    expected: Object.freeze({ attempt_outcome: "refused" }),
  }),
});

export const ENVIRONMENT_CONTROL_KEYS = Object.freeze(Object.keys(ENVIRONMENT_CONTROL_SCHEMAS));
export const ENVIRONMENT_EVIDENCE_SOURCES = Object.freeze(["provider-api", "provider-ui"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Validate ONE protected-environment control record against ITS OWN closed schema.
 *
 * Returns `null` when the record is acceptable as `verified`; otherwise the reason it is not, which
 * the caller records as a blocker. `unverified` is never an error here — it is the honest state, and
 * it blocks activation on its own.
 */
export function validateEnvironmentControl(record, { dir, key, environment, environmentId = null, runId = null, attempt = null, window = null, offbranch = null }) {
  const schema = ENVIRONMENT_CONTROL_SCHEMAS[String(key)];
  if (!schema) return `names the control ${JSON.stringify(String(key))}, which is outside the closed PC-06 list`;
  if (record === undefined || record === null) return "is absent";
  if (typeof record !== "object" || Array.isArray(record)) return "is not a control record";
  /**
   * ── THE ONE CROSS-RUN VARIANT, SELECTED EXPLICITLY (accepted PC-06 API-only design) ─────────────
   *
   * Only the exact key `off_branch_environment_reference_refused` WITH the integer marker
   * `offbranch_schema_version: 1` reaches the separately staged probe's validator. The marker under
   * any other control refuses — the same-run self-review and unauthorized-reviewer controls cannot
   * borrow cross-run semantics through it — an unknown version refuses, and a record WITHOUT the
   * marker keeps the legacy same-run validation below: absence never infers a link.
   */
  if (Object.hasOwn(record, "offbranch_schema_version")) {
    if (String(key) !== OFFBRANCH_CONTROL) return `carries the cross-run off-branch marker, which only ${OFFBRANCH_CONTROL} may use`;
    if (record.offbranch_schema_version !== OFFBRANCH_SCHEMA_VERSION) return `declares the off-branch schema version ${JSON.stringify(record.offbranch_schema_version)}, which this build does not know`;
    if (!offbranch) return "is a cross-run off-branch record, but no trusted commissioning context exists to validate it against";
    return validateOffBranchRecord(record, {
      dir, environment, environmentId, expected: schema.expected, trusted: offbranch,
      readProbeJournal: () => readJournal({ dir, runId, attempt, kind: "probe" }),
    });
  }
  const status = String(record.status ?? "");
  if (status !== "verified") return `is ${status || "absent"}`;
  if (!schema.sources.includes(String(record.source ?? ""))) {
    return `names the source ${JSON.stringify(String(record.source ?? ""))}, which this control does not accept (it accepts ${schema.sources.join("/")})`;
  }

  // IDENTITY: the exact environment, by numeric ID as well as name.
  if (String(record.environment_name ?? "") !== String(environment)) {
    return `was measured on environment ${JSON.stringify(String(record.environment_name ?? ""))}, not ${environment}`;
  }
  if (!POSITIVE_DECIMAL.test(String(record.environment_id ?? ""))) return "carries no numeric environment ID";

  // THE OUTCOME, both halves. The record cannot bring its own expectation, and its measurement must
  // equal this build's.
  if (canonicalJson(record.expected) !== canonicalJson(schema.expected)) {
    return "declares an expected control outcome that is not the one this build requires";
  }
  if (record.measured === undefined || record.measured === null) return "records no measured control value";
  if (canonicalJson(record.measured) !== canonicalJson(schema.expected)) {
    return `measured a control value that is not the required outcome (${canonicalJson(record.measured)} vs ${canonicalJson(schema.expected)})`;
  }

  // TIME: inside this run's window. A historical timestamp is not this run's evidence.
  const measuredAt = Date.parse(String(record.measured_at ?? ""));
  if (!Number.isFinite(measuredAt)) return "carries no parseable measured_at timestamp";
  if (window?.start !== undefined && Number.isFinite(Date.parse(String(window.start))) && measuredAt < Date.parse(String(window.start))) {
    return `was captured at ${new Date(measuredAt).toISOString()}, before this run's window opened; a historical observation is not this run's evidence`;
  }
  if (window?.end !== undefined && Number.isFinite(Date.parse(String(window.end))) && measuredAt > Date.parse(String(window.end))) {
    return `was captured at ${new Date(measuredAt).toISOString()}, after this run's window closed`;
  }

  // RUN BINDING for the three negative cases: an attempt outcome belongs to an attempt.
  if (schema.run_bound) {
    if (runId !== null && String(record.run_id ?? "") !== String(runId)) return "is a run-bound control that names a different run";
    if (attempt !== null && String(record.attempt ?? "") !== String(attempt)) return "is a run-bound control that names a different attempt";
  }

  // THE ARTIFACT, and its CONTENT. A plain basename inside the evidence directory: a path would make
  // this field a way to read or digest a file somewhere else on the operator's disk.
  const artifact = String(record.artifact ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(artifact)) return "does not name a plain retained artifact file";
  if (!SHA256_HEX.test(String(record.artifact_sha256 ?? ""))) return "carries no SHA-256 digest for its artifact";
  let bytes;
  try {
    const target = path.join(dir, artifact);
    if (lstatSync(target).isSymbolicLink()) return `names an artifact that is a symlink (${artifact})`;
    bytes = readFileSync(target);
  } catch {
    return `names the artifact ${JSON.stringify(artifact)}, which is not in the evidence directory`;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== String(record.artifact_sha256)) {
    return `names an artifact whose digest does not match the one it commits to (${artifact})`;
  }
  // The retained bytes must be ABOUT this control on this environment, with this measurement. Reusing
  // one file across controls or environments — which the previous shape accepted — fails here.
  let observation;
  try { observation = JSON.parse(bytes.toString("utf8")); }
  catch { return `names an artifact that is not a parseable observation (${artifact})`; }
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return `names an artifact that is not an observation object (${artifact})`;
  if (String(observation?.control ?? "") !== String(key)) return `names an artifact recording the control ${JSON.stringify(String(observation?.control ?? ""))}`;
  if (String(observation?.environment ?? "") !== String(environment)) return `names an artifact recording environment ${JSON.stringify(String(observation?.environment ?? ""))}`;
  if (canonicalJson(observation?.measured) !== canonicalJson(record.measured)) {
    return `names an artifact whose recorded measurement is not the one this record claims (${artifact})`;
  }

  /**
   * ── THE RETAINED OBSERVATION OWNS ITS PROVENANCE (R3) ─────────────────────────────────────────
   *
   * The checks above bound the retained bytes to the control, the environment NAME and the measured
   * value — and nothing else. Source, capture time, numeric environment ID and run/attempt were read
   * only from the OUTER record, so a stale observation from another run, attempt, environment and year
   * was accepted as soon as a fresh wrapper was put around it: the digest proved which stale bytes
   * were retained, and the wrapper supplied provenance the bytes contradicted.
   *
   * So the observation carries its own closed provenance, every field is REQUIRED in the bytes, and
   * the wrapper may only repeat it. The window and run checks above therefore apply to the capture
   * time and run identity the observation itself recorded; a fresh outer timestamp cannot replace it.
   */
  const allowed = environmentObservationFields(schema);
  const unexpected = Object.keys(observation).filter((field) => !allowed.includes(field)).sort();
  if (unexpected.length) return `names an artifact carrying field(s) outside this control's closed observation schema (${unexpected.join(", ")})`;
  const missing = allowed.filter((field) => observation[field] === undefined || observation[field] === null || observation[field] === "");
  if (missing.length) return `names an artifact that does not record its own ${missing.join(", ")}; provenance the retained observation lacks cannot be supplied by its wrapper`;
  if (!schema.sources.includes(String(observation.source))) {
    return `names an artifact recording the source ${JSON.stringify(String(observation.source))}, which this control does not accept`;
  }
  if (String(observation.source) !== String(record.source)) {
    return `names an artifact recorded from ${JSON.stringify(String(observation.source))}, not the ${JSON.stringify(String(record.source))} source its record claims`;
  }
  if (!POSITIVE_DECIMAL.test(String(observation.environment_id))) return "names an artifact recording no numeric environment ID";
  if (String(observation.environment_id) !== String(record.environment_id)) {
    return `names an artifact recording environment ID ${String(observation.environment_id)}, not the ${String(record.environment_id)} its record claims`;
  }
  if (environmentId !== null && String(observation.environment_id) !== String(environmentId)) {
    return `names an artifact recording environment ID ${String(observation.environment_id)}, not ${String(environmentId)}`;
  }
  // EXACT, not "parses to something near": the capture time is the observation's own fact.
  if (!Number.isFinite(Date.parse(String(observation.measured_at))) || String(observation.measured_at) !== String(record.measured_at)) {
    return `names an artifact captured at ${JSON.stringify(String(observation.measured_at))}, not the ${JSON.stringify(String(record.measured_at))} its record claims; an outer timestamp cannot restamp an observation`;
  }
  if (schema.run_bound) {
    for (const [field, expectedValue] of [["run_id", runId], ["attempt", attempt]]) {
      if (String(observation[field]) !== String(record[field] ?? "")) {
        return `names an artifact recording ${field} ${String(observation[field])}, not the ${String(record[field] ?? "")} its record claims`;
      }
      if (expectedValue !== null && String(observation[field]) !== String(expectedValue)) {
        return `names an artifact produced in a different ${field === "run_id" ? "run" : "attempt"} (${String(observation[field])})`;
      }
    }
  }
  return null;
}

/** The closed field set a retained PC-06 observation carries: its subject, measurement and provenance. */
export function environmentObservationFields(schema) {
  return [
    "control", "environment", "environment_id", "source", "measured_at", "measured",
    ...(schema?.run_bound ? ["run_id", "attempt"] : []),
  ];
}

/**
 * Every evidence file's identity, checked before ANY field in it is believed.
 *
 * A file that is present but belongs to another run, another attempt or another phase is worse than
 * an absent one: absence blocks loudly, whereas a mis-bound file would contribute PASSING gates
 * measured against a different subject. A copy of last week's green packet dropped into this run's
 * directory is exactly the shape this refuses.
 */
export function validateEvidenceBinding(payload, { runId, attempt, phase, required = [], workflowSha = null }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "is not a JSON object";
  if (payload.schema_version !== RESULT_SCHEMA_VERSION) return `declares schema version ${JSON.stringify(payload.schema_version ?? null)}, not ${RESULT_SCHEMA_VERSION}`;
  if (String(payload.run_id) !== String(runId)) return `belongs to run ${JSON.stringify(String(payload.run_id ?? ""))}`;
  if (String(payload.attempt) !== String(attempt)) return `belongs to attempt ${JSON.stringify(String(payload.attempt ?? ""))}`;
  if (String(payload.phase) !== phase) return `records phase ${JSON.stringify(String(payload.phase ?? ""))}, not ${phase}`;
  // A CLOSED required-field list per phase. Without it a `{}` body with the right four identity
  // fields satisfies every gate that reads its contents with `?? {}`.
  const missing = required.filter((field) => payload[field] === undefined || payload[field] === null);
  if (missing.length) return `is missing the required field(s) ${missing.join(", ")}`;
  // Cross-file binding: every file must agree about the immutable source it was produced against.
  if (workflowSha && payload.workflow_sha !== undefined && String(payload.workflow_sha) !== String(workflowSha)) {
    return `was produced against workflow SHA ${String(payload.workflow_sha).slice(0, 12)}, not this run's`;
  }
  return null;
}

/** Which evidence file each gate needs, the phase it must declare, and the fields it must carry. */
const EVIDENCE_MANIFEST = Object.freeze([
  { key: "intent", gate: "PC-03", phase: "intent", required: ["workflow_sha", "repository_id", "derived_refs", "derived_contexts", "graph_plan", "provider_measured", "normal_app_id", "emergency_app_id", "producer_ids_hash", "normal_installation_id", "emergency_installation_id"] },
  { key: "setup", gate: "PC-03", phase: "setup", required: ["workflow_sha", "operator", "intent_remeasured", "protected_jobs_at_setup", "production_baseline", "production_policy_hash", "synthetic_graph", "derived_refs", "disposable_rulesets", "synthetic_pull_request", "compatibility", "approval_history_before_approval", "manifest_sha256", "manifest", "graph_sha256", "production_inputs_sha256", "unresolved_intents"] },
  { key: "fixture", gate: "PC-02", phase: "fixture-checks", required: ["workflow_sha", "published", "measured_producer_app_ids", "manifest_wait"] },
  { key: "human", gate: "PC-05", phase: "human-tests", required: ["workflow_sha", "actor", "cases"] },
  { key: "normal", gate: "PC-05", phase: "normal-tests", required: ["workflow_sha", "actor", "policy_in_force", "check_publication", "cases", "manifest_commit_sha", "manifest_sha256", "graph_sha256"] },
  { key: "emergency", gate: "PC-05", phase: "emergency-tests", required: ["workflow_sha", "actor", "policy_in_force", "cases", "manifest_commit_sha", "manifest_sha256", "graph_sha256"] },
  { key: "approvals", gate: "PC-06", phase: "approvals", required: ["workflow_sha", "approval_history", "environments", "dispatcher_is_the_approver", "measured_dispatcher", "run_measured"] },
  { key: "environment", gate: "PC-06", phase: "environment-controls", required: ["controls"] },
  { key: "cleanup", gate: "PC-07", phase: "cleanup", required: ["workflow_sha", "operator", "outcomes", "refusals", "production_baseline_before", "production_baseline_after", "production_drift", "unresolved_intents"] },
  // The F1 transport's own record: the local witness process's summary of what it published.
  { key: "witness-process", gate: "PC-04", phase: "witness", required: ["workflow_sha", "domain", "expected_publications", "publications", "witness_identity"] },
  // The private local subject the offline reconstruction needs. Absent means INCOMPLETE, never
  // "fall back to comparing the packet's copies of a digest with each other".
  { key: "production-inputs", gate: "PC-04", phase: "production-inputs", required: ["workflow_sha", "repository_id", "normal_app_id", "emergency_app_id", "producer_ids", "producer_ids_hash", "production_rulesets", "production_policy_hash"] },
]);

/** The evidence file a case's outcome must come from — its OWN actor's, and no other. */
const ACTOR_EVIDENCE_KEY = Object.freeze({ human: "human", normal: "normal", emergency: "emergency" });

/**
 * DERIVE one case's verdict from what its record measured, instead of reading its `passed` field.
 *
 * The record is the subject here, not the authority. `passed: true` is a claim the file makes about
 * itself, and a file is exactly the thing an adversarial or truncated packet controls; so every
 * invariant the outcome depends on is recomputed — the identity of the case, the operation and force
 * flag it claims, the before/after/requested SHAs, the HTTP class, whether the diagnostic actually
 * attributes the refusal to a rule, and whether the declared check state was measured at all.
 *
 * Returns a list of reasons the record does not support its own outcome. Empty means it does.
 */
export function deriveCaseVerdict(record, kase, { runId, attempt, graph = null, normalAppId = null }) {
  const problems = [];
  const complain = (why) => problems.push(why);
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["is not a case record"];
  if (String(record.case) !== kase.id) return [`records case ${JSON.stringify(String(record.case ?? ""))}`];
  // Ownership: the record must claim the case's own actor, in the case's own actor's file.
  if (String(record.actor) !== kase.actor) complain(`claims actor ${JSON.stringify(String(record.actor ?? ""))}, not ${kase.actor}`);
  if (String(record.operation) !== kase.operation) complain(`claims operation ${JSON.stringify(String(record.operation ?? ""))}`);
  if (record.force !== kase.force) complain(`claims force ${JSON.stringify(record.force ?? null)}`);
  if (String(record.expected) !== kase.expected) complain(`claims to have expected ${JSON.stringify(String(record.expected ?? ""))}`);
  if (String(record.ref) !== derivedRef(runId, attempt, kase.ref)) complain("names a ref this run did not derive for it");
  if (!CASE_OUTCOMES.includes(String(record.outcome))) return [...problems, `records the unknown outcome ${JSON.stringify(String(record.outcome ?? ""))}`];

  const outcome = String(record.outcome);
  const derivedPassed = outcome === kase.expected;
  // A file whose own `passed` disagrees with its own outcome is not a measurement; it is a claim.
  if (record.passed !== derivedPassed) complain(`says passed=${JSON.stringify(record.passed ?? null)} for outcome ${outcome}`);
  if (!derivedPassed) return [...problems, `recorded ${outcome}`];

  const status = Number(record.http_status);
  const diagnostic = record.diagnostic;
  const before = String(record.before_sha ?? "");
  const after = String(record.after_sha ?? "");
  const requested = String(record.requested_sha ?? "");
  if (!FULL_SHA.test(before)) complain("carries no measured before SHA");
  if (!diagnostic || typeof diagnostic !== "object") complain("carries no provider diagnostic");
  // The request class is DERIVED from the recorded status by the one owner, never read from the
  // record: a `request_class` that disagrees with its own status is an asserted outcome.
  // Completion is part of that derivation (R02-1): a record with no `response_complete: true` is a
  // request whose response the transport never measured as finished, whatever status it carries.
  const requestClass = mutationRequestClass(record.http_status, record.response_complete);
  if (record.request_class !== undefined && record.request_class !== requestClass) {
    complain(`labels its request ${JSON.stringify(String(record.request_class))}, but HTTP ${Number.isFinite(status) ? status : "?"} (${record.response_complete === true ? "complete" : "incomplete"} response) is ${requestClass}`);
  }

  // ── NON-VACUITY, BOUND TO THE FROZEN GRAPH (F3) ────────────────────────────────────────────────
  //
  // The previous gate validated SHA syntax and equality and nothing else. It therefore returned no
  // problems for `normal-update-all-green` AND `normal-force-rewind` with before == requested ==
  // after — a no-op recorded as a permitted write, and a force flag on a ref that never moved
  // recorded as a denied non-fast-forward. Neither record can prove what its case claims. The
  // runtime precondition helper was already strict; the AUTHORITATIVE offline gate was not, and this
  // is where the packet is judged.
  //
  // So the identities come from the run's own journaled synthetic graph, and the RELATION between
  // them has to be the one the operation needs.
  if (!graph || typeof graph !== "object") {
    complain("cannot be bound to this run's synthetic graph, so its before/requested identities are unverifiable");
  } else {
    const expectedBefore = String(graph[kase.from] ?? "");
    const expectedRequested = kase.to ? String(graph[kase.to] ?? "") : null;
    if (!FULL_SHA.test(expectedBefore)) complain(`has no journaled synthetic commit for its starting node ${kase.from}`);
    else if (before !== expectedBefore) complain(`starts at a commit that is not the journaled synthetic node ${kase.from}`);
    if (kase.to) {
      if (!FULL_SHA.test(String(expectedRequested))) complain(`has no journaled synthetic commit for its target node ${kase.to}`);
      else if (requested !== expectedRequested) complain(`requests a commit that is not the journaled synthetic node ${kase.to}`);
      // A request equal to the current head measures nothing at all.
      if (requested && before === requested) complain("requests the commit the ref is already at, which is a no-op rather than a measurement");
      const descendant = ancestorsOf(kase.to).has(kase.from) && kase.to !== kase.from;
      if (kase.operation === "update" && !descendant) complain(`is an ${kase.operation} whose target does not descend from its start; it would not measure a fast-forward`);
      if (kase.operation === "merge" && !descendant) complain("is a merge whose head does not descend from its base");
      if (kase.operation === "force") {
        // A force to a DESCENDANT is an ordinary fast-forward wearing a force flag: a
        // `non_fast_forward` rule does not refuse it, so a denial recorded for it proves nothing.
        if (descendant) complain("is a force whose target descends from its start, which is a fast-forward wearing a force flag and proves nothing");
        const ancestor = ancestorsOf(kase.from).has(kase.to);
        const divergent = !ancestor && !descendant && kase.to !== kase.from;
        if (!ancestor && !divergent) complain("is a force whose target is neither a real rewind nor a divergent commit");
      }
    } else if (kase.operation === "delete") {
      // A delete case has to be deleting something: an already-absent ref cannot be refused.
      if (!FULL_SHA.test(before)) complain("is a delete of a ref with no measured content");
    }
  }

  // The declared check state, RECOMPUTED from its own per-context measurement AND bound to the
  // exact synthetic commit this case requested.
  const checkHeadSha = kase.to && graph && typeof graph === "object" && FULL_SHA.test(String(graph[kase.to] ?? "")) ? String(graph[kase.to]) : null;
  for (const why of recomputeCheckState(record.check_state, { runId, attempt, expectation: kase.checks, normalAppId, headSha: checkHeadSha })) complain(why);

  if (outcome === "denied") {
    // A MEASURED refusal only. A 5xx, 408 or status 0 is a request of unknown fate, and an unchanged
    // readback beside it is not enforcement evidence.
    if (requestClass !== "refused") complain(`records a denial at HTTP ${Number.isFinite(status) ? status : "?"}, which is not a measured provider refusal`);
    // POLICY DENIAL, RECOMPUTED from this build's closed diagnostic table rather than read out of the
    // record. `policyDenial` in a packet is a caller-supplied boolean, and a caller-supplied boolean
    // is exactly what a hostile or truncated packet controls.
    const category = String(diagnostic?.category ?? "");
    const known = DIAGNOSTIC_PATTERNS.find((entry) => entry.id === category);
    if (!known) complain(`records a denial whose diagnostic category ${JSON.stringify(category)} is not one this build classifies`);
    else if (known.policyDenial !== true) complain(`records a denial whose ${category} diagnostic is not attributable to a policy rule`);
    const ruleIds = Array.isArray(diagnostic?.ruleIds) ? diagnostic.ruleIds : [];
    if (ruleIds.some((id) => !DIAGNOSTIC_PATTERNS.some((entry) => entry.id === id))) complain("records a rule identifier outside this build's closed diagnostic set");
    if (after !== before) complain("records a denial on a ref that moved");
    if (kase.requiresRuleId && !ruleIds.includes(kase.requiresRuleId)) {
      complain(`records a denial that does not isolate the ${kase.requiresRuleId} rule`);
    }
  } else if (outcome === "accepted") {
    if (!FULL_SHA.test(requested)) complain("carries no measured requested SHA");
    if (after !== requested) complain("records an acceptance whose independent readback is not the requested commit");
    // A MEASURED 2xx, and nothing else (R1). Status 0, a 5xx or a 408 is a request whose fate is
    // unknown; a readback that happens to show the requested commit is reconciliation evidence, never
    // an acceptance.
    if (requestClass !== "accepted") complain(`records an acceptance at HTTP ${Number.isFinite(status) ? status : "?"}, which is not a measured provider acceptance`);
  }
  return problems;
}

/**
 * The offline half of "an ambiguous mutation stops further actor mutations", for the CLOUD actors.
 *
 * The local human cases are held to this by their verified journal ({@link assessHumanCaseJournal}).
 * A cloud actor's cases are recorded only in its own evidence file, so the rule is re-applied here
 * from each record's values: a case halts its actor when it recorded an unexpected success or
 * mutation, or when its request had no decisive outcome ({@link mutationRequestClass}) — including a
 * record with no status at all, which the finalizer writes for a case that used its mutation marker
 * and never finalized. Any later case in the closed order that records anything other than `not-run`
 * was issued while further mutations were forbidden. The record's own `outcome` or a readback that
 * matches cannot excuse it.
 */
export function cloudCasesIssuedAfterHalt(files) {
  const problems = [];
  for (const actor of ["normal", "emergency"]) {
    const cases = Array.isArray(files?.[ACTOR_EVIDENCE_KEY[actor]]?.cases) ? files[ACTOR_EVIDENCE_KEY[actor]].cases : [];
    let halted = null;
    for (const kase of casesForActor(actor)) {
      const recorded = cases.filter((record) => String(record?.case) === kase.id);
      if (!recorded.length) continue;
      const issued = recorded.filter((record) => String(record?.outcome) !== "not-run");
      if (halted && issued.length) {
        problems.push(`case ${kase.id} records ${String(issued[0]?.outcome)} after ${halted} had stopped further ${actor} mutations; an attempt never issues a mutation after an ambiguous or halting one`);
      }
      const halts = issued.some((record) => ["unexpected-success", "unexpected-mutation"].includes(String(record?.outcome))
        || mutationRequestClass(record?.http_status, record?.response_complete) === "ambiguous");
      if (halts) halted = halted ?? kase.id;
    }
  }
  return problems;
}

/**
 * The disposable policy this run INTENDED, recomputed offline from the immutable intent (F2).
 *
 * ── WHY THIS IS COMPUTABLE WITHOUT THE PRODUCER MAP ─────────────────────────────────────────────
 *
 * The intent artifact deliberately publishes only a DIGEST of the twelve production producer IDs,
 * not the map, so an offline assessor does not have them. It does not need them: the closed
 * disposable transformation REPLACES every required check with `{ context: <derived TEST-ONLY
 * name>, integration_id: <normal App> }`, and the derived context names come from the ordinals of
 * `REQUIRED_MAIN_CONTEXTS`. So the disposable body depends on the producer map only through the
 * NUMBER and ORDER of required contexts, which are fixed. The placeholder map below therefore
 * yields exactly the bodies this run created — the same trick {@link derivedRulesetNames} already
 * relies on — and the assessment compares the retained projections against a policy it derived
 * itself rather than against anything the packet supplied.
 */
export function expectedDisposableRulesets({ runId, attempt, actor, normalAppId, emergencyAppId }) {
  const placeholderProducers = Object.fromEntries(REQUIRED_MAIN_CONTEXTS.map((context) => [context, 1]));
  const production = buildMainRulesets({ normalAppId, emergencyAppId, producerIds: placeholderProducers });
  return transformToDisposable(production, { runId, attempt, actor, normalAppId });
}

/**
 * The closed publishable vocabulary an OFFLINE reader can derive (F2).
 *
 * Narrower than {@link publishableVocabulary} in exactly one dimension — the producer set contains
 * only the normal App, because that is the only producer a DISPOSABLE required check may name.
 * Narrower is the safe direction: a projection that would fail this re-validation is one this
 * build would never have published.
 */
export function offlinePublishableVocabulary({ runId, attempt, actor, normalAppId, emergencyAppId }) {
  return {
    rulesetNames: new Set(derivedRulesetNames(runId, attempt)[actor] ?? []),
    refPatterns: new Set([derivedRef(runId, attempt, actor === "human" ? "human" : actor)]),
    contexts: new Set(derivedContextNames(runId, attempt)),
    producerIds: new Set([Number(normalAppId)]),
    bypassAppIds: new Set([Number(normalAppId), Number(emergencyAppId)]),
    sources: new Set([COMMISSIONING_REPOSITORY, ORG]),
  };
}

/**
 * INDEPENDENTLY REPEAT one retained governed observation (F2).
 *
 * Runs the SAME closed projection validator the consumer ran ({@link validateGovernedSnapshot}),
 * then compares the governed set to the policy this assessor derived for itself. Returns the
 * reasons the retained measurement does not support the verdict recorded beside it.
 *
 * This is the difference the review names: the previous gate counted unique IDs and checked digest
 * SYNTAX, so a packet whose per-case policy verdicts all read `mismatch`, or whose observations
 * were absent entirely, produced no blockers at all. A digest proves which bytes were retained. It
 * does not prove what they say.
 */
export function reassessGovernedObservation(observation, { runId, attempt, actor, normalAppId, emergencyAppId }) {
  const problems = [];
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return ["carries no retained governed observation"];
  if (observation.inert === true) return ["carries an INERT rehearsal observation; a rehearsal measurement can never stand for a commissioning case"];
  let governed;
  try {
    ({ governed } = validateGovernedSnapshot(observation, offlinePublishableVocabulary({ runId, attempt, actor, normalAppId, emergencyAppId })));
  } catch (error) {
    return [`carries a governed observation that does not re-validate against the closed publishable vocabulary (${error instanceof Error ? error.message : String(error)})`];
  }
  const wanted = expectedDisposableRulesets({ runId, attempt, actor, normalAppId, emergencyAppId });
  const byName = new Map(governed.map((ruleset) => [String(ruleset.name), ruleset]));
  for (const want of wanted) {
    const actual = byName.get(String(want.name));
    if (!actual) { problems.push(`measured no ${want.name} ruleset as applicable`); continue; }
    for (const field of GOVERNED_RULESET_FIELDS.filter((entry) => entry !== "name")) {
      // STRICT: byte equality or key reordering. `compareToDesired` reported an all-`added`
      // difference set as normalization-only, which is how an extra governed parameter passed.
      const comparison = compareToIntendedGoverned(actual[field] ?? null, want[field] ?? null);
      if (!comparison.equal) {
        problems.push(`measured a ${want.name} ${field} that is not the intended disposable policy`);
      }
    }
  }
  /**
   * ── AND THE UNCHANGED PRODUCTION VERIFIER, ON THE OFFLINE INVERSE (root's qualification) ──────
   *
   * The field comparison above is a difference REPORTER. The VERDICT belongs to the same function
   * runtime uses, because that is the only way the offline answer to "is
   * `update_allows_fetch_and_merge: true` acceptable?" is the runtime answer. The driver added
   * exactly that parameter, recomputed the projection digest, and the packet returned no blockers.
   *
   * The inverse uses the same placeholder producer map {@link expectedDisposableRulesets} relies on,
   * so the comparison is the runtime one modulo the producer identity — which is checked separately
   * against the immutable intent. `main-policy.mjs` is not touched.
   */
  const owned = governed.filter((ruleset) => wanted.some((want) => String(want.name) === String(ruleset.name)));
  const foreignRulesets = governed.filter((ruleset) => !wanted.some((want) => String(want.name) === String(ruleset.name)));
  let inverted = null;
  try {
    inverted = owned.map((ruleset) => invertDisposable(ruleset, {
      runId, attempt, actor,
      producerIds: Object.fromEntries(REQUIRED_MAIN_CONTEXTS.map((context) => [context, 1])),
      normalAppId,
    }));
  } catch (error) {
    problems.push(`carries a governed body the closed inverse transformation refuses (${error instanceof Error ? error.message : String(error)})`);
  }
  if (inverted) {
    const verdict = verifyEffectiveMainPolicy({
      applicableRulesets: [...inverted, ...foreignRulesets],
      classicProtection: null,
      expected: {
        normalAppId, emergencyAppId,
        producerIds: Object.fromEntries(REQUIRED_MAIN_CONTEXTS.map((context) => [context, 1])),
      },
      applicabilityMeasured: true,
    });
    if (!verdict.ok) {
      for (const error of (verdict.errors ?? []).slice(0, 6)) {
        problems.push(`is rejected by the unchanged production verifier: ${error}`);
      }
    }
  }
  const foreign = governed.filter((ruleset) => !wanted.some((want) => String(want.name) === String(ruleset.name)));
  if (foreign.length) problems.push(`measured ${foreign.length} additional applicable ruleset(s) (${foreign.map((r) => String(r.name)).join(", ")})`);
  // The timings, as ACTUAL FINITE NUMBERS. `Number(null)` is zero and zero is inside every bound.
  for (const field of ["started_at", "completed_at"]) {
    if (!Number.isFinite(Date.parse(String(observation[field])))) problems.push(`carries no parseable ${field}`);
  }
  if (typeof observation.span_ms !== "number" || !Number.isFinite(observation.span_ms) || observation.span_ms < 0 || observation.span_ms > MAX_POLICY_READ_SPAN_MS) {
    problems.push(`carries an observation span (${JSON.stringify(observation.span_ms ?? null)}) outside the ${MAX_POLICY_READ_SPAN_MS}ms contemporaneity bound`);
  }
  return problems;
}

/** A measured interval must be an ACTUAL FINITE NUMBER inside its bound — never `null` coerced. */
function assessInterval(value, label, bound) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${label} is ${JSON.stringify(value ?? null)} rather than an actual measured interval; an absent timing is not a zero one`;
  }
  if (value < 0 || value > bound) return `${label} (${value}ms) is outside the ${bound}ms sequencing bound`;
  return null;
}

/**
 * The authoritative completeness assessment (PC-07/PC-08). Every gate reports, and a gate that
 * could not be measured is `unverified` — which BLOCKS, and is never rendered as a pass.
 *
 * THREE KINDS OF BLOCKER, deliberately distinct in the output: `failed` is a measured statement
 * about the subject, `unverified` is "we could not look or nobody has looked yet", and `invalid` is
 * "a file claiming to be this evidence is not this evidence". Only an empty blocker list is a pass,
 * so the distinction changes the exit code (1 vs 3) and the story, never the verdict.
 *
 * NOTHING IN A FILE IS TRUSTED BECAUSE OF ITS FILENAME. An earlier version of this function returned
 * ZERO blockers for a packet whose intent belonged to another run, whose fixture, actor and cleanup
 * files were empty objects, whose compatibility map had no entries, whose case records were bare
 * `{case, passed: true}` pairs pooled from a single actor's file, and whose environment evidence was
 * one boolean. Every one of those shapes is now a blocker: required fields are closed per phase,
 * outcomes are derived rather than read, cases are bound to their own actor's file, cleanup coverage
 * is computed from the verified journal, and environment proof is re-hashed from disk.
 */
/**
 * RE-RUN THE TWO AUTHORITATIVE TRANSPORT VALIDATORS on one case's retained facts (F2, corrected).
 *
 * ── WHY THIS EXISTS RATHER THAN MORE FIELD CHECKS ───────────────────────────────────────────────
 *
 * The previous assessment read this case's digests, artifact IDs and DECLARED intervals. Every one
 * of those is a value the packet controls, which is why eleven independent per-case corruptions —
 * a mutation timestamped 2099, a readback before the mutation, a foreign challenge lifetime, a
 * moved source, a removed publisher run, a removed provenance record, a refused scoped read, an
 * unplanned installation — each produced ZERO blockers on their own.
 *
 * So the actual functions run again, here, on the retained bytes: {@link assertResponseBinding}
 * against an expected binding this assessor DERIVES, and {@link assertPublisherArtifactProvenance}
 * against the retained artifact/run/jobs facts. The timings are recomputed from the observation and
 * readback instants rather than read from the record that asserts them.
 *
 * `expectedBinding` is built from the immutable intent (repository, source, App and PLANNED
 * INSTALLATION identities), this build's own derivations (ref, ordinal, job) and the digests
 * reconstructed elsewhere in this function — never from the case record.
 */
function reconstructCaseTransport(record, { runId, attempt, role, kase, intent, manifestDigest, graphDigest, witnessJournal = null }) {
  const problems = [];
  const witness = record?.witness;
  if (!witness || typeof witness !== "object") return ["records no witness evidence to reconstruct"];
  const plannedInstallation = String(role === "normal" ? intent?.normal_installation_id ?? "" : intent?.emergency_installation_id ?? "");
  const intendedAppId = Number(role === "normal" ? intent?.normal_app_id : intent?.emergency_app_id);

  // ── THE PLANNED INSTALLATION IDENTITY, from the intent and nowhere else ────────────────────────
  if (!POSITIVE_DECIMAL.test(plannedInstallation)) {
    problems.push("cannot be bound to a planned installation identity, because the immutable intent carries none");
  } else if (String(record?.installation_id ?? "") !== plannedInstallation) {
    problems.push(`names installation ${JSON.stringify(String(record?.installation_id ?? ""))}, not the ${plannedInstallation} this run's immutable intent planned`);
  }
  const grants = record?.grants;
  if (grants && typeof grants === "object") {
    if (String(grants.installation_id ?? "") !== plannedInstallation) {
      problems.push(`measured installation ${JSON.stringify(String(grants.installation_id ?? ""))}, not the planned ${plannedInstallation}`);
    }
    // The provider's OWN identity for the installation must be the one that was asked about.
    if (grants.installation_body_id !== undefined && Number(grants.installation_body_id) !== Number(plannedInstallation)) {
      problems.push(`records a provider installation identity of ${JSON.stringify(grants.installation_body_id ?? null)}, not the planned ${plannedInstallation}`);
    }
    if (Number.isInteger(intendedAppId) && Number(grants.installation_app_id) !== intendedAppId) {
      problems.push(`records an installation belonging to App ${JSON.stringify(grants.installation_app_id ?? null)}, not the ${intendedAppId} the intent configured`);
    }
  }
  // ── THE SCOPED READ, which is a MEASUREMENT and not a field ─────────────────────────────────────
  const scoped = record?.token_proof?.scoped_read;
  if (!scoped || typeof scoped !== "object") problems.push("records no scoped read for its freshly minted credential");
  else {
    if (String(scoped.operation ?? "") !== "read-repository") problems.push(`records a scoped read of ${JSON.stringify(String(scoped.operation ?? ""))}`);
    if (Number(scoped.status) !== 200) problems.push(`records a scoped read that returned ${JSON.stringify(scoped.status ?? null)}, which is not a successful read`);
    if (intent && Number(scoped.repository_id) !== Number(intent.repository_id)) {
      problems.push("records a scoped read of a repository the immutable intent did not configure");
    }
  }
  // ── SOURCE CONTINUITY AT BOTH CONSUMPTION BOUNDARIES ────────────────────────────────────────────
  for (const direction of ["pre", "post"]) {
    const continuity = record?.source_continuity?.[direction];
    if (!continuity || typeof continuity !== "object" || continuity.measured !== true) {
      problems.push(`records no measured ${direction}-consumption source continuity`);
      continue;
    }
    if (continuity.moved === true) problems.push(`ran with the source MOVED at its ${direction} consumption boundary; the attempt is interrupted, not passing`);
    if (intent && String(continuity.trusted_source_sha ?? "") !== String(intent.workflow_sha)) {
      problems.push(`measured ${direction} continuity against a source that is not this run's immutable one`);
    }
  }

  for (const direction of ["pre", "post"]) {
    const challenge = witness[`${direction}_challenge`];
    const digest = witness[`${direction}_challenge_digest`];
    const response = witness[`${direction}_response`];
    const receivedAt = witness[`${direction}_received_at`];
    const responseBytes = witness[`${direction}_response_bytes`];
    const entryDigest = witness[`${direction}_entry_digest`];
    const facts = witness[`${direction}_provenance_facts`];
    if (!challenge || !response || !SHA256_HEX.test(String(digest ?? ""))) {
      problems.push(`retains no ${direction} challenge/response pair to re-bind`);
      continue;
    }
    /**
     * ── THE RECEIPT IS A DISTINCT MEASURED EVENT (root's condition 3) ────────────────────────────
     *
     * This used to read `receivedAt ?? response.created_at`. Those are two different facts: WHEN THE
     * WITNESS CREATED the response, and WHEN THIS JOB RECEIVED it. The challenge lifetime is checked
     * against the receipt, so substituting the creation time silently answered a question nobody had
     * measured — and made a packet with no receipt at all indistinguishable from one that arrived in
     * time. There is no fallback: a missing receipt is INCOMPLETE.
     *
     * It is also why an already-valid historical packet needs no wall clock here. Everything the
     * lifetime and ordering are judged against is retained history.
     */
    if (!Number.isFinite(Date.parse(String(receivedAt ?? "")))) {
      problems.push(`retains no measured ${direction} receipt time; a response's creation time is not its receipt, and an absent receipt is not substituted`);
      continue;
    }
    /**
     * ── THE DISPATCH → EXACT BYTES → ENTRY DIGEST → CHALLENGE/NONCE JOIN (root's condition 2) ────
     *
     * Every step is recomputed from a different retained artefact, so no single declared hash can
     * carry the claim:
     *
     *   the retained BYTES hash to the entry digest           (bytes ⇄ entry_digest)
     *   the bytes PARSE to the retained response object       (bytes ⇄ response)
     *   re-serializing that response reproduces the digest    (response ⇄ envelope contract)
     *   the witness journal's DISPATCH names that digest      (dispatch ⇄ bytes)
     *   the response's nonce digests to the observed challenge (bytes ⇄ nonce)
     *
     * An unknown or changed byte stream refuses even when the parsed objects look equivalent, which
     * is the case a pretty-printed re-serialization of the same response produces.
     */
    if (typeof responseBytes !== "string" || !responseBytes) {
      problems.push(`retains no exact ${direction} response bytes, so its entry digest describes nothing this assessor can measure`);
    } else if (!SHA256_HEX.test(String(entryDigest ?? ""))) {
      problems.push(`retains no ${direction} entry digest for the bytes it carries`);
    } else {
      const measuredDigest = bytesSha256(Buffer.from(responseBytes, "utf8"));
      if (measuredDigest !== String(entryDigest)) {
        problems.push(`retains ${direction} response bytes that hash to ${measuredDigest.slice(0, 12)}, not the ${String(entryDigest).slice(0, 12)} entry digest they are published under`);
      }
      let parsed = null;
      try { parsed = JSON.parse(responseBytes); } catch { problems.push(`retains ${direction} response bytes that are not valid JSON`); }
      if (parsed && canonicalJson(parsed) !== canonicalJson(response)) {
        problems.push(`retains ${direction} response bytes that do not describe the response object beside them`);
      }
      // The SAME serialization contract the local witness dispatched under.
      try {
        if (serializeDispatchEnvelope({ response }).digest !== String(entryDigest)) {
          problems.push(`retains a ${direction} response whose dispatch serialization does not reproduce its published entry digest`);
        }
      } catch (error) {
        problems.push(`retains a ${direction} response that does not serialize under the dispatch contract (${error instanceof Error ? error.message : String(error)})`);
      }
      // THE DISPATCH ITSELF, from the separate witness chain.
      const history = witnessJournal?.get(`${String(kase.id)}:${direction}`) ?? null;
      if (!history?.dispatchIntent) {
        problems.push(`has no ${direction} dispatch record in the verified witness journal to join its published bytes to`);
      } else if (String(history.dispatchIntent.envelope_digest ?? "") !== String(entryDigest)) {
        problems.push(`was dispatched under envelope digest ${String(history.dispatchIntent.envelope_digest ?? "none").slice(0, 12)}, which is not the ${String(entryDigest).slice(0, 12)} its published bytes carry`);
      }
      if (history?.observed) {
        if (String(history.observed.nonce_digest ?? "") !== nonceDigest(String(response.challenge_nonce ?? ""))) {
          problems.push(`carries a ${direction} response whose nonce is not the one the witness journal observed for it`);
        }
        if (String(history.observed.challenge_digest ?? "") !== String(response.challenge_digest ?? "")) {
          problems.push(`carries a ${direction} response answering challenge bytes the witness journal did not observe`);
        }
      }
    }
    // THE EXPECTED BINDING, DERIVED. Not one field of it comes from the record.
    const expectedBinding = {
      domain: COMMISSION_DOMAIN,
      repository: COMMISSIONING_REPOSITORY,
      repository_id: intent ? Number(intent.repository_id) : null,
      source_mode: "commission",
      original_run_id: String(runId),
      original_attempt: String(attempt),
      workflow_path: COMMISSIONING_WORKFLOW_PATH,
      source_sha: intent ? String(intent.workflow_sha) : null,
      role: String(role),
      job_id: assertRoleBinding(role).job,
      case_id: String(kase.id),
      case_ordinal: caseOrdinal(role, kase.id),
      direction,
      target_ref: derivedRef(runId, attempt, kase.ref),
      intended_app_id: Number.isInteger(intendedAppId) ? intendedAppId : null,
      intended_installation_id: POSITIVE_DECIMAL.test(plannedInstallation) ? plannedInstallation : null,
      manifest_sha256: manifestDigest,
      graph_sha256: graphDigest,
    };
    try {
      // AT THE HISTORICAL RECEIPT. No wall clock, and no substituted creation time.
      assertResponseBinding(response, {
        challenge, challengeDigest: String(digest), expectedBinding,
        receivedAt: String(receivedAt),
      });
    } catch (error) {
      problems.push(`${direction} response does not re-bind to the challenge this assessor derives (${error instanceof Error ? error.message : String(error)})`);
    }
    // THE PUBLISHER'S PROVENANCE, re-derived from the retained facts.
    if (!facts || typeof facts !== "object") {
      problems.push(`retains no ${direction} publisher artifact/run/job facts, so its provenance cannot be re-derived`);
    } else {
      try {
        const provenance = assertPublisherArtifactProvenance({
          artifact: facts.artifact, run: facts.run, jobs: facts.jobs,
          expected: { workflowPath: COMMISSIONING_WORKFLOW_PATH, sourceSha: intent ? String(intent.workflow_sha) : null },
        });
        if (positiveProviderId(witness[`${direction}_publisher_run_id`]) !== provenance.publisher_run_id) {
          problems.push(`records a ${direction} publisher run that is not the one its retained provenance facts establish`);
        }
        if (positiveProviderId(witness[`${direction}_artifact`]?.artifact_id) !== provenance.artifact_id) {
          problems.push(`records a ${direction} artifact identity that is not the one its retained provenance facts establish`);
        }
      } catch (error) {
        problems.push(`${direction} publisher provenance does not re-derive (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    // THE CHALLENGE LIFETIME, exactly the fixed TTL, and the response inside it.
    const created = Date.parse(String(challenge.created_at));
    const expires = Date.parse(String(challenge.expires_at));
    if (!Number.isFinite(created) || !Number.isFinite(expires)) problems.push(`carries no parseable ${direction} challenge lifetime`);
    else if (expires - created !== CHALLENGE_TTL_MS) problems.push(`records a ${direction} challenge lifetime of ${expires - created}ms rather than the fixed ${CHALLENGE_TTL_MS}ms`);
    if (String(witness[`${direction}_challenge_created_at`] ?? "") !== String(challenge.created_at)) {
      problems.push(`records a ${direction} challenge creation time that is not the retained challenge's own`);
    }
  }

  // ── THE TIMINGS, RECOMPUTED FROM THE FACTS ──────────────────────────────────────────────────────
  const preObservation = witness.pre_observation ?? witness.pre_response?.observation ?? null;
  const postObservation = witness.post_observation ?? witness.post_response?.observation ?? null;
  const mutationStartedAt = Date.parse(String(record?.mutation_started_at ?? ""));
  const readbackAt = Date.parse(String(record?.readback_at ?? ""));
  if (!Number.isFinite(mutationStartedAt)) problems.push("carries no parseable mutation start time");
  if (!Number.isFinite(readbackAt)) problems.push("carries no parseable readback time");
  if (Number.isFinite(mutationStartedAt) && Number.isFinite(readbackAt) && readbackAt < mutationStartedAt) {
    problems.push("records a readback that happened before the mutation it reads back; the ordering is impossible");
  }
  if (preObservation && Number.isFinite(mutationStartedAt)) {
    const observed = Date.parse(String(preObservation.completed_at));
    if (!Number.isFinite(observed)) problems.push("carries no parseable pre-observation completion time");
    else {
      const recomputed = mutationStartedAt - observed;
      if (recomputed < 0) problems.push("mutated before the pre-witness observation it depends on completed; the ordering is impossible");
      else if (recomputed > MAX_OBSERVATION_TO_MUTATION_MS) problems.push(`mutated ${recomputed}ms after its pre-observation, beyond the ${MAX_OBSERVATION_TO_MUTATION_MS}ms bound`);
      if (Number(witness.pre_to_mutation_ms) !== recomputed) {
        problems.push(`declares a pre-to-mutation interval of ${JSON.stringify(witness.pre_to_mutation_ms ?? null)}ms; its own retained facts give ${recomputed}ms`);
      }
    }
    // The challenge that authorised the mutation must still have been alive when it was issued.
    const preExpiry = Date.parse(String(witness.pre_challenge?.expires_at ?? ""));
    if (Number.isFinite(preExpiry) && mutationStartedAt > preExpiry) {
      problems.push("mutated after its pre-witness challenge had expired; the expiry is never extended");
    }
  }
  if (postObservation && Number.isFinite(readbackAt)) {
    const started = Date.parse(String(postObservation.started_at));
    if (!Number.isFinite(started)) problems.push("carries no parseable post-observation start time");
    else {
      const recomputed = started - readbackAt;
      if (recomputed < 0) problems.push("observed its post-witness policy before the readback it is bound to; the ordering is impossible");
      else if (recomputed > MAX_OBSERVATION_TO_MUTATION_MS) problems.push(`observed its post-witness policy ${recomputed}ms after its readback, beyond the ${MAX_OBSERVATION_TO_MUTATION_MS}ms bound`);
      if (Number(witness.readback_to_post_ms) !== recomputed) {
        problems.push(`declares a readback-to-post interval of ${JSON.stringify(witness.readback_to_post_ms ?? null)}ms; its own retained facts give ${recomputed}ms`);
      }
    }
  }
  // The post challenge is created AT the readback, by construction.
  if (witness.post_challenge_created_at !== undefined && record?.readback_at !== undefined
    && String(witness.post_challenge_created_at) !== String(record.readback_at)) {
    problems.push("records a post-challenge creation time that is not its own measured readback instant");
  }
  // The post challenge published the request's status AND completion (R02-1). A record that now
  // claims a different status or a completion the published challenge did not is a restamped result.
  const postChallenge = witness.post_challenge;
  if (postChallenge && typeof postChallenge === "object") {
    if (Number(postChallenge.request_status) !== Number(record?.http_status)) {
      problems.push("records a request status that is not the one its published post challenge carried");
    }
    if (postChallenge.request_complete !== (record?.response_complete === true)) {
      problems.push("records a response completion that is not the one its published post challenge carried");
    }
  }
  return problems;
}

export function assessEvidence({ dir, runId, attempt, now = () => new Date() }) {
  const blockers = [];
  const block = (gate, kind, detail) => { blockers.push({ gate, kind, detail }); };
  let journalRecords = null;
  let journalError = null;
  try { journalRecords = readJournal({ dir, runId, attempt }); }
  catch (error) { journalError = error instanceof Error ? error.message : String(error); }
  if (journalError) block("PC-07", "failed", `the local journal chain does not verify: ${journalError}`);
  else if (!journalRecords.length) block("PC-07", "unverified", "the local journal is empty; no local phase has run");

  /**
   * ── THE SECOND HASH-CHAINED JOURNAL, VERIFIED (F2) ────────────────────────────────────────────
   *
   * The assessor read only the RESOURCE journal. The witness process keeps its own separate
   * append-only chain — the challenges it observed, the dispatches it made, the publications it
   * reconciled — and removing that file entirely produced no blocker whatsoever: the whole
   * transport half of the evidence could simply be absent and the packet still passed. Both chains
   * bind the same immutable source and the same manifest, which is exactly what makes the join
   * below possible, so both are verified here and a missing one blocks.
   */
  let witnessRecords = null;
  let witnessJournalError = null;
  try { witnessRecords = readJournal({ dir, runId, attempt, kind: "witness" }); }
  catch (error) { witnessJournalError = error instanceof Error ? error.message : String(error); }
  if (witnessJournalError) block("PC-04", "failed", `the local witness journal chain does not verify: ${witnessJournalError}`);
  else if (!witnessRecords.length) block("PC-04", "unverified", "the separate witness journal is absent or empty; the witness transport's own record of what it observed, dispatched and reconciled is missing");

  /**
   * THIS RUN'S WINDOW, from the verified journal's own first record.
   *
   * It exists so a manual environment observation has to have been captured DURING this run. The
   * independent review's packet dated every control 2020 and was accepted; a capture time that
   * predates the run is a historical observation, and a historical observation is not this run's
   * evidence no matter how correctly it is hashed.
   */
  /**
   * ── THIS RUN'S WINDOW, WITH BOTH ENDS (root's clock qualification) ────────────────────────────
   *
   * It had only a START, so a control captured in 2099 was "not before the run opened" and passed.
   * The retained reviewer packet dated every control 2099 and was accepted, and that is evidence of
   * the defect rather than a baseline to keep. A capture AFTER the run it claims to describe is
   * exactly as unmoored as one before it, and the canonical forbids future and impossible ordering
   * outright, so the window closes at the moment of assessment.
   */
  const assessedAt = now().toISOString();
  const runWindow = journalRecords?.length ? { start: String(journalRecords[0].ts), end: assessedAt } : null;

  // The immutable source every file must agree about. Taken from the INTENT, which is the first
  // artifact in the chain, and re-measured against the provider by setup.
  const intentRaw = readEvidenceFile(dir, evidenceSlug(runId, attempt, "intent"));
  const workflowSha = FULL_SHA.test(String(intentRaw?.workflow_sha ?? "")) ? String(intentRaw.workflow_sha) : null;
  const workflowShaFromIntent = workflowSha;

  /**
   * BOTH CHAINS ARE BOUND TO THE IMMUTABLE SOURCE (F2, corrected).
   *
   * `openJournal` writes a `source` into every record, and nothing read it. So a witness chain
   * rebuilt under a source this run never ran verified perfectly — the hash links were genuine — and
   * produced no blocker. The chain's integrity was never the question; whose evidence it is was.
   */
  for (const [label, records, gate] of [["resource", journalRecords, "PC-07"], ["witness", witnessRecords, "PC-04"]]) {
    if (!records?.length || !workflowShaFromIntent) continue;
    const foreign = records.filter((record) => String(record.source) !== String(workflowShaFromIntent));
    if (foreign.length) {
      block(gate, "invalid", `${foreign.length} record(s) in the ${label} journal were written against a different immutable source than this run's`);
    }
  }

  const files = {};
  for (const entry of EVIDENCE_MANIFEST) {
    const payload = readEvidenceFile(dir, evidenceSlug(runId, attempt, entry.key));
    if (!payload) {
      block(entry.gate, "unverified", `the ${EVIDENCE_KEYS[entry.key]} evidence file is absent`);
      files[entry.key] = null;
      continue;
    }
    const problem = validateEvidenceBinding(payload, { runId, attempt, phase: entry.phase, required: entry.required, workflowSha });
    if (problem) {
      block(entry.gate, "invalid", `the ${EVIDENCE_KEYS[entry.key]} evidence file ${problem}`);
      files[entry.key] = null;
      continue;
    }
    files[entry.key] = payload;
  }
  if (!workflowSha) block("PC-03", "unverified", "no intent evidence carries this run's immutable workflow SHA, so no file can be bound to it");

  if (files.intent && files.intent.provider_measured !== false) {
    block("PC-03", "invalid", "the intent evidence claims a provider measurement the credential-free intent phase does not make");
  }

  /**
   * THE FROZEN SYNTHETIC GRAPH, from the VERIFIED JOURNAL (F3/F4).
   *
   * The journal is the authority here, not the setup file: the chain is hash-linked and append-only,
   * and the setup file is just a file. The setup file's own copy is then required to AGREE, and its
   * `graph_sha256` is recomputed rather than believed — a digest a packet supplies about itself is
   * not a check on that packet.
   */
  const journalGraph = journalRecords
    ? Object.fromEntries(journalRecords.filter((r) => r.type === "resource-created" && r.data?.kind === "commit").map((r) => [String(r.data.node), String(r.data.sha)]))
    : {};
  let graph = null;
  if (Object.keys(journalGraph).length) {
    graph = journalGraph;
    const plan = buildGraphPlan(runId, attempt);
    const missing = plan.filter((node) => !FULL_SHA.test(String(journalGraph[node.key] ?? ""))).map((node) => node.key);
    if (missing.length) block("PC-03", "unverified", `the journal records no synthetic commit for node(s) ${missing.join(", ")}`);
  } else {
    block("PC-03", "unverified", "the verified journal records no synthetic commit graph, so no case's identities can be bound to one");
  }

  if (files.setup) {
    // The graph and manifest digests, RECOMPUTED. A packet that carries a graph and a digest which
    // do not describe each other is internally inconsistent, and the previous gate read neither.
    if (canonicalJson(files.setup.synthetic_graph ?? null) !== canonicalJson(graph)) {
      block("PC-03", "invalid", "the setup evidence's synthetic graph is not the one the verified journal records this run creating");
    }
    if (graph && String(files.setup.graph_sha256 ?? "") !== graphBindingDigest(graph, runId, attempt)) {
      block("PC-03", "invalid", "the setup evidence's graph digest does not describe the graph it carries");
    }
    if (!SHA256_HEX.test(String(files.setup.manifest_sha256 ?? ""))) {
      block("PC-03", "invalid", "the setup evidence carries no manifest digest for the cloud challenges to bind against");
    }
    /**
     * THE MANIFEST, RECOMPUTED AND THEN RECONSTRUCTED.
     *
     * First its digest must describe the manifest it carries — which alone defeats a fabricated
     * digest, however consistently propagated. Then the manifest itself is rebuilt from the verified
     * journal's graph, this build's derivations and the private inputs' identities, so the object
     * cannot be fabricated to match a digest either.
     */
    if (canonicalJson(files.setup.manifest ?? null) === canonicalJson(null)) {
      block("PC-03", "invalid", "the setup evidence retains no manifest, so its digest cannot be recomputed");
    } else if (canonicalHash(files.setup.manifest) !== String(files.setup.manifest_sha256 ?? "")) {
      block("PC-03", "invalid", "the setup evidence's manifest digest does not describe the manifest it carries");
    } else if (graph && files["production-inputs"] && files.intent) {
      const rebuilt = buildManifest({
        runId, attempt, workflowSha: String(files.intent.workflow_sha), repositoryId: Number(files.intent.repository_id),
        normalAppId: Number(files["production-inputs"].normal_app_id),
        emergencyAppId: Number(files["production-inputs"].emergency_app_id),
        graphShas: graph, contextNames: derivedContextNames(runId, attempt),
        rulesetPlan: Object.fromEntries(["normal", "emergency", "human"].map((actor) => [actor,
          expectedDisposableRulesets({
            runId, attempt, actor,
            normalAppId: Number(files["production-inputs"].normal_app_id),
            emergencyAppId: Number(files["production-inputs"].emergency_app_id),
          }).map((ruleset) => ({ name: ruleset.name, target_ref: ruleset.conditions.ref_name.include[0], hash: canonicalHash(ruleset) })),
        ])),
        productionPolicyHash: String(files["production-inputs"].production_policy_hash),
      });
      if (canonicalHash(rebuilt) !== String(files.setup.manifest_sha256)) {
        block("PC-03", "invalid", "the setup evidence's manifest is not the one this run's authoritative inputs reconstruct");
      }
    }
    // The OPERATOR, by numeric identity (F6).
    const operator = files.setup.operator;
    if (Number(operator?.id) !== OWNER_USER_ID || String(operator?.login) !== OWNER_LOGIN || String(operator?.permission) !== "admin") {
      block("PC-02", "failed", `the setup evidence records the operator ${JSON.stringify(String(operator?.login ?? ""))} (#${operator?.id ?? "unmeasured"}), not the one authorized administrator`);
    }
    /**
     * ── THE PRODUCTION SUBJECT, REGENERATED FROM PRIVATE RETAINED INPUTS (PC-04, corrected) ──────
     *
     * This gate was `!== ""`, so `production_policy_hash: "invalid"` passed; and the manifest digest
     * was only SHA-shaped, so a fabricated one propagated consistently through the actor and case
     * files passed too. Neither could be better, because the producer map is deliberately not
     * published and the assessor had nothing to regenerate the subject FROM.
     *
     * Now it does. The private mode-0600 production-inputs file carries the exact validated map and
     * the raw `buildMainRulesets` output; its digest is anchored in the hash-linked journal; and
     * everything downstream — the raw subject, the policy hash, the disposable plan and the whole
     * manifest — is recomputed here. The setup file's declarations are OUTPUTS TO VERIFY.
     */
    const privateInputs = files["production-inputs"];
    if (!privateInputs) {
      block("PC-04", "unverified", "this run retains no private production-input record, so its production subject, policy hash and manifest cannot be independently reconstructed");
    } else {
      const bound = journalRecords?.find((record) => record.type === "production-inputs-bound")?.data ?? null;
      if (!bound) block("PC-04", "unverified", "the verified journal records no binding for the private production inputs");
      else if (String(bound.production_inputs_sha256) !== canonicalHash(privateInputs)) {
        block("PC-04", "invalid", "the private production-input record is not the one this run's verified journal bound at setup");
      }
      if (files.intent && String(privateInputs.producer_ids_hash ?? "") !== String(files.intent.producer_ids_hash ?? "")) {
        block("PC-04", "invalid", "the private production inputs carry a producer map whose digest is not the one the immutable intent measured");
      }
      const producerIds = privateInputs.producer_ids;
      const contextKeys = producerIds && typeof producerIds === "object" && !Array.isArray(producerIds) ? Object.keys(producerIds).sort() : null;
      if (!contextKeys || canonicalJson(contextKeys) !== canonicalJson([...REQUIRED_MAIN_CONTEXTS].sort())) {
        block("PC-04", "invalid", "the private production inputs do not carry exactly this build's required production contexts");
      } else if (Object.values(producerIds).some((value) => positiveProviderId(value) === null)) {
        block("PC-04", "invalid", "the private production inputs carry a producer identity that is not a positive integer");
      } else if (canonicalHash(producerIds) !== String(privateInputs.producer_ids_hash ?? "")) {
        block("PC-04", "invalid", "the private production inputs' own producer-map digest does not describe the map they carry");
      } else {
        // REGENERATED, not compared. This is the whole point of retaining the inputs.
        let regenerated = null;
        try {
          regenerated = buildMainRulesets({
            normalAppId: Number(privateInputs.normal_app_id),
            emergencyAppId: Number(privateInputs.emergency_app_id),
            producerIds,
          });
        } catch (error) {
          block("PC-04", "invalid", `the private production inputs do not regenerate a production policy (${error instanceof Error ? error.message : String(error)})`);
        }
        if (regenerated) {
          if (canonicalJson(regenerated) !== canonicalJson(privateInputs.production_rulesets)) {
            block("PC-04", "invalid", "the retained raw production subject is not the one its own inputs regenerate");
          }
          const regeneratedHash = canonicalHash(regenerated);
          if (String(privateInputs.production_policy_hash ?? "") !== regeneratedHash) {
            block("PC-04", "invalid", "the private production inputs' policy hash does not describe the subject they regenerate");
          }
          if (String(files.setup.production_policy_hash ?? "") !== regeneratedHash) {
            block("PC-04", "invalid", `the setup evidence declares a production-policy hash the retained private inputs do not produce`);
          }
        }
      }
      if (files.intent) {
        for (const [field, label] of [["normal_app_id", "normal App"], ["emergency_app_id", "emergency App"], ["normal_installation_id", "planned normal installation"], ["emergency_installation_id", "planned emergency installation"]]) {
          if (String(privateInputs[field] ?? "") !== String(files.intent[field] ?? "")) {
            block("PC-04", "invalid", `the private production inputs name a ${label} identity the immutable intent did not configure`);
          }
        }
      }
    }
    // COMPLETE RESOURCE ACCOUNTING: every resource the journal records, present in the setup file.
    if (journalRecords?.length) {
      const owned = journalRecords.filter((r) => r.type === "resource-created").map((r) => r.data);
      const journaledRulesets = owned.filter((entry) => entry?.kind === "ruleset").map((entry) => Number(entry.id)).sort((a, b) => a - b);
      const reportedRulesets = Object.values(files.setup.disposable_rulesets ?? {}).flat().map((entry) => Number(entry?.id)).sort((a, b) => a - b);
      if (canonicalJson(journaledRulesets) !== canonicalJson(reportedRulesets)) {
        block("PC-03", "invalid", `the setup evidence reports ${reportedRulesets.length} disposable ruleset(s); the verified journal records ${journaledRulesets.length}`);
      }
      const journaledRefs = owned.filter((entry) => entry?.kind === "ref").map((entry) => String(entry.ref)).sort();
      const reportedRefs = Object.values(files.setup.derived_refs ?? {}).map((entry) => String(entry?.ref ?? "")).sort();
      if (canonicalJson(journaledRefs) !== canonicalJson(reportedRefs)) {
        block("PC-03", "invalid", "the setup evidence's derived refs are not the ones the verified journal records this run creating");
      }
      if (!journaledRulesets.length) block("PC-03", "unverified", "the verified journal records no disposable ruleset, so no case ran against a measured policy");
      // Every disposable ruleset must have a measured provider-shape fingerprint (F5).
      const fingerprinted = new Set(journalRecords.filter((r) => r.type === "resource-fingerprinted").map((r) => String(r.data?.key)));
      const unfingerprinted = owned.filter((entry) => entry?.kind === "ruleset" && !fingerprinted.has(String(entry.name)));
      if (unfingerprinted.length) {
        block("PC-07", "unverified", `${unfingerprinted.length} journaled ruleset(s) have no measured provider-shape fingerprint, so their ownership cannot be re-proved`);
      }
      // UNRESOLVED CREATE INTENTS (F5). A packet cannot be complete while the journal holds a create
      // whose outcome nobody established.
      const unresolved = blockingCreateIntents(journalRecords);
      if (unresolved.length) block("PC-07", "unverified", `${unresolved.length} create intent(s) in the verified journal have no result and no reconciliation`);
      if (Number(files.setup.unresolved_intents ?? -1) !== unresolved.length) {
        block("PC-07", "invalid", "the setup evidence's unresolved-intent count is not the one the verified journal supports");
      }
    }
    // Because intent measures nothing, THIS is where the run's identity was checked against the
    // provider. A setup file without it is not a pass with a caveat; it is an unproved identity.
    /**
     * THE PROVIDER RE-MEASUREMENT, AS A COMPLETE RECORD (F2, corrected).
     *
     * This read one boolean, so `intent_remeasured: {confirmed: true}` satisfied the one gate where
     * the run's identity is actually checked against the provider. The re-measurement is the
     * substance; `confirmed` is its label.
     */
    const remeasured = files.setup.intent_remeasured;
    if (!remeasured || typeof remeasured !== "object" || remeasured.confirmed !== true) {
      block("PC-03", "unverified", "the setup evidence does not record a provider re-measurement of the credential-free intent's identity claims");
    } else {
      const expectedRemeasurement = files.intent ? {
        measured_repository_id: Number(files.intent.repository_id),
        measured_head_sha: String(files.intent.workflow_sha),
        measured_workflow_path: COMMISSIONING_WORKFLOW_PATH,
        measured_event: COMMISSIONING_EVENT_NAME,
        measured_head_branch: branchOf(COMMISSIONING_DISPATCH_REF),
      } : null;
      if (expectedRemeasurement) {
        for (const [field, wanted] of Object.entries(expectedRemeasurement)) {
          if (String(remeasured[field] ?? "") !== String(wanted)) {
            block("PC-03", "invalid", `the setup evidence's provider re-measurement records ${field} as ${JSON.stringify(remeasured[field] ?? null)}, not the ${JSON.stringify(wanted)} this run is bound to`);
          }
        }
      }
      if (remeasured.matches_intent !== true) block("PC-03", "invalid", "the setup evidence's provider re-measurement does not state that it matches the immutable intent");
    }
    /**
     * THE PROTECTED JOBS AT SETUP, AS A MEASUREMENT.
     *
     * `protected_jobs_at_setup: {}` satisfied every gate by having nothing to object to. The closed
     * expectation is one entry per protected job, each in a state the run could legally be in.
     */
    const parked = files.setup.protected_jobs_at_setup;
    const parkedStates = [...PARKED_JOB_STATUSES, "uncreated"];
    if (!parked || typeof parked !== "object" || Array.isArray(parked)) {
      block("PC-03", "invalid", "the setup evidence carries no protected-job snapshot");
    } else {
      for (const spec of PROTECTED_JOBS) {
        const state = String(parked[spec.id] ?? "");
        if (!state) block("PC-03", "unverified", `the setup evidence records no state for the ${spec.id} protected job`);
        else if (!parkedStates.includes(state)) {
          block("PC-03", "failed", `the setup evidence records the ${spec.id} protected job as ${JSON.stringify(state)}, which is not a state it could legally be in when setup ran`);
        }
      }
      const unknownJobs = Object.keys(parked).filter((id) => !PROTECTED_JOBS.some((spec) => spec.id === id));
      if (unknownJobs.length) block("PC-03", "invalid", `the setup evidence's protected-job snapshot names ${unknownJobs.length} job(s) outside this workflow's two`);
    }
    // EXACTLY the three actors, each compatible. A compatibility map with no entries used to pass
    // this gate by iterating nothing.
    const actors = ["normal", "emergency", "human"];
    const measuredActors = Object.keys(files.setup.compatibility ?? {}).sort();
    if (canonicalJson(measuredActors) !== canonicalJson([...actors].sort())) {
      block("PC-04", "invalid", `the setup evidence reports compatibility for ${measuredActors.length} actor(s), not the three this run transforms`);
    }
    for (const actor of actors) {
      const value = (files.setup.compatibility ?? {})[actor];
      if (!value || typeof value !== "object") { block("PC-04", "invalid", `the ${actor} compatibility entry is not a verdict record`); continue; }
      if (value.verdict === "compatible") continue;
      block("PC-04", value.verdict === "measurement-incomplete" ? "unverified" : "failed", `the ${actor} disposable policy is ${value.verdict ?? "unreported"}${value.gap ? ` (${value.gap} gap)` : ""}`);
    }
    const preApproval = files.setup.approval_history_before_approval;
    if (preApproval?.measured !== true) block("PC-06", "unverified", "the pre-approval snapshot was not measured, so a later approval cannot be shown to postdate the plan");
    else if ((preApproval.entries ?? []).some((entry) => entry.state === "approved")) {
      block("PC-06", "failed", "a protected environment was already approved before setup published the plan");
    }
  }

  // PC-04's grant gate, per protected role: the MEASURED object, compared against the closed set —
  // AND against the immutable intent's two App identities, which must be distinct (F6).
  //
  // The previous gate compared each actor's App ID only with its OWN grant object, so a packet naming
  // the same unrelated App for both actors agreed with itself perfectly and passed. "Internally
  // consistent" is not "the identity this run was configured for".
  const intendedApps = files.intent
    ? { normal: Number(files.intent.normal_app_id), emergency: Number(files.intent.emergency_app_id) }
    : null;
  if (intendedApps && (!Number.isInteger(intendedApps.normal) || !Number.isInteger(intendedApps.emergency))) {
    block("PC-04", "invalid", "the intent evidence carries no numeric normal and emergency App identities");
  } else if (intendedApps && intendedApps.normal === intendedApps.emergency) {
    block("PC-04", "failed", "the intent evidence names the SAME App as both the normal and the emergency identity; the two release identities must be distinct");
  }
  const observedApps = {};
  for (const role of ["normal", "emergency"]) {
    if (!files[role]) continue;
    const grants = files[role].actor?.grants;
    if (!grants || typeof grants !== "object" || grants.measured !== true) {
      block("PC-04", "unverified", `the ${role} actor evidence records no measured App grant set`);
      continue;
    }
    observedApps[role] = Number(grants.app_id);
    if (Number(grants.app_id) !== Number(files[role].actor?.app_id) || Number(grants.installation_app_id) !== Number(grants.app_id)) {
      block("PC-04", "invalid", `the ${role} actor evidence's measured App identity does not agree with itself`);
    }
    if (intendedApps && Number(grants.app_id) !== intendedApps[role]) {
      block("PC-04", "failed", `the ${role} actor evidence measured App ${Number(grants.app_id)}, not the ${intendedApps[role]} this run's immutable intent configured`);
    }
    if (grants.repository_selection !== "selected" || grants.suspended !== false) {
      block("PC-04", "failed", `the ${role} App's installation is not a live selected-repository installation`);
    }
    if (!POSITIVE_DECIMAL.test(String(grants.installation_id ?? ""))) {
      block("PC-04", "invalid", `the ${role} actor evidence records no numeric installation identity`);
    }
    const comparison = comparePermissions(grants.installation_permissions, ROLE_APP_PERMISSIONS[role]);
    if (!comparison.ok) {
      block("PC-04", "failed", `the ${role} App's measured grants are not the closed set (unexpected: ${comparison.unexpected.join(", ") || "none"}; missing: ${comparison.missing.join(", ") || "none"})`);
    }
    if (canonicalJson(grants.expected_permissions ?? null) !== canonicalJson(ROLE_APP_PERMISSIONS[role])) {
      block("PC-04", "invalid", `the ${role} actor evidence was measured against a different expected permission set than this build declares`);
    }
  }
  if (Number.isInteger(observedApps.normal) && observedApps.normal === observedApps.emergency) {
    block("PC-04", "failed", `both actor files measured App ${observedApps.normal}; the normal and emergency identities must be distinct`);
  }
  if (Number.isInteger(observedApps.normal) && Number.isInteger(observedApps.emergency)
    && files.normal && files.emergency
    && String(files.normal.actor?.installation?.repository_full_name ?? COMMISSIONING_REPOSITORY) !== COMMISSIONING_REPOSITORY) {
    block("PC-04", "failed", "the normal actor's installation does not report this commissioning repository as its sole scope");
  }

  // PC-04's POLICY verdict, per protected role. The previous gate never read this field at all, so a
  // packet whose `policy_in_force.verdict` was `mismatch` contributed zero blockers.
  for (const role of ["normal", "emergency"]) {
    if (!files[role]) continue;
    const policy = files[role].policy_in_force;
    if (!policy || typeof policy !== "object") { block("PC-04", "unverified", `the ${role} actor evidence records no policy-in-force measurement`); continue; }
    if (String(policy.verdict) !== "compatible") {
      block("PC-04", String(policy.verdict) === "measurement-incomplete" ? "unverified" : "failed",
        `the ${role} actor ran against a policy recorded as ${JSON.stringify(String(policy.verdict ?? "unreported"))}${policy.gap ? ` (${policy.gap} gap)` : ""}`);
    }
    if (!SHA256_HEX.test(String(policy.governed_fingerprint ?? ""))) {
      block("PC-04", "invalid", `the ${role} actor evidence's policy measurement carries no complete governed fingerprint`);
    }
    // The guarantee, stated. A packet that upgraded the claim to an atomic one is refused.
    if (!/NOT an atomic policy-at-mutation proof/.test(String(policy.guarantee ?? ""))) {
      block("PC-04", "invalid", `the ${role} actor evidence's policy measurement does not carry the bounded pre/post guarantee it is limited to`);
    }
  }

  // The NORMAL role's installation-level positive control, and its exact producers and SHAs (F4).
  if (files.normal) {
    const publication = files.normal.check_publication;
    if (!publication || typeof publication !== "object") block("PC-05", "unverified", "the normal actor evidence records no TEST-ONLY check publication, so its installation-level positive control is unestablished");
    else {
      const producers = Array.isArray(publication.measured_producer_app_ids) ? publication.measured_producer_app_ids.map(Number) : [];
      if (!producers.length) block("PC-05", "unverified", "the normal check publication records no measured producer identity");
      else if (intendedApps && !producers.includes(intendedApps.normal)) {
        block("PC-05", "failed", `the normal check publication was attributed to producer(s) ${producers.join(", ")}, not the intended normal App ${intendedApps.normal}`);
      }
      const published = Array.isArray(publication.published) ? publication.published : [];
      if (!published.length) block("PC-05", "unverified", "the normal check publication records no published checks");
      else if (graph) {
        const known = new Set(Object.values(graph));
        const foreign = published.filter((entry) => !known.has(String(entry?.head_sha)));
        if (foreign.length) block("PC-05", "failed", `${foreign.length} TEST-ONLY check(s) were published on commits the verified journal does not record this run creating`);
      }
      const positive = files.normal.actor?.positive_control;
      if (positive?.established !== true) block("PC-05", "unverified", "the normal actor evidence does not record its installation-level positive-write liveness as established in this attempt");
    }
  }

  /**
   * ── THE WITNESS TRANSPORT, JOINED ACROSS ALL FOUR SOURCES (F1/F2) ─────────────────────────────
   *
   * The previous checks here counted unique IDs, validated digest SYNTAX, and compared totals. All
   * of that is satisfied by a packet whose publication case IDs are invented unique names, whose
   * publisher-run identities are absent, whose per-case artifacts are unrelated numbers with the
   * entry digests removed, and whose separate witness journal does not exist — and every one of
   * those independent mutations returned `blockers: []`.
   *
   * So the exact ELEVEN cloud cases × TWO directions are joined, by name, across the four things
   * that must agree about them: the immutable intent's derived plan, the actor job's own consumed
   * evidence, the verified resource journal's synthetic graph, and the verified witness journal's
   * observed challenges and reconciled publications. A publication that is not one of the closed
   * 22 is an invented case; a case whose artifact the witness journal does not record is a claim
   * with no counterparty.
   */
  const expectedPublicationKeys = witnessWorkPlan(COMMISSION_DOMAIN).map((entry) => `${entry.caseId}:${entry.direction}`);
  /** The three witness-chain facts each case/direction is joined against, in one place. */
  const witnessTransportHistory = new Map();
  /** The witness journal's own record of what it observed and what it reconciled. */
  const witnessObserved = new Map();
  const witnessReconciled = new Map();
  /** The DISPATCH the published bytes must join back to — the other half of the transport. */
  const witnessDispatched = new Map();
  /** Every witness-journal event, counted per case/direction, so a MISSING one is visible. */
  const witnessHistory = new Map();
  for (const record of witnessRecords ?? []) {
    const key = `${String(record.data?.case_id)}:${String(record.data?.direction)}`;
    if (record.type === "challenge-observed") witnessObserved.set(key, record.data);
    if (record.type === "response-reconciled") witnessReconciled.set(key, record.data);
    if (record.type === "dispatch-intent") witnessDispatched.set(key, record.data);
    if (!witnessHistory.has(key)) witnessHistory.set(key, {});
    const counts = witnessHistory.get(key);
    counts[record.type] = Number(counts[record.type] ?? 0) + 1;
  }
  /**
   * ── THE COMPLETE ONE-USE HISTORY (F2, corrected) ──────────────────────────────────────────────
   *
   * A reconciled publication was never required to have a DISPATCH behind it, so a chain with every
   * `dispatch-intent` and `dispatch-result` removed — rebuilt so the hash links still verified —
   * produced no blocker. A publication with no recorded dispatch has no counterparty: the nonce it
   * answers was never sent by this process, which is the one thing the witness journal exists to
   * record. Each of the closed 22 needs exactly one of each event, and every nonce is used once.
   */
  if (witnessRecords?.length) {
    const nonceDigests = [];
    for (const key of witnessWorkPlan(COMMISSION_DOMAIN).map((entry) => `${entry.caseId}:${entry.direction}`)) {
      const counts = witnessHistory.get(key) ?? {};
      /**
       * EXACTLY ONE OF EACH. Not presence, and not "once-only for the dispatch".
       *
       * ⚠️ I relaxed this to presence-only because the producer appended twice, and that was the
       * wrong repair: the duplicate came from four UNCONDITIONAL append sites in the production
       * witness path, so weakening the count made a real lifecycle defect invisible instead of
       * fixing it. The producer now makes a validated once-only transition
       * ({@link recordWitnessEventOnce}), and this stays exact — zero has no counterparty, and two
       * is an ambiguous history that cannot be resolved into one publication.
       */
      for (const type of ["challenge-observed", "dispatch-intent", "dispatch-result", "response-reconciled"]) {
        const seen = Number(counts[type] ?? 0);
        if (seen === 0) {
          block("PC-04", "unverified", `the verified witness journal records no ${type} for ${key}; its publication has no counterparty in the process that served it`);
        } else if (seen > 1) {
          block("PC-04", "invalid", `the verified witness journal records ${seen} ${type} events for ${key}; each is once-only and a duplicated history cannot be resolved into one publication`);
        }
      }
      const observed = witnessObserved.get(key);
      if (observed && SHA256_HEX.test(String(observed.nonce_digest ?? ""))) nonceDigests.push(String(observed.nonce_digest));
    }
    if (new Set(nonceDigests).size !== nonceDigests.length) {
      block("PC-04", "invalid", "the verified witness journal observes the same nonce for more than one case or direction; every witness nonce is used once");
    }
  }

  for (const key of new Set([...witnessObserved.keys(), ...witnessReconciled.keys(), ...witnessDispatched.keys()])) {
    witnessTransportHistory.set(key, {
      observed: witnessObserved.get(key) ?? null,
      reconciled: witnessReconciled.get(key) ?? null,
      dispatchIntent: witnessDispatched.get(key) ?? null,
    });
  }

  if (files["witness-process"]) {
    const witness = files["witness-process"];
    if (String(witness.domain) !== COMMISSION_DOMAIN) {
      block("PC-04", "invalid", `the witness evidence records the ${JSON.stringify(String(witness.domain ?? ""))} domain; a rehearsal response cannot contribute to a commissioning attempt`);
    }
    const publications = Array.isArray(witness.publications) ? witness.publications : [];
    if (Number(witness.expected_publications) !== REQUIRED_WITNESS_PUBLICATIONS) {
      block("PC-04", "invalid", `the witness evidence expected ${witness.expected_publications} publications; this build requires exactly ${REQUIRED_WITNESS_PUBLICATIONS}`);
    }
    // THE EXACT CLOSED SET, not a count of distinct strings.
    const keys = publications.map((entry) => `${String(entry?.case_id)}:${String(entry?.direction)}`);
    const missingKeys = expectedPublicationKeys.filter((key) => !keys.includes(key));
    const inventedKeys = keys.filter((key) => !expectedPublicationKeys.includes(key));
    if (new Set(keys).size !== keys.length) block("PC-04", "invalid", "the witness evidence records duplicate case/direction publications");
    if (missingKeys.length) {
      block("PC-04", "unverified", `${missingKeys.length} of the required ${REQUIRED_WITNESS_PUBLICATIONS} case/direction publications are missing (${missingKeys.slice(0, 4).join(", ")}${missingKeys.length > 4 ? ", …" : ""})`);
    }
    if (inventedKeys.length) {
      block("PC-04", "invalid", `the witness evidence records ${inventedKeys.length} publication(s) for case/direction pairs outside this run's closed set (${inventedKeys.slice(0, 4).join(", ")}${inventedKeys.length > 4 ? ", …" : ""})`);
    }
    const artifactIds = publications.map((entry) => positiveProviderId(entry?.artifact_id));
    if (artifactIds.some((id) => id === null)) block("PC-04", "invalid", "a witness publication carries no positive artifact identity");
    if (new Set(artifactIds).size !== artifactIds.length) block("PC-04", "invalid", "the witness evidence records the same artifact for more than one publication");
    // THE PUBLISHER RUN, per publication. Removing these was one of the independent mutations that
    // used to pass: a publication with no publisher run has no provenance to re-derive.
    const withoutPublisher = publications.filter((entry) => positiveProviderId(entry?.publisher_run_id) === null);
    if (withoutPublisher.length) {
      block("PC-04", "invalid", `${withoutPublisher.length} witness publication(s) name no publisher run identity`);
    }
    // CROSS-CHECKED AGAINST THE WITNESS JOURNAL, which is the chain that actually recorded them.
    for (const entry of publications) {
      const key = `${String(entry?.case_id)}:${String(entry?.direction)}`;
      if (!expectedPublicationKeys.includes(key)) continue;
      const journaled = witnessReconciled.get(key);
      if (!journaled) { block("PC-04", "invalid", `the witness evidence reports a publication for ${key} that its own verified journal does not record reconciling`); continue; }
      if (positiveProviderId(journaled.artifact_id) !== positiveProviderId(entry?.artifact_id)) {
        block("PC-04", "invalid", `the witness evidence's artifact for ${key} is not the one its verified journal reconciled`);
      }
    }
    const identity = witness.witness_identity;
    if (Number(identity?.user_id) !== OWNER_USER_ID || String(identity?.login) !== OWNER_LOGIN) {
      block("PC-04", "failed", "the witness evidence does not name the one authorized local measuring identity");
    }
  }

  /**
   * ── PER-CASE RECONSTRUCTION, FROM EACH ACTOR'S OWN FILE (F2) ──────────────────────────────────
   *
   * Every case, not the first one. The previous shape let the first case supply the role-level
   * grants and policy record and left every subsequent case's proof outside substantive
   * assessment — so deleting every per-case token proof, or setting every per-case policy verdict
   * to `mismatch`, changed nothing.
   */
  for (const role of ["normal", "emergency"]) {
    if (!files[role]) continue;
    const cases = Array.isArray(files[role].cases) ? files[role].cases : [];
    const nonces = [];
    const artifacts = [];
    const intendedApp = intendedApps ? intendedApps[role] : null;
    /**
     * THE ACTOR FILE'S OWN MANIFEST AND GRAPH BINDINGS, RECOMPUTED (F2).
     *
     * Replacing either with an unrelated valid-length digest was one of the independent mutations
     * that produced no blockers: the fields were REQUIRED to be present and then never compared to
     * anything. The graph digest is recomputed from the verified journal's own commits, and the
     * manifest digest must be the one this run's setup published.
     */
    if (files.setup && String(files[role].manifest_sha256 ?? "") !== String(files.setup.manifest_sha256 ?? "")) {
      block("PC-04", "invalid", `the ${role} actor evidence names a manifest digest that is not the one this run's setup published`);
    }
    if (graph && String(files[role].graph_sha256 ?? "") !== graphBindingDigest(graph, runId, attempt)) {
      block("PC-04", "invalid", `the ${role} actor evidence's graph digest does not describe the synthetic graph the verified journal records`);
    }
    for (const record of cases) {
      const caseId = String(record?.case);
      const witness = record?.witness;
      if (!witness) { block("PC-04", "unverified", `case ${caseId} records no witness binding`); continue; }

      // ── identities, positive and distinct ─────────────────────────────────────────────────────
      for (const field of ["pre_nonce_digest", "post_nonce_digest"]) {
        if (!SHA256_HEX.test(String(witness[field] ?? ""))) block("PC-04", "invalid", `case ${caseId} carries no ${field}`);
        else nonces.push(String(witness[field]));
      }
      for (const field of ["pre_artifact", "post_artifact"]) {
        const id = positiveProviderId(witness[field]?.artifact_id);
        if (id === null) block("PC-04", "invalid", `case ${caseId} carries no ${field} identity`);
        else artifacts.push(id);
      }
      // THE ENTRY DIGESTS, whose removal used to be invisible: without them the retained bytes are
      // bound to nothing.
      for (const field of ["pre_entry_digest", "post_entry_digest"]) {
        if (!SHA256_HEX.test(String(witness[field] ?? ""))) block("PC-04", "invalid", `case ${caseId} carries no ${field} for the publication it consumed`);
      }
      if (!SHA256_HEX.test(String(witness.governed_fingerprint ?? ""))) {
        block("PC-04", "invalid", `case ${caseId} carries no complete governed fingerprint for its measurement window`);
      }

      // ── the join, per direction, against the verified witness journal ─────────────────────────
      for (const [direction, artifactField] of [["pre", "pre_artifact"], ["post", "post_artifact"]]) {
        const key = `${caseId}:${direction}`;
        if (!expectedPublicationKeys.includes(key)) continue;
        const reconciled = witnessReconciled.get(key);
        const observed = witnessObserved.get(key);
        if (!reconciled) { block("PC-04", "unverified", `the verified witness journal records no reconciled ${direction} publication for case ${caseId}`); continue; }
        if (positiveProviderId(reconciled.artifact_id) !== positiveProviderId(witness[artifactField]?.artifact_id)) {
          block("PC-04", "invalid", `case ${caseId}'s ${direction} artifact is not the one the verified witness journal reconciled`);
        }
        if (!observed) block("PC-04", "unverified", `the verified witness journal records no observed ${direction} challenge for case ${caseId}`);
        else if (String(observed.nonce_digest) !== String(witness[`${direction}_nonce_digest`])) {
          block("PC-04", "invalid", `case ${caseId}'s ${direction} nonce digest is not the one the verified witness journal observed`);
        }
        if (reconciled.entry_digest !== undefined && String(reconciled.entry_digest) !== String(witness[`${direction}_entry_digest`])) {
          block("PC-04", "invalid", `case ${caseId}'s ${direction} entry digest is not the one the verified witness journal reconciled`);
        }
      }

      // ── the actual measured intervals: FINITE NUMBERS, never a coerced null ───────────────────
      for (const field of ["pre_to_mutation_ms", "readback_to_post_ms"]) {
        const problem = assessInterval(witness[field], `case ${caseId}'s ${field}`, MAX_OBSERVATION_TO_MUTATION_MS);
        if (problem) block("PC-04", "invalid", problem);
      }

      /**
       * ── THE TWO AUTHORITATIVE TRANSPORT VALIDATORS, RE-RUN (F2, corrected) ────────────────────
       *
       * Response binding and artifact provenance, on this case's RETAINED BYTES AND FACTS, against
       * an expected binding derived from the immutable intent and this build's own derivations.
       * Plus the timings recomputed from the observation and readback instants, the per-case source
       * continuity, the scoped read, and the PLANNED installation identity.
       */
      const matchingCase = buildActorMatrix().find((entry) => entry.id === caseId);
      if (matchingCase) {
        for (const why of reconstructCaseTransport(record, {
          runId, attempt, role, kase: matchingCase, intent: files.intent,
          manifestDigest: files.setup ? String(files.setup.manifest_sha256 ?? "") : null,
          graphDigest: graph ? graphBindingDigest(graph, runId, attempt) : null,
          witnessJournal: witnessTransportHistory,
        })) block("PC-04", "failed", `case ${caseId} ${why}`);
      }

      // ── the retained pre/post observations, INDEPENDENTLY REPEATED ───────────────────────────
      if (Number.isInteger(intendedApp) && intendedApps) {
        for (const direction of ["pre", "post"]) {
          const problems = reassessGovernedObservation(witness[`${direction}_observation`], {
            runId, attempt, actor: role, normalAppId: intendedApps.normal, emergencyAppId: intendedApps.emergency,
          });
          for (const why of problems) block("PC-04", "failed", `case ${caseId}'s ${direction} witness observation ${why}`);
        }
      }
      // PRE == POST on the complete governed policy: the whole contemporaneity claim, recomputed
      // here rather than read out of the record that asserts it.
      const preDigest = witness.pre_observation?.projected_governed_digest;
      const postDigest = witness.post_observation?.projected_governed_digest;
      if (SHA256_HEX.test(String(preDigest ?? "")) && SHA256_HEX.test(String(postDigest ?? "")) && String(preDigest) !== String(postDigest)) {
        block("PC-04", "failed", `case ${caseId}'s governed policy changed across its mutation window; the measurement is not contemporaneous`);
      }

      // ── this case's OWN policy verdict, and its OWN token/installation proof ──────────────────
      for (const [label, policy] of [["pre-mutation", record?.policy_pre], ["post-mutation", record?.policy_in_force]]) {
        if (!policy || typeof policy !== "object") { block("PC-04", "unverified", `case ${caseId} records no ${label} policy verdict`); continue; }
        if (String(policy.verdict) !== "compatible") {
          block("PC-04", String(policy.verdict) === "measurement-incomplete" ? "unverified" : "failed",
            `case ${caseId}'s ${label} policy is recorded as ${JSON.stringify(String(policy.verdict ?? "unreported"))}`);
        }
      }
      const proof = record?.token_proof;
      if (!proof || typeof proof !== "object") {
        block("PC-04", "unverified", `case ${caseId} records no token proof; its credential's App, installation, repository and scoped read are unestablished`);
      } else {
        const installation = proof.installation;
        if (!installation || typeof installation !== "object") block("PC-04", "unverified", `case ${caseId}'s token proof records no installation scope`);
        else {
          // THE REPOSITORY, BY NUMERIC ID. A proof naming repository 1 with `total_count: 999`,
          // preserving only the expected repository NAME, used to pass.
          if (files.intent && Number(installation.repository_id) !== Number(files.intent.repository_id)) {
            block("PC-04", "failed", `case ${caseId}'s token proof names repository ${JSON.stringify(installation.repository_id ?? null)}, not the one this run's immutable intent configured`);
          }
          if (String(installation.repository_full_name ?? "") !== COMMISSIONING_REPOSITORY) {
            block("PC-04", "failed", `case ${caseId}'s token proof names ${JSON.stringify(String(installation.repository_full_name ?? ""))} as its repository`);
          }
          if (Number(installation.total_count) !== 1) {
            block("PC-04", "failed", `case ${caseId}'s token proof reports ${JSON.stringify(installation.total_count ?? null)} reachable repositories; commissioning requires exactly one`);
          }
        }
      }
      const grants = record?.grants;
      if (!grants || typeof grants !== "object" || grants.measured !== true) {
        block("PC-04", "unverified", `case ${caseId} records no measured App grant set of its own`);
      } else {
        if (Number.isInteger(intendedApp) && Number(grants.app_id) !== intendedApp) {
          block("PC-04", "failed", `case ${caseId} measured App ${Number(grants.app_id)}, not the ${intendedApp} this run's immutable intent configured`);
        }
        const comparison = comparePermissions(grants.installation_permissions, ROLE_APP_PERMISSIONS[role]);
        if (!comparison.ok) block("PC-04", "failed", `case ${caseId}'s measured grants are not the closed ${role} set`);
      }

      // ── the manifest and graph this case's challenges bound ──────────────────────────────────
      if (files.setup && String(record?.manifest_sha256 ?? "") !== String(files.setup.manifest_sha256 ?? "")) {
        block("PC-04", "invalid", `case ${caseId} names a manifest digest that is not the one this run's setup published`);
      }
      if (graph && String(record?.graph_sha256 ?? "") !== graphBindingDigest(graph, runId, attempt)) {
        block("PC-04", "invalid", `case ${caseId} names a synthetic graph digest that does not describe the graph the verified journal records`);
      }
    }
    if (new Set(nonces).size !== nonces.length) block("PC-04", "invalid", `the ${role} actor evidence reuses a witness nonce across cases or directions`);
    if (new Set(artifacts).size !== artifacts.length) block("PC-04", "invalid", `the ${role} actor evidence reuses a witness artifact across cases or directions`);
  }

  // PC-06, the ACTUAL human approval — from the approvals file `collect` wrote after the protected
  // jobs ran, never from setup's pre-approval snapshot.
  if (files.approvals) {
    // The DISPATCHER, measured from provider run metadata (F6). Every self-review comparison below is
    // derived from these identities rather than from a supplied `is_dispatcher` boolean.
    if (files.approvals.run_measured !== true) block("PC-06", "unverified", "the run's own actor metadata could not be measured, so no dispatcher identity is established");
    const dispatcher = files.approvals.measured_dispatcher;
    if (!dispatcher || !Number.isInteger(Number(dispatcher.id))) {
      block("PC-06", "unverified", "the approval evidence records no numeric measured dispatcher identity");
    }
    /**
     * ── THE PHASE'S OWN TIME, ORDERED AGAINST WHAT IT REPORTS (root's clock qualification) ───────
     *
     * `collect` runs AFTER the protected actor phases, so a collection time that precedes the first
     * case's measured mutation describes an ordering that did not happen. The phase time was never
     * read at all, so a contradictory one was free.
     */
    const collectedAt = Date.parse(String(files.approvals.collected_at ?? ""));
    if (!Number.isFinite(collectedAt)) block("PC-06", "invalid", "the approval evidence carries no parseable collection time");
    else {
      if (runWindow?.start && collectedAt < Date.parse(String(runWindow.start))) {
        block("PC-06", "invalid", "the approval evidence was collected before this run's window opened");
      }
      if (runWindow?.end && collectedAt > Date.parse(String(runWindow.end))) {
        block("PC-06", "invalid", "the approval evidence was collected after this run's window closed");
      }
      const caseMutations = ["normal", "emergency"]
        .flatMap((role) => (Array.isArray(files[role]?.cases) ? files[role].cases : []))
        .map((record) => Date.parse(String(record?.mutation_started_at ?? "")))
        .filter((value) => Number.isFinite(value));
      if (caseMutations.length && collectedAt < Math.max(...caseMutations)) {
        block("PC-06", "invalid", `the approval evidence was collected at ${new Date(collectedAt).toISOString()}, before the last actor case it reports on mutated; the phase ordering is contradictory`);
      }
    }
    for (const spec of PROTECTED_JOBS) {
      const environment = files.approvals.environments?.[spec.environment];
      if (!environment) { block("PC-06", "unverified", `the approval evidence records nothing for ${spec.environment}`); continue; }
      if (environment.approval_measured !== true) {
        block("PC-06", "unverified", `${spec.environment}'s approval history could not be measured${environment.approval_measurement_reason ? ` (${environment.approval_measurement_reason})` : ""}`);
        continue;
      }
      if (environment.approved !== true) { block("PC-06", "unverified", `no human approval is recorded for ${spec.environment}`); continue; }
      const reviewers = Array.isArray(environment.reviewers) ? environment.reviewers : [];
      if (!reviewers.length) { block("PC-06", "unverified", `${spec.environment} is recorded as approved with no reviewer identity`); continue; }
      // THE CONFIGURED HUMAN REVIEWER, by numeric identity (F6). The previous gate accepted any plain
      // login INCLUDING a `[bot]` one, and required no particular identity — so a bot approval read
      // as human approval.
      const human = reviewers.filter((reviewer) => Number(reviewer?.id) === OWNER_USER_ID
        && String(reviewer?.login) === OWNER_LOGIN && String(reviewer?.type) === OWNER_USER_TYPE);
      if (!human.length) {
        block("PC-06", "failed", `${spec.environment} is recorded as approved by ${reviewers.map((r) => `${String(r?.login)}(#${r?.id ?? "?"},${String(r?.type)})`).join(", ")}, not by the configured human reviewer ${OWNER_LOGIN} (#${OWNER_USER_ID})`);
      }
      if (reviewers.some((reviewer) => String(reviewer?.type) !== "User")) {
        block("PC-06", "failed", `${spec.environment}'s approval records a non-User reviewer; a bot approval is not the human gate PC-06 asks for`);
      }
      // A dispatcher that approves its own run is a self-review: the run happened, but it is not the
      // two-identity evidence PC-06 asks for. RE-DERIVED from the measured identities.
      const selfReviewed = dispatcher && reviewers.some((reviewer) =>
        (Number(reviewer?.id) === Number(dispatcher.id)) || String(reviewer?.login) === String(dispatcher.login));
      if (selfReviewed) {
        block("PC-06", "failed", `${spec.environment} was approved by the measured dispatcher itself; that is a self-review, not independent approval`);
      }
      if (reviewers.some((reviewer) => reviewer.is_dispatcher === true)) {
        block("PC-06", "failed", `${spec.environment}'s own record marks its approver as the dispatcher; that is a self-review`);
      }
      /**
       * WHEN THE APPROVAL HAPPENED (root's clock qualification).
       *
       * The summary dropped the provider's timestamp entirely, so an approval could not be placed in
       * time and a future one was invisible by construction. An approval outside this run's window
       * is not this run's approval.
       */
      for (const reviewer of reviewers) {
        const approvedAt = Date.parse(String(reviewer?.approved_at ?? ""));
        if (!Number.isFinite(approvedAt)) {
          block("PC-06", "unverified", `${spec.environment}'s approval by ${JSON.stringify(String(reviewer?.login ?? ""))} carries no parseable approval time`);
          continue;
        }
        if (runWindow?.start && approvedAt < Date.parse(String(runWindow.start))) {
          block("PC-06", "failed", `${spec.environment} records an approval at ${new Date(approvedAt).toISOString()}, before this run's window opened; it cannot have been given against a plan that did not exist`);
        }
        if (runWindow?.end && approvedAt > Date.parse(String(runWindow.end))) {
          block("PC-06", "failed", `${spec.environment} records an approval at ${new Date(approvedAt).toISOString()}, after this run's window closed`);
        }
      }
      if (environment.job_state_measured !== true) block("PC-06", "unverified", `the ${spec.id} job's final state could not be measured`);
      else if (environment.job_status !== "completed") block("PC-06", "unverified", `the ${spec.id} job is ${environment.job_status}; its approval did not lead to a completed actor phase`);
      // SUCCESS, IN THIS EXACT ATTEMPT (F6). A `completed` job with a `failure` conclusion previously
      // satisfied this gate, and a success borrowed from another attempt would have too.
      else if (String(environment.job_conclusion) !== "success") {
        block("PC-06", "failed", `the ${spec.id} job concluded ${JSON.stringify(String(environment.job_conclusion ?? "none"))}, not success`);
      } else if (environment.job_run_attempt !== null && Number(environment.job_run_attempt) !== Number(attempt)) {
        block("PC-06", "invalid", `the ${spec.id} job's recorded success belongs to attempt ${environment.job_run_attempt}, not ${attempt}`);
      }
    }
  }

  // PC-05: every case in the matrix, DERIVED from its own actor's file. No pooling: a record for a
  // normal-App case is only ever read out of the normal job's evidence.
  // An actor whose evidence file is absent or mis-bound loses PC-05 coverage for ITS OWN cases, and
  // says so once rather than seven times — but it never loses it silently, because "the file was
  // rejected" and "these cases are therefore unmeasured" are two different things a reader needs.
  for (const actor of Object.keys(ACTOR_EVIDENCE_KEY)) {
    if (files[ACTOR_EVIDENCE_KEY[actor]]) continue;
    const count = buildActorMatrix().filter((kase) => kase.actor === actor).length;
    block("PC-05", "unverified", `${count} ${actor} case(s) have no usable recorded outcome, because its evidence file was absent or rejected`);
  }
  /**
   * THE LOCAL HUMAN CASES, JOINED TO THEIR HISTORY (R2).
   *
   * The human evidence file is a DERIVED view that every `human-tests` run rewrites, so uniqueness
   * inside it proves nothing about how many requests were issued. Each human case is joined to its
   * one intent → result → readback → outcome sequence in the verified chain, through the same owner
   * runtime admission uses, and a duplicate, unresolved or rewritten history refuses.
   */
  const humanJournal = journalRecords ? assessHumanCaseJournal(journalRecords, { runId, attempt }) : null;
  for (const why of humanJournal?.problems ?? []) block("PC-05", "invalid", why);
  for (const kase of buildActorMatrix()) {
    const source = files[ACTOR_EVIDENCE_KEY[kase.actor]];
    if (kase.actor === "human" && humanJournal) {
      const joined = humanJournal.cases[kase.id];
      if (joined.state === "invalid") block("PC-05", "invalid", `case ${kase.id} ${joined.problems.join("; ")}`);
      else if (joined.state === "unresolved") block("PC-05", "unverified", `case ${kase.id} ${joined.problems.join("; ")}`);
    }
    if (!source) continue; // reported once per actor, immediately above
    const cases = Array.isArray(source.cases) ? source.cases : null;
    if (!cases) { block("PC-05", "invalid", `the ${kase.actor} evidence does not carry a case list`); continue; }
    const matching = cases.filter((record) => String(record?.case) === kase.id);
    if (!matching.length) { block("PC-05", "unverified", `case ${kase.id} has no recorded outcome in the ${kase.actor} evidence`); continue; }
    if (matching.length > 1) { block("PC-05", "invalid", `case ${kase.id} is recorded ${matching.length} times`); continue; }
    if (kase.actor === "human") {
      const joined = humanJournal?.cases[kase.id] ?? null;
      // With no verified journal the case cannot pass, but the record is still judged below: its own
      // contradictions are measured refusals, and must not be hidden behind "unverified".
      if (!joined) block("PC-05", "unverified", `case ${kase.id} cannot be joined to a verified journal history`);
      else if (joined.state === "none" && !["inconclusive", "not-run"].includes(String(matching[0]?.outcome))) {
        block("PC-05", "invalid", `case ${kase.id} records the outcome ${JSON.stringify(String(matching[0]?.outcome ?? ""))}, but the verified journal records no mutation for it`);
      }
      if (joined?.state === "settled" && canonicalJson(matching[0]) !== canonicalJson(joined.record)) {
        block("PC-05", "invalid", `case ${kase.id}'s recorded outcome is not the one its verified journal history holds; a derived file cannot replace it`);
      }
      // In every one of these the record is ALSO judged on its own terms below, so a contradiction it
      // measures about the subject is still reported as the failure it is.
    }
    const problems = deriveCaseVerdict(matching[0], kase, {
      runId, attempt, graph,
      normalAppId: files.intent ? Number(files.intent.normal_app_id) : null,
    });
    if (!problems.length) continue;
    const unmeasured = problems.some((why) => /recorded (inconclusive|not-run)/.test(why));
    block("PC-05", unmeasured ? "unverified" : (problems.length === 1 && /^recorded /.test(problems[0]) ? "failed" : "invalid"), `case ${kase.id} ${problems.join("; ")}`);
  }
  for (const why of cloudCasesIssuedAfterHalt(files)) block("PC-05", "invalid", why);

  if (files.cleanup) {
    /**
     * THE OPERATOR WHO DELETED, by numeric identity (F9).
     *
     * Cleanup previously performed no `/user` read at all, so a different repository administrator
     * could run it end to end and the packet recorded nothing about that at all. The admission is
     * now in the shared local session; this is the durable half, so a reviewer can see WHOSE
     * credential removed the resources rather than assuming it was the one who created them.
     */
    const cleaner = files.cleanup.operator;
    if (Number(cleaner?.id) !== OWNER_USER_ID || String(cleaner?.login) !== OWNER_LOGIN
      || String(cleaner?.type) !== OWNER_USER_TYPE || String(cleaner?.permission) !== "admin") {
      block("PC-02", "failed", `the cleanup evidence records the operator ${JSON.stringify(String(cleaner?.login ?? ""))} (#${cleaner?.id ?? "unmeasured"}), not the one authorized administrator`);
    }
    if ((files.cleanup.production_drift ?? []).length) block("PC-07", "failed", "production state moved during the run");
    if (Number(files.cleanup.refusals ?? 0) > 0) block("PC-07", "failed", `${files.cleanup.refusals} owned resource(s) remain or did not match their fingerprint`);
    /**
     * DRIFT, RECOMPUTED (F4).
     *
     * The previous gate read `production_drift` and trusted it. The independent review's hostile
     * packet therefore passed with DIFFERENT before/after main SHAs and `production_drift: []` — the
     * one shape this gate exists to catch. The two baselines are in the file; the comparison is this
     * gate's job, not the file's.
     */
    const before = files.cleanup.production_baseline_before;
    const after = files.cleanup.production_baseline_after;
    if (!before || typeof before !== "object" || !after || typeof after !== "object") {
      block("PC-07", "invalid", "the cleanup evidence does not carry both production baselines to compare");
    } else {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
      const recomputed = keys.filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]));
      if (recomputed.length) {
        block("PC-07", "failed", `recomputing the cleanup baselines shows production moved in ${recomputed.length} dimension(s) (${recomputed.slice(0, 4).join(", ")}${recomputed.length > 4 ? ", …" : ""})`);
      }
      if (canonicalJson(recomputed) !== canonicalJson([...(files.cleanup.production_drift ?? [])].sort())) {
        block("PC-07", "invalid", "the cleanup evidence's reported drift is not the drift its own two baselines show");
      }
      // The "before" baseline must be the one the verified journal recorded at the start of the run.
      const journaled = journalRecords?.find((record) => record.type === "baseline-measured")?.data ?? null;
      if (!journaled) block("PC-07", "unverified", "the verified journal records no production baseline for the cleanup comparison to be anchored to");
      else if (canonicalJson(journaled) !== canonicalJson(before)) {
        block("PC-07", "invalid", "the cleanup evidence's starting baseline is not the one the verified journal recorded");
      }
    }
    if (Number(files.cleanup.unresolved_intents ?? -1) !== 0) {
      block("PC-07", "unverified", `the cleanup evidence records ${files.cleanup.unresolved_intents} unresolved create intent(s)`);
    }
    const outcomes = Array.isArray(files.cleanup.outcomes) ? files.cleanup.outcomes : [];
    const leftovers = outcomes.filter((entry) => !["removed", "already-absent", "closed", "already-closed"].includes(entry?.result));
    if (leftovers.length) block("PC-07", "failed", `${leftovers.length} owned resource(s) were not removed`);
    // COVERAGE, computed from the verified journal rather than from the cleanup file's own list. An
    // empty `outcomes: []` used to satisfy every check above by having nothing to object to.
    if (journalRecords?.length) {
      const owned = journalRecords.filter((record) => record.type === "resource-created").map((record) => record.data);
      const expected = [
        ...owned.filter((entry) => entry?.kind === "ruleset").map((entry) => `ruleset:${Number(entry.id)}`),
        ...owned.filter((entry) => entry?.kind === "ref").map((entry) => `ref:${String(entry.ref)}`),
        ...owned.filter((entry) => entry?.kind === "pull-request").map((entry) => `pull-request:${Number(entry.number)}`),
      ];
      const covered = new Set(outcomes.map((entry) => {
        if (entry?.kind === "ruleset") return `ruleset:${Number(entry.id)}`;
        if (entry?.kind === "ref") return `ref:${String(entry.ref)}`;
        if (entry?.kind === "pull-request") return `pull-request:${Number(entry.number)}`;
        return `unknown:${String(entry?.kind ?? "")}`;
      }));
      const uncovered = expected.filter((key) => !covered.has(key));
      if (uncovered.length) {
        block("PC-07", "unverified", `${uncovered.length} journaled resource(s) have no cleanup outcome (${uncovered.slice(0, 4).join(", ")}${uncovered.length > 4 ? ", …" : ""})`);
      }
      const unowned = [...covered].filter((key) => !expected.includes(key));
      if (unowned.length) block("PC-07", "invalid", `the cleanup evidence reports ${unowned.length} outcome(s) for resources the journal does not record this run creating`);
    }
  }

  // PC-06 negative controls: the cross product of control × protected environment, each with bound
  // provider proof re-hashed from the evidence directory.
  if (files.environment) {
    const controls = files.environment.controls;
    if (!controls || typeof controls !== "object" || Array.isArray(controls)) {
      block("PC-06", "invalid", "the environment-controls evidence does not carry a controls map");
    } else {
      // One environment has ONE numeric identity. Every accepted observation of it must agree (R3).
      const measuredIds = new Map(PROTECTED_JOBS.map((spec) => [spec.environment, new Set()]));
      /**
       * The TRUSTED context the cross-run off-branch variant is validated against: the commissioning
       * identity recomputed from the verified original intent, the verified resource journal, this
       * run's window and the collected approvals. Nothing in it comes from the record under review.
       */
      const offbranch = files.intent && journalRecords?.length && runWindow ? {
        commissioning: commissioningIdentity({
          intent: files.intent, runId, attempt, repository: COMMISSIONING_REPOSITORY, workflowPath: COMMISSIONING_WORKFLOW_PATH,
        }),
        resourceJournal: journalRecords, window: runWindow, approvals: files.approvals ?? null,
      } : null;
      for (const key of ENVIRONMENT_CONTROL_KEYS) {
        const perEnvironment = controls[key];
        if (!perEnvironment || typeof perEnvironment !== "object" || Array.isArray(perEnvironment)) {
          block("PC-06", "unverified", `the protected-environment control ${key} has no per-environment records`);
          continue;
        }
        for (const spec of PROTECTED_JOBS) {
          let problem;
          try {
            problem = validateEnvironmentControl(perEnvironment[spec.environment], {
              dir, key, environment: spec.environment, runId, attempt, window: runWindow, offbranch,
            });
          } catch (error) {
            // A probe journal that does not verify is a refusal of THIS record, never a crash of the gate.
            problem = `could not be validated (${error instanceof Error ? error.message : String(error)})`;
          }
          if (problem) block("PC-06", "unverified", `the protected-environment control ${key} for ${spec.environment} ${problem}`);
          else measuredIds.get(spec.environment).add(String(perEnvironment[spec.environment].environment_id));
        }
        const unknownEnvironments = Object.keys(perEnvironment).filter((name) => !PROTECTED_JOBS.some((spec) => spec.environment === name));
        if (unknownEnvironments.length) block("PC-06", "invalid", `the control ${key} names ${unknownEnvironments.length} environment(s) outside this workflow's two`);
        if (key === OFFBRANCH_CONTROL) {
          for (const problem of crossCheckOffBranchPair(perEnvironment, dir)) block("PC-06", "invalid", `the control ${key}: ${problem}`);
        }
      }
      for (const [environment, ids] of measuredIds) {
        if (ids.size > 1) block("PC-06", "invalid", `the ${environment} controls were observed on ${ids.size} different numeric environment IDs (${[...ids].sort().join(", ")}); one environment has one identity`);
      }
      const shared = [...measuredIds.values()].filter((ids) => ids.size === 1).map((ids) => [...ids][0]);
      if (shared.length > 1 && new Set(shared).size !== shared.length) {
        block("PC-06", "invalid", "two different protected environments were observed under the same numeric environment ID");
      }
      const unknown = Object.keys(controls).filter((key) => !ENVIRONMENT_CONTROL_KEYS.includes(key));
      if (unknown.length) block("PC-06", "invalid", `the environment-controls evidence declares ${unknown.length} control(s) outside the closed PC-06 list`);
    }
  }
  return { blockers, files, journal_records: journalRecords?.length ?? 0 };
}

function evidenceResult({ runId, attempt, phase, dir, deps }) {
  const assessment = assessEvidence({ dir, runId, attempt, now: deps.now ?? (() => new Date()) });
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
  // THE DISPATCHER, MEASURED (F6). The previous version took it from the intent artifact's
  // `GITHUB_ACTOR`, and `localContext` never compared that with the provider's own record — so the
  // self-review comparison rested on a value the run's own environment supplied. `actor` and
  // `triggering_actor` are read from the attempt the provider holds, and both travel with their
  // numeric IDs, because the comparison that matters is between identities and not between strings.
  const attemptRun = await request("GET", `/repos/${COMMISSIONING_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`);
  const runMeasured = attemptRun.status === 200 && Boolean(attemptRun.body);
  const identity = (value) => (value && typeof value === "object"
    ? { login: String(value.login ?? "unknown"), id: Number.isInteger(Number(value.id)) ? Number(value.id) : null, type: String(value.type ?? "unknown") }
    : null);
  const measuredDispatcher = runMeasured ? identity(attemptRun.body.actor) : null;
  const measuredTriggeringActor = runMeasured ? identity(attemptRun.body.triggering_actor) : null;
  const declaredDispatcher = String(ctx?.intent?.dispatcher ?? "") || null;

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
      // an App; an approval by the dispatcher is a self-review and is reported as one. `is_dispatcher`
      // is DERIVED here from the two measured identities, and the completeness gate re-derives it
      // rather than reading it — a supplied boolean is not an identity comparison.
      reviewers: approvals.map((entry) => ({
        login: entry.reviewer_login, id: entry.reviewer_id, type: entry.reviewer_type,
        approved_at: entry.approved_at,
        is_dispatcher: Boolean(
          (measuredDispatcher && entry.reviewer_id !== null && entry.reviewer_id === measuredDispatcher.id)
          || (measuredDispatcher && entry.reviewer_login === measuredDispatcher.login)
          || (measuredTriggeringActor && entry.reviewer_id !== null && entry.reviewer_id === measuredTriggeringActor.id),
        ),
      })),
      job_state_measured: jobsMeasured,
      // `null` when the jobs list could not be read, and "uncreated" when the job is genuinely
      // absent. Neither is collapsed into a state, because "never ran" and "we could not look" are
      // different facts and only one of them is about the subject.
      job_status: jobsMeasured ? String(job?.status ?? "uncreated") : null,
      job_conclusion: jobsMeasured ? (job?.conclusion === undefined ? null : String(job?.conclusion ?? "none")) : null,
      job_id: jobsMeasured && Number.isInteger(Number(job?.id)) ? Number(job.id) : null,
      // The attempt the job ran in, so "success" cannot be borrowed from a different attempt.
      job_run_attempt: jobsMeasured && Number.isInteger(Number(job?.run_attempt)) ? Number(job.run_attempt) : null,
    };
  }
  return {
    schema_version: RESULT_SCHEMA_VERSION, phase: "approvals", run_id: String(runId), attempt: String(attempt),
    workflow_sha: ctx.workflowSha, collected_at: now().toISOString(),
    run_measured: runMeasured,
    measured_dispatcher: measuredDispatcher,
    measured_triggering_actor: measuredTriggeringActor,
    // Kept for comparison, and labelled: this is what the run's own environment claimed.
    declared_dispatcher: declaredDispatcher,
    declared_dispatcher_matches_measured: Boolean(measuredDispatcher && declaredDispatcher === measuredDispatcher.login),
    dispatcher_is_the_approver: Object.values(environments).some((entry) => entry.reviewers.some((reviewer) => reviewer.is_dispatcher)),
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
  // OBSERVE, for the same reason as cleanup: gathering the approval evidence a completed run
  // already produced must not be blocked by a later, unrelated merge to staging.
  const session = await openLocalSession({ runId, attempt, evidenceDir, env, deps, sourceContinuity: "observe" });
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
  // The local witness. Same three arguments, no network selector, its own read-only journal lock —
  // so it can run concurrently with `human-tests` rather than deadlocking against it.
  if (phase === "witness") return runWitnessPhase({ runId, attempt, evidenceDir, env, deps });
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
