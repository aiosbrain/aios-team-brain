/**
 * AIO-1124 PC-06 — the ONE cross-run variant: `off_branch_environment_reference_refused`, measured by
 * a separately staged, no-secret, inert probe run (accepted API-only design, SHA-256
 * 45e0b818…c01e0, independently reviewed PLAN_READY).
 *
 * ── WHY A SEPARATE VARIANT EXISTS AT ALL ────────────────────────────────────────────────────────
 *
 * The commissioning workflow admits exactly `refs/heads/staging`, so inside it the off-branch case
 * cannot be produced, and PC-06 forbids widening that admission. The honest way to measure it is a
 * DIFFERENT run: a fixed inert workflow dispatched from one fixed disposable ref. But every other
 * negative control is bound to the ORIGINAL commissioning run/attempt, and a separate probe cannot
 * meet that binding truthfully. So this module is one explicitly named exception, selected only by
 * the exact control key plus the integer marker `offbranch_schema_version: 1`, with its OWN closed
 * schema. It is not a generic cross-run override, and the other controls cannot reach it.
 *
 * ── WHAT A PASSING OBSERVATION HAS TO SURVIVE ───────────────────────────────────────────────────
 *
 *  - the trusted commissioning identity, recomputed from the original intent, with the probe intent
 *    linked into the ORIGINAL attempt's hash-chained resource journal BEFORE the probe ref existed;
 *  - the probe's own append-only ownership journal: create-once ref, one dispatch, one reconciled run,
 *    terminal capture, exact-SHA cleanup and verified absence — with no unresolved intent;
 *  - the raw provider responses themselves, re-hashed and re-parsed here: run, jobs, the job→check
 *    join, the check's suite/producer/deployment, and the EXACT branch-policy annotation for this
 *    fixed branch and environment. A verdict field is never read; the refusal is re-derived;
 *  - complete before/after environment policy readbacks, equal to each other, to the staged baseline
 *    and to the configuration the commissioning controls expect;
 *  - original provider and capture times, in order, inside the original run's window, before the
 *    original protected jobs were approved.
 *
 * ── WHAT IT CANNOT CLAIM ────────────────────────────────────────────────────────────────────────
 *
 * Retained captures are collected under the trusted local operator boundary. Hashes and local JSON
 * are not a provider signature and do not prove tamper resistance against that operator; the
 * offline assessment does not re-contact GitHub; before/after equality shows the two endpoints
 * agreed, not that the policy was continuously immutable. UI-sourced denial evidence has no reviewed
 * closed descriptor in this implementation and stays unverified.
 *
 * STATIC IMPORTS: node built-ins and dependency-free repository modules only — the commissioning
 * runner imports this, and that runner's import closure must load with no `node_modules` (F1).
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { OWNER_LOGIN, OWNER_USER_ID, OWNER_USER_TYPE, WITNESS_MAX_PAGES, WITNESS_PAGE_SIZE, canonicalHash, canonicalJson } from "./commissioning-witness.mjs";

// ──────────────────────────────────────────────────────────────────────────────
// 1. Fixed identities. Nothing here is configurable and nothing is read from input.
// ──────────────────────────────────────────────────────────────────────────────

export const OFFBRANCH_CONTROL = "off_branch_environment_reference_refused";
export const OFFBRANCH_SCHEMA_VERSION = 1;
export const PROBE_REPOSITORY = "aiosbrain/aios-team-brain";
export const PROBE_WORKFLOW_FILE = "release-environment-negative-probe.yml";
export const PROBE_WORKFLOW_PATH = `.github/workflows/${PROBE_WORKFLOW_FILE}`;
/**
 * The reviewed workflow BYTES. Changing the YAML — including its comments — changes this digest, and
 * the guard suite fails until the new bytes are reviewed and this literal is changed with them.
 */
export const PROBE_WORKFLOW_SHA256 = "3111f6a5dff64df47af7f05356d94c17150cbab7dee2404d2c737c3a4fe33dba";
export const PROBE_BRANCH = "remediation/pc06-off-branch-negative-20260921";
export const PROBE_REF = `refs/heads/${PROBE_BRANCH}`;
export const PROBE_EVENT = "workflow_dispatch";
export const PROBE_ATTEMPT = "1";
/** Job KEY = explicit YAML `name:` = the name the jobs API reports. One per protected environment. */
export const PROBE_JOBS = Object.freeze([
  Object.freeze({ job_key: "probe-release", environment: "staging-release" }),
  Object.freeze({ job_key: "probe-emergency", environment: "staging-emergency" }),
]);
export const PROBE_ENVIRONMENTS = Object.freeze(PROBE_JOBS.map((job) => job.environment));
/** The dispatcher is the authorized local operator. Dispatcher provenance only — never an approval. */
export const PROBE_DISPATCHER = Object.freeze({ id: OWNER_USER_ID, login: OWNER_LOGIN, type: OWNER_USER_TYPE });
/** The Actions check producer. Necessary, not sufficient: other workflows publish through it too. */
export const ACTIONS_CHECK_PRODUCER = Object.freeze({
  app_id: 15368, slug: "github-actions", owner: Object.freeze({ id: 9919, login: "github", type: "Organization" }),
});
export const API_ORIGIN = "https://api.github.com";
export const WEB_ORIGIN = "https://github.com";
/** Local deadline from the durable dispatch intent. A job timeout does not bound an approval wait. */
export const DISPATCH_DEADLINE_MS = 10 * 60_000;
/** After cancelling at the deadline, how long terminal confirmation may take before cleanup blocks. */
export const CANCEL_CONFIRM_MS = 2 * 60_000;
export const MAX_OBSERVATION_BYTES = 64 * 1024;
export const MAX_DESCRIPTOR_BYTES = 64 * 1024;
export const MAX_RAW_CAPTURE_BYTES = 1024 * 1024;
export const MAX_PAGES = WITNESS_MAX_PAGES;
export const PAGE_SIZE = WITNESS_PAGE_SIZE;
export const CAPTURE_SCHEMA_VERSION = 1;
export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const PROBE_INTENT_SCHEMA_VERSION = 1;

/** The two literal diagnostics of the reviewed fixture shape. The subject is ours, never the annotation's. */
export const specificDiagnosticMessage = (branch, environment) =>
  `Branch "${branch}" is not allowed to deploy to ${environment} due to environment protection rules.`;
export const GENERIC_DIAGNOSTIC_MESSAGE = "The deployment was rejected or didn't satisfy other protection rules.";

const POSITIVE_DECIMAL = /^[1-9][0-9]{0,17}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const repoApi = (repository = PROBE_REPOSITORY) => `${API_ORIGIN}/repos/${repository}`;
const repoWeb = (repository = PROBE_REPOSITORY) => `${WEB_ORIGIN}/${repository}`;

/** A refusal inside this module. Every public validator converts it to a blocker string. */
export class ProbeRefusal extends Error {
  constructor(message) { super(message); this.name = "ProbeRefusal"; }
}
const refuse = (message) => { throw new ProbeRefusal(message); };

// ──────────────────────────────────────────────────────────────────────────────
// 2. Derived local file names. Plain basenames inside the private evidence directory.
// ──────────────────────────────────────────────────────────────────────────────

const assertRunPair = (runId, attempt) => {
  if (!POSITIVE_DECIMAL.test(String(runId)) || !POSITIVE_DECIMAL.test(String(attempt))) refuse("a probe file name needs a positive decimal run and attempt");
};
const stem = (runId, attempt) => { assertRunPair(runId, attempt); return `commissioning-${runId}-${attempt}-offbranch`; };
export const probeIntentName = (runId, attempt) => `${stem(runId, attempt)}-intent.json`;
export const probeObservationName = (runId, attempt, environment) => {
  if (!PROBE_ENVIRONMENTS.includes(environment)) refuse("a probe observation names one of the two protected environments");
  return `${stem(runId, attempt)}-observation-${environment}.json`;
};
/** Descriptor and raw capture names carry a monotonically increasing ordinal the collector assigns. */
export const probeCaptureName = (runId, attempt, kind, ordinal) => {
  if (!/^(raw|desc)$/.test(kind) || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 99_999) refuse("a probe capture name is derived");
  return `${stem(runId, attempt)}-${kind}-${String(ordinal).padStart(5, "0")}.json`;
};
/** The probe's own journal lives beside the resource journal, as the `probe` journal kind. */
export const probeJournalName = (runId, attempt) => { assertRunPair(runId, attempt); return `commissioning-${runId}-${attempt}.probe.jsonl`; };

// ──────────────────────────────────────────────────────────────────────────────
// 3. The CLOSED schema: every subobject, event and descriptor this variant admits.
// ──────────────────────────────────────────────────────────────────────────────

/** The environment-controls wrapper record for this variant. Legacy records keep their own shape. */
export const OFFBRANCH_RECORD_FIELDS = Object.freeze([
  "status", "source", "environment_name", "environment_id", "expected", "measured", "measured_at",
  "run_id", "attempt", "artifact", "artifact_sha256", "offbranch_schema_version", "commissioning",
]);
/** The retained observation, create-once, mode 0600, at most {@link MAX_OBSERVATION_BYTES}. */
export const OFFBRANCH_OBSERVATION_FIELDS = Object.freeze([
  "offbranch_schema_version", "control", "environment", "environment_id", "source", "measured_at",
  "measured", "run_id", "attempt", "commissioning", "probe_intent", "probe", "provider_evidence",
]);
export const COMMISSIONING_IDENTITY_FIELDS = Object.freeze([
  "repository", "repository_id", "run_id", "attempt", "workflow_path", "workflow_sha", "intent_sha256",
]);
export const ARTIFACT_REF_FIELDS = Object.freeze(["artifact", "sha256"]);
export const PROBE_IDENTITY_FIELDS = Object.freeze([
  "workflow_path", "workflow_sha", "ref", "event", "job_key", "job_id", "actor", "triggering_actor", "created_at", "terminal_at",
]);
export const ACTOR_FIELDS = Object.freeze(["id", "login", "type"]);
export const PROVIDER_EVIDENCE_FIELDS = Object.freeze(["run", "jobs", "denial", "environment_before", "environment_after"]);
/** One retained raw provider response body, with the local capture interval around its request. */
export const RAW_REF_FIELDS = Object.freeze(["artifact", "sha256", "started_at", "completed_at"]);
export const PAGED_RAW_REF_FIELDS = Object.freeze(["page", ...RAW_REF_FIELDS]);
export const CHECK_CAPTURE_FIELDS = Object.freeze([...RAW_REF_FIELDS, "terminal"]);
/** Closed capture descriptors, by `kind`. The denial descriptor is the separately versioned one below. */
export const CAPTURE_DESCRIPTORS = Object.freeze({
  run: Object.freeze({ fields: Object.freeze(["capture_schema_version", "kind", "initial", "terminal"]) }),
  jobs: Object.freeze({ fields: Object.freeze(["capture_schema_version", "kind", "pages"]) }),
  "run-selection": Object.freeze({ fields: Object.freeze(["capture_schema_version", "kind", "pages"]) }),
  "environment-policy": Object.freeze({ fields: Object.freeze(["capture_schema_version", "kind", "phase", "environment", "settings", "branch_policies"]) }),
  registration: Object.freeze({ fields: Object.freeze(["capture_schema_version", "kind", "workflow", "source"]) }),
});
export const DENIAL_DESCRIPTOR_FIELDS = Object.freeze(["diagnostic_schema_version", "check_id", "check", "annotations"]);
export const POLICY_PHASES = Object.freeze(["baseline", "before", "after"]);
/** The probe intent: written once, before the ref exists, and linked into the original journal. */
export const PROBE_INTENT_FIELDS = Object.freeze([
  "probe_intent_schema_version", "commissioning", "probe", "environments", "baseline_policy", "dispatcher", "staged_at", "journal",
]);
export const PROBE_INTENT_PROBE_FIELDS = Object.freeze(["workflow_path", "ref", "workflow_sha", "attempt"]);
export const PROBE_INTENT_ENVIRONMENT_FIELDS = Object.freeze(["environment", "environment_id", "job_key"]);
export const PROBE_INTENT_JOURNAL_FIELDS = Object.freeze(["artifact"]);
/** The ONE event this variant adds to the original attempt's resource journal. */
export const RESOURCE_LINK_EVENT = "probe-staged";
export const RESOURCE_LINK_FIELDS = Object.freeze(["intent_artifact", "intent_sha256", "probe_journal"]);

/**
 * The probe ownership journal's CLOSED event vocabulary with each event's EXACT payload field set.
 * `http_status`/`response_complete`/`response_incomplete`/`measured_status` are the completed-response
 * facts every persisted mutation result must carry (R02-1); a bare status is never journaled.
 */
const RESPONSE_FACTS = Object.freeze(["http_status", "response_complete", "response_incomplete", "measured_status"]);
export const PROBE_JOURNAL_EVENTS = Object.freeze({
  "probe-opened": Object.freeze(["intent_artifact", "intent_sha256", "commissioning_run_id", "commissioning_attempt"]),
  "registration-verified": Object.freeze(["workflow_id", "workflow_state", "workflow_created_at", "source_sha256", "descriptor"]),
  "automation-inspected": Object.freeze(["workflow_count", "workflows_sha256", "induced"]),
  "ref-absent-verified": Object.freeze(["ref", ...RESPONSE_FACTS, "measured_at"]),
  "ref-create-intent": Object.freeze(["ref", "sha"]),
  "ref-create-result": Object.freeze(["ref", "sha", ...RESPONSE_FACTS, "object_sha"]),
  "ref-readback": Object.freeze(["ref", ...RESPONSE_FACTS, "object_sha", "measured_at"]),
  "policy-captured": Object.freeze(["phase", "environment", "environment_id", "descriptor", "completed_at"]),
  "dispatch-intent": Object.freeze(["workflow_file", "ref", "deadline_at"]),
  "dispatch-result": Object.freeze(RESPONSE_FACTS),
  "run-identified": Object.freeze(["run_id", "eligible", "descriptor"]),
  "run-unidentified": Object.freeze(["eligible", "descriptor", "reason"]),
  "run-terminal": Object.freeze(["run_id", "run_attempt", "status", "conclusion", "observed_at"]),
  "cancel-intent": Object.freeze(["run_id", "reason"]),
  "cancel-result": Object.freeze(["run_id", ...RESPONSE_FACTS]),
  "capture-recorded": Object.freeze(["kind", "environment", "descriptor", "completed_at"]),
  "observation-recorded": Object.freeze(["environment", "outcome", "artifact", "sha256", "measured_at", "reason"]),
  "cleanup-intent": Object.freeze(["ref", "expected_sha"]),
  "cleanup-result": Object.freeze(["ref", "expected_sha", "outcome", "exit_code"]),
  "absence-verified": Object.freeze(["ref", ...RESPONSE_FACTS, "measured_at"]),
  reconciliation: Object.freeze(["of", "outcome", "object_sha", "measured_at"]),
  "probe-closed": Object.freeze(["outcome"]),
});
export const PROBE_JOURNAL_EVENT_TYPES = Object.freeze(Object.keys(PROBE_JOURNAL_EVENTS));
/** Intent events whose outcome must be resolved by a result or an explicit reconciliation. */
export const PROBE_INTENT_PAIRS = Object.freeze({
  "ref-create-intent": "ref-create-result",
  "dispatch-intent": "dispatch-result",
  "cancel-intent": "cancel-result",
  "cleanup-intent": "cleanup-result",
});
export const CLEANUP_OUTCOMES = Object.freeze(["deleted", "lease-refused", "ambiguous"]);
export const OBSERVATION_OUTCOMES = Object.freeze(["refused", "admitted", "unverified"]);
export const PROBE_CLOSED_OUTCOMES = Object.freeze(["measured", "inconclusive", "failed"]);
export const RECONCILIATION_OUTCOMES = Object.freeze(["absent", "present-unchanged", "present-ownership-uncertain", "present-changed"]);

/** Refuse a probe journal payload whose field set is not EXACTLY its event's. */
export function assertProbeEventPayload(type, data) {
  const fields = PROBE_JOURNAL_EVENTS[String(type)];
  if (!fields) refuse(`unknown probe journal event ${JSON.stringify(String(type))}`);
  assertClosed(data, fields, `the ${type} payload`);
  return data;
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. Small closed-shape primitives.
// ──────────────────────────────────────────────────────────────────────────────

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Exactly these own keys, no more and no fewer. */
export function assertClosed(value, fields, label) {
  if (!isPlainObject(value)) refuse(`${label} is not an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...fields].sort();
  const extra = keys.filter((key) => !wanted.includes(key));
  const missing = wanted.filter((key) => !keys.includes(key));
  if (extra.length) refuse(`${label} carries field(s) outside its closed schema (${extra.join(", ")})`);
  if (missing.length) refuse(`${label} is missing its closed field(s) ${missing.join(", ")}`);
  return value;
}

const positiveInt = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) refuse(`${label} is not a positive integer identity`);
  return value;
};
const decimalString = (value, label) => {
  if (typeof value !== "string" || !POSITIVE_DECIMAL.test(value)) refuse(`${label} is not a positive decimal identity string`);
  return value;
};
const timeOf = (value, label) => {
  if (typeof value !== "string" || !ISO_UTC.test(value)) refuse(`${label} is not an exact UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) refuse(`${label} is not a parseable time`);
  return parsed;
};
const equalOrRefuse = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected)) refuse(`${label} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Read one retained local file named by a closed `{artifact, sha256}` reference.
 *
 * Basename only, no symlink, regular file, bounded BEFORE it is read, digest-checked BEFORE it is
 * parsed. A reference cannot point outside the evidence directory or at a file nobody hashed.
 */
export function readRetained(dir, ref, { maxBytes, label, fields = ARTIFACT_REF_FIELDS }) {
  assertClosed(ref, fields, label);
  const artifact = ref.artifact;
  if (typeof artifact !== "string" || !ARTIFACT_NAME.test(artifact)) refuse(`${label} does not name a plain retained artifact`);
  if (typeof ref.sha256 !== "string" || !SHA256_HEX.test(ref.sha256)) refuse(`${label} carries no lowercase SHA-256`);
  const target = path.join(dir, artifact);
  let stats;
  try { stats = lstatSync(target); } catch { refuse(`${label} names ${artifact}, which is not in the evidence directory`); }
  if (stats.isSymbolicLink()) refuse(`${label} names a symlink (${artifact})`);
  if (!stats.isFile()) refuse(`${label} names something that is not a regular file (${artifact})`);
  if (stats.size > maxBytes) refuse(`${label} names ${artifact}, beyond its ${maxBytes}-byte bound`);
  const bytes = readFileSync(target);
  if (bytes.length > maxBytes) refuse(`${label} grew beyond its ${maxBytes}-byte bound while being read`);
  if (sha256(bytes) !== ref.sha256) refuse(`${label} names ${artifact}, whose digest is not the one it commits to`);
  return bytes;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
function parseJsonBytes(bytes, label) {
  let text;
  try { text = STRICT_UTF8.decode(bytes); } catch { refuse(`${label} is not valid UTF-8`); }
  try { return JSON.parse(text); } catch { refuse(`${label} is not parseable JSON`); }
}

/** A retained descriptor (closed, ≤64KiB) or raw provider body (≤1MiB), parsed. */
export const readDescriptor = (dir, ref, label) => parseJsonBytes(readRetained(dir, ref, { maxBytes: MAX_DESCRIPTOR_BYTES, label }), label);
function readRaw(dir, ref, label, fields) {
  const bytes = readRetained(dir, ref, { maxBytes: MAX_RAW_CAPTURE_BYTES, label, fields });
  const started = timeOf(ref.started_at, `${label} started_at`);
  const completed = timeOf(ref.completed_at, `${label} completed_at`);
  if (completed < started) refuse(`${label} completed before it started`);
  const body = parseJsonBytes(bytes, label);
  if (body === null || typeof body !== "object") refuse(`${label} is not a JSON object or array`);
  return { body, started, completed };
}

/** Pages 1..n, contiguous, each a retained raw body. */
function readPages(dir, pages, label) {
  if (!Array.isArray(pages) || !pages.length) refuse(`${label} retains no pages`);
  if (pages.length > MAX_PAGES) refuse(`${label} retains more than ${MAX_PAGES} pages`);
  return pages.map((ref, index) => {
    assertClosed(ref, PAGED_RAW_REF_FIELDS, `${label} page ${index + 1}`);
    if (ref.page !== index + 1) refuse(`${label} pages are not the contiguous sequence 1..${pages.length}`);
    const { page, ...raw } = ref;
    return { page, ...readRaw(dir, raw, `${label} page ${page}`, RAW_REF_FIELDS) };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. Provider shape parsers. Raw provider responses are OPEN (the provider adds fields); only the
//    named fields are read, and none of them can widen a target or supply a different identity.
// ──────────────────────────────────────────────────────────────────────────────

export function parseActor(value, label) {
  if (!isPlainObject(value)) refuse(`${label} is not an identity`);
  return { id: positiveInt(value.id, `${label} id`), login: String(value.login ?? ""), type: String(value.type ?? "") };
}

/**
 * The probe RUN, from `GET /repos/{repo}/actions/runs/{R}`. Returns the governing projection the
 * terminal re-read must reproduce exactly.
 */
export function parseProbeRun(body, { runId, repositoryId, workflowSha }) {
  if (!isPlainObject(body)) refuse("the probe run capture is not an object");
  const id = positiveInt(body.id, "the probe run id");
  if (String(id) !== String(runId)) refuse(`the probe run capture describes run ${id}, not ${runId}`);
  if (body.run_attempt !== 1) refuse(`the probe run capture is attempt ${JSON.stringify(body.run_attempt)}; a rerun cannot replace the original attempt 1`);
  for (const field of ["repository", "head_repository"]) {
    if (!isPlainObject(body[field])) refuse(`the probe run carries no ${field}`);
    if (body[field].id !== Number(repositoryId)) refuse(`the probe run's ${field} is not the commissioning repository ID`);
    if (body[field].full_name !== PROBE_REPOSITORY) refuse(`the probe run's ${field} is not ${PROBE_REPOSITORY}`);
  }
  if (body.path !== PROBE_WORKFLOW_PATH) refuse(`the probe run is workflow ${JSON.stringify(body.path)}, not the fixed probe workflow`);
  if (body.event !== PROBE_EVENT) refuse(`the probe run was triggered by ${JSON.stringify(body.event)}, not ${PROBE_EVENT}`);
  if (body.head_branch !== PROBE_BRANCH) refuse(`the probe run is on branch ${JSON.stringify(body.head_branch)}, not the fixed probe ref`);
  if (body.head_sha !== workflowSha) refuse("the probe run's source SHA is not the reviewed commissioning source");
  const actor = parseActor(body.actor, "the probe run actor");
  const triggeringActor = parseActor(body.triggering_actor, "the probe run triggering actor");
  equalOrRefuse(actor, PROBE_DISPATCHER, "the probe run actor");
  equalOrRefuse(triggeringActor, PROBE_DISPATCHER, "the probe run triggering actor");
  if (body.status !== "completed") refuse(`the probe run is ${JSON.stringify(body.status)}, not completed`);
  if (body.conclusion !== "failure") refuse(`the probe run concluded ${JSON.stringify(body.conclusion)}; only a provider refusal (failure) can carry this measurement`);
  const checkSuiteId = positiveInt(body.check_suite_id, "the probe run check suite id");
  const createdAt = timeOf(body.created_at, "the probe run created_at");
  if (body.url !== `${repoApi()}/actions/runs/${id}`) refuse("the probe run's API URL is not its reconstructed route");
  if (body.html_url !== `${repoWeb()}/actions/runs/${id}`) refuse("the probe run's web URL is not its reconstructed route");
  return {
    run_id: String(id), run_attempt: 1, repository_id: body.repository.id, path: body.path, event: body.event,
    head_branch: body.head_branch, head_sha: body.head_sha, actor, triggering_actor: triggeringActor,
    status: body.status, conclusion: body.conclusion, check_suite_id: checkSuiteId, created_at: body.created_at, created_ms: createdAt,
  };
}

/** Parse `check_run_url` into its positive decimal check ID, accepting only the one exact spelling. */
export function parseCheckRunUrl(url) {
  const match = typeof url === "string"
    ? new RegExp(`^${API_ORIGIN.replace(/[.]/g, "\\.")}/repos/aiosbrain/aios-team-brain/check-runs/([1-9][0-9]{0,17})$`).exec(url)
    : null;
  if (!match) refuse("a job's check_run_url is not the exact fixed check-run route");
  return match[1];
}

/**
 * The probe JOBS, from every page of `GET …/actions/runs/{R}/jobs?filter=all`. Exactly the two
 * fixed jobs, each failed before a runner or a step existed, each linked to its own check run.
 */
export function parseProbeJobs(pages, { runId, workflowSha }) {
  let total = null;
  const jobs = [];
  for (const { page, body } of pages) {
    if (!isPlainObject(body) || !Number.isSafeInteger(body.total_count) || !Array.isArray(body.jobs)) refuse(`jobs page ${page} is not the documented shape`);
    if (total === null) total = body.total_count;
    else if (body.total_count !== total) refuse("the jobs pages disagree about their total count");
    if (page < pages.length && body.jobs.length !== PAGE_SIZE) refuse(`jobs page ${page} is short but is not the last page`);
    jobs.push(...body.jobs);
  }
  if (jobs.length !== total) refuse(`the jobs pages carry ${jobs.length} job(s) against a total of ${total}; the listing is incomplete`);
  if (pages.length !== Math.max(1, Math.ceil(total / PAGE_SIZE))) refuse("the jobs listing was not read to its terminal page");
  const ids = new Set();
  const byKey = {};
  for (const job of jobs) {
    if (!isPlainObject(job)) refuse("a probe job is not an object");
    const id = positiveInt(job.id, "a probe job id");
    if (ids.has(id)) refuse(`the jobs listing repeats job ${id}`);
    ids.add(id);
    const spec = PROBE_JOBS.find((entry) => entry.job_key === job.name);
    if (!spec) refuse(`the probe run carries a job named ${JSON.stringify(job.name)}, outside the two fixed probe jobs`);
    if (byKey[spec.job_key]) refuse(`the probe run carries more than one ${spec.job_key} job`);
    if (String(job.run_id) !== String(runId)) refuse(`job ${id} belongs to run ${job.run_id}`);
    if (job.run_attempt !== 1) refuse(`job ${id} belongs to attempt ${JSON.stringify(job.run_attempt)}`);
    if (job.head_branch !== PROBE_BRANCH || job.head_sha !== workflowSha) refuse(`job ${id} is not on the fixed probe ref and source`);
    if (job.status !== "completed") refuse(`job ${spec.job_key} is ${JSON.stringify(job.status)}`);
    if (job.conclusion !== "failure") refuse(`job ${spec.job_key} concluded ${JSON.stringify(job.conclusion)}; a skip, cancellation or success is not a branch-policy refusal`);
    if (!Array.isArray(job.steps) || job.steps.length) refuse(`job ${spec.job_key} ran steps; an admitted job is not a refusal`);
    if (job.runner_id !== 0) refuse(`job ${spec.job_key} was allocated runner ${JSON.stringify(job.runner_id)}; a refused job never reaches a runner`);
    if (typeof job.node_id !== "string" || !job.node_id) refuse(`job ${spec.job_key} carries no node ID`);
    if (job.url !== `${repoApi()}/actions/jobs/${id}`) refuse(`job ${spec.job_key}'s API URL is not its reconstructed route`);
    if (job.run_url !== `${repoApi()}/actions/runs/${runId}`) refuse(`job ${spec.job_key}'s run URL is not its reconstructed route`);
    if (job.html_url !== `${repoWeb()}/actions/runs/${runId}/job/${id}`) refuse(`job ${spec.job_key}'s web URL is not its reconstructed route`);
    const checkId = parseCheckRunUrl(job.check_run_url);
    const started = timeOf(job.started_at, `job ${spec.job_key} started_at`);
    const completed = timeOf(job.completed_at, `job ${spec.job_key} completed_at`);
    if (completed < started) refuse(`job ${spec.job_key} completed before it started`);
    byKey[spec.job_key] = {
      job_key: spec.job_key, environment: spec.environment, job_id: String(id), node_id: job.node_id, name: job.name,
      check_id: checkId, started_at: job.started_at, completed_at: job.completed_at, completed_ms: completed,
    };
  }
  for (const spec of PROBE_JOBS) if (!byKey[spec.job_key]) refuse(`the probe run has no ${spec.job_key} job`);
  if (jobs.length !== PROBE_JOBS.length) refuse("the probe run does not carry exactly the two fixed jobs");
  return byKey;
}

/**
 * One job's CHECK RUN, from `GET …/check-runs/{C}` with C taken from that job's own check_run_url.
 * Every join is required: the job, the run's suite, the producer, and the deployment environment.
 */
export function parseProbeCheck(body, { checkId, job, run, environment, workflowSha }) {
  if (!isPlainObject(body)) refuse("the check capture is not an object");
  if (String(body.id) !== String(checkId) || !Number.isSafeInteger(body.id)) refuse(`the check capture describes ${body.id}, not the job's check ${checkId}`);
  if (body.url !== `${repoApi()}/check-runs/${checkId}`) refuse("the check's API URL is not its reconstructed route");
  const jobWeb = `${repoWeb()}/actions/runs/${run.run_id}/job/${job.job_id}`;
  if (body.html_url !== jobWeb || body.details_url !== jobWeb) refuse("the check's web and details URLs are not this job's reconstructed route");
  if (body.name !== job.name) refuse("the check's name is not its job's name");
  if (body.node_id !== job.node_id) refuse("the check's node ID is not its job's node ID");
  if (body.head_sha !== workflowSha) refuse("the check is not on the reviewed probe source");
  if (body.status !== "completed" || body.conclusion !== "failure") refuse("the check is not a completed failure");
  if (body.started_at !== job.started_at || body.completed_at !== job.completed_at) refuse("the check's start/end times are not its job's");
  if (!isPlainObject(body.check_suite) || body.check_suite.id !== run.check_suite_id) refuse("the check's suite is not the probe run's check suite");
  const app = body.app;
  if (!isPlainObject(app) || app.id !== ACTIONS_CHECK_PRODUCER.app_id || app.slug !== ACTIONS_CHECK_PRODUCER.slug) refuse("the check was not produced by the GitHub Actions App");
  if (!isPlainObject(app.owner) || app.owner.id !== ACTIONS_CHECK_PRODUCER.owner.id || app.owner.login !== ACTIONS_CHECK_PRODUCER.owner.login
    || app.owner.type !== ACTIONS_CHECK_PRODUCER.owner.type) refuse("the check producer's owner is not GitHub");
  const deployment = body.deployment;
  if (!isPlainObject(deployment)) refuse("the check carries no deployment; environment evaluation was not reached");
  const deploymentId = positiveInt(deployment.id, "the check's deployment id");
  if (deployment.url !== `${repoApi()}/deployments/${deploymentId}`) refuse("the check's deployment URL is not its reconstructed route");
  if (deployment.environment !== environment || deployment.original_environment !== environment) refuse(`the check's deployment targets ${JSON.stringify(deployment.environment)}, not ${environment}`);
  const output = body.output;
  if (!isPlainObject(output) || output.annotations_url !== `${repoApi()}/check-runs/${checkId}/annotations`) refuse("the check's annotations URL is not its reconstructed route");
  if (output.annotations_count !== 2) refuse(`the check reports ${JSON.stringify(output.annotations_count)} annotation(s), not the reviewed two`);
  return {
    check_id: String(checkId), name: body.name, node_id: body.node_id, head_sha: body.head_sha, status: body.status, conclusion: body.conclusion,
    started_at: body.started_at, completed_at: body.completed_at, check_suite_id: body.check_suite.id, app_id: app.id,
    deployment_id: deploymentId, deployment_environment: deployment.environment, annotations_count: output.annotations_count,
  };
}

const ANNOTATION_FIELDS = Object.freeze([
  "path", "blob_href", "start_line", "start_column", "end_line", "end_column", "annotation_level", "title", "message", "raw_details",
]);

/**
 * THE LOW-LEVEL DIAGNOSTIC SHAPE PARSER. Pure: the subject is an explicit argument.
 *
 * Exactly two annotations, in either order: the one SPECIFIC branch-policy message built by literal
 * concatenation from the given branch and environment, and the one generic companion. Exact string
 * equality — no trimming, case folding, normalisation or substring match. The live validator only
 * ever calls this with the fixed probe branch, the job's fixed environment and the reviewed source;
 * the isolated fixture test is the only caller with a historical subject.
 */
export function parseDiagnosticAnnotations(pages, { branch, environment, sha, repository = PROBE_REPOSITORY }) {
  const rows = [];
  for (const { page, body } of pages) {
    if (!Array.isArray(body)) refuse(`annotations page ${page} is not the documented array`);
    if (page < pages.length && body.length !== PAGE_SIZE) refuse(`annotations page ${page} is short but is not the last page`);
    rows.push(...body);
  }
  if (pages.length && pages[pages.length - 1].body.length === PAGE_SIZE) refuse("the annotations listing ends on a full page; it was not read to its end");
  if (rows.length !== 2) refuse(`the check carries ${rows.length} annotation(s); the reviewed diagnostic shape is exactly two`);
  const blob = `${WEB_ORIGIN}/${repository}/blob/${sha}/.github`;
  const specific = specificDiagnosticMessage(branch, environment);
  let specificCount = 0;
  let genericCount = 0;
  for (const [index, row] of rows.entries()) {
    assertClosed(row, ANNOTATION_FIELDS, `annotation ${index + 1}`);
    if (row.annotation_level !== "failure" || row.path !== ".github" || row.start_line !== 1 || row.end_line !== 1
      || row.start_column !== null || row.end_column !== null || row.blob_href !== blob) {
      refuse(`annotation ${index + 1} is not at the reviewed location, level and source`);
    }
    if (row.message === specific && row.title === ".github#L1" && row.raw_details === null) specificCount += 1;
    else if (row.message === GENERIC_DIAGNOSTIC_MESSAGE && row.title === "" && row.raw_details === "") genericCount += 1;
    else refuse(`annotation ${index + 1} is neither the exact branch-policy refusal for ${environment} nor its generic companion`);
  }
  if (specificCount !== 1 || genericCount !== 1) refuse("the annotations are not exactly one specific branch-policy refusal and one generic companion");
  return { specific: 1, generic: 1, count: 2 };
}

/**
 * One environment's COMPLETE relevant policy: the environment itself plus every page of its
 * deployment branch policies. Normalised for exact before/after comparison.
 */
export function parseEnvironmentPolicy({ settings, branchPages }, { environment }) {
  if (!isPlainObject(settings)) refuse(`${environment}'s settings capture is not an object`);
  const id = positiveInt(settings.id, `${environment}'s environment id`);
  if (settings.name !== environment) refuse(`the settings capture names ${JSON.stringify(settings.name)}, not ${environment}`);
  timeOf(settings.created_at, `${environment}'s created_at`);
  if (typeof settings.can_admins_bypass !== "boolean") refuse(`${environment}'s administrator bypass state is unmeasured`);
  const dbp = settings.deployment_branch_policy;
  if (!isPlainObject(dbp) || typeof dbp.protected_branches !== "boolean" || typeof dbp.custom_branch_policies !== "boolean") {
    refuse(`${environment}'s deployment branch policy is unmeasured`);
  }
  if (!Array.isArray(settings.protection_rules)) refuse(`${environment}'s protection rules are unmeasured`);
  const rules = settings.protection_rules.map((rule, index) => {
    if (!isPlainObject(rule)) refuse(`${environment} protection rule ${index + 1} is not an object`);
    const ruleId = positiveInt(rule.id, `${environment} protection rule ${index + 1} id`);
    if (rule.type === "required_reviewers") {
      if (typeof rule.prevent_self_review !== "boolean" || !Array.isArray(rule.reviewers)) refuse(`${environment}'s reviewer rule is incomplete`);
      const reviewers = rule.reviewers.map((entry) => {
        if (!isPlainObject(entry) || !isPlainObject(entry.reviewer)) refuse(`${environment} lists a reviewer without an identity`);
        return { type: String(entry.type ?? ""), id: positiveInt(entry.reviewer.id, `${environment} reviewer id`), login: String(entry.reviewer.login ?? "") };
      }).sort((a, b) => a.id - b.id);
      return { type: rule.type, id: ruleId, prevent_self_review: rule.prevent_self_review, reviewers };
    }
    if (rule.type === "branch_policy") return { type: rule.type, id: ruleId };
    // A wait timer, a custom deployment protection rule or any unknown type is another way to refuse
    // a deployment; a refusal it caused is not a branch-policy refusal, so it is not admitted here.
    return refuse(`${environment} carries a ${JSON.stringify(String(rule.type))} protection rule; a refusal could be attributed to it rather than to branch policy`);
  }).sort((a, b) => a.id - b.id);
  let total = null;
  const branchPolicies = [];
  for (const { page, body } of branchPages) {
    if (!isPlainObject(body) || !Number.isSafeInteger(body.total_count) || !Array.isArray(body.branch_policies)) refuse(`${environment} branch-policy page ${page} is not the documented shape`);
    if (total === null) total = body.total_count;
    else if (body.total_count !== total) refuse(`${environment}'s branch-policy pages disagree about their total`);
    if (page < branchPages.length && body.branch_policies.length !== PAGE_SIZE) refuse(`${environment} branch-policy page ${page} is short but is not the last page`);
    for (const entry of body.branch_policies) {
      if (!isPlainObject(entry)) refuse(`${environment} lists a malformed branch policy`);
      branchPolicies.push({ id: positiveInt(entry.id, `${environment} branch policy id`), name: String(entry.name ?? ""), type: String(entry.type ?? "") });
    }
  }
  if (branchPolicies.length !== total) refuse(`${environment}'s branch-policy listing is incomplete`);
  if (branchPages.length !== Math.max(1, Math.ceil(total / PAGE_SIZE))) refuse(`${environment}'s branch-policy listing was not read to its terminal page`);
  if (new Set(branchPolicies.map((entry) => entry.id)).size !== branchPolicies.length) refuse(`${environment} repeats a branch policy`);
  branchPolicies.sort((a, b) => a.id - b.id);
  return {
    environment_id: String(id), name: settings.name, created_at: settings.created_at, can_admins_bypass: settings.can_admins_bypass,
    deployment_branch_policy: { protected_branches: dbp.protected_branches, custom_branch_policies: dbp.custom_branch_policies },
    rules, branch_policies: branchPolicies,
  };
}

/**
 * The configuration the ORIGINAL commissioning controls expect, required of every policy capture:
 * the owner as sole reviewer, self-review prevented, branch-only `staging` (never a tag rule named
 * staging), no administrator bypass. The API's bypass field is required here as a precondition for
 * interpreting the probe; it never becomes evidence for the UI-only administrator-bypass control.
 */
export function assertPolicyAgreesWithCommissioning(policy, environment) {
  equalOrRefuse(policy.deployment_branch_policy, { protected_branches: false, custom_branch_policies: true }, `${environment}'s deployment branch policy`);
  const reviewerRules = policy.rules.filter((rule) => rule.type === "required_reviewers");
  const branchRules = policy.rules.filter((rule) => rule.type === "branch_policy");
  if (reviewerRules.length !== 1 || branchRules.length !== 1) refuse(`${environment} does not carry exactly one reviewer rule and one branch-policy rule`);
  equalOrRefuse(reviewerRules[0].reviewers, [{ type: OWNER_USER_TYPE, id: OWNER_USER_ID, login: OWNER_LOGIN }], `${environment}'s required reviewers`);
  if (reviewerRules[0].prevent_self_review !== true) refuse(`${environment} does not prevent self-review`);
  if (policy.branch_policies.length !== 1 || policy.branch_policies[0].name !== "staging" || policy.branch_policies[0].type !== "branch") {
    refuse(`${environment}'s deployment branch policies are not exactly the one branch rule \`staging\``);
  }
  if (policy.can_admins_bypass !== false) refuse(`${environment} lets administrators bypass its protection rules`);
  return policy;
}

/**
 * Probe-run SELECTION from every page of the fixed workflow-runs listing: exactly one eligible run
 * created inside [dispatch intent, deadline]. Zero or several is never resolved by picking one.
 */
export function selectEligibleRuns(pages, { dispatchIntentMs, deadlineMs }) {
  let total = null;
  const rows = [];
  for (const { page, body } of pages) {
    if (!isPlainObject(body) || !Number.isSafeInteger(body.total_count) || !Array.isArray(body.workflow_runs)) refuse(`run-selection page ${page} is not the documented shape`);
    if (total === null) total = body.total_count;
    else if (body.total_count !== total) refuse("the run-selection pages disagree about their total");
    if (page < pages.length && body.workflow_runs.length !== PAGE_SIZE) refuse(`run-selection page ${page} is short but is not the last page`);
    rows.push(...body.workflow_runs);
  }
  if (rows.length !== total) refuse("the run-selection listing is incomplete");
  if (pages.length !== Math.max(1, Math.ceil(total / PAGE_SIZE))) refuse("the run-selection listing was not read to its terminal page");
  // Provider times are whole seconds; the intent is floored to its second rather than given any
  // positive allowance. A run the provider dates before that second is not attributable to it.
  const floor = Math.floor(dispatchIntentMs / 1000) * 1000;
  const eligible = rows.filter((row) => isPlainObject(row) && row.path === PROBE_WORKFLOW_PATH && row.head_branch === PROBE_BRANCH
    && row.event === PROBE_EVENT && Number.isFinite(Date.parse(String(row.created_at))) && Date.parse(String(row.created_at)) >= floor
    && Date.parse(String(row.created_at)) <= deadlineMs);
  return eligible.map((row) => String(row.id));
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. The inert workflow, statically. Shared by the guard suite and the staging preflight.
// ──────────────────────────────────────────────────────────────────────────────

export const PROBE_JOB_IF = "github.repository == 'aiosbrain/aios-team-brain' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/remediation/pc06-off-branch-negative-20260921' && github.run_attempt == 1";

/** The COMPLETE parsed probe workflow, enumerated. Anything else refuses. */
export function assertInertProbeWorkflow(doc) {
  assertClosed(doc, ["name", "on", "permissions", "jobs"], "the probe workflow");
  equalOrRefuse(doc.on, { workflow_dispatch: null }, "the probe workflow trigger");
  equalOrRefuse(doc.permissions, {}, "the probe workflow permissions");
  assertClosed(doc.jobs, PROBE_JOBS.map((job) => job.job_key), "the probe workflow jobs");
  for (const spec of PROBE_JOBS) {
    const job = doc.jobs[spec.job_key];
    assertClosed(job, ["name", "if", "runs-on", "timeout-minutes", "environment", "steps"], `probe job ${spec.job_key}`);
    equalOrRefuse(job.name, spec.job_key, `probe job ${spec.job_key}'s name`);
    equalOrRefuse(job.if, PROBE_JOB_IF, `probe job ${spec.job_key}'s admission`);
    equalOrRefuse(job["runs-on"], "ubuntu-latest", `probe job ${spec.job_key}'s runner`);
    equalOrRefuse(job["timeout-minutes"], 1, `probe job ${spec.job_key}'s timeout`);
    equalOrRefuse(job.environment, spec.environment, `probe job ${spec.job_key}'s environment`);
    equalOrRefuse(job.steps, [{ run: ":" }], `probe job ${spec.job_key}'s steps`);
  }
  return true;
}

/** Events a ref creation, ref deletion, dispatch or refused deployment could fire in ANOTHER workflow. */
export const INDUCED_EVENTS = Object.freeze([
  "create", "delete", "deployment", "deployment_status", "workflow_run", "check_run", "check_suite", "status", "branch_protection_rule",
]);

/**
 * No OTHER workflow may be started by the probe ref's lifecycle. A `push` trigger must name literal
 * branches that exclude the probe branch (or be tag-only); an unfiltered push, a `branches-ignore`
 * filter, a glob, or any induced event refuses — this runs before the probe ref ever exists.
 */
export function inducedAutomation(docs) {
  const findings = [];
  for (const [file, doc] of Object.entries(docs)) {
    if (file === PROBE_WORKFLOW_PATH) continue;
    const on = doc?.on ?? doc?.[true];
    const events = typeof on === "string" ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((name) => [name, null])) : (isPlainObject(on) ? on : null);
    if (!events) { findings.push(`${file}: triggers are unreadable`); continue; }
    for (const [event, filter] of Object.entries(events)) {
      if (INDUCED_EVENTS.includes(event)) findings.push(`${file}: listens on ${event}`);
      if (event !== "push") continue;
      const branches = isPlainObject(filter) ? filter.branches : undefined;
      const tags = isPlainObject(filter) ? filter.tags : undefined;
      if (isPlainObject(filter) && (filter["branches-ignore"] !== undefined || filter["tags-ignore"] !== undefined)) findings.push(`${file}: push uses an ignore filter`);
      else if (branches === undefined && tags !== undefined) continue;
      else if (!Array.isArray(branches)) findings.push(`${file}: push has no literal branch filter`);
      else if (branches.some((name) => typeof name !== "string" || /[*?[\]!+]/.test(name))) findings.push(`${file}: push branch filter is a pattern`);
      else if (branches.includes(PROBE_BRANCH)) findings.push(`${file}: push fires on the probe branch`);
    }
  }
  return findings;
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. Probe intent, descriptors, journal lifecycle — the offline half.
// ──────────────────────────────────────────────────────────────────────────────

/** The probe intent, parsed and checked against the trusted commissioning identity. */
export function parseProbeIntent(intent, { commissioning }) {
  assertClosed(intent, PROBE_INTENT_FIELDS, "the probe intent");
  if (intent.probe_intent_schema_version !== PROBE_INTENT_SCHEMA_VERSION) refuse("the probe intent declares an unknown schema version");
  assertClosed(intent.commissioning, COMMISSIONING_IDENTITY_FIELDS, "the probe intent's commissioning identity");
  equalOrRefuse(intent.commissioning, commissioning, "the probe intent's commissioning identity");
  assertClosed(intent.probe, PROBE_INTENT_PROBE_FIELDS, "the probe intent's probe");
  equalOrRefuse(intent.probe, { workflow_path: PROBE_WORKFLOW_PATH, ref: PROBE_REF, workflow_sha: commissioning.workflow_sha, attempt: PROBE_ATTEMPT }, "the probe intent's probe");
  if (!Array.isArray(intent.environments) || intent.environments.length !== PROBE_JOBS.length) refuse("the probe intent does not map exactly the two protected environments");
  const environments = {};
  for (const [index, entry] of intent.environments.entries()) {
    assertClosed(entry, PROBE_INTENT_ENVIRONMENT_FIELDS, `probe intent environment ${index + 1}`);
    const spec = PROBE_JOBS[index];
    if (entry.environment !== spec.environment || entry.job_key !== spec.job_key) refuse("the probe intent's environment mapping is not the fixed job mapping");
    environments[entry.environment] = decimalString(entry.environment_id, `the probe intent's ${entry.environment} id`);
  }
  if (environments[PROBE_ENVIRONMENTS[0]] === environments[PROBE_ENVIRONMENTS[1]]) refuse("the probe intent maps both environments to one numeric identity");
  assertClosed(intent.baseline_policy, PROBE_ENVIRONMENTS, "the probe intent's baseline policy references");
  for (const environment of PROBE_ENVIRONMENTS) assertClosed(intent.baseline_policy[environment], ARTIFACT_REF_FIELDS, `the ${environment} baseline reference`);
  assertClosed(intent.dispatcher, ACTOR_FIELDS, "the probe intent's dispatcher");
  equalOrRefuse(intent.dispatcher, PROBE_DISPATCHER, "the probe intent's dispatcher");
  timeOf(intent.staged_at, "the probe intent's staged_at");
  assertClosed(intent.journal, PROBE_INTENT_JOURNAL_FIELDS, "the probe intent's journal reference");
  if (typeof intent.journal.artifact !== "string" || !ARTIFACT_NAME.test(intent.journal.artifact)) refuse("the probe intent's journal reference is not a plain basename");
  return { environments, staged_ms: Date.parse(intent.staged_at) };
}

/** One environment policy descriptor → its normalised policy and the capture interval. */
export function readPolicyDescriptor(dir, ref, { environment, phase }) {
  const descriptor = readDescriptor(dir, ref, `the ${environment} ${phase} policy descriptor`);
  assertClosed(descriptor, CAPTURE_DESCRIPTORS["environment-policy"].fields, `the ${environment} ${phase} policy descriptor`);
  if (descriptor.capture_schema_version !== CAPTURE_SCHEMA_VERSION || descriptor.kind !== "environment-policy") refuse(`the ${environment} ${phase} policy descriptor is not a version-1 policy capture`);
  if (descriptor.phase !== phase || descriptor.environment !== environment) refuse(`the ${environment} ${phase} policy descriptor describes ${descriptor.environment} ${descriptor.phase}`);
  const settings = readRaw(dir, assertClosed(descriptor.settings, RAW_REF_FIELDS, "a settings capture"), `the ${environment} ${phase} settings`, RAW_REF_FIELDS);
  const branchPages = readPages(dir, descriptor.branch_policies, `the ${environment} ${phase} branch policies`);
  const policy = assertPolicyAgreesWithCommissioning(parseEnvironmentPolicy({ settings: settings.body, branchPages }, { environment }), environment);
  const intervals = [settings, ...branchPages];
  return { policy, started: Math.min(...intervals.map((entry) => entry.started)), completed: Math.max(...intervals.map((entry) => entry.completed)) };
}

/** Read and closed-check every probe journal record's payload. */
export function checkProbeJournalShape(records) {
  for (const record of records) {
    if (!PROBE_JOURNAL_EVENT_TYPES.includes(String(record.type))) refuse(`the probe journal carries the unknown event ${JSON.stringify(record.type)}`);
    assertProbeEventPayload(record.type, record.data);
  }
  return records;
}

/**
 * Every intent RESOLVED: a result, or an explicit reconciliation of that intent, after it. Anything
 * else is an unknown outcome, and an unknown outcome is never a passing lifecycle.
 */
export function unresolvedProbeIntents(records) {
  const open = [];
  for (const [index, record] of records.entries()) {
    const resultType = PROBE_INTENT_PAIRS[record.type];
    if (!resultType) continue;
    const later = records.slice(index + 1);
    const nextIntent = later.findIndex((entry) => entry.type === record.type);
    const window = nextIntent >= 0 ? later.slice(0, nextIntent) : later;
    const resolved = window.some((entry) => entry.type === resultType
      || (entry.type === "reconciliation" && entry.data?.of === record.type));
    if (!resolved) open.push({ seq: record.seq, type: record.type });
  }
  return open;
}

const only = (records, type, label) => {
  const matches = records.filter((record) => record.type === type);
  if (matches.length !== 1) refuse(`the probe journal records ${matches.length} ${label ?? type} event(s), not exactly one`);
  return matches[0];
};

/**
 * The COMPLETE, RECONCILED lifecycle of the owned probe, from its own verified chain.
 * Returns the facts the observation must agree with. Any gap refuses.
 */
export function assessProbeLifecycle(records, { intentSha256, intentArtifact, commissioning, workflowSha }) {
  if (!records.length) refuse("the probe journal is absent or empty");
  checkProbeJournalShape(records);
  const foreign = records.filter((record) => String(record.source) !== String(workflowSha));
  if (foreign.length) refuse(`${foreign.length} probe journal record(s) were written against a different immutable source`);
  if (records[0].type !== "probe-opened") refuse("the probe journal does not begin with its opening record");
  equalOrRefuse(records[0].data, {
    intent_artifact: intentArtifact, intent_sha256: intentSha256,
    commissioning_run_id: commissioning.run_id, commissioning_attempt: commissioning.attempt,
  }, "the probe journal's opening binding");
  const open = unresolvedProbeIntents(records);
  if (open.length) refuse(`${open.length} probe intent(s) have no result or reconciliation (${open.map((entry) => `${entry.type}#${entry.seq}`).join(", ")})`);

  const registration = only(records, "registration-verified");
  if (registration.data.source_sha256 !== PROBE_WORKFLOW_SHA256 || registration.data.workflow_state !== "active") refuse("the registered probe workflow is not the reviewed active source");
  const automation = only(records, "automation-inspected");
  if (!Array.isArray(automation.data.induced) || automation.data.induced.length) refuse("the probe ref lifecycle was found to induce other automation");

  const create = only(records, "ref-create-intent");
  equalOrRefuse(create.data, { ref: PROBE_REF, sha: workflowSha }, "the probe ref create intent");
  const absentBefore = records.filter((record) => record.type === "ref-absent-verified" && record.seq < create.seq);
  if (!absentBefore.length || absentBefore.some((record) => record.data.http_status !== 404 || record.data.response_complete !== true)) {
    refuse("the probe ref was not measured absent before it was created");
  }
  const created = only(records, "ref-create-result");
  if (created.seq < create.seq || created.data.http_status !== 201 || created.data.response_complete !== true || created.data.object_sha !== workflowSha) {
    refuse("the probe ref's creation is not a complete 201 at the reviewed source; ownership is not established");
  }
  const readback = records.find((record) => record.type === "ref-readback" && record.seq > created.seq);
  if (!readback || readback.data.http_status !== 200 || readback.data.response_complete !== true || readback.data.object_sha !== workflowSha) {
    refuse("the created probe ref has no complete readback at the reviewed source");
  }
  const dispatch = only(records, "dispatch-intent");
  equalOrRefuse({ workflow_file: dispatch.data.workflow_file, ref: dispatch.data.ref }, { workflow_file: PROBE_WORKFLOW_FILE, ref: PROBE_BRANCH }, "the probe dispatch intent");
  if (dispatch.seq < readback.seq) refuse("the probe was dispatched before its ref was read back");
  const dispatchMs = timeOf(dispatch.ts, "the dispatch intent time");
  // The operator computes the deadline from its clock read immediately BEFORE the durable append, so
  // it can only be at or before ten minutes from the record's own time — never later. The stricter
  // of the two bounds governs; a deadline that would extend the window refuses.
  const deadlineMs = timeOf(dispatch.data.deadline_at, "the dispatch deadline");
  if (deadlineMs > dispatchMs + DISPATCH_DEADLINE_MS || deadlineMs < dispatchMs + DISPATCH_DEADLINE_MS - 60_000) {
    refuse("the dispatch deadline is not ten minutes from the durable dispatch intent");
  }
  const dispatched = only(records, "dispatch-result");
  if (dispatched.data.response_complete === true && dispatched.data.http_status !== 204) refuse("the provider refused the probe dispatch");
  if (records.some((record) => record.type === "run-unidentified")) refuse("the probe run could not be identified uniquely");
  const identified = only(records, "run-identified");
  if (identified.data.eligible !== 1) refuse("the probe run was not the single eligible run");
  const terminal = only(records, "run-terminal");
  if (terminal.data.run_id !== identified.data.run_id || terminal.data.run_attempt !== 1 || terminal.data.status !== "completed" || terminal.data.conclusion !== "failure") {
    refuse("the probe run's journaled terminal state is not a completed failure of attempt 1");
  }
  if (records.some((record) => record.type === "cancel-intent")) refuse("the probe run was cancelled; a cancellation is inconclusive, never a refusal");
  for (const record of records.filter((entry) => entry.type === "observation-recorded")) {
    if (record.data.outcome !== "refused") refuse(`the collector recorded ${record.data.environment} as ${record.data.outcome}`);
  }
  const cleanupIntents = records.filter((record) => record.type === "cleanup-intent");
  if (!cleanupIntents.length) refuse("the owned probe ref has no cleanup intent");
  for (const intent of cleanupIntents) equalOrRefuse(intent.data, { ref: PROBE_REF, expected_sha: workflowSha }, "a probe cleanup intent");
  const absent = records.filter((record) => record.type === "absence-verified");
  const lastAbsent = absent[absent.length - 1];
  if (!lastAbsent || lastAbsent.data.http_status !== 404 || lastAbsent.data.response_complete !== true || lastAbsent.seq < cleanupIntents[0].seq) {
    refuse("the owned probe ref's absence was not verified after cleanup");
  }
  if (records.some((record) => record.type === "cleanup-result" && record.data.outcome === "lease-refused")) refuse("the owned probe ref changed and its cleanup was refused");
  const closed = only(records, "probe-closed");
  if (closed.seq !== records[records.length - 1].seq || closed.data.outcome !== "measured") refuse("the probe journal is not closed as a measured probe");
  const policies = records.filter((record) => record.type === "policy-captured");
  return {
    run_id: identified.data.run_id, dispatch_ms: dispatchMs, deadline_ms: deadlineMs,
    selection: identified.data.descriptor, cleanup_confirmed_ms: timeOf(lastAbsent.data.measured_at, "the absence readback time"),
    cleanup_intent_ms: timeOf(cleanupIntents[0].ts, "the cleanup intent time"),
    captures: records.filter((record) => record.type === "capture-recorded").map((record) => record.data),
    policies: policies.map((record) => ({ ...record.data, seq: record.seq })), dispatch_seq: dispatch.seq,
    observations: records.filter((record) => record.type === "observation-recorded").map((record) => record.data),
    created_ms: timeOf(readback.data.measured_at, "the ref readback time"),
  };
}

/**
 * Verify every raw capture behind ONE environment's observation and re-derive the refusal.
 * Used by the collector BEFORE it writes an observation, and again by the offline assessment.
 */
export function verifyProbeCaptures(dir, { providerEvidence, environment, commissioning, runId, dispatchMs, deadlineMs }) {
  const spec = PROBE_JOBS.find((entry) => entry.environment === environment);
  if (!spec) refuse(`${environment} is not a probe environment`);
  assertClosed(providerEvidence, PROVIDER_EVIDENCE_FIELDS, "the provider evidence references");
  const workflowSha = commissioning.workflow_sha;

  const runDescriptor = readDescriptor(dir, providerEvidence.run, "the run descriptor");
  assertClosed(runDescriptor, CAPTURE_DESCRIPTORS.run.fields, "the run descriptor");
  if (runDescriptor.capture_schema_version !== CAPTURE_SCHEMA_VERSION || runDescriptor.kind !== "run") refuse("the run descriptor is not a version-1 run capture");
  const runInitial = readRaw(dir, runDescriptor.initial, "the run capture", RAW_REF_FIELDS);
  const runTerminal = readRaw(dir, runDescriptor.terminal, "the run terminal re-read", RAW_REF_FIELDS);
  const expectRun = { runId, repositoryId: commissioning.repository_id, workflowSha };
  const run = parseProbeRun(runInitial.body, expectRun);
  equalOrRefuse(parseProbeRun(runTerminal.body, expectRun), run, "the run terminal re-read");

  const jobsDescriptor = readDescriptor(dir, providerEvidence.jobs, "the jobs descriptor");
  assertClosed(jobsDescriptor, CAPTURE_DESCRIPTORS.jobs.fields, "the jobs descriptor");
  if (jobsDescriptor.capture_schema_version !== CAPTURE_SCHEMA_VERSION || jobsDescriptor.kind !== "jobs") refuse("the jobs descriptor is not a version-1 jobs capture");
  const jobPages = readPages(dir, jobsDescriptor.pages, "the jobs listing");
  const jobs = parseProbeJobs(jobPages, { runId, workflowSha });
  const job = jobs[spec.job_key];

  const denial = readDescriptor(dir, providerEvidence.denial, "the denial descriptor");
  assertClosed(denial, DENIAL_DESCRIPTOR_FIELDS, "the denial descriptor");
  if (denial.diagnostic_schema_version !== DIAGNOSTIC_SCHEMA_VERSION) refuse("the denial descriptor declares an unknown diagnostic schema version");
  if (denial.check_id !== job.check_id) refuse("the denial descriptor names a check that is not this job's own check run");
  assertClosed(denial.check, CHECK_CAPTURE_FIELDS, "the denial check capture");
  const { terminal: checkTerminalRef, ...checkInitialRef } = denial.check;
  const checkInitial = readRaw(dir, checkInitialRef, "the check capture", RAW_REF_FIELDS);
  const checkTerminal = readRaw(dir, checkTerminalRef, "the check terminal re-read", RAW_REF_FIELDS);
  const checkExpect = { checkId: job.check_id, job, run, environment, workflowSha };
  const check = parseProbeCheck(checkInitial.body, checkExpect);
  equalOrRefuse(parseProbeCheck(checkTerminal.body, checkExpect), check, "the check terminal re-read");
  const annotationPages = readPages(dir, denial.annotations, "the annotations listing");
  parseDiagnosticAnnotations(annotationPages, { branch: PROBE_BRANCH, environment, sha: workflowSha });

  // THE ORIGINAL ORDER. Provider facts first, then every capture after the provider's own terminal
  // time, then the terminal re-reads after everything they re-check. No skew allowance, no repair.
  const floorDispatch = Math.floor(dispatchMs / 1000) * 1000;
  if (run.created_ms < floorDispatch) refuse("the probe run was created before its durable dispatch intent");
  if (Date.parse(job.started_at) < run.created_ms) refuse("the probe job started before its run existed");
  if (job.completed_ms > deadlineMs) refuse("the probe job reached its terminal state after the ten-minute deadline");
  const captures = [runInitial, runTerminal, ...jobPages, checkInitial, checkTerminal, ...annotationPages];
  if (captures.some((capture) => capture.started < job.completed_ms)) refuse("a provider capture began before the provider's own terminal time for this job");
  const reread = Math.max(...jobPages.map((page) => page.completed), checkInitial.completed, ...annotationPages.map((page) => page.completed), runInitial.completed);
  if (runTerminal.started < reread || checkTerminal.started < Math.max(checkInitial.completed, ...annotationPages.map((page) => page.completed))) {
    refuse("a terminal consistency re-read did not follow the captures it re-checks");
  }
  return {
    run, job, check, all_jobs: jobs,
    captured_completed_ms: Math.max(...captures.map((capture) => capture.completed)),
    captured_started_ms: Math.min(...captures.map((capture) => capture.started)),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 8. The variant validator the commissioning assessment dispatches to.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Validate ONE environment's cross-run off-branch record. Returns `null` when it is acceptable as
 * verified, or the reason it is not.
 *
 * `trusted` comes ONLY from the assessor: the commissioning identity recomputed from the original
 * intent, the verified resource journal, the probe journal read here, this run's window, and the
 * collected approvals. No field of the record or its observation supplies an expectation.
 */
export function validateOffBranchRecord(record, { dir, environment, environmentId = null, expected, trusted, readProbeJournal }) {
  try {
    assertClosed(record, OFFBRANCH_RECORD_FIELDS, "the cross-run off-branch record");
    if (record.offbranch_schema_version !== OFFBRANCH_SCHEMA_VERSION) refuse("declares an unknown off-branch schema version");
    if (record.status !== "verified") return `is ${String(record.status || "absent")}`;
    if (record.source !== "provider-api") {
      refuse(`names the source ${JSON.stringify(record.source)}; only API-derived denial evidence has a reviewed closed schema in this build, so UI denial evidence stays unverified`);
    }
    const { commissioning, window, resourceJournal, approvals } = trusted ?? {};
    if (!commissioning || !resourceJournal?.length || !window?.start || !window?.end) refuse("has no trusted commissioning identity, verified journal and window to be validated against");
    assertClosed(record.commissioning, COMMISSIONING_IDENTITY_FIELDS, "the record's commissioning identity");
    equalOrRefuse(record.commissioning, commissioning, "the record's commissioning identity");
    if (record.environment_name !== environment) refuse(`was measured on ${JSON.stringify(record.environment_name)}, not ${environment}`);
    decimalString(record.environment_id, "the record's environment id");
    equalOrRefuse(record.expected, expected, "the record's expected outcome");
    equalOrRefuse(record.measured, expected, "the record's measured outcome");
    decimalString(record.run_id, "the record's probe run id");
    if (record.run_id === commissioning.run_id) refuse("names the original commissioning run as the producing probe; the probe is a distinct run");
    if (record.attempt !== PROBE_ATTEMPT) refuse(`names probe attempt ${JSON.stringify(record.attempt)}; only the original attempt 1 of the probe counts`);

    // The retained observation owns its provenance; the wrapper may only repeat it.
    const observationBytes = readRetained(dir, { artifact: record.artifact, sha256: record.artifact_sha256 }, { maxBytes: MAX_OBSERVATION_BYTES, label: "the observation" });
    const observation = parseJsonBytes(observationBytes, "the observation");
    assertClosed(observation, OFFBRANCH_OBSERVATION_FIELDS, "the observation");
    if (observation.offbranch_schema_version !== OFFBRANCH_SCHEMA_VERSION || observation.control !== OFFBRANCH_CONTROL) refuse("the observation is not a version-1 off-branch observation");
    for (const [wrapperField, observationField] of [["source", "source"], ["environment_name", "environment"], ["environment_id", "environment_id"],
      ["measured_at", "measured_at"], ["measured", "measured"], ["run_id", "run_id"], ["attempt", "attempt"], ["commissioning", "commissioning"]]) {
      equalOrRefuse(record[wrapperField], observation[observationField], `the wrapper's ${wrapperField} against its observation`);
    }
    if (environmentId !== null && observation.environment_id !== String(environmentId)) refuse(`the observation's environment id is not ${environmentId}`);
    const measuredMs = timeOf(observation.measured_at, "the observation's measured_at");

    // THE PRIOR LINK: exactly one staged-probe record in the ORIGINAL attempt's resource journal.
    const links = resourceJournal.filter((entry) => entry.type === RESOURCE_LINK_EVENT);
    if (links.length !== 1) refuse(`the original attempt's journal records ${links.length} staged probe link(s), not exactly one`);
    const link = links[0];
    assertClosed(link.data, RESOURCE_LINK_FIELDS, "the staged probe link");
    assertClosed(observation.probe_intent, ARTIFACT_REF_FIELDS, "the observation's probe intent reference");
    if (link.data.intent_artifact !== observation.probe_intent.artifact || link.data.intent_sha256 !== observation.probe_intent.sha256) {
      refuse("the observation's probe intent is not the one linked into the original attempt's journal");
    }
    const intent = parseJsonBytes(readRetained(dir, observation.probe_intent, { maxBytes: MAX_OBSERVATION_BYTES, label: "the probe intent" }), "the probe intent");
    const parsedIntent = parseProbeIntent(intent, { commissioning });
    if (link.data.probe_journal !== intent.journal.artifact) refuse("the staged link and the probe intent name different probe journals");
    if (parsedIntent.environments[environment] !== observation.environment_id) refuse("the observation's environment id is not the one the probe intent staged");
    const linkMs = timeOf(link.ts, "the staged link time");
    if (parsedIntent.staged_ms > linkMs) refuse("the probe intent claims to be staged after it was linked");

    const probeRecords = readProbeJournal();
    const lifecycle = assessProbeLifecycle(probeRecords, {
      intentSha256: observation.probe_intent.sha256, intentArtifact: observation.probe_intent.artifact, commissioning, workflowSha: commissioning.workflow_sha,
    });
    if (lifecycle.run_id !== observation.run_id) refuse("the observation's probe run is not the run the probe journal identified");
    // The ownership chain opens after the link, never before it: a pre-existing chain cannot adopt it.
    if (timeOf(probeRecords[0].ts, "the probe journal opening") < linkMs) refuse("the probe journal was opened before the intent was linked");
    const createIntent = probeRecords.find((entry) => entry.type === "ref-create-intent");
    if (timeOf(createIntent.ts, "the ref create intent time") < linkMs) refuse("the probe ref was created before the probe intent was linked into the original journal");

    // The selection: exactly one eligible run, recomputed from the retained listing.
    const selection = readDescriptor(dir, lifecycle.selection, "the run-selection descriptor");
    assertClosed(selection, CAPTURE_DESCRIPTORS["run-selection"].fields, "the run-selection descriptor");
    if (selection.capture_schema_version !== CAPTURE_SCHEMA_VERSION || selection.kind !== "run-selection") refuse("the run-selection descriptor is not a version-1 selection capture");
    const eligible = selectEligibleRuns(readPages(dir, selection.pages, "the run-selection listing"), { dispatchIntentMs: lifecycle.dispatch_ms, deadlineMs: lifecycle.deadline_ms });
    if (eligible.length !== 1 || eligible[0] !== observation.run_id) refuse(`the retained run listing shows ${eligible.length} eligible probe run(s); exactly the one observed run is required`);

    // THE PROVIDER EVIDENCE, re-parsed; the refusal is DERIVED here, never read.
    const captured = verifyProbeCaptures(dir, {
      providerEvidence: observation.provider_evidence, environment, commissioning, runId: observation.run_id,
      dispatchMs: lifecycle.dispatch_ms, deadlineMs: lifecycle.deadline_ms,
    });
    assertClosed(observation.probe, PROBE_IDENTITY_FIELDS, "the observation's probe identity");
    assertClosed(observation.probe.actor, ACTOR_FIELDS, "the probe actor");
    assertClosed(observation.probe.triggering_actor, ACTOR_FIELDS, "the probe triggering actor");
    const spec = PROBE_JOBS.find((entry) => entry.environment === environment);
    equalOrRefuse(observation.probe, {
      workflow_path: PROBE_WORKFLOW_PATH, workflow_sha: commissioning.workflow_sha, ref: PROBE_REF, event: PROBE_EVENT,
      job_key: spec.job_key, job_id: captured.job.job_id, actor: PROBE_DISPATCHER, triggering_actor: PROBE_DISPATCHER,
      created_at: captured.run.created_at, terminal_at: captured.job.completed_at,
    }, "the observation's probe identity");
    // The same provider evidence the collector journaled — never a substitute capture.
    const journaled = (kind) => lifecycle.captures.filter((entry) => entry.kind === kind && (kind === "denial" ? entry.environment === environment : true));
    for (const [kind, ref] of [["run", observation.provider_evidence.run], ["jobs", observation.provider_evidence.jobs], ["denial", observation.provider_evidence.denial]]) {
      const matches = journaled(kind);
      if (matches.length !== 1 || canonicalJson(matches[0].descriptor) !== canonicalJson(ref)) refuse(`the observation's ${kind} evidence is not the single capture the probe journal recorded`);
    }

    // THE POLICY: baseline (in the intent), before dispatch, after capture — equal, complete, agreeing.
    const baseline = readPolicyDescriptor(dir, intent.baseline_policy[environment], { environment, phase: "baseline" });
    const before = readPolicyDescriptor(dir, observation.provider_evidence.environment_before, { environment, phase: "before" });
    const after = readPolicyDescriptor(dir, observation.provider_evidence.environment_after, { environment, phase: "after" });
    for (const [label, entry] of [["before", before], ["after", after]]) {
      equalOrRefuse(entry.policy, baseline.policy, `the ${environment} ${label}-probe policy against the staged baseline`);
      const matches = lifecycle.policies.filter((policy) => policy.phase === label && policy.environment === environment);
      if (matches.length !== 1 || canonicalJson(matches[0].descriptor) !== canonicalJson(observation.provider_evidence[`environment_${label}`])) {
        refuse(`the ${environment} ${label}-probe policy is not the single capture the probe journal recorded`);
      }
      if (label === "before" && matches[0].seq > lifecycle.dispatch_seq) refuse(`the ${environment} before-probe policy was captured after dispatch`);
    }
    if (baseline.policy.environment_id !== observation.environment_id) refuse("the staged baseline measured a different numeric environment");

    // THE ORIGINAL ORDER, end to end, inside the original run's window.
    const windowStart = Date.parse(window.start);
    const windowEnd = Date.parse(window.end);
    const ordered = [
      ["the commissioning window opening", windowStart],
      ["the baseline policy capture", baseline.completed],
      ["the probe intent staging", parsedIntent.staged_ms],
      ["the staged link", linkMs],
      ["the before-probe policy capture", before.completed],
      ["the durable dispatch intent", lifecycle.dispatch_ms],
      ["the terminal provider capture", captured.captured_completed_ms],
      ["the after-probe policy capture start", after.started],
      ["the after-probe policy capture", after.completed],
      ["the observation's capture completion", measuredMs],
      ["the confirmed cleanup", lifecycle.cleanup_confirmed_ms],
      ["the assessment", windowEnd],
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index][1] < ordered[index - 1][1]) refuse(`${ordered[index][0]} precedes ${ordered[index - 1][0]}; the original ordering is impossible`);
    }
    if (baseline.started < windowStart) refuse("the staged baseline predates the commissioning window");
    if (lifecycle.cleanup_intent_ms < after.completed) refuse("cleanup began before the after-probe policy was captured");
    const recorded = lifecycle.observations.filter((entry) => entry.environment === environment);
    if (recorded.length !== 1 || recorded[0].artifact !== record.artifact || recorded[0].sha256 !== record.artifact_sha256 || recorded[0].measured_at !== observation.measured_at) {
      refuse("the observation is not the one the collector recorded in the probe journal");
    }
    // PRE-APPROVAL: staged, measured and cleaned while the original protected jobs were unapproved.
    for (const reviewer of Object.values(approvals?.environments ?? {}).flatMap((entry) => (Array.isArray(entry?.reviewers) ? entry.reviewers : []))) {
      const approvedAt = Date.parse(String(reviewer?.approved_at ?? ""));
      if (Number.isFinite(approvedAt) && approvedAt <= lifecycle.cleanup_confirmed_ms) {
        refuse("an original protected job was approved before the probe was measured and cleaned; the probe must complete while the original attempt is unapproved");
      }
    }
    return null;
  } catch (error) {
    if (error instanceof ProbeRefusal) return error.message;
    throw error;
  }
}

/**
 * The two environments' records, together: separate observation files and digests, distinct
 * environment and job identities, one probe run and one probe intent. One file cannot serve both.
 */
export function crossCheckOffBranchPair(records, dir) {
  const problems = [];
  const variant = PROBE_ENVIRONMENTS.map((environment) => records?.[environment]).filter((record) => isPlainObject(record) && Object.hasOwn(record, "offbranch_schema_version"));
  if (!variant.length) return problems;
  if (variant.length !== PROBE_ENVIRONMENTS.length) {
    problems.push("only one protected environment carries a cross-run off-branch record; both must be measured by the same staged probe");
    return problems;
  }
  const [first, second] = variant;
  if (first.artifact === second.artifact || first.artifact_sha256 === second.artifact_sha256) problems.push("the two environments reuse one off-branch observation");
  if (first.environment_id === second.environment_id) problems.push("the two environments' off-branch observations share one numeric environment ID");
  if (first.run_id !== second.run_id) problems.push("the two environments' off-branch observations name different probe runs");
  try {
    const read = (record) => parseJsonBytes(readRetained(dir, { artifact: record.artifact, sha256: record.artifact_sha256 }, { maxBytes: MAX_OBSERVATION_BYTES, label: "an observation" }), "an observation");
    const a = read(first);
    const b = read(second);
    if (canonicalJson(a.probe_intent) !== canonicalJson(b.probe_intent)) problems.push("the two environments' off-branch observations name different probe intents");
    if (a.probe?.job_id === b.probe?.job_id) problems.push("the two environments' off-branch observations name the same probe job");
    if (canonicalJson(a.provider_evidence?.denial) === canonicalJson(b.provider_evidence?.denial)) problems.push("the two environments share one denial capture");
  } catch (error) {
    if (!(error instanceof ProbeRefusal)) throw error;
    // An unreadable observation is already a per-environment blocker; nothing to add here.
  }
  return problems;
}

/** The trusted commissioning identity object, derived from the original intent the assessor verified. */
export function commissioningIdentity({ intent, runId, attempt, repository, workflowPath }) {
  return {
    repository, repository_id: String(intent.repository_id), run_id: String(runId), attempt: String(attempt),
    workflow_path: workflowPath, workflow_sha: String(intent.workflow_sha), intent_sha256: canonicalHash(intent),
  };
}
