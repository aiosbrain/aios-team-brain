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
  AssertionFailure, COMMISSIONING_DISPATCH_REF, COMMISSIONING_EVENT_NAME, COMMISSIONING_REPOSITORY, COMMISSIONING_WORKFLOW_PATH,
  IncompleteEvidence, RESULT_SCHEMA_VERSION, UsageError, assertLocalOperator, assertProtectedJobsWaiting, assertRunIdentity,
  assertSourceContinuity, branchOf, canonicalHash, collectSentinels, createGuardedRequest, createLocalGhTransport, createRedactor,
  evidenceSlug, readEvidenceFile, responseEvidence, summarizeApprovals,
} from "./policy-commissioning.mjs";
import {
  CANCEL_CONFIRM_MS, CAPTURE_SCHEMA_VERSION, DIAGNOSTIC_SCHEMA_VERSION, DISPATCH_DEADLINE_MS, MAX_PAGES, OFFBRANCH_CONTROL,
  OFFBRANCH_SCHEMA_VERSION, PAGE_SIZE, PROBE_ATTEMPT, PROBE_BRANCH, PROBE_DISPATCHER, PROBE_ENVIRONMENTS, PROBE_EVENT,
  PROBE_INTENT_SCHEMA_VERSION, PROBE_JOBS, PROBE_REF, PROBE_WORKFLOW_FILE, PROBE_WORKFLOW_PATH, PROBE_WORKFLOW_SHA256,
  ProbeRefusal, RESOURCE_LINK_EVENT, assertInertProbeWorkflow, assertProbeEventPayload, commissioningIdentity, inducedAutomation,
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
async function pagedCapture(session, endpoint, listKey, label) {
  const pages = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const { ref, body } = await rawCapture(session, `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`, `${label} page ${page}`);
    pages.push({ page, ...ref });
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

async function openProbeSession({ runId, attempt, evidenceDir, env, deps, continuity = "enforce" }) {
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
  const sourceContinuity = await assertSourceContinuity({
    request, label: "the staged off-branch probe", mode: continuity,
    expected: { repositoryId: Number(intent.repository_id), workflowSha: commissioning.workflow_sha },
  });
  const run = await request("GET", `/repos/${REPO}/actions/runs/${runId}/attempts/${attempt}`);
  if (run.status !== 200 || !run.body) throw new IncompleteEvidence("the original commissioning attempt could not be measured");
  if (run.body.head_sha !== commissioning.workflow_sha || run.body.path !== COMMISSIONING_WORKFLOW_PATH || run.body.event !== COMMISSIONING_EVENT_NAME
    || run.body.head_branch !== branchOf(COMMISSIONING_DISPATCH_REF)) {
    throw new AssertionFailure("the original attempt is not the reviewed commissioning run its intent describes");
  }
  return {
    dir, now, request, guardCtx, operator, intent, commissioning, sourceContinuity, originalRun: run.body, deps, env,
    runId: String(runId), attempt: String(attempt), sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** The original attempt is still running and nobody has approved a protected job. */
async function assertOriginalUnapproved(session) {
  if (session.originalRun.status === "completed") throw new AssertionFailure("the original commissioning attempt has completed; a probe can only be staged and run while it is active");
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

/** The staged probe: intent bytes, their link in the original journal, and the probe journal binding. */
function loadStagedProbe(session) {
  const name = probeIntentName(session.runId, session.attempt);
  let bytes;
  try { bytes = readFileSync(path.join(session.dir, name)); } catch { throw new IncompleteEvidence("no probe has been staged for this attempt"); }
  const digest = sha256(bytes);
  const resource = readJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt });
  const links = resource.filter((record) => record.type === RESOURCE_LINK_EVENT);
  if (links.length !== 1 || links[0].data?.intent_artifact !== name || links[0].data?.intent_sha256 !== digest) {
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
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps });
  const resource = readJournal({ dir: session.dir, runId: session.runId, attempt: session.attempt });
  if (!resource.length || resource[0].source !== session.commissioning.workflow_sha) throw new IncompleteEvidence("the original attempt has no verified journal bound to its source; run setup first");
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
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps });
  const staged = loadStagedProbe(session);
  await assertOriginalUnapproved(session);
  const probe = openProbeJournal(session);
  try {
    const records = probe.records();
    if (records[0]?.type !== "probe-opened" || records[0].data.intent_sha256 !== staged.digest) throw new AssertionFailure("the probe journal is not bound to the staged intent");
    if (records.some((record) => record.type === "ref-create-intent")) {
      throw new AssertionFailure("this attempt's probe ref was already created once; the create is never re-issued (collect, cancel or clean up instead)");
    }
    const absent = await session.request("GET", probeRefPath);
    probe.append("ref-absent-verified", { ref: PROBE_REF, ...facts(absent), measured_at: session.now().toISOString() });
    if (absent.complete === true && absent.status === 200) throw new AssertionFailure("the fixed probe ref appeared after staging; an unowned ref is never adopted");
    if (!(absent.complete === true && absent.status === 404)) throw new IncompleteEvidence("the probe ref's absence could not be measured");

    // CREATE ONCE: durable intent, one request, its result — and reconciliation, not a retry.
    const sha = session.commissioning.workflow_sha;
    probe.append("ref-create-intent", { ref: PROBE_REF, sha });
    const created = await session.request("POST", `/repos/${REPO}/git/refs`, { ref: PROBE_REF, sha });
    const objectSha = created.complete === true && FULL_SHA.test(String(created.body?.object?.sha ?? "")) ? created.body.object.sha : null;
    probe.append("ref-create-result", { ref: PROBE_REF, sha, ...facts(created), object_sha: objectSha });
    if (created.complete !== true) {
      const readback = await session.request("GET", probeRefPath);
      const at = session.now().toISOString();
      if (readback.complete === true && readback.status === 404) {
        probe.append("reconciliation", { of: "ref-create-intent", outcome: "absent", object_sha: null, measured_at: at });
        throw new IncompleteEvidence("the probe ref create answer was lost and the ref is absent; it is not re-created for this attempt");
      }
      if (readback.complete === true && readback.status === 200) {
        probe.append("reconciliation", { of: "ref-create-intent", outcome: "present-ownership-uncertain", object_sha: String(readback.body?.object?.sha ?? "") || null, measured_at: at });
        throw new IncompleteEvidence("the probe ref create answer was lost and a ref now exists; ownership is uncertain, so it is neither dispatched nor deleted — root reconciliation is required");
      }
      throw new IncompleteEvidence("the probe ref create answer was lost and its readback failed; the create intent stays unresolved");
    }
    if (created.status !== 201 || objectSha !== sha) throw new AssertionFailure(`the provider did not create the probe ref at the reviewed source (${created.status})`);
    const readback = await session.request("GET", probeRefPath);
    probe.append("ref-readback", { ref: PROBE_REF, ...facts(readback), object_sha: readback.complete === true ? (String(readback.body?.object?.sha ?? "") || null) : null, measured_at: session.now().toISOString() });
    if (readback.complete !== true || readback.status !== 200 || readback.body?.object?.sha !== sha) throw new IncompleteEvidence("the created probe ref could not be read back at the reviewed source");

    for (const environment of PROBE_ENVIRONMENTS) {
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
    if (dispatched.complete === true && dispatched.status !== 204) throw new AssertionFailure(`the provider refused the probe dispatch (${dispatched.status}); nothing ran — clean up the ref`);
    return result(session, "dispatch", dispatched.complete === true ? "dispatched" : "dispatch-ambiguous", {
      deadline_at: deadlineAt, note: "Collect before the deadline. A lost dispatch answer is reconciled by collect, never re-dispatched.",
    });
  } finally {
    probe.lock.release();
  }
}

/** Poll the ONE identified run until it is terminal or the given instant passes. Non-retaining reads. */
async function waitTerminal(session, runId, untilMs) {
  for (;;) {
    const read = await session.request("GET", `/repos/${REPO}/actions/runs/${runId}`);
    if (read.complete === true && read.status === 200 && read.body?.status === "completed") return read.body;
    if (session.now().getTime() >= untilMs) return null;
    await session.sleep(PROBE_POLL_INTERVAL_MS);
  }
}

async function cancelAndConfirm(session, probe, runId, reason) {
  const records = probe.records();
  if (!records.some((record) => record.type === "cancel-intent")) {
    probe.append("cancel-intent", { run_id: runId, reason });
    const cancelled = await session.request("POST", `/repos/${REPO}/actions/runs/${runId}/cancel`);
    probe.append("cancel-result", { run_id: runId, ...facts(cancelled) });
  }
  const terminal = await waitTerminal(session, runId, session.now().getTime() + CANCEL_CONFIRM_MS);
  if (!terminal) {
    throw new IncompleteEvidence("the probe run is still not terminal two minutes after cancellation; cleanup is BLOCKED — evidence is retained and nothing is claimed");
  }
  probe.append("run-terminal", { run_id: runId, run_attempt: terminal.run_attempt ?? null, status: terminal.status, conclusion: terminal.conclusion ?? null, observed_at: session.now().toISOString() });
  return terminal;
}

export async function runCollect({ runId, attempt, evidenceDir, env, deps }) {
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps, continuity: "observe" });
  const staged = loadStagedProbe(session);
  const probe = openProbeJournal(session);
  try {
    let records = probe.records();
    const dispatch = records.find((record) => record.type === "dispatch-intent");
    const dispatched = records.find((record) => record.type === "dispatch-result");
    if (!dispatch || !dispatched) throw new IncompleteEvidence("the probe has not been dispatched");
    if (dispatched.data.response_complete === true && dispatched.data.http_status !== 204) throw new AssertionFailure("the probe dispatch was refused; there is nothing to collect");
    const dispatchMs = Date.parse(dispatch.ts);
    const deadlineMs = Date.parse(dispatch.data.deadline_at);

    // THE ONE ELIGIBLE RUN. Zero or several is never resolved by picking; nothing is re-dispatched.
    let identified = records.find((record) => record.type === "run-identified");
    if (records.some((record) => record.type === "run-unidentified")) throw new IncompleteEvidence("the probe run was already recorded as unidentifiable; this attempt's probe is inconclusive");
    if (!identified) {
      const listing = `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/runs?branch=${PROBE_BRANCH}&event=${PROBE_EVENT}`;
      for (;;) {
        const peek = await session.request("GET", `${listing}&per_page=${PAGE_SIZE}&page=1`);
        const seen = peek.complete === true && peek.status === 200 && Array.isArray(peek.body?.workflow_runs)
          ? asIncomplete(() => selectEligibleRuns([{ page: 1, body: { ...peek.body, total_count: peek.body.workflow_runs.length } }], { dispatchIntentMs: dispatchMs, deadlineMs })).length : 0;
        if (seen > 0 || session.now().getTime() >= deadlineMs) break;
        await session.sleep(PROBE_POLL_INTERVAL_MS);
      }
      const selection = await pagedCapture(session, listing, "workflow_runs", "the probe run listing");
      const descriptor = writeDescriptor(session, { capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "run-selection", pages: selection.pages });
      const pages = selection.pages.map((ref) => ({ page: ref.page, body: JSON.parse(readFileSync(path.join(session.dir, ref.artifact), "utf8")) }));
      const eligible = asIncomplete(() => selectEligibleRuns(pages, { dispatchIntentMs: dispatchMs, deadlineMs }));
      if (eligible.length !== 1) {
        probe.append("run-unidentified", { eligible: eligible.length, descriptor, reason: eligible.length ? "several eligible runs" : "no eligible run by the deadline" });
        if (eligible.length > 1) throw new AssertionFailure(`${eligible.length} eligible probe runs exist; none is selected, and the probe cannot pass`);
        throw new IncompleteEvidence("no eligible probe run appeared by the deadline; the probe is inconclusive and nothing is re-dispatched");
      }
      identified = probe.append("run-identified", { run_id: eligible[0], eligible: 1, descriptor });
    }
    const probeRunId = identified.data.run_id;
    session.guardCtx.probeRunId = probeRunId;

    records = probe.records();
    let terminalRecord = records.find((record) => record.type === "run-terminal");
    if (!terminalRecord) {
      const terminal = await waitTerminal(session, probeRunId, deadlineMs);
      if (!terminal) {
        await cancelAndConfirm(session, probe, probeRunId, "deadline");
        throw new IncompleteEvidence("the probe reached no terminal state within ten minutes; it was cancelled, which is inconclusive — clean up next");
      }
      terminalRecord = probe.append("run-terminal", { run_id: probeRunId, run_attempt: terminal.run_attempt ?? null, status: terminal.status, conclusion: terminal.conclusion ?? null, observed_at: session.now().toISOString() });
    }
    if (records.some((record) => record.type === "cancel-intent")) throw new IncompleteEvidence("the probe run was cancelled; a cancellation is inconclusive — clean up next");
    if (records.some((record) => record.type === "observation-recorded")) throw new AssertionFailure("this probe's observations were already recorded; they are never rewritten");

    // THE ORIGINAL PROVIDER RESPONSES, retained byte-for-byte.
    const runInitial = await rawCapture(session, `/repos/${REPO}/actions/runs/${probeRunId}`, "the probe run");
    const jobs = await pagedCapture(session, `/repos/${REPO}/actions/runs/${probeRunId}/jobs?filter=all`, "jobs", "the probe jobs");
    const jobsDescriptor = writeDescriptor(session, { capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "jobs", pages: jobs.pages });
    const jobRows = jobs.pages.flatMap((ref) => JSON.parse(readFileSync(path.join(session.dir, ref.artifact), "utf8")).jobs ?? []);
    const denials = {};
    for (const spec of PROBE_JOBS) {
      const job = jobRows.filter((row) => row?.name === spec.job_key);
      if (job.length !== 1) continue;
      let checkId;
      try { checkId = parseCheckRunUrl(job[0].check_run_url); } catch { continue; }
      session.guardCtx.probeCheckIds.add(checkId);
      const check = await rawCapture(session, `/repos/${REPO}/check-runs/${checkId}`, `the ${spec.job_key} check`);
      const annotations = await pagedCapture(session, `/repos/${REPO}/check-runs/${checkId}/annotations`, null, `the ${spec.job_key} annotations`);
      const checkTerminal = await rawCapture(session, `/repos/${REPO}/check-runs/${checkId}`, `the ${spec.job_key} check re-read`);
      denials[spec.environment] = writeDescriptor(session, {
        diagnostic_schema_version: DIAGNOSTIC_SCHEMA_VERSION, check_id: checkId,
        check: { ...check.ref, terminal: checkTerminal.ref }, annotations: annotations.pages,
      });
    }
    const runTerminal = await rawCapture(session, `/repos/${REPO}/actions/runs/${probeRunId}`, "the probe run re-read");
    const runDescriptor = writeDescriptor(session, { capture_schema_version: CAPTURE_SCHEMA_VERSION, kind: "run", initial: runInitial.ref, terminal: runTerminal.ref });
    const capturedAt = session.now().toISOString();
    probe.append("capture-recorded", { kind: "run", environment: null, descriptor: runDescriptor, completed_at: capturedAt });
    probe.append("capture-recorded", { kind: "jobs", environment: null, descriptor: jobsDescriptor, completed_at: capturedAt });
    for (const environment of PROBE_ENVIRONMENTS) {
      if (denials[environment]) probe.append("capture-recorded", { kind: "denial", environment, descriptor: denials[environment], completed_at: capturedAt });
    }
    const after = {};
    for (const environment of PROBE_ENVIRONMENTS) {
      after[environment] = await capturePolicy(session, environment, "after");
      probe.append("policy-captured", { phase: "after", environment, environment_id: after[environment].policy.environment_id, descriptor: after[environment].ref, completed_at: after[environment].completed_at });
    }

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
        const job = jobRows.find((row) => row?.name === spec.job_key);
        if (job?.conclusion === "success" || (Array.isArray(job?.steps) && job.steps.length) || (Number.isInteger(job?.runner_id) && job.runner_id !== 0)) outcome = "admitted";
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
    return result(session, "collect", "measured", {
      probe_run_id: probeRunId, outcomes, records: records_out,
      note: "Measured, not accepted: clean up next, then check-evidence re-derives everything offline.",
    });
  } finally {
    probe.lock.release();
  }
}

export async function runCancel({ runId, attempt, evidenceDir, env, deps }) {
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps, continuity: "observe" });
  loadStagedProbe(session);
  const probe = openProbeJournal(session);
  try {
    const records = probe.records();
    const identified = records.find((record) => record.type === "run-identified");
    if (!identified) throw new IncompleteEvidence("no probe run is identified; there is no owned run to cancel");
    if (records.some((record) => record.type === "run-terminal")) return result(session, "cancel", "already-terminal");
    session.guardCtx.probeRunId = identified.data.run_id;
    await cancelAndConfirm(session, probe, identified.data.run_id, "operator");
    return result(session, "cancel", "cancelled", { note: "A cancelled probe is inconclusive. Clean up next." });
  } finally {
    probe.lock.release();
  }
}

function closeOutcome(records) {
  const observations = records.filter((record) => record.type === "observation-recorded");
  if (observations.some((record) => record.data.outcome === "admitted")) return "failed";
  if (observations.length === PROBE_ENVIRONMENTS.length && observations.every((record) => record.data.outcome === "refused")
    && !records.some((record) => record.type === "cancel-intent")) return "measured";
  return "inconclusive";
}

export async function runCleanup({ runId, attempt, evidenceDir, env, deps }) {
  const session = await openProbeSession({ runId, attempt, evidenceDir, env, deps, continuity: "observe" });
  loadStagedProbe(session);
  const deleteRef = deps.deleteRef ?? createGitLeaseDeleter({ spawnImpl: deps.spawnImpl, env });
  const probe = openProbeJournal(session);
  try {
    const records = probe.records();
    if (records.some((record) => record.type === "probe-closed")) return result(session, "cleanup", "already-closed");
    const sha = session.commissioning.workflow_sha;
    const created = records.find((record) => record.type === "ref-create-result");
    const createReconciled = records.find((record) => record.type === "reconciliation" && record.data.of === "ref-create-intent");
    if (createReconciled?.data.outcome === "present-ownership-uncertain") {
      throw new IncompleteEvidence("the probe ref's ownership is uncertain; it is never deleted automatically — root reconciliation is required");
    }
    const owned = created?.data.response_complete === true && created.data.http_status === 201 && created.data.object_sha === sha;
    if (!owned) {
      if (unresolvedProbeIntents(records).length) throw new IncompleteEvidence("an unresolved probe intent remains; reconcile before closing");
      probe.append("probe-closed", { outcome: "inconclusive" });
      return result(session, "cleanup", "nothing-owned", { note: "No owned probe ref exists; the journal is closed as inconclusive." });
    }
    // AFTER TERMINAL CAPTURE: an identified run must be terminal, and a terminal failure collected.
    const identified = records.find((record) => record.type === "run-identified");
    const terminal = records.find((record) => record.type === "run-terminal");
    const dispatchResult = records.find((record) => record.type === "dispatch-result");
    const dispatchRefused = dispatchResult?.data.response_complete === true && dispatchResult.data.http_status !== 204;
    if (dispatchResult && !dispatchRefused && !identified && !records.some((record) => record.type === "run-unidentified")) {
      throw new IncompleteEvidence("the dispatched probe run has not been reconciled; collect before cleanup — a run may exist that nobody has captured");
    }
    if (identified && !terminal) throw new IncompleteEvidence("the probe run is not terminal; cancel (or collect) it before cleanup");
    const cancelled = records.some((record) => record.type === "cancel-intent");
    if (terminal && !cancelled && !records.some((record) => record.type === "observation-recorded")) {
      throw new IncompleteEvidence("the terminal probe run has not been collected; collect before cleanup so the original evidence is captured first");
    }
    if (records.some((record) => record.type === "cleanup-result" && record.data.outcome === "lease-refused")) {
      throw new AssertionFailure("the owned probe ref changed and its lease deletion was refused; it is never deleted at another SHA");
    }
    const at = () => session.now().toISOString();
    const close = (status, extra = {}) => {
      const outcome = closeOutcome(probe.records());
      probe.append("probe-closed", { outcome });
      return result(session, "cleanup", status, { outcome, ...extra });
    };
    // A cleanup whose answer was lost is RECONCILED by readback before anything else happens.
    const unresolved = unresolvedProbeIntents(records).filter((entry) => entry.type === "cleanup-intent");
    const lastResult = [...records].reverse().find((record) => record.type === "cleanup-result");
    const lastReconciliation = [...records].reverse().find((record) => record.type === "reconciliation" && record.data.of === "cleanup-intent");
    const needsReconcile = unresolved.length || (lastResult?.data.outcome === "ambiguous" && !(lastReconciliation && lastReconciliation.seq > lastResult.seq));
    if (needsReconcile) {
      const readback = await session.request("GET", probeRefPath);
      if (readback.complete === true && readback.status === 404) {
        probe.append("reconciliation", { of: "cleanup-intent", outcome: "absent", object_sha: null, measured_at: at() });
        probe.append("absence-verified", { ref: PROBE_REF, ...facts(readback), measured_at: at() });
        return close("cleaned-after-reconciliation");
      }
      if (readback.complete === true && readback.status === 200) {
        const objectSha = String(readback.body?.object?.sha ?? "");
        probe.append("reconciliation", { of: "cleanup-intent", outcome: objectSha === sha ? "present-unchanged" : "present-changed", object_sha: objectSha || null, measured_at: at() });
        if (objectSha !== sha) throw new AssertionFailure("the owned probe ref now points elsewhere; it is never deleted at another SHA");
        throw new IncompleteEvidence("the lost deletion did not take effect; the reconciliation is recorded — run cleanup again to issue one fresh lease deletion");
      }
      throw new IncompleteEvidence("a lost deletion could not be reconciled; its readback failed");
    }

    const readback = await session.request("GET", probeRefPath);
    if (readback.complete !== true || ![200, 404].includes(readback.status)) throw new IncompleteEvidence("the owned probe ref could not be read back before cleanup");
    if (readback.status === 404) {
      probe.append("absence-verified", { ref: PROBE_REF, ...facts(readback), measured_at: at() });
      throw new AssertionFailure("the owned probe ref disappeared without this probe deleting it; its ownership history is broken");
    }
    if (readback.body?.object?.sha !== sha) {
      probe.append("ref-readback", { ref: PROBE_REF, ...facts(readback), object_sha: String(readback.body?.object?.sha ?? "") || null, measured_at: at() });
      throw new AssertionFailure("the owned probe ref points at a SHA this probe did not create; it is never deleted");
    }
    probe.append("cleanup-intent", { ref: PROBE_REF, expected_sha: sha });
    const deletion = await deleteRef({ ref: PROBE_REF, expectedSha: sha });
    const outcome = ["deleted", "lease-refused", "ambiguous"].includes(deletion?.outcome) ? deletion.outcome : "ambiguous";
    probe.append("cleanup-result", { ref: PROBE_REF, expected_sha: sha, outcome, exit_code: Number.isInteger(deletion?.exit_code) ? deletion.exit_code : null });
    if (outcome === "lease-refused") throw new AssertionFailure("the lease deletion was refused: the owned probe ref changed, and it is left untouched");
    const after = await session.request("GET", probeRefPath);
    if (after.complete === true && after.status === 404) {
      if (outcome === "ambiguous") probe.append("reconciliation", { of: "cleanup-intent", outcome: "absent", object_sha: null, measured_at: at() });
      probe.append("absence-verified", { ref: PROBE_REF, ...facts(after), measured_at: at() });
      return close("cleaned");
    }
    if (outcome === "ambiguous" && after.complete === true && after.status === 200) {
      const objectSha = String(after.body?.object?.sha ?? "");
      probe.append("reconciliation", { of: "cleanup-intent", outcome: objectSha === sha ? "present-unchanged" : "present-changed", object_sha: objectSha || null, measured_at: at() });
      if (objectSha !== sha) throw new AssertionFailure("the owned probe ref now points elsewhere; it is never deleted at another SHA");
      throw new IncompleteEvidence("the ambiguous deletion did not take effect; the reconciliation is recorded — run cleanup again to issue one fresh lease deletion");
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
  const run = { stage: runStage, dispatch: runDispatch, collect: runCollect, cancel: runCancel, cleanup: runCleanup }[phase];
  if (!run) throw new UsageError(`unsupported probe phase ${JSON.stringify(String(phase))}`);
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
