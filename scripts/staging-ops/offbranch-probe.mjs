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
/** A retained, hash-valid provider listing that cannot establish a complete qualification view. */
export class ProbeProviderIncomplete extends ProbeRefusal {
  constructor(category, message) {
    super(message);
    this.name = "ProbeProviderIncomplete";
    this.category = category;
  }
}
const refuse = (message) => { throw new ProbeRefusal(message); };
const providerIncomplete = (category, message) => { throw new ProbeProviderIncomplete(category, message); };

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
  "original-identity-bound": Object.freeze(["capture"]),
  "original-identity-observed": Object.freeze(["capture"]),
  "capture-progress": Object.freeze(["run_id", "kind", "page", "capture"]),
  "capture-failed": Object.freeze(["run_id", "phase", "category", "capture_sequences"]),
  "qualification-incomplete": Object.freeze(["phase", "category", "observed_at"]),
  "qualification-ended": Object.freeze(["run_id", "reason", "terminal_sequence"]),
  "admission-observed": Object.freeze(["run_id", "environment", "job_id", "run_capture", "jobs_descriptor"]),
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
  "run-selection-observed": Object.freeze(["selection_id", "boundary", "page", "capture"]),
  "run-identified": Object.freeze(["run_id", "eligible", "descriptor"]),
  "run-unidentified": Object.freeze(["eligible", "descriptor", "reason"]),
  "run-observed": Object.freeze(["run_id", "boundary", "capture"]),
  "lock-recovered": Object.freeze(["replaced_owner", "intent_sha256", "reconciled_intents"]),
  "run-terminal": Object.freeze(["run_id", "run_attempt", "status", "conclusion", "observed_at"]),
  "cancel-intent": Object.freeze(["run_id", "reason"]),
  "cancel-result": Object.freeze(["run_id", ...RESPONSE_FACTS]),
  "capture-recorded": Object.freeze(["kind", "environment", "descriptor", "completed_at"]),
  "observation-recorded": Object.freeze(["environment", "outcome", "artifact", "sha256", "measured_at", "reason"]),
  "cleanup-intent": Object.freeze(["ref", "expected_sha"]),
  "cleanup-result": Object.freeze(["ref", "expected_sha", "outcome", "exit_code"]),
  "absence-verified": Object.freeze(["ref", ...RESPONSE_FACTS, "measured_at"]),
  reconciliation: Object.freeze(["of", "outcome", "object_sha", "measured_at"]),
  // The measured live source, KEPT (R05-F2). `observe` mode reports a move instead of throwing so
  // that cleanup can still remove what the run created; the report is worthless unless the phase
  // that took it writes it into the bound history, which is what this event is.
  "source-observed": Object.freeze(["phase", "mode", "moved", "staging_sha", "trusted_source_sha", "measured_at"]),
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
export const SOURCE_OBSERVED_EVENT = "source-observed";
export const CLEANUP_OUTCOMES = Object.freeze(["deleted", "lease-refused", "ambiguous"]);
export const OBSERVATION_OUTCOMES = Object.freeze(["refused", "admitted", "unverified"]);
export const PROBE_CLOSED_OUTCOMES = Object.freeze(["measured", "inconclusive", "failed"]);
export const RECONCILIATION_OUTCOMES = Object.freeze(["absent", "present-unchanged", "present-ownership-uncertain", "present-changed"]);

/** Refuse a probe journal payload whose field set is not EXACTLY its event's. */
export function assertProbeEventPayload(type, data) {
  const fields = PROBE_JOURNAL_EVENTS[String(type)];
  if (!fields) refuse(`unknown probe journal event ${JSON.stringify(String(type))}`);
  assertClosed(data, fields, `the ${type} payload`);
  if (["original-identity-bound", "original-identity-observed"].includes(type)) assertClosed(data.capture, RAW_REF_FIELDS, "the original identity capture");
  if (["capture-progress", "capture-failed", "qualification-ended", "admission-observed"].includes(type)) decimalString(data.run_id, "the capture run identity");
  if (type === "capture-progress") {
    if (!["run", "jobs", "check", "annotations", "terminal"].includes(data.kind)) refuse("unknown capture progress kind");
    positiveInt(data.page, "the capture progress page");
    assertClosed(data.capture, RAW_REF_FIELDS, "the retained partial capture");
  }
  if (type === "capture-failed") {
    if (data.phase !== "collect" || !["run", "jobs", "denial", "terminal", "policy", "derivation"].includes(data.category)) refuse("unknown capture failure disposition");
    if (!Array.isArray(data.capture_sequences) || data.capture_sequences.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) refuse("invalid capture failure references");
  }
  if (type === "qualification-incomplete") {
    if (!["stage", "dispatch", "collect", "cancel", "cleanup"].includes(data.phase)
      || !["source-unavailable", "source-invalid", "original-unavailable", "original-invalid", "original-inactive", "original-closed"].includes(data.category)) refuse("unknown qualification incompleteness category");
    timeOf(data.observed_at, "the qualification incompleteness time");
  }
  if (type === "qualification-ended") {
    if (data.reason !== "operator-terminal-abort") refuse("unknown qualification end reason");
    positiveInt(data.terminal_sequence, "the abort terminal evidence sequence");
  }
  if (type === "admission-observed") {
    if (!PROBE_ENVIRONMENTS.includes(data.environment)) refuse("unknown admitted environment");
    decimalString(data.job_id, "the admitted job identity");
    assertClosed(data.run_capture, RAW_REF_FIELDS, "the admission run capture");
    assertClosed(data.jobs_descriptor, ARTIFACT_REF_FIELDS, "the admission jobs descriptor");
  }
  if (type === "run-observed") {
    decimalString(data.run_id, "the observed run id");
    if (!["read", "cancel", "cleanup-entry", "delete", "closure"].includes(data.boundary)) refuse("unknown run observation boundary");
    assertClosed(data.capture, RAW_REF_FIELDS, "the run observation capture");
  }
  if (type === "run-selection-observed") {
    positiveInt(data.selection_id, "the run-selection observation id");
    positiveInt(data.page, "the run-selection observation page");
    if (!["peek", "listing"].includes(data.boundary)) refuse("unknown run-selection observation boundary");
    assertClosed(data.capture, RAW_REF_FIELDS, "the run-selection observation capture");
  }
  if (type === "lock-recovered") {
    assertClosed(data.replaced_owner, ["pid", "host", "acquired_at"], "the replaced lock owner");
    if (!SHA256_HEX.test(data.intent_sha256) || !Array.isArray(data.reconciled_intents)) refuse("invalid probe lock recovery binding");
    for (const intent of data.reconciled_intents) {
      assertClosed(intent, ["seq", "type"], "a recovered mutation binding");
      if (!Number.isSafeInteger(intent.seq) || intent.seq < 1 || !PROBE_INTENT_PAIRS[intent.type]) refuse("unknown recovered probe mutation");
    }
  }
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
function readRawEnvelope(dir, ref, label, fields) {
  const bytes = readRetained(dir, ref, { maxBytes: MAX_RAW_CAPTURE_BYTES, label, fields });
  const started = timeOf(ref.started_at, `${label} started_at`);
  const completed = timeOf(ref.completed_at, `${label} completed_at`);
  if (completed < started) refuse(`${label} completed before it started`);
  return { bytes, started, completed };
}
function readRaw(dir, ref, label, fields) {
  const { bytes, started, completed } = readRawEnvelope(dir, ref, label, fields);
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

/**
 * Validate the retained jobs page set for recovery admission. Descriptor/reference integrity is a
 * hard refusal; only the provider body's shape/count/pagination can be classified incomplete.
 */
export function readAdmissionJobPages(dir, pages, label = "the admission jobs") {
  if (!Array.isArray(pages) || !pages.length) refuse(`${label} retains no pages`);
  if (pages.length > MAX_PAGES) refuse(`${label} retains more than ${MAX_PAGES} pages`);
  const parsed = pages.map((ref, index) => {
    assertClosed(ref, PAGED_RAW_REF_FIELDS, `${label} page ${index + 1}`);
    if (ref.page !== index + 1) refuse(`${label} pages are not the contiguous sequence 1..${pages.length}`);
    const { page, ...raw } = ref;
    const capture = readRawEnvelope(dir, raw, `${label} page ${page}`, RAW_REF_FIELDS);
    let text;
    try { text = STRICT_UTF8.decode(capture.bytes); }
    catch { providerIncomplete("jobs-page-invalid-utf8", `${label} page ${page} is not valid UTF-8`); }
    let body;
    try { body = JSON.parse(text); }
    catch { providerIncomplete("jobs-page-invalid-json", `${label} page ${page} is not parseable JSON`); }
    if (!isPlainObject(body) || !Array.isArray(body.jobs)) {
      providerIncomplete("jobs-page-malformed", `${label} page ${page} is not the documented shape`);
    }
    if (!Number.isSafeInteger(body.total_count) || body.total_count < 0) {
      providerIncomplete("jobs-total-missing-or-invalid", `${label} page ${page} has no valid total_count`);
    }
    if (body.jobs.length > PAGE_SIZE) providerIncomplete("jobs-page-malformed", `${label} page ${page} exceeds the fixed page size`);
    return { page, body, started: capture.started, completed: capture.completed };
  });
  const total = parsed[0].body.total_count;
  if (parsed.some((page) => page.body.total_count !== total)) {
    providerIncomplete("jobs-total-mismatch", `${label} pages disagree about their total count`);
  }
  if (parsed.slice(0, -1).some((page) => page.body.jobs.length !== PAGE_SIZE)) {
    providerIncomplete("jobs-page-truncated", `${label} has a short non-terminal page`);
  }
  const rows = parsed.flatMap((page) => page.body.jobs);
  if (rows.length !== total) providerIncomplete("jobs-row-count-mismatch", `${label} listing is incomplete`);
  if (parsed.length !== Math.max(1, Math.ceil(total / PAGE_SIZE))) {
    providerIncomplete("jobs-terminal-page-missing", `${label} was not read to its terminal page`);
  }
  return { pages: parsed, rows };
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
 * The probe run's IMMUTABLE IDENTITY, established WITHOUT its terminal state.
 *
 * Selection, guard binding, recovery and the instant before a cancellation each need to know that a
 * run is OURS, and none of them can wait for it to be terminal. Keeping this separate from the
 * refusal parsing below is the whole point (R04-F1): the fixed workflow, ref, event and time window
 * are a COARSE selector — a run matching all four can still belong to a different dispatcher,
 * source, repository or attempt, and a cancellation aimed at it mutates somebody else's run.
 *
 * Every field here is immutable for the life of a run, so the same check holds while it is queued,
 * in progress and completed; a rerun moves `run_attempt` and is therefore refused rather than
 * silently followed.
 */
export function assertProbeRunIdentity(body, { runId, repositoryId, workflowSha }) {
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
  const createdAt = timeOf(body.created_at, "the probe run created_at");
  if (body.url !== `${repoApi()}/actions/runs/${id}`) refuse("the probe run's API URL is not its reconstructed route");
  if (body.html_url !== `${repoWeb()}/actions/runs/${id}`) refuse("the probe run's web URL is not its reconstructed route");
  return {
    run_id: String(id), run_attempt: 1, repository_id: body.repository.id, path: body.path, event: body.event,
    head_branch: body.head_branch, head_sha: body.head_sha, actor, triggering_actor: triggeringActor,
    created_at: body.created_at, created_ms: createdAt,
  };
}

/**
 * The probe RUN, from `GET /repos/{repo}/actions/runs/{R}`: its immutable identity PLUS the terminal
 * state a measurement needs. Returns the governing projection the terminal re-read must reproduce
 * exactly.
 */
export function parseProbeRun(body, { runId, repositoryId, workflowSha }) {
  const identity = assertProbeRunIdentity(body, { runId, repositoryId, workflowSha });
  if (body.status !== "completed") refuse(`the probe run is ${JSON.stringify(body.status)}, not completed`);
  if (body.conclusion !== "failure") refuse(`the probe run concluded ${JSON.stringify(body.conclusion)}; only a provider refusal (failure) can carry this measurement`);
  const checkSuiteId = positiveInt(body.check_suite_id, "the probe run check suite id");
  return { ...identity, status: body.status, conclusion: body.conclusion, check_suite_id: checkSuiteId };
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
 *
 * `identity` is REQUIRED and carries the trusted commissioning repository ID and source SHA
 * (R04-F1). The window, workflow, ref and event are only a coarse selector; a row that matches all
 * of them is a CANDIDATE, and a candidate becomes eligible only once its full immutable identity —
 * repository, source, attempt 1 and the measured dispatcher — is established from the listing's own
 * bytes. A candidate that fails that check is not quietly dropped in favour of a more convenient
 * row: it refuses the whole selection, because a run somebody else started on our fixed ref inside
 * our dispatch window is an ambiguity nobody can resolve by picking.
 */
export function selectEligibleRuns(pages, { dispatchIntentMs, deadlineMs, identity }) {
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
  return eligibleRunIds(rows, { dispatchIntentMs, deadlineMs, identity });
}

/** Validate every candidate in one authoritative selection response before any caller interprets it. */
function eligibleRunIds(rows, { dispatchIntentMs, deadlineMs, identity }) {
  if (!isPlainObject(identity) || !POSITIVE_DECIMAL.test(String(identity.repositoryId ?? "")) || !/^[0-9a-f]{40}$/.test(String(identity.workflowSha ?? ""))) {
    refuse("probe-run selection needs the trusted commissioning repository identity and source to establish ownership");
  }
  // Provider times are whole seconds; the intent is floored to its second rather than given any
  // positive allowance. A run the provider dates before that second is not attributable to it.
  const floor = Math.floor(dispatchIntentMs / 1000) * 1000;
  const candidates = rows.filter((row) => isPlainObject(row) && row.path === PROBE_WORKFLOW_PATH && row.head_branch === PROBE_BRANCH
    && row.event === PROBE_EVENT && Number.isFinite(Date.parse(String(row.created_at))) && Date.parse(String(row.created_at)) >= floor
    && Date.parse(String(row.created_at)) <= deadlineMs);
  return candidates.map((row) => {
    try {
      assertProbeRunIdentity(row, { runId: row.id, repositoryId: identity.repositoryId, workflowSha: identity.workflowSha });
    } catch (error) {
      if (!(error instanceof ProbeRefusal)) throw error;
      refuse(`a run on the fixed probe ref inside this dispatch window is not this probe's own run (${error.message}); nothing is selected and nothing is cancelled`);
    }
    return String(row.id);
  });
}

/**
 * Fold every retained pre-selection response, including observations rejected before a run ID was
 * chosen. A restored attempt/source/actor or a later smaller listing cannot erase a contradiction.
 * Partial listings are not treated as complete selection evidence, but identities actually present
 * in any retained page remain binding.
 */
export function assessRunSelectionContinuity(records, { dir, dispatchIntentMs, deadlineMs, identity }) {
  const groups = new Map();
  const eligibleAcrossHistory = new Set();
  for (const record of records ?? []) {
    if (record?.type !== "run-selection-observed") continue;
    assertProbeEventPayload(record.type, record.data);
    const captured = readRaw(dir, record.data.capture, "the retained run-selection observation", RAW_REF_FIELDS);
    if (captured.completed > timeOf(record.ts, "the run-selection observation journal time")) refuse("a run-selection observation was journaled before its capture completed");
    if (!isPlainObject(captured.body) || !Number.isSafeInteger(captured.body.total_count) || !Array.isArray(captured.body.workflow_runs)) {
      refuse(`run-selection ${record.data.boundary} page ${record.data.page} is not the documented shape`);
    }
    const eligible = eligibleRunIds(captured.body.workflow_runs, { dispatchIntentMs, deadlineMs, identity });
    const key = String(record.data.selection_id);
    const group = groups.get(key) ?? { selection_id: record.data.selection_id, boundary: record.data.boundary, pages: [], eligible: [] };
    if (group.boundary !== record.data.boundary || group.pages.some((page) => page.page === record.data.page)) {
      refuse("a retained run-selection observation reuses an id or page inconsistently");
    }
    group.pages.push({ page: record.data.page, ...record.data.capture });
    group.eligible.push(...eligible);
    groups.set(key, group);
    if (group.eligible.length > 1) refuse(`${group.eligible.length} eligible probe runs were observed before selection; none is selected, and the probe cannot pass`);
    for (const runId of eligible) eligibleAcrossHistory.add(runId);
    if (eligibleAcrossHistory.size > 1) {
      refuse(`${eligibleAcrossHistory.size} different eligible probe runs were observed across the original dispatch window; a later listing cannot replace the earlier candidate, so none is selected and the probe cannot pass`);
    }
  }
  return Object.freeze([...groups.values()].map((group) => Object.freeze({
    selection_id: group.selection_id, boundary: group.boundary,
    pages: Object.freeze([...group.pages].sort((a, b) => a.page - b.page)),
    eligible: Object.freeze([...group.eligible]),
  })));
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

/**
 * The probe workflow's REGISTRATION, re-established offline from its retained descriptor and the
 * RAW provider bytes behind it (R04-F3).
 *
 * Mandatory default-branch registration before the original baseline is a sequencing requirement of
 * the accepted design, so the journal's `workflow_id` / `workflow_state` / `workflow_created_at` /
 * `source_sha256` are ASSERTIONS THE COLLECTOR MADE, not evidence. This reads the descriptor and
 * both captures, re-hashes them through {@link readRetained}, decodes the registered source and
 * requires the reviewed digest, and requires the journal's four values to REPEAT what the bytes
 * carry. Missing, corrupt, substituted or out-of-order evidence refuses; nothing here is replaced
 * by another caller-supplied boolean.
 *
 * `windowStartMs` is the trusted original commissioning window opening: the workflow must have been
 * registered at or before it, and both captures must have been taken after it.
 */
export function verifyProbeRegistration(dir, record, { windowStartMs }) {
  const claimed = record?.data ?? {};
  const descriptor = readDescriptor(dir, assertClosed(claimed.descriptor, ARTIFACT_REF_FIELDS, "the registration descriptor reference"), "the registration descriptor");
  assertClosed(descriptor, CAPTURE_DESCRIPTORS.registration.fields, "the registration descriptor");
  if (descriptor.capture_schema_version !== CAPTURE_SCHEMA_VERSION || descriptor.kind !== "registration") refuse("the registration descriptor is not a version-1 registration capture");
  const workflow = readRaw(dir, assertClosed(descriptor.workflow, RAW_REF_FIELDS, "the registered workflow capture"), "the registered probe workflow", RAW_REF_FIELDS);
  const source = readRaw(dir, assertClosed(descriptor.source, RAW_REF_FIELDS, "the registered source capture"), "the registered probe workflow source", RAW_REF_FIELDS);

  const registered = workflow.body;
  if (!isPlainObject(registered)) refuse("the registered probe workflow capture is not an object");
  const workflowId = positiveInt(registered.id, "the registered probe workflow id");
  if (registered.path !== PROBE_WORKFLOW_PATH) refuse(`the registered workflow is ${JSON.stringify(registered.path)}, not the fixed probe workflow`);
  if (registered.state !== "active") refuse(`the retained registration shows the probe workflow ${JSON.stringify(registered.state)}, not active`);
  const createdMs = timeOf(registered.created_at, "the registered probe workflow created_at");

  const file = source.body;
  if (!isPlainObject(file) || file.path !== PROBE_WORKFLOW_PATH || file.encoding !== "base64" || typeof file.content !== "string") {
    refuse("the retained registered source is not a base64 file capture of the fixed probe workflow");
  }
  if (sha256(Buffer.from(file.content, "base64")) !== PROBE_WORKFLOW_SHA256) refuse("the retained registered source is not the reviewed probe workflow bytes");

  // The journal may only REPEAT the bytes.
  if (claimed.workflow_id !== workflowId) refuse("the journal's registered workflow id is not the one the retained response carries");
  if (claimed.workflow_state !== registered.state) refuse("the journal's registered workflow state is not the one the retained response carries");
  if (String(claimed.workflow_created_at) !== String(registered.created_at)) refuse("the journal's registration time is not the one the retained response carries");
  if (claimed.source_sha256 !== PROBE_WORKFLOW_SHA256) refuse("the registered probe workflow is not the reviewed active source");

  // ORDERING, against the trusted original window — registration precedes the commissioning baseline.
  if (createdMs > windowStartMs) refuse("the probe workflow was registered after the original attempt's baseline window opened");
  if (Math.min(workflow.started, source.started) < windowStartMs) refuse("the registered workflow capture predates the original commissioning window");
  return {
    workflow_id: workflowId, created_ms: createdMs,
    started: Math.min(workflow.started, source.started), completed: Math.max(workflow.completed, source.completed),
  };
}

/** Read and closed-check every probe journal record's payload. */
export function checkProbeJournalShape(records) {
  let closed = false;
  for (const record of records) {
    if (closed) refuse("a closed probe journal has a later record");
    closed = record.type === "probe-closed";
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
    const resolved = window.some((entry) => (entry.type === resultType
        && (record.type === "ref-create-intent" ? entry.data.response_complete === true && entry.data.http_status === 201 && entry.data.object_sha === record.data.sha
          : record.type === "dispatch-intent" ? entry.data.response_complete === true && entry.data.http_status === 204
            : record.type === "cancel-intent" ? false : entry.data.outcome === "deleted"))
      || (entry.type === "reconciliation" && entry.data?.of === record.type
        && (record.type === "dispatch-intent" ? entry.data.outcome === "present-unchanged" : ["ref-create-intent", "cleanup-intent"].includes(record.type) && entry.data.outcome === "absent"))
      || (record.type === "cancel-intent" && entry.type === "run-terminal"
        && entry.data.run_id === record.data.run_id && entry.data.run_attempt === 1 && entry.data.status === "completed"));
    if (!resolved) open.push({ seq: record.seq, type: record.type });
  }
  return open;
}

/** Re-authenticate a retained run identification before deriving a dispatch effect from it. */
export function verifyIdentifiedProbeRun(records, { dir, commissioning }) {
  const dispatch = only(records, "dispatch-intent");
  const identified = only(records, "run-identified");
  if (records.some((row) => row.type === "run-unidentified")) refuse("the run selection is ambiguous");
  equalOrRefuse({ workflow_file: dispatch.data.workflow_file, ref: dispatch.data.ref }, { workflow_file: PROBE_WORKFLOW_FILE, ref: PROBE_BRANCH }, "the original dispatch identity");
  const dispatchIntentMs = timeOf(dispatch.ts, "the original dispatch time"), deadlineMs = timeOf(dispatch.data.deadline_at, "the original dispatch deadline");
  if (deadlineMs > dispatchIntentMs + DISPATCH_DEADLINE_MS || deadlineMs < dispatchIntentMs + DISPATCH_DEADLINE_MS - 60_000) refuse("the original dispatch deadline changed");
  const identity = { repositoryId: commissioning.repository_id, workflowSha: commissioning.workflow_sha };
  const groups = assessRunSelectionContinuity(records, { dir, dispatchIntentMs, deadlineMs, identity });
  const descriptor = readDescriptor(dir, identified.data.descriptor, "the retained run identification");
  assertClosed(descriptor, CAPTURE_DESCRIPTORS["run-selection"].fields, "the retained selection descriptor");
  if (descriptor.kind !== "run-selection" || descriptor.capture_schema_version !== CAPTURE_SCHEMA_VERSION
    || identified.seq <= dispatch.seq || identified.data.eligible !== 1) refuse("invalid retained run identification");
  if (!groups.some((group) => group.boundary === "listing" && canonicalJson(group.pages) === canonicalJson(descriptor.pages))) refuse("the identified descriptor is not bound to retained selection pages");
  const pages = readPages(dir, descriptor.pages, "the identified selection pages");
  if (pages.some((page) => page.completed > Date.parse(identified.ts))) refuse("run identification precedes its selection evidence");
  const eligible = selectEligibleRuns(pages, { dispatchIntentMs, deadlineMs, identity });
  equalOrRefuse(eligible, [identified.data.run_id], "the retained unique run identification");
  assessRunContinuity(records, { dir, repositoryId: commissioning.repository_id, workflowSha: commissioning.workflow_sha });
  return identified;
}

/** Missing bookkeeping is completed from authenticated durable effects, never by retrying a write.
 * All public phase writers consume this same plan; a cut after any proposed append is idempotent.
 */
export function deriveProbeResolutionEvents(records, { dir, commissioning }) {
  checkProbeJournalShape(records);
  if (records.some((row) => row.type === "probe-closed")) return [];
  const events = [], sha = commissioning.workflow_sha;
  const ownership = assessRefOwnership(records, { workflowSha: sha });
  const pending = unresolvedProbeIntents(records);
  const reconciliation = (of, outcome, fact) => events.push({ type: "reconciliation", data: { of, outcome,
    object_sha: outcome === "absent" ? null : sha, measured_at: fact.data.measured_at ?? fact.ts } });
  for (const type of Object.keys(PROBE_INTENT_PAIRS)) {
    const intents = records.filter((row) => row.type === type);
    if (intents.length > 1) refuse(`the probe repeats its ${type}`);
    const intent = intents[0]; if (!intent) continue;
    if (type === "ref-create-intent" || type === "cleanup-intent") {
      equalOrRefuse(intent.data, type === "ref-create-intent" ? { ref: PROBE_REF, sha } : { ref: PROBE_REF, expected_sha: sha }, "the retained ref mutation intent");
      const absence = records.find((row) => row.seq > intent.seq && ["ref-readback", "absence-verified"].includes(row.type)
        && row.data.ref === PROBE_REF && row.data.response_complete === true && row.data.http_status === 404
        && row.data.measured_status === 404 && row.data.response_incomplete === null);
      if (!absence || ownership.state === "uncertain") continue;
      const measured = timeOf(absence.data.measured_at, "the retained absence measurement");
      if (measured < timeOf(intent.ts, "the ref mutation intent") || measured > timeOf(absence.ts, "the retained absence journal time")) refuse("the retained absence is outside its mutation and journal bounds");
      const supported = type === "ref-create-intent" ? ownership.state === "unowned" : ownership.state === "ended" && ownership.absence_confirmed;
      if (!supported) continue;
      if (pending.some((row) => row.seq === intent.seq)) reconciliation(type, "absent", absence);
      if (type === "cleanup-intent" && !records.some((row) => row.seq > intent.seq && row.type === "absence-verified")) {
        events.push({ type: "absence-verified", data: { ref: PROBE_REF, http_status: 404, response_complete: true,
          response_incomplete: null, measured_status: 404, measured_at: absence.data.measured_at } });
      }
    } else if (type === "dispatch-intent" && records.some((row) => row.type === "run-identified")) {
      const identified = verifyIdentifiedProbeRun(records, { dir, commissioning });
      if (pending.some((row) => row.seq === intent.seq)) reconciliation(type, "present-unchanged", identified);
    } else if (type === "cancel-intent" && !records.some((row) => row.type === "run-terminal")) {
      const identified = verifyIdentifiedProbeRun(records, { dir, commissioning });
      if (intent.data.run_id !== identified.data.run_id) refuse("the cancellation intent names a different run");
      const observed = assessRunContinuity(records, { dir, repositoryId: commissioning.repository_id, workflowSha: sha })
        .filter((row) => row.seq > intent.seq && row.body.status === "completed").at(-1);
      if (observed) {
        const fact = records.find((row) => row.seq === observed.seq);
        events.push({ type: "run-terminal", data: { run_id: identified.data.run_id, run_attempt: observed.body.run_attempt,
          status: observed.body.status, conclusion: observed.body.conclusion ?? null, observed_at: fact.data.capture.completed_at } });
      }
    }
  }
  return events;
}

/** Current run evidence is retained before it is consumed, including rejected identities.
 * A later return to attempt 1 or terminal state cannot erase a measured substitution.
 */
export function assessRunContinuity(records, { dir, repositoryId, workflowSha }) {
  const identified = records.find((record) => record.type === "run-identified");
  let terminal = null;
  const observations = [];
  for (const record of records) {
    if (record.type === "run-terminal") terminal = record.data;
    if (record.type !== "run-observed") continue;
    assertProbeEventPayload(record.type, record.data);
    if (!identified || record.data.run_id !== identified.data.run_id) refuse("a run observation is not bound to the identified owned run");
    const captured = readRaw(dir, record.data.capture, "the current owned run observation", RAW_REF_FIELDS);
    assertProbeRunIdentity(captured.body, { runId: identified.data.run_id, repositoryId, workflowSha });
    if (terminal && (captured.body.status !== "completed" || captured.body.conclusion !== terminal.conclusion)) {
      refuse("the probe run's current state contradicts its retained terminal state; cleanup is blocked");
    }
    if (captured.completed > timeOf(record.ts, "the run observation journal time")) refuse("the run observation was journaled before its capture completed");
    observations.push({ seq: record.seq, boundary: record.data.boundary, body: captured.body });
  }
  return observations;
}


/** Independent original identity: the intent declares a login; the provider measures two tuples. */
export function assertOriginalProbeIdentity(body, { commissioning, dispatcher, baseline = null }) {
  if (!isPlainObject(body) || !Number.isSafeInteger(body.id) || String(body.id) !== commissioning.run_id
    || body.run_attempt !== Number(commissioning.attempt)) refuse("the original run/attempt identity does not match its trusted intent");
  for (const field of ["repository", "head_repository"]) {
    if (body[field]?.id !== Number(commissioning.repository_id) || body[field]?.full_name !== commissioning.repository) refuse(`the original ${field} identity does not match its trusted intent`);
  }
  if (body.head_sha !== commissioning.workflow_sha || body.path !== commissioning.workflow_path
    || body.event !== "workflow_dispatch" || body.head_branch !== "staging") refuse("the original source/workflow/event/branch identity does not match its trusted intent");
  if (typeof dispatcher !== "string" || !dispatcher) refuse("the original trusted intent has no declared dispatcher");
  for (const field of ["actor", "triggering_actor"]) {
    const type = body[field]?.type;
    const login = body[field]?.login;
    const loginMatchesType = type === "Bot"
      ? /^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/.test(login)
      : /^(?:[A-Za-z0-9][A-Za-z0-9-]*)$/.test(login);
    if (typeof login !== "string" || !["User", "Bot", "Organization"].includes(type) || !loginMatchesType) {
      refuse(`the original ${field} tuple is malformed`);
    }
  }
  const identity = { actor: parseActor(body.actor, "the original actor"), triggering_actor: parseActor(body.triggering_actor, "the original triggering actor") };
  if (identity.actor.login !== dispatcher) refuse("the original actor differs from its declared dispatcher");
  if (baseline) equalOrRefuse(identity, baseline, "the original measured actor identity");
  return identity;
}

export function assessOriginalProbeBinding(records, { dir, commissioning, dispatcher, qualification = false }) {
  const bindings = records.filter((record) => record.type === "original-identity-bound");
  if (bindings.length !== 1) refuse("the probe requires exactly one retained original identity binding");
  if (records.some((row) => ["ref-create-intent", "dispatch-intent"].includes(row.type) && row.seq < bindings[0].seq)) refuse("original identity was not bound before launch");
  const captured = readRaw(dir, bindings[0].data.capture, "the original identity capture", RAW_REF_FIELDS);
  if (captured.completed > timeOf(bindings[0].ts, "the original identity binding time")) refuse("the original identity binding predates its capture");
  const baseline = assertOriginalProbeIdentity(captured.body, { commissioning, dispatcher });
  if (qualification) for (const row of records.filter((entry) => entry.type === "original-identity-observed")) {
    const observed = readRaw(dir, row.data.capture, "the original identity observation", RAW_REF_FIELDS);
    if (observed.completed > Date.parse(row.ts)) refuse("the original identity observation predates capture");
    assertOriginalProbeIdentity(observed.body, { commissioning, dispatcher, baseline });
    if (observed.body.status === "completed") refuse("the original commissioning attempt completed; qualification has ended");
  }
  return baseline;
}


/** Admission is derived without denial diagnostics, from a terminal exact run and bound jobs. */
export function deriveProbeAdmissions(dir, { runCapture, jobsDescriptor, commissioning, runId }) {
  const run = readRaw(dir, runCapture, "the admission run", RAW_REF_FIELDS);
  assertProbeRunIdentity(run.body, { runId, repositoryId: commissioning.repository_id, workflowSha: commissioning.workflow_sha });
  if (run.body.status !== "completed") refuse("admission requires terminal run evidence");
  const descriptor = readDescriptor(dir, jobsDescriptor, "the admission jobs");
  assertClosed(descriptor, CAPTURE_DESCRIPTORS.jobs.fields, "the admission jobs descriptor");
  if (descriptor.kind !== "jobs" || descriptor.capture_schema_version !== CAPTURE_SCHEMA_VERSION) refuse("invalid admission jobs descriptor");
  const { pages, rows } = readAdmissionJobPages(dir, descriptor.pages);
  const admitted = [];
  for (const spec of PROBE_JOBS) {
    const matches = rows.filter((job) => job?.name === spec.job_key);
    if (matches.length !== 1) continue;
    const job = matches[0];
    if (!Number.isSafeInteger(job.id) || job.id <= 0 || rows.filter((row) => row?.id === job.id).length !== 1
      || String(job.run_id) !== String(runId) || job.run_attempt !== Number(PROBE_ATTEMPT)
      || job.head_branch !== PROBE_BRANCH || job.head_sha !== commissioning.workflow_sha || job.status !== "completed"
      || job.url !== `${repoApi()}/actions/jobs/${job.id}` || job.run_url !== `${repoApi()}/actions/runs/${runId}`
      || job.html_url !== `${repoWeb()}/actions/runs/${runId}/job/${job.id}` || typeof job.node_id !== "string" || !job.node_id) continue;
    const start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || start < Date.parse(run.body.created_at)
      || pages.some((page) => page.started < end) || run.started < end) continue;
    if (job.conclusion === "success" || (Array.isArray(job.steps) && job.steps.length > 0)
      || (Number.isSafeInteger(job.runner_id) && job.runner_id > 0)) admitted.push({ environment: spec.environment, job_id: String(job.id) });
  }
  return admitted;
}

/** Retained recovery dispositions are authenticated facts, never positive qualification. */
export function verifyProbeRecoveryHistory(records, { dir, commissioning }) {
  const identified = records.find((row) => row.type === "run-identified");
  for (const row of records) {
    const data = row.data;
    if (row.type === "qualification-incomplete" && timeOf(data.observed_at, "the qualification gap observation") > timeOf(row.ts, "the qualification gap journal time")) refuse("the qualification gap predates its observation");
    if (["capture-progress", "capture-failed", "qualification-ended", "admission-observed"].includes(row.type)
      && (!identified || data.run_id !== identified.data.run_id)) refuse("a recovery disposition names an unowned run");
    if (row.type === "capture-progress") {
      const raw = readRawEnvelope(dir, data.capture, "the retained capture progress", RAW_REF_FIELDS);
      if (raw.completed > Date.parse(row.ts)) refuse("capture progress predates its provider read");
    }
    if (row.type === "capture-failed") {
      const expected = records.filter((entry) => entry.seq < row.seq && ["capture-progress", "capture-recorded", "run-observed"].includes(entry.type)).map((entry) => entry.seq);
      equalOrRefuse(data.capture_sequences, expected, "the failed capture references");
    }
    if (row.type === "qualification-ended") {
      const terminal = records.find((entry) => entry.seq === data.terminal_sequence && entry.seq < row.seq && entry.type === "run-observed");
      if (!terminal || terminal.data.run_id !== data.run_id) refuse("the qualification abort lacks its exact terminal proof");
      const raw = readRaw(dir, terminal.data.capture, "the abort terminal proof", RAW_REF_FIELDS);
      assertProbeRunIdentity(raw.body, { runId: data.run_id, repositoryId: commissioning.repository_id, workflowSha: commissioning.workflow_sha });
      if (raw.body.status !== "completed") refuse("the qualification abort run was not terminal");
    }
    if (row.type === "admission-observed") {
      const admitted = deriveProbeAdmissions(dir, { runCapture: data.run_capture, jobsDescriptor: data.jobs_descriptor, commissioning, runId: data.run_id });
      if (!admitted.some((entry) => entry.environment === data.environment && entry.job_id === data.job_id)) refuse("the admitted fact has no bound execution evidence");
    }
  }
}

/** Shared history facts used by every public phase and by offline qualification. */
export function assessProbePhaseState(records, { workflowSha }) {
  checkProbeJournalShape(records);
  const has = (type) => records.some((row) => row.type === type);
  const observations = records.filter((row) => row.type === "observation-recorded");
  const captures = records.filter((row) => row.type === "capture-recorded");
  const paired = PROBE_ENVIRONMENTS.every((environment) => observations.filter((row) => row.data.environment === environment
    && ["refused", "admitted"].includes(row.data.outcome)).length === 1)
    && ["run", "jobs"].every((kind) => captures.filter((row) => row.data.kind === kind).length === 1)
    && PROBE_ENVIRONMENTS.every((environment) => captures.some((row) => row.data.kind === "denial" && row.data.environment === environment));
  const failed = has("admission-observed") || observations.some((row) => row.data.outcome === "admitted");
  const ended = has("qualification-incomplete") || has("qualification-ended") || has("capture-failed") || has("cancel-intent") || assessSourceContinuity(records).interrupted;
  const ref = assessRefOwnership(records, { workflowSha });
  return Object.freeze({ closed: has("probe-closed"), staged: has("probe-opened"), create: has("ref-create-intent"), dispatch: has("dispatch-intent"),
    cleanup: has("cleanup-intent"), capture_started: has("capture-progress") || has("capture-recorded"), paired, failed, ended, aborted: has("qualification-ended"), ref,
    qualification: failed ? "failed" : ended ? "inconclusive" : paired ? "measured" : "incomplete" });
}

export const REF_OWNERSHIP_STATES = Object.freeze(["unowned", "owned", "ended", "uncertain"]);

/**
 * ── THE OWNED PROBE REF'S LIFECYCLE, DERIVED FROM THE WHOLE HISTORY (R05-F1) ────────────────────
 *
 * Authority to mutate the probe ref — and the right to close the probe as MEASURED — is a property
 * of the ACCUMULATED append-only history, never of the newest record. What this replaces read the
 * last cleanup reconciliation as confirmation of the last deletion RESULT, so after a successful
 * deletion whose absence readback was lost, a third invocation took "a reconciliation exists" as
 * permission, issued a SECOND lease deletion, and removed a ref another creator had put back at the
 * same bytes — then closed the probe measured and passed the offline assessment.
 *
 * The rules, in the order they bind:
 *
 *  - Ownership begins ONLY at a complete 201 create of the fixed ref at the reviewed source.
 *  - A deletion this probe recorded as SUCCESSFUL ends that ownership irreversibly. Presence
 *    afterwards is a contradiction, never continuity: an equal SHA is equal BYTES, and bytes are
 *    not a continuous resource. A same-SHA recreation is somebody else's ref.
 *  - A ref measured at another SHA ends it too, and a later return to the reviewed SHA does not
 *    revive it. The state is monotonic, so a restored value cannot walk the contradiction back.
 *  - An UNDECIDED deletion — an ambiguous transport, or an intent whose result was never appended
 *    — stays undecided until evidence about THAT SAME operation decides it. EXACT ABSENCE decides
 *    it applied. PRESENCE AT THE REVIEWED SHA DECIDES NOTHING AT ALL (R06).
 *  - Absence with no deletion of ours on record is a broken ownership history, not a clean end.
 *
 * ── WHY EQUAL BYTES CANNOT DECIDE AN UNDECIDED DELETION (R06) ───────────────────────────────────
 *
 * What this replaces treated "the deletion was ambiguous and the ref is still at the reviewed SHA"
 * as proof the deletion did not apply, and issued one fresh lease deletion on that basis. Two
 * histories produce byte-for-byte identical observations:
 *
 *   (A) the deletion never applied, and the ref this probe created still holds SHA S;
 *   (B) the deletion applied, and ANOTHER creation has since put a new ref at the same SHA S.
 *
 * The expected-SHA lease tests S. It does not test creation identity, so it cannot separate them —
 * and under (B) the "retry" deletes somebody else's ref. Nothing available to the operator decides
 * between them: `createGitLeaseDeleter` distinguishes only `deleted`, the exact stale-info
 * `lease-refused`, and otherwise `ambiguous`, and a stale-info refusal is evidence of a MISMATCHED
 * ref condition, not of continuous ownership. So a matching presence is INERT here: it neither
 * resolves the pending deletion nor contradicts ownership, and `may_delete` stays false for good.
 * An exact 404 afterwards still resolves it — that observation really is about this ref.
 *
 * Every COMPLETE ref observation is reduced, whichever phase captured it and whatever the event is
 * called: a post-create `ref-readback` of 404 is the same measured disappearance as an
 * `absence-verified` 404 (R06-F1). An INCOMPLETE read is not an observation of anything.
 *
 * `uncertain` is terminal, and it survives a fresh process precisely because it is re-derived from
 * the journal rather than held in memory. The operator and the offline assessment both derive from
 * here, so neither can admit an action the other would refuse.
 */
export function assessRefOwnership(records, { workflowSha }) {
  let state = "unowned";
  let reason = null;
  let severity = null;
  /** An issued deletion whose effect on THIS ref no evidence has decided yet. */
  let pending = null;
  let deleted = false;
  let absenceConfirmed = false;

  const contradict = (why, how) => {
    if (state === "uncertain") return;
    state = "uncertain";
    reason = why;
    severity = how;
    pending = null;
  };
  const observePresent = (objectSha, changedReason) => {
    if (state === "uncertain" || state === "unowned") return;
    if (objectSha !== workflowSha) return contradict(changedReason, "assertion");
    if (state === "ended") {
      return contradict("a deletion this probe recorded as successful did not remove the owned probe ref; that history is inconsistent, so no second deletion is issued — root reconciliation is required", "incomplete");
    }
    // A ref present at the reviewed BYTES while a deletion of ours is undecided says nothing about
    // that deletion: an unapplied delete and an applied-then-recreated one look exactly like this
    // (R06). So `pending` is deliberately NOT cleared here — equal bytes are not a decision.
  };
  const observeAbsent = () => {
    if (state === "uncertain" || state === "unowned") return;
    if (state === "owned" && !pending) {
      return contradict("the owned probe ref disappeared without this probe deleting it; its ownership history is broken", "assertion");
    }
    state = "ended";
    absenceConfirmed = true;
    pending = null;
  };

  for (const record of records ?? []) {
    const data = record?.data ?? {};
    switch (record?.type) {
      case "ref-create-intent":
        if (state === "unowned" && !pending) pending = Object.freeze({ seq: record.seq, of: "ref-create-intent", outcome: "unknown" });
        else contradict("a probe creation intent was repeated", "assertion");
        break;
      case "ref-create-result":
        if (state === "unowned" && data.response_complete === true && data.http_status === 201 && data.object_sha === workflowSha) {
          state = "owned";
          pending = null;
        } else if (state === "unowned") {
          // A complete error can follow an applied create just as a lost response can. It is not
          // evidence of nonapplication and must survive process restart until a bounded readback.
          pending ??= Object.freeze({ seq: record.seq, of: "ref-create-intent", outcome: "unknown" });
        }
        break;
      case "ref-readback":
        if (data.response_complete === true && data.http_status === 200) {
          if (state === "unowned" && pending?.of === "ref-create-intent") {
            contradict("the probe ref exists after a create whose application was not established; ownership is uncertain, so it is never adopted or deleted automatically — root reconciliation is required", "incomplete");
          } else {
            observePresent(String(data.object_sha ?? ""), "the owned probe ref points at a SHA this probe did not create; it is never deleted");
          }
        // A COMPLETE 404 under this event is the same measured disappearance as one under
        // `absence-verified` (R06-F1): the post-create readback is where it is actually seen, and
        // reducing it only under the other event's name left the ownership standing.
        } else if (data.response_complete === true && data.http_status === 404) {
          if (state === "unowned" && pending?.of === "ref-create-intent") pending = null;
          else observeAbsent();
        }
        break;
      case "ref-absent-verified":
      case "absence-verified":
        if (data.response_complete === true && data.http_status === 404) observeAbsent();
        break;
      case "cleanup-intent":
        if (state === "owned") pending = Object.freeze({ seq: record.seq, of: "cleanup-intent", outcome: null });
        break;
      case "cleanup-result":
        if (data.outcome === "deleted") {
          deleted = true;
          if (state === "ended") contradict("a second deletion was issued against a ref this probe had already deleted; the ownership history is inconsistent — root reconciliation is required", "assertion");
          else if (state === "owned") { state = "ended"; pending = Object.freeze({ seq: record.seq, of: "cleanup-result", outcome: "deleted" }); }
        } else if (data.outcome === "lease-refused") {
          contradict("the owned probe ref changed and its lease deletion was refused; it is never deleted at another SHA", "assertion");
        } else if (state === "owned") {
          pending = Object.freeze({ seq: record.seq, of: "cleanup-result", outcome: "ambiguous" });
        }
        break;
      case "reconciliation":
        if (data.of === "ref-create-intent") {
          if (data.outcome === "present-ownership-uncertain") {
            contradict("the probe ref's ownership is uncertain; it is never deleted automatically — root reconciliation is required", "incomplete");
          } else if (data.outcome === "absent") {
            if (state === "unowned" && pending?.of === "ref-create-intent") pending = null;
            else observeAbsent();
          }
        } else if (data.of === "cleanup-intent") {
          if (data.outcome === "absent") observeAbsent();
          else if (data.outcome === "present-unchanged" || data.outcome === "present-changed") {
            // The RECORDED SHA decides, not the label: a row that claims "unchanged" about another
            // commit is describing a ref this probe did not create.
            observePresent(String(data.object_sha ?? ""), "the owned probe ref now points elsewhere; it is never deleted at another SHA");
          } else if (data.outcome === "present-ownership-uncertain") {
            contradict("the owned probe ref's cleanup was reconciled to a ref whose ownership was never established; root reconciliation is required", "incomplete");
          }
        }
        break;
      default:
        break;
    }
  }
  return Object.freeze({
    state, reason, severity, deleted, absence_confirmed: absenceConfirmed,
    pending,
    /** One fresh lease deletion is admissible only against an ownership the history still supports. */
    may_delete: state === "owned" && pending === null,
    /** A measured close, and offline acceptance, need the owned ref gone and its absence measured. */
    may_accept: state === "ended" && absenceConfirmed && pending === null,
  });
}

/**
 * ── THE MEASURED LIVE SOURCE, KEPT (R05-F2) ────────────────────────────────────────────────────
 *
 * `assertSourceContinuity` in `observe` mode deliberately REPORTS a staging move instead of
 * throwing, so that the phase whose job is to remove what the run created is not blocked by the
 * move. The reporting only means anything if the caller writes the observation into the bound
 * history: the defect this replaces obtained the result in every local probe phase and consumed it
 * in none, so a collection that measured staging at a different commit still returned `measured`,
 * and once staging came back the closure and the offline assessment saw nothing at all.
 *
 * An interruption is monotonic. It is recorded under the original attempt's own hash-chained probe
 * journal, so a restored staging head, a later phase or a fresh process re-derives it unchanged.
 */
export function assessSourceContinuity(records) {
  const observations = (records ?? []).filter((record) => record?.type === SOURCE_OBSERVED_EVENT);
  const moved = observations.filter((record) => record.data?.moved === true);
  return Object.freeze({
    observed: observations.length,
    phases: Object.freeze(observations.map((record) => String(record.data?.phase ?? ""))),
    interrupted: moved.length > 0,
    first_move: moved.length
      ? Object.freeze({
        seq: moved[0].seq, phase: String(moved[0].data.phase ?? ""),
        staging_sha: String(moved[0].data.staging_sha ?? ""), measured_at: String(moved[0].data.measured_at ?? ""),
      })
      : null,
  });
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
export function assessProbeLifecycle(records, { dir, intentSha256, intentArtifact, commissioning, workflowSha, windowStartMs }) {
  if (typeof dir !== "string" || !dir) refuse("the probe lifecycle is assessed against retained evidence, so it needs the evidence directory");
  if (!Number.isFinite(windowStartMs)) refuse("the probe lifecycle is assessed against the trusted original commissioning window");
  if (!records.length) refuse("the probe journal is absent or empty");
  checkProbeJournalShape(records);
  const originalFile = path.join(dir, `commissioning-${commissioning.run_id}-${commissioning.attempt}-intent.json`);
  let stat;
  try { stat = lstatSync(originalFile); } catch { refuse("the original intent file is absent"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RAW_CAPTURE_BYTES) refuse("the original intent file is not bounded regular evidence");
  const originalIntent = parseJsonBytes(readFileSync(originalFile), "the original trusted intent");
  if (canonicalHash(originalIntent) !== commissioning.intent_sha256) refuse("the original intent no longer matches its authenticated binding");
  assessOriginalProbeBinding(records, { dir, commissioning, dispatcher: originalIntent.dispatcher, qualification: true });
  verifyProbeRecoveryHistory(records, { dir, commissioning });
  const phaseState = assessProbePhaseState(records, { workflowSha });
  if (phaseState.failed || phaseState.ended) refuse("the cumulative probe qualification is failed, interrupted or irreversibly incomplete");
  const foreign = records.filter((record) => String(record.source) !== String(workflowSha));
  if (foreign.length) refuse(`${foreign.length} probe journal record(s) were written against a different immutable source`);
  if (records[0].type !== "probe-opened") refuse("the probe journal does not begin with its opening record");
  equalOrRefuse(records[0].data, {
    intent_artifact: intentArtifact, intent_sha256: intentSha256,
    commissioning_run_id: commissioning.run_id, commissioning_attempt: commissioning.attempt,
  }, "the probe journal's opening binding");
  for (const recovery of records.filter((row) => row.type === "lock-recovered")) {
    if (recovery.data.intent_sha256 !== intentSha256) refuse("the recovered probe lock names another intent");
    equalOrRefuse(recovery.data.reconciled_intents,
      records.filter((row) => row.seq < recovery.seq && PROBE_INTENT_PAIRS[row.type]).map((row) => ({ seq: row.seq, type: row.type })),
      "the recovered probe mutation bindings");
  }
  const open = unresolvedProbeIntents(records);
  if (open.length) refuse(`${open.length} probe intent(s) have no result or reconciliation (${open.map((entry) => `${entry.type}#${entry.seq}`).join(", ")})`);

  // REGISTRATION is traversed evidence, not a journal assertion (R04-F3).
  const registration = verifyProbeRegistration(dir, only(records, "registration-verified"), { windowStartMs });
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
  const dispatch = only(records, "dispatch-intent");
  equalOrRefuse({ workflow_file: dispatch.data.workflow_file, ref: dispatch.data.ref }, { workflow_file: PROBE_WORKFLOW_FILE, ref: PROBE_BRANCH }, "the probe dispatch intent");
  // Creation and dispatch are immutable once-only bindings. Readbacks are replayable observations:
  // an incomplete read decides nothing, while a complete contradiction remains sticky. Select a
  // matching pre-dispatch observation only when the cumulative history through that exact row still
  // proves the original complete-201 ownership. A later match therefore cannot erase a prior 404,
  // changed SHA or uncertain creation, and a post-dispatch/cleanup read can never qualify the launch.
  const readback = records.find((record, index) => record.type === "ref-readback"
    && record.seq > created.seq && record.seq < dispatch.seq
    && record.data.ref === PROBE_REF
    && record.data.http_status === 200 && record.data.response_complete === true
    && record.data.object_sha === workflowSha
    && assessRefOwnership(records.slice(0, index + 1), { workflowSha }).may_delete);
  if (!readback) refuse("the created probe ref has no complete authenticated readback at the reviewed source before dispatch");
  const dispatchMs = timeOf(dispatch.ts, "the dispatch intent time");
  // The operator computes the deadline from its clock read immediately BEFORE the durable append, so
  // it can only be at or before ten minutes from the record's own time — never later. The stricter
  // of the two bounds governs; a deadline that would extend the window refuses.
  const deadlineMs = timeOf(dispatch.data.deadline_at, "the dispatch deadline");
  if (deadlineMs > dispatchMs + DISPATCH_DEADLINE_MS || deadlineMs < dispatchMs + DISPATCH_DEADLINE_MS - 60_000) {
    refuse("the dispatch deadline is not ten minutes from the durable dispatch intent");
  }
  const selectionHistory = assessRunSelectionContinuity(records, {
    dir, dispatchIntentMs: dispatchMs, deadlineMs,
    identity: { repositoryId: commissioning.repository_id, workflowSha },
  });
  // The DISPATCH INTENT owns its own outcome (R04-F2). Normally its result is journaled; when the
  // process was cut between the durable intent and the provider's answer, the intent is instead
  // resolved by exactly one reconciliation that found the owned run. That reconciliation is not a
  // weaker substitute for the 204: the run it points at is separately re-derived below from the
  // retained listing and the raw run captures — its identity, attempt, source and dispatcher — so
  // the evidence chain is the run itself rather than an acknowledgement of a request.
  const results = records.filter((record) => record.type === "dispatch-result");
  if (results.length > 1) refuse(`the probe journal records ${results.length} dispatch results, not exactly one`);
  if (results.length === 1) {
    // Even a complete 5xx may follow an applied dispatch. Exact retained run evidence below
    // establishes the application; response completion alone supplies no nonapplication proof.
  } else {
    const reconciled = records.filter((record) => record.type === "reconciliation" && record.data.of === "dispatch-intent");
    if (reconciled.length !== 1) refuse(`the probe dispatch has no result and ${reconciled.length} reconciliation(s); exactly one must resolve it`);
    if (reconciled[0].data.outcome !== "present-unchanged" || reconciled[0].data.object_sha !== workflowSha) {
      refuse("the interrupted probe dispatch was not reconciled to an owned run at the reviewed source");
    }
    if (reconciled[0].seq < dispatch.seq) refuse("the probe dispatch reconciliation precedes the intent it resolves");
  }
  if (records.some((record) => record.type === "run-unidentified")) refuse("the probe run could not be identified uniquely");
  const identified = only(records, "run-identified");
  const identifiedSelection = readDescriptor(dir, identified.data.descriptor, "the identified run-selection descriptor");
  assertClosed(identifiedSelection, CAPTURE_DESCRIPTORS["run-selection"].fields, "the identified run-selection descriptor");
  if (identifiedSelection.capture_schema_version !== CAPTURE_SCHEMA_VERSION || identifiedSelection.kind !== "run-selection") {
    refuse("the identified run-selection descriptor is not a version-1 selection capture");
  }
  if (!selectionHistory.some((group) => group.boundary === "listing"
    && canonicalJson(group.pages) === canonicalJson(identifiedSelection.pages))) {
    refuse("the identified run-selection descriptor is not bound to the pre-interpretation page observations");
  }
  const runObservations = assessRunContinuity(records, { dir, repositoryId: commissioning.repository_id, workflowSha });
  if (identified.data.eligible !== 1) refuse("the probe run was not the single eligible run");
  const terminal = only(records, "run-terminal");
  if (terminal.data.run_id !== identified.data.run_id || terminal.data.run_attempt !== 1 || terminal.data.status !== "completed" || terminal.data.conclusion !== "failure") {
    refuse("the probe run's journaled terminal state is not a completed failure of attempt 1");
  }
  if (records.some((record) => record.type === "cancel-intent")) refuse("the probe run was cancelled; a cancellation is inconclusive, never a refusal");
  for (const record of records.filter((entry) => entry.type === "observation-recorded")) {
    if (record.data.outcome !== "refused") refuse(`the collector recorded ${record.data.environment} as ${record.data.outcome}`);
  }

  // ── THE SAME DERIVATION THE OPERATOR ACTS ON (R05) ───────────────────────────────────────────
  // Acceptance follows from the accumulated lifecycle, so a contradiction recorded at any point —
  // a ref that came back after a successful deletion, a ref that moved and was put back, a
  // deletion still undecided — refuses here exactly as it refuses the next mutation. It is derived
  // BEFORE the individual cleanup rows are read, so the refusal names the contradiction itself
  // rather than whichever downstream row it happens to break.
  const ownership = assessRefOwnership(records, { workflowSha });
  if (!ownership.may_accept) {
    refuse(`the owned probe ref's accumulated lifecycle does not support acceptance (${ownership.reason ?? `ownership is ${ownership.state}`})`);
  }

  // ── THE MEASURED SOURCE (R05-F2) ─────────────────────────────────────────────────────────────
  const observed = records.filter((record) => record.type === SOURCE_OBSERVED_EVENT);
  if (!observed.length) refuse("the probe journal records no measured source-continuity observation");
  for (const record of observed) {
    if (typeof record.data.moved !== "boolean") refuse("a probe source observation does not record whether the source moved");
    const staging = String(record.data.staging_sha ?? "");
    const trusted = String(record.data.trusted_source_sha ?? "");
    if (!/^[0-9a-f]{40}$/.test(staging) || trusted !== workflowSha) refuse("a probe source observation is not a full live staging head measured against this attempt's trusted source");
    if (record.data.moved !== (staging !== trusted)) refuse("a probe source observation's move flag contradicts the commits it records");
    timeOf(record.data.measured_at, "a probe source observation's measured time");
  }
  const continuity = assessSourceContinuity(records);
  if (!continuity.phases.includes("collect")) refuse("the probe collection recorded no measured source-continuity observation");
  if (continuity.interrupted) {
    refuse(`the probe measured the live staging head at ${continuity.first_move.staging_sha.slice(0, 12)} during ${continuity.first_move.phase}; the attempt is interrupted and is never accepted`);
  }

  const cleanupIntents = records.filter((record) => record.type === "cleanup-intent");
  if (!cleanupIntents.length) refuse("the owned probe ref has no cleanup intent");
  for (const intent of cleanupIntents) {
    equalOrRefuse(intent.data, { ref: PROBE_REF, expected_sha: workflowSha }, "a probe cleanup intent");
    const current = runObservations.find((row) => row.seq === intent.seq - 1 && row.boundary === "delete");
    if (!current || current.body.status !== "completed") refuse("cleanup lacks current exact-owned terminal run evidence at deletion");
  }
  const absent = records.filter((record) => record.type === "absence-verified");
  const lastAbsent = absent[absent.length - 1];
  if (!lastAbsent || lastAbsent.data.http_status !== 404 || lastAbsent.data.response_complete !== true || lastAbsent.seq < cleanupIntents[0].seq) {
    refuse("the owned probe ref's absence was not verified after cleanup");
  }
  if (records.some((record) => record.type === "cleanup-result" && record.data.outcome === "lease-refused")) refuse("the owned probe ref changed and its cleanup was refused");
  const closed = only(records, "probe-closed");
  const finalRun = runObservations.find((row) => row.seq === closed.seq - 1 && row.boundary === "closure");
  if (!finalRun || finalRun.body.status !== "completed") refuse("closure lacks current exact-owned terminal run evidence");
  if (closed.seq !== records[records.length - 1].seq || closed.data.outcome !== "measured") refuse("the probe journal is not closed as a measured probe");
  const policies = records.filter((record) => record.type === "policy-captured");
  return {
    run_id: identified.data.run_id, dispatch_ms: dispatchMs, deadline_ms: deadlineMs, registration,
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

    const windowStart = Date.parse(window.start);
    const windowEnd = Date.parse(window.end);
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) refuse("the trusted commissioning window is not a measurable interval");
    const probeRecords = readProbeJournal();
    const lifecycle = assessProbeLifecycle(probeRecords, {
      dir, intentSha256: observation.probe_intent.sha256, intentArtifact: observation.probe_intent.artifact,
      commissioning, workflowSha: commissioning.workflow_sha, windowStartMs: windowStart,
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
    const eligible = selectEligibleRuns(readPages(dir, selection.pages, "the run-selection listing"), {
      dispatchIntentMs: lifecycle.dispatch_ms, deadlineMs: lifecycle.deadline_ms,
      identity: { repositoryId: commissioning.repository_id, workflowSha: commissioning.workflow_sha },
    });
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
    const ordered = [
      ["the commissioning window opening", windowStart],
      ["the registered workflow capture", lifecycle.registration.completed],
      ["the baseline policy capture start", baseline.started],
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
