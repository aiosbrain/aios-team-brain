#!/usr/bin/env node
/**
 * AIO-1124 PC-06 — the LOCAL operator protocol for the staged off-branch probe.
 *
 *   node scripts/staging-ops/offbranch-probe-operator.mjs <stage|dispatch|collect|cancel|cleanup> \
 *     --run-id <original commissioning run> --attempt <its attempt> --evidence-dir <private dir>
 *
 * The ONLY inputs are the original commissioning run identity and the private evidence directory.
 * There is no ref, workflow, endpoint, URL, environment or SHA argument: the probe ref, workflow and
 * environments are fixed literals, the source is the original attempt's trusted intent, and every
 * provider request goes through the commissioning request boundary under the `probe` role.
 *
 * ── THE ORDER, AND WHAT EACH STEP REFUSES ───────────────────────────────────────────────────────
 *
 *  stage     while the original attempt is ACTIVE and UNAPPROVED, and after its baseline: verify the
 *            fixed workflow is registered on the default branch with the reviewed bytes, that no other
 *            workflow is induced by the ref lifecycle, that the probe ref is ABSENT, and capture both
 *            environments' baseline policies. Then write the create-once probe intent and link its
 *            digest into the ORIGINAL attempt's resource journal, and open the probe's own journal.
 *  dispatch  create the ref ONCE (journaled intent before the request; a lost answer is reconciled by
 *            readback, never retried or adopted), capture the before-probe policies, dispatch ONCE.
 *  collect   identify exactly one eligible run; wait for its terminal state up to ten minutes from the
 *            durable dispatch intent; at the deadline cancel ONLY that run and allow two more minutes;
 *            capture raw run/jobs/check/annotation responses and after-probe policies; re-derive the
 *            refusal and write one create-once observation per environment.
 *  cancel    the explicit operator abort: cancel only the identified probe run, then confirm terminal.
 *  cleanup   after terminal capture: delete ONLY the owned ref with an expected-old-SHA lease through
 *            local git, reconcile a lost answer by readback, verify exact absence, close the journal.
 *
 * Nothing here approves, rejects or bypasses a deployment review, edits an environment, or touches
 * run records. A passing collection is still not PC-06 acceptance: `check-evidence` re-derives it.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import path from "node:path";
import { acquireJournalLock, assertPrivateDirectory, openJournal, readJournal } from "./commissioning-journal.mjs";
import { isDirectEntry as directEntry } from "./direct-entry.mjs";
import {
  AssertionFailure, COMMISSIONING_REPOSITORY, COMMISSIONING_WORKFLOW_PATH,
  IncompleteEvidence, RESULT_SCHEMA_VERSION, UsageError, assertLocalOperator, assertProtectedJobsWaiting, assertRunIdentity,
  assertSourceContinuity, canonicalHash, collectSentinels, createGuardedRequest, createLocalGhTransport, createRedactor,
  evidenceSlug, readEvidenceFile, responseEvidence, summarizeApprovals,
} from "./policy-commissioning.mjs";
import {
  CANCEL_CONFIRM_MS, CAPTURE_SCHEMA_VERSION, DIAGNOSTIC_SCHEMA_VERSION, DISPATCH_DEADLINE_MS, MAX_PAGES, OFFBRANCH_CONTROL,
  OFFBRANCH_SCHEMA_VERSION, PAGE_SIZE, PROBE_ATTEMPT, PROBE_BRANCH, PROBE_DISPATCHER, PROBE_ENVIRONMENTS, PROBE_EVENT,
  PROBE_INTENT_SCHEMA_VERSION, PROBE_JOBS, PROBE_REF, PROBE_WORKFLOW_FILE, PROBE_WORKFLOW_PATH, PROBE_WORKFLOW_SHA256,
  ProbeRefusal, RESOURCE_LINK_EVENT, SOURCE_OBSERVED_EVENT, assertInertProbeWorkflow, assertProbeEventPayload, assertProbeRunIdentity,
  deriveProbeAdmissions, verifyProbeRecoveryHistory, assessProbePhaseState, assessOriginalProbeBinding, assertOriginalProbeIdentity,
  assessRefOwnership, assessRunContinuity, assessRunSelectionContinuity, assessSourceContinuity, commissioningIdentity, inducedAutomation,
  parseCheckRunUrl, parseProbeIntent, probeCaptureName, probeIntentName, probeJournalName, probeObservationName,
  readPolicyDescriptor, selectEligibleRuns, unresolvedProbeIntents, verifyProbeCaptures,
} from "./offbranch-probe.mjs";

export const PROBE_PHASES = Object.freeze(["stage", "dispatch", "collect", "cancel", "cleanup"]);
export const PROBE_POLL_INTERVAL_MS = 10_000;
/** The ONE git remote a lease deletion may address. Fixed; never an argument. */
export const PROBE_GIT_REMOTE = `https://github.com/${COMMISSIONING_REPOSITORY}.git`;
const REPO = COMMISSIONING_REPOSITORY;
const FULL_SHA = /^[0-9a-f]{40}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const EXPECTED = Object.freeze({ attempt_outcome: "refused" });

// ──────────────────────────────────────────────────────────────────────────────
// 1. Local, create-once, mode-0600 retention.
// ──────────────────────────────────────────────────────────────────────────────

/** Create a file that must not exist yet. A second write of the same evidence is a refusal. */
export function writeCreateOnce(dir, name, bytes) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) throw new UsageError("a retained probe file name is derived, never supplied");
  let fd;
  try { fd = openSync(path.join(dir, name), "wx", 0o600); } catch (error) {
    if (error?.code === "EEXIST") throw new AssertionFailure(`${name} already exists; retained probe evidence is create-once and is never rewritten`);
    throw error;
  }
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return { artifact: name, sha256: sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8")) };
}

/** The next free ordinal for a capture kind, scanned from disk; the write itself is still `wx`. */
function nextOrdinal(dir, runId, attempt, kind) {
  const prefix = probeCaptureName(runId, attempt, kind, 1).slice(0, -"00001.json".length);
  const used = readdirSync(dir).filter((name) => name.startsWith(prefix)).map((name) => Number(name.slice(prefix.length, -".json".length)));
  return (used.length ? Math.max(...used.filter(Number.isSafeInteger)) : 0) + 1;
}

function writeDescriptor(session, descriptor) {
  const name = probeCaptureName(session.runId, session.attempt, "desc", nextOrdinal(session.dir, session.runId, session.attempt, "desc"));
  return writeCreateOnce(session.dir, name, `${JSON.stringify(descriptor, null, 2)}\n`);
}

/**
 * ONE retained provider read: the exact completed body bytes, with the local interval around the
 * request. Anything short of a complete 200 whose raw text was retainable is incomplete — never a
 * re-serialized body standing in for the provider's bytes.
 */
async function rawCapture(session, requestPath, label) {
  const started = session.now().toISOString();
  const response = await session.request("GET", requestPath);
  const completed = session.now().toISOString();
  if (response.complete !== true || response.status !== 200) throw new IncompleteEvidence(`${label} could not be captured (${response.status}${response.incomplete ? `, ${response.incomplete}` : ""})`);
  if (typeof response.raw_text !== "string") throw new IncompleteEvidence(`${label} was answered, but its exact bytes were not retainable`);
  const name = probeCaptureName(session.runId, session.attempt, "raw", nextOrdinal(session.dir, session.runId, session.attempt, "raw"));
  const ref = writeCreateOnce(session.dir, name, response.raw_text);
  return { ref: { ...ref, started_at: started, completed_at: completed }, body: response.body };
}

/** Every page of a fixed listing, read to its terminal page inside the canonical bound. */
async function pagedCapture(session, endpoint, listKey, label, onPage = null) {
  const pages = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const { ref, body } = await rawCapture(session, `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`, `${label} page ${page}`);
    pages.push({ page, ...ref });
    if (onPage) await onPage(page, ref, body);
    const rows = listKey ? body?.[listKey] : body;
    if (!Array.isArray(rows)) throw new IncompleteEvidence(`${label} page ${page} is not the documented shape`);
    seen += rows.length;
    const total = listKey ? body.total_count : null;
    if (rows.length < PAGE_SIZE || (Number.isSafeInteger(total) && seen >= total)) return { pages, bodies: pages.length };
  }
  throw new IncompleteEvidence(`${label} exceeded ${MAX_PAGES} pages; the capture is incomplete`);
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. The session: the operator, the original attempt, and the trusted commissioning identity.
// ──────────────────────────────────────────────────────────────────────────────

async function openProbeSession({ runId, attempt, evidenceDir, env, deps, phase, continuity = "enforce" }) {
  assertRunIdentity(runId, attempt);
  const dir = assertPrivateDirectory(evidenceDir);
  const now = deps.now ?? (() => new Date());
  const redact = createRedactor(collectSentinels(env));
  const guardCtx = { role: "probe", runId: String(runId), attempt: String(attempt), probeSha: null, probeRunId: null, probeCheckIds: new Set() };
  const transport = deps.transport ?? createLocalGhTransport({ spawnImpl: deps.spawnImpl ?? spawn, redact, env, retainRaw: true });
  const request = createGuardedRequest(transport, guardCtx);
  const operator = await assertLocalOperator({ request });
  const intent = readEvidenceFile(dir, evidenceSlug(runId, attempt, "intent"));
  if (!intent) throw new IncompleteEvidence("the original attempt's intent artifact is not in the evidence directory");
  if (intent.schema_version !== RESULT_SCHEMA_VERSION || intent.repository !== REPO || intent.workflow_path !== COMMISSIONING_WORKFLOW_PATH
    || String(intent.run_id) !== String(runId) || String(intent.attempt) !== String(attempt) || !FULL_SHA.test(String(intent.workflow_sha))) {
    throw new AssertionFailure("the intent artifact is not this commissioning attempt's trusted intent");
  }
  const commissioning = commissioningIdentity({ intent, runId, attempt, repository: REPO, workflowPath: COMMISSIONING_WORKFLOW_PATH });
  guardCtx.probeSha = commissioning.workflow_sha;
  const session = {
    dir, now, request, guardCtx, operator, intent, commissioning, sourceContinuity: null, deps, env,
    continuityMode: continuity, phase: String(phase ?? ""), sourceRecorded: null, originalRun: null,
    runId: String(runId), attempt: String(attempt), sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  // Authenticate local history before qualification reads or writer-lock acquisition. Closed
  // reporting is read-only even when a process died with the final fsynced close still locked.
  const records = readJournal({ dir, runId, attempt, kind: "probe" });
  const state = asAssertion(() => assessProbePhaseState(records, { workflowSha: commissioning.workflow_sha }));
  let baseline = null;
  if (records.length) {
    const staged = loadStagedProbe(session);
    if (records.some((row) => row.source !== commissioning.workflow_sha)
      || records[0]?.type !== "probe-opened" || records[0].data.intent_sha256 !== staged.digest
      || records[0].data.intent_artifact !== staged.name || records[0].data.commissioning_run_id !== String(runId)
      || records[0].data.commissioning_attempt !== String(attempt)) throw new AssertionFailure("the probe history is not bound to the original intent");
    asAssertion(() => verifyProbeRecoveryHistory(records, { dir, commissioning }));
    baseline = asAssertion(() => assessOriginalProbeBinding(records, { dir, commissioning, dispatcher: intent.dispatcher, qualification: !["cancel", "cleanup"].includes(phase) }));
  } else if (phase !== "stage") throw new IncompleteEvidence("no probe has been staged for this attempt");
  session.state = state;
  if (state.closed) {
    if (!["cancel", "cleanup"].includes(phase)) throw new AssertionFailure("the probe is closed; its terminal history cannot reopen");
    return session;
  }
  if (phase === "stage" && records.length && (state.create || state.dispatch || state.cleanup || state.ended)) throw new AssertionFailure("a probe is already staged for this attempt");
  if (["dispatch", "collect"].includes(phase) && (state.cleanup || state.aborted || state.ended || state.failed || state.ref.state === "uncertain")) {
    throw new IncompleteEvidence("this probe's cumulative history interrupted or ended qualification; mutations are never re-issued and only bounded recovery remains");
  }
  if (phase === "collect" && state.capture_started && !state.paired) throw new IncompleteEvidence("the original capture was interrupted; explicit cancel must end incomplete qualification before cleanup");
  if (phase === "collect" && !state.dispatch) throw new IncompleteEvidence("the probe has no dispatch intent to collect");
  const recovery = phase === "cancel" || phase === "cleanup";
  // Recovery relies on the retained authenticated original baseline and independently re-proves
  // exact run/ref ownership. Qualification-only reads cannot revoke that recovery authority.
  try {
    session.sourceContinuity = await assertSourceContinuity({ request, label: "the staged off-branch probe", mode: "observe",
      expected: { repositoryId: Number(intent.repository_id), workflowSha: commissioning.workflow_sha } });
  } catch (error) { if (!recovery) throw error; }
  if (session.sourceContinuity?.moved === true) persistKnownSourceMove(session);
  if (!recovery) {
    const captured = await rawCapture(session, `/repos/${REPO}/actions/runs/${runId}/attempts/${attempt}`, "the original commissioning attempt");
    if (records.length) appendUnderLock(session, "probe", "original-identity-observed", { capture: captured.ref });
    asAssertion(() => assertOriginalProbeIdentity(captured.body, { commissioning, dispatcher: intent.dispatcher, baseline }));
    session.originalRun = captured.body;
    session.originalCapture = captured.ref;
  }
  return session;
}

/** The measured live source, in the exact closed shape both journals carry it in. */
function sourceObservation(session, phase) {
  const measured = session.sourceContinuity;
  if (!measured) throw new IncompleteEvidence("source continuity was unavailable");
  return {
    phase, mode: String(session.continuityMode ?? "observe"), moved: measured?.moved === true,
    staging_sha: String(measured?.staging_sha ?? ""), trusted_source_sha: String(measured?.trusted_source_sha ?? ""),
    measured_at: session.now().toISOString(),
  };
}

/** Append one record under a freshly taken lock for `kind`, then give the lock straight back. */
function appendUnderLock(session, kind, type, data) {
  const lock = acquireJournalLock({ dir: session.dir, runId: session.runId, attempt: session.attempt, kind, now: session.now });
  try {
    openJournal({
      dir: session.dir, runId: session.runId, attempt: session.attempt, kind,
      source: session.commissioning.workflow_sha, lock, now: session.now,
    }).append(type, assertProbeEventPayload(type, data));
  } finally {
    lock.release();
  }
}

/**
 * A KNOWN MOVE, WRITTEN DOWN BEFORE ANYTHING REFUSES (R06-F3).
 *
 * The trusted bound history available to the attempt right now — nothing more. The probe's own
 * journal when this attempt has one and it is still open; otherwise the ORIGINAL attempt's
 * hash-chained journal, which `stage` measures against before any probe exists. No intent is
 * fabricated to hold the record, and a journal already closed is never reopened to log into: a
 * terminal history stays terminal, and an attempt with no trusted journal at all simply refuses
 * without one, which is honest about what it could retain.
 */
function persistKnownSourceMove(session) {
  const data = sourceObservation(session, session.phase);
  const sha = session.commissioning.workflow_sha;
  const bound = (records) => records.length && records.every((record) => String(record.source) === String(sha));
  const probe = readJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt, kind: "probe" });
  if (probe.length) {
    if (!bound(probe) || probe.some((record) => record.type === "probe-closed")) return;
    appendUnderLock(session, "probe", SOURCE_OBSERVED_EVENT, data);
    session.sourceRecorded = "probe";
    return;
  }
  const resource = readJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt });
  if (!bound(resource) || resource.some((record) => record.type === "run-closed")) return;
  appendUnderLock(session, "resource", SOURCE_OBSERVED_EVENT, data);
  session.sourceRecorded = "resource";
}

/**
 * The refusal `enforce` mode used to throw from inside the session, now issued by the phase AFTER
 * the move is durably recorded (R06-F3). Same condition, same outcome — a different moment.
 */
function assertSourceNotMoved(session) {
  const measured = session.sourceContinuity;
  if (session.continuityMode !== "enforce" || measured?.moved !== true) return;
  throw new IncompleteEvidence(
    `the staged off-branch probe's live staging head (${String(measured.staging_sha).slice(0, 12)}) is no longer the immutable trusted source this attempt is bound to (${String(measured.trusted_source_sha).slice(0, 12)}); the attempt is interrupted and needs cleanup and root reconciliation`,
    { moved: true, measured_staging_sha: String(measured.staging_sha), trusted_source_sha: String(measured.trusted_source_sha) },
  );
}

/** The original attempt is still running and nobody has approved a protected job. */
async function assertOriginalUnapproved(session) {
  if (session.originalRun.status === "completed") throw new AssertionFailure("the original commissioning attempt has completed; a probe can only be staged and run while it is active");
  if (!["queued", "in_progress", "waiting", "pending", "requested"].includes(session.originalRun.status)) throw new AssertionFailure("the original commissioning attempt has no measured active status");
  if (readJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt }).some((row) => row.type === "run-closed")) throw new AssertionFailure("the original commissioning attempt's journal is closed; qualification has ended");
  const approvals = summarizeApprovals(await session.request("GET", `/repos/${REPO}/actions/runs/${session.runId}/approvals`));
  if (!approvals.measured) throw new IncompleteEvidence(`the original attempt's approval history could not be measured (${approvals.reason})`);
  if (approvals.entries.some((entry) => entry.state === "approved")) {
    throw new AssertionFailure("an original protected job has already been approved; the probe must be staged, measured and cleaned before approval");
  }
  await assertProtectedJobsWaiting({ request: session.request, runId: session.runId, attempt: session.attempt });
}

function openProbeJournal(session) {
  const lock = acquireJournalLock({ dir: session.dir, runId: session.runId, attempt: session.attempt, kind: "probe", now: session.now });
  try {
    const journal = openJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt, kind: "probe", source: session.commissioning.workflow_sha, lock, now: session.now });
    const records = journal.read();
    if (records.some((record) => record.source !== session.commissioning.workflow_sha)) throw new AssertionFailure("the probe journal was written against a different immutable source");
    const append = (type, data) => journal.append(type, assertProbeEventPayload(type, data));
    return { lock, journal, append, records: () => journal.read() };
  } catch (error) {
    lock.release();
    throw error;
  }
}

/**
 * WRITE THIS PHASE'S MEASURED SOURCE-CONTINUITY OBSERVATION INTO THE BOUND HISTORY (R05-F2).
 *
 * `openProbeSession` measures the live staging head on every phase; in `observe` mode — collect,
 * cancel, cleanup — a move is REPORTED rather than thrown, so that removing what the run created
 * is never blocked by somebody else's legitimate merge. That report has to become a durable fact
 * of this probe, or the interruption vanishes the moment staging returns to its old value. It is
 * appended before the phase acts, so the phase's own decisions are derived from it.
 */
function recordSourceObservation(session, probe, phase) {
  // Never after the close: a closed probe's history is final, and appending past it would invalidate
  // the very evidence this observation exists to protect.
  if (probe.records().some((record) => record.type === "probe-closed")) return assessSourceContinuity(probe.records());
  // Already written, by the session, into THIS journal (R06-F3): a measured move is recorded before
  // the phase's other fallible reads, so appending it again here would double the same observation.
  if (session.sourceContinuity && session.sourceRecorded !== "probe") probe.append(SOURCE_OBSERVED_EVENT, sourceObservation(session, phase));
  return assessSourceContinuity(probe.records());
}

/**
 * The interruption, once observed, binds every later phase and process (R05-F2). Measurement and
 * acceptance stop; owned-run cancellation and owned-resource cleanup deliberately continue, which
 * is the canonical's "interrupts the attempt, WITH CLEANUP and root reconciliation".
 */
function sourceInterruption(continuity) {
  if (!continuity.interrupted) return null;
  const move = continuity.first_move;
  return `this attempt measured the live staging head at ${move.staging_sha.slice(0, 12)} during ${move.phase}, which is not the immutable trusted source it is bound to; the attempt is interrupted — it is never measured or accepted, and only owned cancellation and cleanup may continue`;
}

/** The staged probe: intent bytes, their link in the original journal, and the probe journal binding. */
function loadStagedProbe(session) {
  const name = probeIntentName(session.runId, session.attempt);
  let bytes;
  try { bytes = readFileSync(path.join(session.dir, name)); } catch { throw new IncompleteEvidence("no probe has been staged for this attempt"); }
  const digest = sha256(bytes);
  const resource = readJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt });
  if (!resource.length || resource.some((row) => row.source !== session.commissioning.workflow_sha)) throw new AssertionFailure("the original resource journal has an invalid source binding");
  const links = resource.filter((record) => record.type === RESOURCE_LINK_EVENT);
  if (links.length !== 1 || links[0].data?.intent_artifact !== name || links[0].data?.intent_sha256 !== digest || links[0].data?.probe_journal !== probeJournalName(session.runId, session.attempt)) {
    throw new AssertionFailure("the probe intent is not the one linked, exactly once, into the original attempt's journal");
  }
  const intent = JSON.parse(bytes.toString("utf8"));
  const parsed = asAssertion(() => parseProbeIntent(intent, { commissioning: session.commissioning }));
  return { name, digest, intent, parsed };
}

const asAssertion = (fn) => {
  try { return fn(); } catch (error) { if (error instanceof ProbeRefusal) throw new AssertionFailure(error.message); throw error; }
};
const asIncomplete = (fn) => {
  try { return fn(); } catch (error) { if (error instanceof ProbeRefusal) throw new IncompleteEvidence(error.message); throw error; }
};

const facts = (response) => {
  const evidence = responseEvidence(response);
  return {
    http_status: Number.isInteger(response?.status) ? response.status : 0,
    response_complete: evidence.response_complete, response_incomplete: evidence.response_incomplete, measured_status: evidence.measured_status,
  };
};

const probeRefPath = `/repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`;

/**
 * WHAT A REF STILL SITTING AT THE REVIEWED BYTES DOES NOT TELL YOU (R06).
 *
 * This message replaces an invitation to "run cleanup again to issue one fresh lease deletion". A
 * deletion whose answer was lost or ambiguous, followed by a ref present at the reviewed SHA, has
 * two readings the operator cannot tell apart: the deletion never applied, or it applied and
 * another creation has put a ref back at the same bytes. The expected-SHA lease tests the bytes,
 * not the creation, so the "retry" would delete a stranger's ref half the time. It is not retried.
 */
const UNDECIDED_DELETION = "this probe's deletion of the owned ref has no decided effect, and a ref present at the reviewed source does not decide it — an unapplied deletion and an applied one followed by another creation at the same bytes are indistinguishable from here; NO second deletion is issued, and root reconciliation is required";

/** One environment's settings plus every page of its branch policies, retained, parsed, agreeing. */
async function capturePolicy(session, environment, phase) {
  const settings = await rawCapture(session, `/repos/${REPO}/environments/${environment}`, `${environment} settings`);
  const branch = await pagedCapture(session, `/repos/${REPO}/environments/${environment}/deployment-branch-policies`, "branch_policies", `${environment} branch policies`);
  const ref = writeDescriptor(session, {
    capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "environment-policy", phase, environment,
    settings: settings.ref, branch_policies: branch.pages,
  });
  const { policy, completed } = asAssertion(() => readPolicyDescriptor(session.dir, ref, { environment, phase }));
  return { ref, policy, completed_at: new Date(completed).toISOString() };
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Local git: the workflow tree at the reviewed SHA, and the exact-SHA lease deletion.
// ──────────────────────────────────────────────────────────────────────────────

async function runGit(args, { spawnImpl = spawn, cwd, env = process.env, timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024 }) {
  const child = spawnImpl("git", args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  const err = [];
  let bytes = 0;
  let terminated = null;
  const collect = (target) => (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) { terminated = "oversize"; child.kill("SIGKILL"); return; }
    target.push(Buffer.from(chunk));
  };
  child.stdout?.on("data", collect(out));
  child.stderr?.on("data", collect(err));
  const timer = setTimeout(() => { terminated = "timeout"; child.kill("SIGKILL"); }, timeoutMs);
  const code = await new Promise((resolve) => { child.once("error", () => resolve(null)); child.once("close", resolve); });
  clearTimeout(timer);
  return { code, terminated, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

/** Every workflow file at the exact reviewed SHA, from the operator's local repository. Read-only. */
export function createGitWorkflowReader({ spawnImpl = spawn, cwd = process.cwd(), env = process.env } = {}) {
  return async (sha) => {
    if (!FULL_SHA.test(String(sha))) throw new UsageError("the workflow tree is read only at a full commit SHA");
    const listed = await runGit(["ls-tree", "--name-only", sha, "--", ".github/workflows/"], { spawnImpl, cwd, env });
    if (listed.code !== 0 || listed.terminated) throw new IncompleteEvidence("the reviewed commit is not available in the local repository; fetch staging and stage again");
    const files = {};
    for (const file of listed.stdout.split("\n").filter((line) => /\.ya?ml$/.test(line))) {
      const shown = await runGit(["show", `${sha}:${file}`], { spawnImpl, cwd, env });
      if (shown.code !== 0 || shown.terminated) throw new IncompleteEvidence(`the workflow ${file} could not be read at the reviewed commit`);
      files[file] = shown.stdout;
    }
    return files;
  };
}

/**
 * The owned ref's deletion WITH AN EXPECTED-OLD-SHA LEASE, through local `git push`.
 *
 * `--force-with-lease=<ref>:<sha>` makes the remote itself refuse unless the ref still holds exactly
 * that SHA — which is what a preceding GET cannot give. The porcelain output is parsed strictly:
 * exactly the deleted line with exit 0 is a deletion; exactly the stale-info rejection with exit 1 is
 * a lease refusal; anything else (timeout, auth, network, other output) is AMBIGUOUS and is
 * reconciled by readback, never retried here. Hooks run normally; nothing is bypassed.
 */
export function createGitLeaseDeleter({ spawnImpl = spawn, cwd = process.cwd(), env = process.env, remote = PROBE_GIT_REMOTE, timeoutMs = 60_000 } = {}) {
  return async ({ ref, expectedSha }) => {
    if (ref !== PROBE_REF) throw new UsageError("only the fixed probe ref may be deleted");
    if (!FULL_SHA.test(String(expectedSha))) throw new UsageError("a lease deletion needs the exact expected SHA");
    const run = await runGit(["push", "--porcelain", `--force-with-lease=${ref}:${expectedSha}`, remote, `:${ref}`], { spawnImpl, cwd, env, timeoutMs });
    const lines = run.stdout.split("\n");
    if (!run.terminated && run.code === 0 && lines.includes(`-\t:${ref}\t[deleted]`)) return { outcome: "deleted", exit_code: 0 };
    // git spells a rejected deletion's source as `(delete)` (measured with git's own porcelain output).
    if (!run.terminated && run.code === 1 && lines.includes(`!\t(delete):${ref}\t[rejected] (stale info)`)) return { outcome: "lease-refused", exit_code: 1 };
    return { outcome: "ambiguous", exit_code: Number.isInteger(run.code) ? run.code : null };
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 4. The phases.
// ──────────────────────────────────────────────────────────────────────────────

const result = (session, phase, status, extra = {}) => ({
  schema_version: RESULT_SCHEMA_VERSION, run_id: session.runId, attempt: session.attempt, phase: `offbranch-${phase}`, status, ...extra,
});

export async function runStage({ runId, attempt, evidenceDir, env, deps }) {
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps, phase: "stage" });
  assertSourceNotMoved(session);
  if (session.state.staged) {
    await assertOriginalUnapproved(session);
    return result(session, "stage", "already-staged");
  }
  const resource = readJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt });
  if (!resource.length || resource[0].source !== session.commissioning.workflow_sha) throw new IncompleteEvidence("the original attempt has no verified journal bound to its source; run setup first");
  // A move measured by an EARLIER staging attempt binds this one (R06-F3). Restoring staging does
  // not un-observe it: the attempt is interrupted, and an interrupted attempt is never staged.
  if (assessSourceContinuity(resource).interrupted) {
    throw new IncompleteEvidence("this attempt already measured the live staging head away from its immutable trusted source; it is interrupted and is never staged, measured or accepted — root reconciliation is required");
  }
  if (!resource.some((record) => record.type === "baseline-measured")) throw new IncompleteEvidence("the original attempt has not captured its baseline; a probe is staged after it");
  if (resource.some((record) => record.type === RESOURCE_LINK_EVENT)) throw new AssertionFailure("a probe is already staged for this attempt; a later attempt needs its own fresh intent");
  if (resource.some((record) => record.type === "run-closed")) throw new AssertionFailure("the original attempt's journal is closed");
  if (readJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt, kind: "probe" }).length) throw new AssertionFailure("a probe journal already exists for this attempt");
  await assertOriginalUnapproved(session);
  const windowStart = Date.parse(resource[0].ts);

  // REGISTRATION on the default branch, with the reviewed bytes, before the original baseline.
  const workflow = await rawCapture(session, `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}`, "the probe workflow registration");
  const source = await rawCapture(session, `/repos/${REPO}/contents/${PROBE_WORKFLOW_PATH}?ref=${session.commissioning.workflow_sha}`, "the probe workflow source");
  if (workflow.body?.path !== PROBE_WORKFLOW_PATH || workflow.body?.state !== "active" || !Number.isSafeInteger(workflow.body?.id)) {
    throw new AssertionFailure("the probe workflow is not registered and active on the default branch");
  }
  if (!(Date.parse(String(workflow.body.created_at)) <= windowStart)) throw new AssertionFailure("the probe workflow was not registered before the original attempt's baseline window opened");
  const sourceBytes = source.body?.encoding === "base64" && source.body?.path === PROBE_WORKFLOW_PATH ? Buffer.from(String(source.body.content), "base64") : null;
  if (!sourceBytes || sha256(sourceBytes) !== PROBE_WORKFLOW_SHA256) throw new AssertionFailure("the registered probe workflow at the reviewed source is not the reviewed bytes");
  const registration = writeDescriptor(session, { capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "registration", workflow: workflow.ref, source: source.ref });

  // NO INDUCED AUTOMATION, measured on the exact reviewed tree before the ref can exist.
  const tree = await (deps.readWorkflowTree ?? createGitWorkflowReader({ spawnImpl: deps.spawnImpl, env }))(session.commissioning.workflow_sha);
  const { parse } = await import("yaml");
  const docs = Object.fromEntries(Object.entries(tree).map(([file, text]) => [file, parse(text)]));
  if (!tree[PROBE_WORKFLOW_PATH] || sha256(Buffer.from(tree[PROBE_WORKFLOW_PATH], "utf8")) !== PROBE_WORKFLOW_SHA256) {
    throw new AssertionFailure("the local reviewed tree does not carry the reviewed probe workflow bytes");
  }
  asAssertion(() => assertInertProbeWorkflow(docs[PROBE_WORKFLOW_PATH]));
  const induced = inducedAutomation(docs);
  if (induced.length) throw new AssertionFailure(`the probe ref lifecycle would start other automation (${induced.join("; ")}); stopping before anything exists`);

  // A PRE-EXISTING probe ref is refused — even at the desired SHA. It is not ours.
  const absent = await session.request("GET", probeRefPath);
  if (absent.complete === true && absent.status === 200) throw new AssertionFailure("the fixed probe ref already exists; an unowned ref is never adopted");
  if (!(absent.complete === true && absent.status === 404)) throw new IncompleteEvidence("the probe ref's absence could not be measured");
  const absentAt = session.now().toISOString();

  const baseline = {};
  const environmentIds = {};
  for (const environment of PROBE_ENVIRONMENTS) {
    const captured = await capturePolicy(session, environment, "baseline");
    baseline[environment] = { artifact: captured.ref.artifact, sha256: captured.ref.sha256 };
    environmentIds[environment] = captured.policy.environment_id;
  }
  if (environmentIds[PROBE_ENVIRONMENTS[0]] === environmentIds[PROBE_ENVIRONMENTS[1]]) throw new AssertionFailure("both protected environments report one numeric identity");

  const intentName = probeIntentName(session.runId, session.attempt);
  const intent = {
    probe_intent_schema_version: PROBE_INTENT_SCHEMA_VERSION, commissioning: session.commissioning,
    probe: { workflow_path: PROBE_WORKFLOW_PATH, ref: PROBE_REF, workflow_sha: session.commissioning.workflow_sha, attempt: PROBE_ATTEMPT },
    environments: PROBE_JOBS.map((job) => ({ environment: job.environment, environment_id: environmentIds[job.environment], job_key: job.job_key })),
    baseline_policy: baseline, dispatcher: { ...PROBE_DISPATCHER }, staged_at: session.now().toISOString(),
    journal: { artifact: probeJournalName(session.runId, session.attempt) },
  };
  const written = writeCreateOnce(session.dir, intentName, `${JSON.stringify(intent, null, 2)}\n`);

  // THE PRIOR LINK, into the ORIGINAL attempt's own hash-chained journal.
  const lock = acquireJournalLock({ dir: session.dir, runId: session.runId, attempt: session.attempt, now: session.now });
  try {
    const journal = openJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt, source: session.commissioning.workflow_sha, lock, now: session.now });
    if (journal.read().some((record) => record.type === RESOURCE_LINK_EVENT)) throw new AssertionFailure("a probe was linked concurrently; refusing a second link");
    journal.append(RESOURCE_LINK_EVENT, { intent_artifact: intentName, intent_sha256: written.sha256, probe_journal: intent.journal.artifact });
  } finally {
    lock.release();
  }
  const probe = openProbeJournal(session);
  try {
    probe.append("probe-opened", { intent_artifact: intentName, intent_sha256: written.sha256, commissioning_run_id: session.runId, commissioning_attempt: session.attempt });
    probe.append("original-identity-bound", { capture: session.originalCapture });
    recordSourceObservation(session, probe, "stage");
    probe.append("registration-verified", {
      workflow_id: workflow.body.id, workflow_state: workflow.body.state, workflow_created_at: String(workflow.body.created_at),
      source_sha256: PROBE_WORKFLOW_SHA256, descriptor: registration,
    });
    probe.append("automation-inspected", {
      workflow_count: Object.keys(tree).length,
      workflows_sha256: canonicalHash(Object.fromEntries(Object.entries(tree).map(([file, text]) => [file, sha256(Buffer.from(text, "utf8"))]))),
      induced,
    });
    probe.append("ref-absent-verified", { ref: PROBE_REF, ...facts(absent), measured_at: absentAt });
  } finally {
    probe.lock.release();
  }
  return result(session, "stage", "staged", { probe_intent: written, environments: environmentIds, note: "Staged only. Nothing exists at the provider yet." });
}

export async function runDispatch({ runId, attempt, evidenceDir, env, deps }) {
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps, phase: "dispatch" });
  assertSourceNotMoved(session);
  const staged = loadStagedProbe(session);
  await assertOriginalUnapproved(session);
  const probe = openProbeJournal(session);
  try {
    const records = probe.records();
    if (records[0]?.type !== "probe-opened" || records[0].data.intent_sha256 !== staged.digest) throw new AssertionFailure("the probe journal is not bound to the staged intent");
    // A move measured by an EARLIER dispatch is a fact of this attempt, and the restored head that
    // follows is not a second chance at it (R06-F3): the accumulated history refuses, not the
    // moment's reading. Nothing is created, and nothing is dispatched.
    const interrupted = sourceInterruption(recordSourceObservation(session, probe, "dispatch"));
    if (interrupted) throw new IncompleteEvidence(`${interrupted}; clean up next`);
    const state = assessProbePhaseState(records, { workflowSha: session.commissioning.workflow_sha });
    if (state.dispatch) throw new AssertionFailure("the probe was already dispatched; dispatch is never re-issued");
    if (state.create && !state.ref.may_delete) throw new IncompleteEvidence("the original probe create is unresolved or unowned; it is never re-issued or adopted");
    const sha = session.commissioning.workflow_sha;
    if (!state.create) {
      const absent = await session.request("GET", probeRefPath);
      probe.append("ref-absent-verified", { ref: PROBE_REF, ...facts(absent), measured_at: session.now().toISOString() });
      if (absent.complete === true && absent.status === 200) throw new AssertionFailure("the fixed probe ref appeared after staging; an unowned ref is never adopted");
      if (!(absent.complete === true && absent.status === 404)) throw new IncompleteEvidence("the probe ref's absence could not be measured");

      // CREATE ONCE: durable intent, one request, its result — and reconciliation, not a retry.
      probe.append("ref-create-intent", { ref: PROBE_REF, sha });
      const created = await session.request("POST", `/repos/${REPO}/git/refs`, { ref: PROBE_REF, sha });
      const objectSha = created.complete === true && FULL_SHA.test(String(created.body?.object?.sha ?? "")) ? created.body.object.sha : null;
      probe.append("ref-create-result", { ref: PROBE_REF, sha, ...facts(created), object_sha: objectSha });
      if (!(created.complete === true && created.status === 201 && objectSha === sha)) {
        const readback = await session.request("GET", probeRefPath);
        probe.append("ref-readback", { ref: PROBE_REF, ...facts(readback), object_sha: readback.complete === true ? (String(readback.body?.object?.sha ?? "") || null) : null, measured_at: session.now().toISOString() });
        const at = session.now().toISOString();
        if (readback.complete === true && readback.status === 404) {
          probe.append("reconciliation", { of: "ref-create-intent", outcome: "absent", object_sha: null, measured_at: at });
          throw new IncompleteEvidence("the probe ref create did not establish application and the ref is absent; it is not re-created for this attempt");
        }
        if (readback.complete === true && readback.status === 200) {
          probe.append("reconciliation", { of: "ref-create-intent", outcome: "present-ownership-uncertain", object_sha: String(readback.body?.object?.sha ?? "") || null, measured_at: at });
          throw new IncompleteEvidence("the probe ref create did not establish application and a ref now exists; ownership is uncertain, so it is neither dispatched nor deleted — root reconciliation is required");
        }
        throw new IncompleteEvidence("the probe ref create did not establish application and its readback failed; the create intent stays unresolved");
      }
    }
    const readback = await session.request("GET", probeRefPath);
    probe.append("ref-readback", { ref: PROBE_REF, ...facts(readback), object_sha: readback.complete === true ? (String(readback.body?.object?.sha ?? "") || null) : null, measured_at: session.now().toISOString() });
    if (readback.complete !== true || readback.status !== 200 || readback.body?.object?.sha !== sha) throw new IncompleteEvidence("the created probe ref could not be read back at the reviewed source");

    for (const environment of PROBE_ENVIRONMENTS) {
      const previous = probe.records().find((row) => row.type === "policy-captured" && row.data.phase === "before" && row.data.environment === environment);
      if (previous) {
        const prior = asIncomplete(() => readPolicyDescriptor(session.dir, previous.data.descriptor, { environment, phase: "before" }));
        const original = asIncomplete(() => readPolicyDescriptor(session.dir, staged.intent.baseline_policy[environment], { environment, phase: "baseline" }));
        if (canonicalHash(prior.policy) !== canonicalHash(original.policy)) throw new AssertionFailure("the earlier before-probe policy contradicted the baseline; dispatch remains refused");
        continue;
      }
      const baseline = asIncomplete(() => readPolicyDescriptor(session.dir, staged.intent.baseline_policy[environment], { environment, phase: "baseline" }));
      const before = await capturePolicy(session, environment, "before");
      probe.append("policy-captured", { phase: "before", environment, environment_id: before.policy.environment_id, descriptor: before.ref, completed_at: before.completed_at });
      if (canonicalHash(before.policy) !== canonicalHash(baseline.policy)) throw new AssertionFailure(`${environment}'s policy changed between staging and dispatch; the probe is not dispatched`);
    }

    // DISPATCH ONCE. The deadline is fixed from the durable intent and never extended.
    const deadlineAt = new Date(session.now().getTime() + DISPATCH_DEADLINE_MS).toISOString();
    probe.append("dispatch-intent", { workflow_file: PROBE_WORKFLOW_FILE, ref: PROBE_BRANCH, deadline_at: deadlineAt });
    const dispatched = await session.request("POST", `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/dispatches`, { ref: PROBE_BRANCH });
    probe.append("dispatch-result", facts(dispatched));
    if (dispatched.complete === true && dispatched.status !== 204) throw new IncompleteEvidence(`the probe dispatch returned ${dispatched.status}; its effect is unknown — reconcile the run without re-dispatching`);
    return result(session, "dispatch", dispatched.complete === true ? "dispatched" : "dispatch-ambiguous", {
      deadline_at: deadlineAt, note: "Collect before the deadline. A lost dispatch answer is reconciled by collect, never re-dispatched.",
    });
  } finally {
    probe.lock.release();
  }
}

/**
 * Re-establish the run's FULL IMMUTABLE IDENTITY from a fresh read (R04-F1).
 *
 * Used on every path that could act on a run: binding it into the request guard when a previous
 * process identified it, each poll while waiting, and the instant before a cancellation. The
 * request boundary's own owned-run check is an allowlist keyed on what this probe journaled — it
 * cannot tell whether that journaled ID is genuinely ours, so ownership is established here.
 */
function assertRunOwnership(session, runId, body, when) {
  try {
    return assertProbeRunIdentity(body, {
      runId, repositoryId: session.commissioning.repository_id, workflowSha: session.commissioning.workflow_sha,
    });
  } catch (error) {
    if (!(error instanceof ProbeRefusal)) throw error;
    throw new AssertionFailure(`run ${runId} is not this probe's own run ${when} (${error.message}); it is neither collected nor cancelled`);
  }
}

async function assertOwnedProbeRun(session, probe, runId, when, boundary = "read") {
  const captured = await rawCapture(session, `/repos/${REPO}/actions/runs/${runId}`, `the probe run's identity ${when}`);
  // Persist before identity/status checks: a rejected rerun must survive a later restored response.
  probe.append("run-observed", { run_id: runId, boundary, capture: captured.ref });
  assertRunOwnership(session, runId, captured.body, when);
  asIncomplete(() => assessRunContinuity(probe.records(), {
    dir: session.dir, repositoryId: session.commissioning.repository_id, workflowSha: session.commissioning.workflow_sha,
  }));
  return captured.body;
}

/**
 * Bind a journaled run ID into the request guard and IMMEDIATELY prove it is ours. The guard has to
 * be set first — it is what permits the read at all — so a failed proof unbinds it again rather
 * than leaving a run this probe never established as owned reachable through the boundary.
 */
async function bindProbeRun(session, probe, runId, when, boundary = "read") {
  session.guardCtx.probeRunId = runId;
  try {
    return await assertOwnedProbeRun(session, probe, runId, when, boundary);
  } catch (error) {
    session.guardCtx.probeRunId = null;
    throw error;
  }
}

/**
 * Poll the ONE identified run until it is terminal or the given instant passes. Each complete
 * observation is retained before its identity check, so a run that is rerun or stops being ours
 * during the wait refuses here instead of being carried into a cancellation.
 */
async function waitTerminal(session, probe, runId, untilMs) {
  for (;;) {
    let body;
    const beforeRead = probe.records().length;
    try { body = await assertOwnedProbeRun(session, probe, runId, "while waiting for it to reach a terminal state"); }
    catch (error) {
      // Unavailable reads may be retried inside the original bound; retained contradictions may not.
      if (!(error instanceof IncompleteEvidence) || probe.records().length !== beforeRead) throw error;
    }
    if (body?.status === "completed") return body;
    if (session.now().getTime() >= untilMs) return null;
    await session.sleep(PROBE_POLL_INTERVAL_MS);
  }
}

/**
 * ── THE ONE OWNED-RUN RECONCILIATION, AND IT DOES NOT DEPEND ON COLLECTION (R06-F2) ─────────────
 *
 * Identifying the run this probe's own dispatch created is OWNERSHIP work, not measurement. It used
 * to live inside `runCollect`, which meant a source move measured at the first collection boundary
 * stranded the whole attempt: collect recorded the interruption and threw before reconciling, so
 * `cancel` found no `run-identified` and refused, and `cleanup` refused a dispatched-but-unidentified
 * run by sending the operator back to the collect that could never run again. A queued run and an
 * owned ref were left behind with no supported way to remove either — the canonical asks for exactly
 * the opposite, "interrupts the attempt, WITH CLEANUP and root reconciliation".
 *
 * So the primitive is shared, and its authority is deliberately narrow. It reconciles ONE dispatch
 * from the durable intent; it selects on the same repository/source/actor/attempt/window checks and
 * the same unique-run rule, so zero, several or foreign candidates refuse here exactly as they
 * refuse a collection; it NEVER re-dispatches; and it reads the run-selection window from the
 * journaled dispatch intent, so a later invocation cannot widen the window it lost.
 *
 * What it returns is the identification, never a measurement: `collect` still has to earn its
 * captures, and an interrupted attempt is still never accepted.
 */
async function reconcileOwnedRun(session, probe) {
  const records = probe.records();
  const identified = records.find((record) => record.type === "run-identified");
  if (identified) return identified;
  if (records.some((record) => record.type === "run-unidentified")) throw new IncompleteEvidence("the probe run was already recorded as unidentifiable; this attempt's probe is inconclusive");
  // THE DURABLE INTENT ADMITS THE RECONCILIATION, not the presence of its result (R04-F2). A process
  // cut between the dispatch intent and its journaled answer does not erase the dispatch: the
  // provider may well have applied it, and the run it created is ours to reconcile — once, from
  // the listing, never by dispatching again.
  const dispatch = records.find((record) => record.type === "dispatch-intent");
  if (!dispatch) throw new IncompleteEvidence("the probe has not been dispatched");
  // FROM THE DURABLE INTENT, never from this invocation's clock: a reconciliation that ran an hour
  // later must still be choosing among the runs the original window admits.
  const dispatchMs = Date.parse(dispatch.ts);
  const deadlineMs = Date.parse(dispatch.data.deadline_at);
  const identity = { repositoryId: session.commissioning.repository_id, workflowSha: session.commissioning.workflow_sha };
  const assessSelections = () => asIncomplete(() => assessRunSelectionContinuity(probe.records(), {
    dir: session.dir, dispatchIntentMs: dispatchMs, deadlineMs, identity,
  }));
  // A prior rejected peek/page binds this process before any fresh provider response can restore it.
  assessSelections();
  const nextSelectionId = () => Math.max(0, ...probe.records().filter((record) => record.type === "run-selection-observed")
    .map((record) => Number(record.data.selection_id))) + 1;
  const retainSelection = (selectionId, boundary, page, ref) => {
    probe.append("run-selection-observed", { selection_id: selectionId, boundary, page, capture: ref });
    assessSelections();
  };
  /** Resolve an interrupted dispatch intent exactly once, from what the listing actually shows. */
  const reconcileDispatch = (outcome, objectSha) => {
    const current = probe.records();
    if (current.some((record) => record.type === "dispatch-result")
      || current.some((record) => record.type === "reconciliation" && record.data.of === "dispatch-intent")) return;
    probe.append("reconciliation", { of: "dispatch-intent", outcome, object_sha: objectSha, measured_at: session.now().toISOString() });
  };

  // THE ONE ELIGIBLE RUN. Zero or several is never resolved by picking; nothing is re-dispatched.
  const listing = `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/runs?branch=${PROBE_BRANCH}&event=${PROBE_EVENT}`;
  for (;;) {
    let seen = 0;
    let captured = false;
    try {
      const peek = await rawCapture(session, `${listing}&per_page=${PAGE_SIZE}&page=1`, "the probe run listing peek");
      captured = true;
      retainSelection(nextSelectionId(), "peek", 1, peek.ref);
      seen = asIncomplete(() => selectEligibleRuns([{ page: 1, body: { ...peek.body, total_count: peek.body.workflow_runs.length } }], { dispatchIntentMs: dispatchMs, deadlineMs, identity })).length;
    } catch (error) {
      // Unavailable peeks remain incomplete reads and may be retried inside the original deadline.
      // Once exact bytes were retained, any rejection derived from them is durable and must escape.
      if (captured || !(error instanceof IncompleteEvidence)) throw error;
    }
    if (seen > 0 || session.now().getTime() >= deadlineMs) break;
    await session.sleep(PROBE_POLL_INTERVAL_MS);
  }
  const listingId = nextSelectionId();
  const selection = await pagedCapture(session, listing, "workflow_runs", "the probe run listing",
    async (page, ref) => retainSelection(listingId, "listing", page, ref));
  const descriptor = writeDescriptor(session, { capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "run-selection", pages: selection.pages });
  const pages = selection.pages.map((ref) => ({ page: ref.page, body: JSON.parse(readFileSync(path.join(session.dir, ref.artifact), "utf8")) }));
  const eligible = asIncomplete(() => selectEligibleRuns(pages, { dispatchIntentMs: dispatchMs, deadlineMs, identity }));
  if (eligible.length !== 1) {
    probe.append("run-unidentified", { eligible: eligible.length, descriptor, reason: eligible.length ? "several eligible runs" : "no eligible run by the deadline" });
    // A complete empty listing cannot distinguish an unapplied request from a hidden live run.
    // No reconciliation row may turn that uncertainty into nonapplication authority.
    if (eligible.length > 1) throw new AssertionFailure(`${eligible.length} eligible probe runs exist; none is selected, and the probe cannot pass`);
    throw new IncompleteEvidence("no eligible probe run appeared by the deadline; the probe is inconclusive and nothing is re-dispatched");
  }
  const record = probe.append("run-identified", { run_id: eligible[0], eligible: 1, descriptor });
  reconcileDispatch("present-unchanged", session.commissioning.workflow_sha);
  return record;
}

const journalTerminal = (session, probe, runId, body) => {
  probe.append("run-terminal", {
    run_id: runId, run_attempt: body.run_attempt ?? null, status: body.status, conclusion: body.conclusion ?? null,
    observed_at: session.now().toISOString(),
  });
  return body;
};

async function cancelAndConfirm(session, probe, runId, reason) {
  let intent = probe.records().find((record) => record.type === "cancel-intent");
  if (!intent) {
    // The last thing before the ONE mutation this probe aims at a run: prove it is still ours.
    const live = await assertOwnedProbeRun(session, probe, runId, "immediately before cancelling it", "cancel");
    // ALREADY TERMINAL: what an exactly-owned run that has already finished needs is its terminal
    // state written down, not a cancellation aimed at a run that has nothing left to stop (R06).
    if (live.status === "completed") return journalTerminal(session, probe, runId, live);
    intent = probe.append("cancel-intent", { run_id: runId, reason });
    const cancelled = await session.request("POST", `/repos/${REPO}/actions/runs/${runId}/cancel`);
    probe.append("cancel-result", { run_id: runId, ...facts(cancelled) });
  }
  // THE FIRST DURABLE CANCELLATION'S OWN BOUND, CARRIED ACROSS RESTARTS (R06). Measuring it from
  // this invocation's clock handed every fresh process another two minutes, so a run that never
  // reaches a terminal state could be waited on indefinitely, two minutes at a time, while the
  // evidence said it had been confirmed within the canonical bound. Exhaustion stays exhausted.
  const terminal = await waitTerminal(session, probe, runId, Date.parse(intent.ts) + CANCEL_CONFIRM_MS);
  if (!terminal) {
    throw new IncompleteEvidence("the probe run is still not terminal two minutes after cancellation; cleanup is BLOCKED — evidence is retained and nothing is claimed");
  }
  return journalTerminal(session, probe, runId, terminal);
}

export async function runCollect({ runId, attempt, evidenceDir, env, deps }) {
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps, phase: "collect", continuity: "observe" });
  const staged = loadStagedProbe(session);
  await assertOriginalUnapproved(session);
  const probe = openProbeJournal(session);
  let captureCategory = null;
  let captureRunId = null;
  try {
    // THE MEASURED SOURCE FIRST (R05-F2). A collection that opened while the live staging head was
    // somewhere else is not measuring the tree this attempt is bound to, and the move is recorded
    // before anything is captured so a restored head cannot erase it.
    const interrupted = sourceInterruption(recordSourceObservation(session, probe, "collect"));
    if (interrupted) throw new IncompleteEvidence(`${interrupted}; clean up next`);
    const identified = await reconcileOwnedRun(session, probe, "collect");
    const probeRunId = identified.data.run_id;
    // Binding a run this process did not itself select — a resumed collection — re-proves it first.
    await bindProbeRun(session, probe, probeRunId, "before collecting it");

    let records = probe.records();
    // THE ORIGINAL WINDOW, re-read from the durable intent the reconciliation selected within, so
    // the wait and the capture bounds are the ones this attempt has had all along.
    const dispatch = records.find((record) => record.type === "dispatch-intent");
    const dispatchMs = Date.parse(dispatch.ts);
    const deadlineMs = Date.parse(dispatch.data.deadline_at);
    let terminalRecord = records.find((record) => record.type === "run-terminal");
    if (!terminalRecord) {
      const terminal = await waitTerminal(session, probe, probeRunId, deadlineMs);
      if (!terminal) {
        await cancelAndConfirm(session, probe, probeRunId, "deadline");
        throw new IncompleteEvidence("the probe reached no terminal state within ten minutes; it was cancelled, which is inconclusive — clean up next");
      }
      terminalRecord = probe.append("run-terminal", { run_id: probeRunId, run_attempt: terminal.run_attempt ?? null, status: terminal.status, conclusion: terminal.conclusion ?? null, observed_at: session.now().toISOString() });
    }
    if (records.some((record) => record.type === "cancel-intent")) throw new IncompleteEvidence("the probe run was cancelled; a cancellation is inconclusive — clean up next");
    if (records.some((record) => record.type === "observation-recorded")) throw new AssertionFailure("this probe's observations were already recorded; they are never rewritten");

    if (session.now().getTime() > deadlineMs) throw new IncompleteEvidence("the original dispatch capture deadline has expired; explicit cancel can end qualification for cleanup");
    captureRunId = probeRunId;
    captureCategory = "run";
    // Each successful capture is committed before the next fallible provider read.
    const runInitial = await rawCapture(session, `/repos/${REPO}/actions/runs/${probeRunId}`, "the probe run");
    probe.append("run-observed", { run_id: probeRunId, boundary: "read", capture: runInitial.ref });
    assertRunOwnership(session, probeRunId, runInitial.body, "before collecting jobs");
    asIncomplete(() => assessRunContinuity(probe.records(), { dir: session.dir, repositoryId: session.commissioning.repository_id, workflowSha: session.commissioning.workflow_sha }));
    captureCategory = "jobs";
    const jobs = await pagedCapture(session, `/repos/${REPO}/actions/runs/${probeRunId}/jobs?filter=all`, "jobs", "the probe jobs",
      (page, capture) => probe.append("capture-progress", { run_id: probeRunId, kind: "jobs", page, capture }));
    const jobsDescriptor = writeDescriptor(session, { capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "jobs", pages: jobs.pages });
    probe.append("capture-recorded", { kind: "jobs", environment: null, descriptor: jobsDescriptor, completed_at: session.now().toISOString() });
    retainAdmissions(session, probe, probeRunId, runInitial.ref, jobsDescriptor);
    captureCategory = "denial";
    const jobRows = jobs.pages.flatMap((ref) => JSON.parse(readFileSync(path.join(session.dir, ref.artifact), "utf8")).jobs ?? []);
    const denials = {};
    for (const spec of PROBE_JOBS) {
      const job = jobRows.filter((row) => row?.name === spec.job_key);
      if (job.length !== 1) continue;
      let checkId;
      try { checkId = parseCheckRunUrl(job[0].check_run_url); } catch { continue; }
      session.guardCtx.probeCheckIds.add(checkId);
      const check = await rawCapture(session, `/repos/${REPO}/check-runs/${checkId}`, `the ${spec.job_key} check`);
      probe.append("capture-progress", { run_id: probeRunId, kind: "check", page: 1, capture: check.ref });
      const annotations = await pagedCapture(session, `/repos/${REPO}/check-runs/${checkId}/annotations`, null, `the ${spec.job_key} annotations`,
        (page, capture) => probe.append("capture-progress", { run_id: probeRunId, kind: "annotations", page, capture }));
      const checkTerminal = await rawCapture(session, `/repos/${REPO}/check-runs/${checkId}`, `the ${spec.job_key} check re-read`);
      probe.append("capture-progress", { run_id: probeRunId, kind: "check", page: 1, capture: checkTerminal.ref });
      denials[spec.environment] = writeDescriptor(session, {
        diagnostic_schema_version: DIAGNOSTIC_SCHEMA_VERSION, check_id: checkId,
        check: { ...check.ref, terminal: checkTerminal.ref }, annotations: annotations.pages,
      });
      probe.append("capture-recorded", { kind: "denial", environment: spec.environment, descriptor: denials[spec.environment], completed_at: session.now().toISOString() });
    }
    captureCategory = "terminal";
    const runTerminal = await rawCapture(session, `/repos/${REPO}/actions/runs/${probeRunId}`, "the probe run re-read");
    probe.append("run-observed", { run_id: probeRunId, boundary: "read", capture: runTerminal.ref });
    asIncomplete(() => assessRunContinuity(probe.records(), { dir: session.dir, repositoryId: session.commissioning.repository_id, workflowSha: session.commissioning.workflow_sha }));
    const runDescriptor = writeDescriptor(session, { capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "run", initial: runInitial.ref, terminal: runTerminal.ref });
    const capturedAt = session.now().toISOString();
    probe.append("capture-recorded", { kind: "run", environment: null, descriptor: runDescriptor, completed_at: capturedAt });
    captureCategory = "policy";
    const after = {};
    for (const environment of PROBE_ENVIRONMENTS) {
      after[environment] = await capturePolicy(session, environment, "after");
      probe.append("policy-captured", { phase: "after", environment, environment_id: after[environment].policy.environment_id, descriptor: after[environment].ref, completed_at: after[environment].completed_at });
    }

    captureCategory = "derivation";
    // DERIVE, per environment. The collector writes an observation only for a re-derived refusal.
    const before = Object.fromEntries(probe.records().filter((record) => record.type === "policy-captured" && record.data.phase === "before").map((record) => [record.data.environment, record.data.descriptor]));
    const outcomes = {};
    const records_out = {};
    for (const spec of PROBE_JOBS) {
      const environment = spec.environment;
      let outcome = "unverified";
      let reason = null;
      let captured = null;
      try {
        if (!denials[environment]) throw new ProbeRefusal(`no ${spec.job_key} job with a check-run link was captured`);
        captured = verifyProbeCaptures(session.dir, {
          providerEvidence: { run: runDescriptor, jobs: jobsDescriptor, denial: denials[environment], environment_before: before[environment], environment_after: after[environment].ref },
          environment, commissioning: session.commissioning, runId: probeRunId, dispatchMs, deadlineMs,
        });
        const baseline = readPolicyDescriptor(session.dir, staged.intent.baseline_policy[environment], { environment, phase: "baseline" });
        const beforePolicy = readPolicyDescriptor(session.dir, before[environment], { environment, phase: "before" });
        if (canonicalHash(beforePolicy.policy) !== canonicalHash(baseline.policy) || canonicalHash(after[environment].policy) !== canonicalHash(baseline.policy)) {
          throw new ProbeRefusal(`${environment}'s policy changed across the probe`);
        }
        outcome = "refused";
      } catch (error) {
        if (!(error instanceof ProbeRefusal)) throw error;
        reason = error.message;
        if (probe.records().some((row) => row.type === "admission-observed" && row.data.environment === environment)) outcome = "admitted";
      }
      if (outcome !== "refused") {
        probe.append("observation-recorded", { environment, outcome, artifact: null, sha256: null, measured_at: session.now().toISOString(), reason });
        outcomes[environment] = outcome;
        continue;
      }
      const measuredAt = session.now().toISOString();
      const observation = {
        offbranch_schema_version: OFFBRANCH_SCHEMA_VERSION, control: OFFBRANCH_CONTROL, environment,
        environment_id: staged.parsed.environments[environment], source: "provider-api", measured_at: measuredAt, measured: { ...EXPECTED },
        run_id: probeRunId, attempt: PROBE_ATTEMPT, commissioning: session.commissioning,
        probe_intent: { artifact: staged.name, sha256: staged.digest },
        probe: {
          workflow_path: PROBE_WORKFLOW_PATH, workflow_sha: session.commissioning.workflow_sha, ref: PROBE_REF, event: PROBE_EVENT,
          job_key: spec.job_key, job_id: captured.job.job_id, actor: { ...PROBE_DISPATCHER }, triggering_actor: { ...PROBE_DISPATCHER },
          created_at: captured.run.created_at, terminal_at: captured.job.completed_at,
        },
        provider_evidence: { run: runDescriptor, jobs: jobsDescriptor, denial: denials[environment], environment_before: before[environment], environment_after: after[environment].ref },
      };
      const written = writeCreateOnce(session.dir, probeObservationName(session.runId, session.attempt, environment), `${JSON.stringify(observation, null, 2)}\n`);
      probe.append("observation-recorded", { environment, outcome, artifact: written.artifact, sha256: written.sha256, measured_at: measuredAt, reason: null });
      outcomes[environment] = outcome;
      // The environment-controls record the operator files. It only REPEATS the observation.
      records_out[environment] = {
        status: "verified", source: "provider-api", environment_name: environment, environment_id: observation.environment_id,
        expected: { ...EXPECTED }, measured: { ...EXPECTED }, measured_at: measuredAt, run_id: probeRunId, attempt: PROBE_ATTEMPT,
        artifact: written.artifact, artifact_sha256: written.sha256, offbranch_schema_version: OFFBRANCH_SCHEMA_VERSION, commissioning: session.commissioning,
      };
    }
    if (Object.values(outcomes).includes("admitted")) {
      throw new AssertionFailure(`a probe job was admitted by an environment that must refuse the off-branch ref (${JSON.stringify(outcomes)}); the negative control FAILED — clean up next`);
    }
    if (Object.values(outcomes).some((outcome) => outcome !== "refused")) {
      throw new IncompleteEvidence(`the refusal could not be derived for every environment (${JSON.stringify(outcomes)}); it stays unverified — clean up next`);
    }
    captureCategory = null;
    return result(session, "collect", "measured", {
      probe_run_id: probeRunId, outcomes, records: records_out,
      note: "Measured, not accepted: clean up next, then check-evidence re-derives everything offline.",
    });
  } catch (error) {
    if (captureCategory && captureRunId && !assessProbePhaseState(probe.records(), { workflowSha: session.commissioning.workflow_sha }).paired) {
      probe.append("capture-failed", { run_id: captureRunId, phase: "collect", category: captureCategory,
        capture_sequences: probe.records().filter((row) => ["capture-progress", "capture-recorded", "run-observed"].includes(row.type)).map((row) => row.seq) });
    }
    if (assessProbePhaseState(probe.records(), { workflowSha: session.commissioning.workflow_sha }).failed) throw new AssertionFailure("an exactly bound probe job was admitted; the negative control FAILED and retained captures require explicit cancel before cleanup");
    throw error;
  } finally {
    probe.lock.release();
  }
}

function retainAdmissions(session, probe, runId, runCapture, jobsDescriptor) {
  const admitted = asIncomplete(() => deriveProbeAdmissions(session.dir, { runCapture, jobsDescriptor, commissioning: session.commissioning, runId }));
  for (const fact of admitted) {
    if (!probe.records().some((row) => row.type === "admission-observed" && row.data.environment === fact.environment)) {
      probe.append("admission-observed", { run_id: runId, ...fact, run_capture: runCapture, jobs_descriptor: jobsDescriptor });
    }
  }
}

export async function runCancel({ runId, attempt, evidenceDir, env, deps }) {
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps, phase: "cancel", continuity: "observe" });
  if (session.state.closed) return result(session, "cancel", "already-closed");
  loadStagedProbe(session);
  const probe = openProbeJournal(session);
  try {
    // Recorded, never blocking: cancelling this probe's OWN run is exactly the safe action a source
    // interruption still permits (R05-F2).
    recordSourceObservation(session, probe, "cancel");
    if (probe.records().some((record) => record.type === "probe-closed")) return result(session, "cancel", "already-closed");
    // A run this probe dispatched but never identified — because the collection that would have
    // identified it was interrupted — is still exactly ours to authenticate and stop (R06-F2).
    const identified = await reconcileOwnedRun(session, probe, "cancel");
    const live = await bindProbeRun(session, probe, identified.data.run_id, "before cancelling it", "cancel");
    if (live.status === "completed") {
      if (!probe.records().some((record) => record.type === "run-terminal")) journalTerminal(session, probe, identified.data.run_id, live);
      let state = assessProbePhaseState(probe.records(), { workflowSha: session.commissioning.workflow_sha });
      if (state.paired) return result(session, "cancel", "already-terminal");
      if (!state.aborted) {
        const records = probe.records();
        let jobs = records.find((row) => row.type === "capture-recorded" && row.data.kind === "jobs");
        // A process may stop after fsyncing the last jobs page and before its descriptor/admission
        // append. Reuse those exact retained pages; this is recovery of original facts, no re-read.
        if (!jobs) {
          const pages = records.filter((row) => row.type === "capture-progress" && row.data.kind === "jobs");
          const bodies = pages.map((row) => JSON.parse(readFileSync(path.join(session.dir, row.data.capture.artifact), "utf8")));
          const total = bodies[0]?.total_count;
          if (pages.length && Number.isSafeInteger(total) && pages.every((row, index) => row.data.page === index + 1)
            && bodies.every((body) => body.total_count === total && Array.isArray(body.jobs))
            && bodies.reduce((count, body) => count + body.jobs.length, 0) === total
            && pages.length === Math.max(1, Math.ceil(total / PAGE_SIZE))) {
            const descriptor = writeDescriptor(session, { capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "jobs", pages: pages.map((row) => ({ page: row.data.page, ...row.data.capture })) });
            jobs = probe.append("capture-recorded", { kind: "jobs", environment: null, descriptor, completed_at: pages.at(-1).data.capture.completed_at });
          }
        }
        const firstJobPage = records.find((row) => row.type === "capture-progress" && row.data.kind === "jobs");
        const run = records.filter((row) => row.type === "run-observed" && row.seq < (firstJobPage?.seq ?? jobs?.seq ?? 0)).at(-1);
        if (jobs && run) retainAdmissions(session, probe, identified.data.run_id, run.data.capture, jobs.data.descriptor);
        const terminal = probe.records().filter((row) => row.type === "run-observed").at(-1);
        probe.append("qualification-ended", { run_id: identified.data.run_id, reason: "operator-terminal-abort", terminal_sequence: terminal.seq });
      }
      state = assessProbePhaseState(probe.records(), { workflowSha: session.commissioning.workflow_sha });
      return result(session, "cancel", "terminal-aborted", { outcome: state.failed ? "failed" : "inconclusive" });
    }
    await cancelAndConfirm(session, probe, identified.data.run_id, "operator");
    return result(session, "cancel", "cancelled", { note: "A cancelled probe is inconclusive. Clean up next." });
  } finally {
    probe.lock.release();
  }
}

function closeOutcome(records, { workflowSha, session }) {
  const observations = records.filter((record) => record.type === "observation-recorded");
  // An ADMITTED job is a real negative-control failure and keeps precedence over every other
  // reading: an interrupted attempt is untrustworthy in the passing direction, not in this one.
  const state = assessProbePhaseState(records, { workflowSha });
  if (state.failed) return "failed";
  try { assessOriginalProbeBinding(records, { dir: session.dir, commissioning: session.commissioning, dispatcher: session.intent.dispatcher, qualification: true }); }
  catch (error) { if (!(error instanceof ProbeRefusal)) throw error; return "inconclusive"; }
  if (state.ended || !state.paired) return "inconclusive";
  // MEASURED needs the accumulated lifecycle to support it: the owned ref actually gone and its
  // absence measured (R05-F1), and no recorded source interruption anywhere in this history
  // (R05-F2). Either one alone downgrades the close to inconclusive, permanently.
  if (!assessRefOwnership(records, { workflowSha }).may_accept) return "inconclusive";
  if (assessSourceContinuity(records).interrupted) return "inconclusive";
  if (observations.length === PROBE_ENVIRONMENTS.length && observations.every((record) => record.data.outcome === "refused")
    && !records.some((record) => record.type === "cancel-intent")) return "measured";
  return "inconclusive";
}

export async function runCleanup({ runId, attempt, evidenceDir, env, deps }) {
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps, phase: "cleanup", continuity: "observe" });
  if (session.state.closed) return result(session, "cleanup", "already-closed");
  loadStagedProbe(session);
  const deleteRef = deps.deleteRef ?? createGitLeaseDeleter({ spawnImpl: deps.spawnImpl, env });
  const probe = openProbeJournal(session);
  try {
    if (probe.records().some((record) => record.type === "probe-closed")) return result(session, "cleanup", "already-closed");
    // Recorded, never blocking: removing what this run created is the one thing a source move must
    // NOT stop (R05-F2). What it does stop is the measured close, derived in `closeOutcome`.
    recordSourceObservation(session, probe, "cleanup");
    let records = probe.records();
    const sha = session.commissioning.workflow_sha;

    // ── ACTION AUTHORITY, DERIVED FROM THE WHOLE HISTORY (R05-F1) ────────────────────────────────
    // A contradiction recorded by any earlier invocation binds this one. It is re-derived here, so
    // a fresh process reaches the same refusal, and a ref that merely LOOKS familiar again cannot
    // re-open a creation whose ownership already ended.
    let ownership = assessRefOwnership(records, { workflowSha: sha });
    // A result row is not proof that a create had no effect. If the writer stopped after retaining
    // an error result but before its bounded readback, cleanup performs that read-only reconciliation
    // first. Exact absence may establish that no resource remains; any presence makes ownership
    // uncertainty permanent and never grants adoption or deletion authority.
    if (ownership.pending?.of === "ref-create-intent") {
      const readback = await session.request("GET", probeRefPath);
      probe.append("ref-readback", { ref: PROBE_REF, ...facts(readback), object_sha: readback.complete === true ? (String(readback.body?.object?.sha ?? "") || null) : null, measured_at: session.now().toISOString() });
      if (readback.complete === true && readback.status === 404) {
        probe.append("reconciliation", { of: "ref-create-intent", outcome: "absent", object_sha: null, measured_at: session.now().toISOString() });
      } else if (readback.complete === true && readback.status === 200) {
        probe.append("reconciliation", { of: "ref-create-intent", outcome: "present-ownership-uncertain", object_sha: String(readback.body?.object?.sha ?? "") || null, measured_at: session.now().toISOString() });
      } else {
        throw new IncompleteEvidence("the uncertain probe ref create could not be reconciled; the journal remains open and no resource is deleted");
      }
      ownership = assessRefOwnership(probe.records(), { workflowSha: sha });
      records = probe.records();
    }
    if (ownership.state === "uncertain") {
      throw ownership.severity === "assertion" ? new AssertionFailure(ownership.reason) : new IncompleteEvidence(ownership.reason);
    }
    // AFTER TERMINAL CAPTURE: an identified run must be terminal, and a terminal failure collected.
    let identified = records.find((record) => record.type === "run-identified");
    const dispatchIntent = records.find((record) => record.type === "dispatch-intent");
    // Driven by the durable INTENT, not by whether its result was ever appended (R04-F2). A process
    // cut after the provider applied the dispatch leaves a live run behind; closing over it because
    // no `dispatch-result` exists would delete the ref and file the probe while the run is queued.
    //
    // It is reconciled HERE (R06-F2), by the shared primitive, rather than by sending the operator
    // back to `collect`: when the interruption that stopped the collection is the reason the run was
    // never identified, "collect before cleanup" is an instruction to a phase that will refuse for
    // ever, and the owned ref never goes.
    if (dispatchIntent && !identified && !records.some((record) => record.type === "run-unidentified")) {
      identified = await reconcileOwnedRun(session, probe, "clean up");
      records = probe.records();
    }
    // ── NOTHING IS DELETED OR CLOSED OVER A RUN SET NOBODY RESOLVED (R06) ────────────────────────
    // Zero, duplicate and foreign candidates are BLOCKED here, not just at selection. The recovery
    // primitive above deliberately cannot pick one of them, so at this point the attempt either owns
    // exactly one run or owns no knowledge of what it started — and in the second case a live run
    // may still be holding the very ref this phase is about to remove. Refusing keeps the evidence
    // and hands it to root reconciliation, which is the only authority that can resolve it.
    //
    if (dispatchIntent && !identified) {
      throw new IncompleteEvidence("this probe's dispatched run was never resolved to exactly one owned run; a run it started may still be live, so the owned ref is NOT deleted and the journal is NOT closed — the evidence is retained for root reconciliation");
    }
    const confirmTerminal = async (boundary) => {
      if (!identified) return;
      const live = await bindProbeRun(session, probe, identified.data.run_id, "before cleanup", boundary);
      if (live.status !== "completed") throw new IncompleteEvidence("the probe run is not terminal; cancel (or collect) it before cleanup");
    };
    await confirmTerminal("cleanup-entry");
    if (ownership.state === "unowned") {
      if (unresolvedProbeIntents(records).length) throw new IncompleteEvidence("an unresolved probe intent remains; reconcile before closing");
      probe.append("probe-closed", { outcome: "inconclusive" });
      return result(session, "cleanup", "nothing-owned", { note: "No owned probe ref exists; the journal is closed as inconclusive." });
    }
    const terminal = records.find((record) => record.type === "run-terminal");
    if (identified && !terminal) throw new IncompleteEvidence("the probe run is not terminal; cancel (or collect) it before cleanup");
    const cancelled = records.some((record) => record.type === "cancel-intent");
    // The collection this waits for exists to capture the evidence of a probe that could still pass.
    // An attempt whose source moved can never pass, so requiring it there protects nothing and only
    // strands the cleanup — the one phase the interruption must NOT stop (R06-F2).
    if (terminal && !cancelled && !assessSourceContinuity(records).interrupted && !assessProbePhaseState(records, { workflowSha: sha }).paired && !records.some((record) => record.type === "qualification-ended")) {
      throw new IncompleteEvidence("the terminal probe run has not been collected; collect before cleanup so the original evidence is captured first");
    }
    const at = () => session.now().toISOString();
    const close = async (status, extra = {}) => {
      await confirmTerminal("closure");
      const current = probe.records();
      // The journal is never closed over an unknown outcome: every intent carries a result or an
      // explicit reconciliation by now, or this probe stays open and blocked (R04-F2).
      const open = unresolvedProbeIntents(current);
      if (open.length) {
        throw new IncompleteEvidence(`${open.length} probe intent(s) are still unresolved (${open.map((entry) => `${entry.type}#${entry.seq}`).join(", ")}); the journal is not closed until each is reconciled`);
      }
      const outcome = closeOutcome(current, { workflowSha: sha, session });
      probe.append("probe-closed", { outcome });
      return result(session, "cleanup", status, { outcome, ...extra });
    };
    /**
     * WHAT A MEASUREMENT MEANS IS DERIVED; WHAT IT PERMITS IS NEVER ASSUMED (R05-F1).
     *
     * Every branch below appends what it measured and then RE-DERIVES the ownership from the whole
     * history including it. That ordering is the fix: the reconciliation row is a fact about the
     * ref, not a permission, so a later invocation reading "a reconciliation exists" can no longer
     * treat it as confirmation of the deletion that preceded it.
     */
    const settle = () => {
      const derived = assessRefOwnership(probe.records(), { workflowSha: sha });
      if (derived.state !== "uncertain") return derived;
      throw derived.severity === "assertion" ? new AssertionFailure(derived.reason) : new IncompleteEvidence(derived.reason);
    };
    /**
     * A deletion whose TERMINAL READBACK is missing is RECONCILED before anything else happens.
     *
     * That includes a deletion this probe recorded as SUCCESSFUL (R04-F4): `deleted` durably
     * journaled and then a lost absence GET, or a process stopped before it, leaves a correctly
     * measured probe whose own history explains the 404 that follows. Treating that expected
     * absence as an unexplained disappearance stranded the probe; so the retained delete result
     * owns the recovery of its own missing confirmation, and no second deletion is issued.
     *
     * The other reading of that same missing confirmation is the one R05-F1 found: a ref that is
     * PRESENT again. It is never this creation coming back — the deletion succeeded — so it ends
     * the lifecycle instead of resuming it, whatever bytes it carries.
     */
    if (ownership.pending) {
      const readback = await session.request("GET", probeRefPath);
      probe.append("ref-readback", { ref: PROBE_REF, ...facts(readback), object_sha: readback.complete === true ? (String(readback.body?.object?.sha ?? "") || null) : null, measured_at: session.now().toISOString() });
      if (readback.complete === true && readback.status === 404) {
        probe.append("reconciliation", { of: "cleanup-intent", outcome: "absent", object_sha: null, measured_at: at() });
        probe.append("absence-verified", { ref: PROBE_REF, ...facts(readback), measured_at: at() });
        settle();
        return await close("cleaned-after-reconciliation");
      }
      if (readback.complete === true && readback.status === 200) {
        const objectSha = String(readback.body?.object?.sha ?? "");
        probe.append("reconciliation", { of: "cleanup-intent", outcome: objectSha === sha ? "present-unchanged" : "present-changed", object_sha: objectSha || null, measured_at: at() });
        settle();
        throw new IncompleteEvidence(UNDECIDED_DELETION);
      }
      throw new IncompleteEvidence("a lost deletion could not be reconciled; its readback failed");
    }

    const readback = await session.request("GET", probeRefPath);
    probe.append("ref-readback", { ref: PROBE_REF, ...facts(readback), object_sha: readback.complete === true ? (String(readback.body?.object?.sha ?? "") || null) : null, measured_at: session.now().toISOString() });
    if (readback.complete !== true || ![200, 404].includes(readback.status)) throw new IncompleteEvidence("the owned probe ref could not be read back before cleanup");
    if (readback.status === 404) {
      probe.append("absence-verified", { ref: PROBE_REF, ...facts(readback), measured_at: at() });
      // An absence this probe's OWN durable history explains is the expected end state, not a
      // disappearance. Without such a deletion recorded, the ownership history really is broken.
      settle();
      return await close("cleaned-after-reconciliation");
    }
    if (readback.body?.object?.sha !== sha) {
      probe.append("ref-readback", { ref: PROBE_REF, ...facts(readback), object_sha: String(readback.body?.object?.sha ?? "") || null, measured_at: at() });
      // `settle` is what refuses, and it is what makes the refusal STICK: the recorded readback
      // leaves the ownership permanently uncertain, so a later invocation finding the ref restored
      // to the reviewed SHA derives the same answer instead of deleting somebody else's ref. The
      // throw below states the same conclusion should the derivation ever be loosened.
      settle();
      throw new AssertionFailure("the owned probe ref points at a SHA this probe did not create; it is never deleted");
    }
    // THE ONE PLACE A DELETION IS ISSUED, and it is gated on the derived authority rather than on
    // this invocation's readback: presence at the expected bytes is not, by itself, ownership.
    if (!settle().may_delete) throw new IncompleteEvidence("the owned probe ref's accumulated lifecycle does not authorise a lease deletion; root reconciliation is required");
    await confirmTerminal("delete");
    probe.append("cleanup-intent", { ref: PROBE_REF, expected_sha: sha });
    const deletion = await deleteRef({ ref: PROBE_REF, expectedSha: sha });
    const outcome = ["deleted", "lease-refused", "ambiguous"].includes(deletion?.outcome) ? deletion.outcome : "ambiguous";
    probe.append("cleanup-result", { ref: PROBE_REF, expected_sha: sha, outcome, exit_code: Number.isInteger(deletion?.exit_code) ? deletion.exit_code : null });
    if (outcome === "lease-refused") throw new AssertionFailure("the lease deletion was refused: the owned probe ref changed, and it is left untouched");
    const after = await session.request("GET", probeRefPath);
    probe.append("ref-readback", { ref: PROBE_REF, ...facts(after), object_sha: after.complete === true ? (String(after.body?.object?.sha ?? "") || null) : null, measured_at: session.now().toISOString() });
    if (after.complete === true && after.status === 404) {
      if (outcome === "ambiguous") probe.append("reconciliation", { of: "cleanup-intent", outcome: "absent", object_sha: null, measured_at: at() });
      probe.append("absence-verified", { ref: PROBE_REF, ...facts(after), measured_at: at() });
      settle();
      return await close("cleaned");
    }
    if (after.complete === true && after.status === 200) {
      const objectSha = String(after.body?.object?.sha ?? "");
      probe.append("reconciliation", { of: "cleanup-intent", outcome: objectSha === sha ? "present-unchanged" : "present-changed", object_sha: objectSha || null, measured_at: at() });
      settle();
      throw new IncompleteEvidence(UNDECIDED_DELETION);
    }
    throw new IncompleteEvidence("the owned probe ref's absence could not be confirmed after deletion; cleanup is not claimed");
  } finally {
    probe.lock.release();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. The closed CLI.
// ──────────────────────────────────────────────────────────────────────────────

const FLAGS = Object.freeze(["--run-id", "--attempt", "--evidence-dir"]);

export function parseProbeArgs(argv) {
  const args = [...argv];
  const phase = args.shift();
  if (!PROBE_PHASES.includes(phase)) throw new UsageError(`usage: offbranch-probe-operator.mjs <${PROBE_PHASES.join("|")}> --run-id <n> --attempt <n> --evidence-dir <dir>`);
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
  if (!path.isAbsolute(evidenceDir) || /[\0\n]/.test(evidenceDir)) throw new UsageError("--evidence-dir must be an absolute plain local directory");
  return { phase, runId, attempt, evidenceDir };
}

export async function runProbePhase({ phase, runId, attempt, evidenceDir, env = process.env, deps = {} }) {
  const phases = Object.freeze({ stage: runStage, dispatch: runDispatch, collect: runCollect, cancel: runCancel, cleanup: runCleanup });
  if (!PROBE_PHASES.includes(phase) || !Object.hasOwn(phases, phase)) {
    throw new UsageError(`unsupported probe phase ${JSON.stringify(String(phase))}`);
  }
  const run = phases[phase];
  try {
    return await run({ runId, attempt, evidenceDir, env, deps });
  } catch (error) {
    if (error instanceof ProbeRefusal) throw new IncompleteEvidence(error.message);
    throw error;
  }
}

const EXIT_STATUS = Object.freeze({ 1: "failed", 2: "refused", 3: "incomplete" });

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const write = deps.write ?? ((text) => process.stdout.write(text));
  const redact = createRedactor(collectSentinels(env));
  let parsed = null;
  try {
    parsed = parseProbeArgs(argv);
    const outcome = await runProbePhase({ ...parsed, env, deps });
    write(`${redact(JSON.stringify(outcome, null, 2))}\n`);
    return 0;
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    write(`${redact(JSON.stringify({
      schema_version: RESULT_SCHEMA_VERSION, run_id: parsed?.runId ?? "0", attempt: parsed?.attempt ?? "0",
      phase: `offbranch-${parsed?.phase ?? "unknown"}`, status: EXIT_STATUS[exitCode] ?? "failed",
      errors: [redact(error instanceof Error ? error.message : String(error))],
    }, null, 2))}\n`);
    return exitCode;
  }
}

if (directEntry(import.meta.url, process.argv[1])) {
  main().then((code) => { process.exitCode = code; });
}
