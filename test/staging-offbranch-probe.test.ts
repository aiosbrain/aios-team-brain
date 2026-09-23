/* eslint-disable @typescript-eslint/no-explicit-any -- raw provider JSON is mutated field by field throughout, as in the other fake-provider suites */
/**
 * AIO-1124 PC-06 — the staged off-branch probe: operator lifecycle, raw captures and the cross-run
 * variant validator (accepted API-only design, SHA-256 45e0b818…c01e0).
 *
 * EVERYTHING HERE IS MOCK DATA. The provider is an in-memory fake answering through the real
 * completed-response contract; refs live in a throwaway local bare git repository; the clock is fake.
 * A passing test is NOT live provider proof: PC-06 stays unverified until an owner-staged probe runs.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMISSIONING_REPOSITORY, COMMISSIONING_WORKFLOW_PATH, ENVIRONMENT_CONTROL_SCHEMAS, OWNER_LOGIN, OWNER_USER_ID,
  ALLOWED_OPERATIONS, PROTECTED_JOBS, assertAllowedRequest, assessEvidence, completedJsonResponse, createGuardedRequest, createRedactor,
  evidenceSlug, incompleteResponse, readEvidenceFile, validateEnvironmentControl, writeEvidenceFile,
} from "../scripts/staging-ops/policy-commissioning.mjs";
import { acquireJournalLock, journalPath, openJournal, readJournal, readLockOwner, recoverJournalLock } from "../scripts/staging-ops/commissioning-journal.mjs";
import {
  GENERIC_DIAGNOSTIC_MESSAGE, OFFBRANCH_CONTROL, PROBE_BRANCH, PROBE_JOBS, PROBE_JOURNAL_EVENTS, PROBE_REF,
  PROBE_WORKFLOW_FILE, PROBE_WORKFLOW_PATH, SOURCE_OBSERVED_EVENT, assertPolicyAgreesWithCommissioning, assessRefOwnership,
  assessProbePhaseState, assessSourceContinuity, commissioningIdentity,
  parseCheckRunUrl, parseDiagnosticAnnotations, parseEnvironmentPolicy, parseProbeCheck, parseProbeJobs, parseProbeRun,
  probeIntentName, probeObservationName, selectEligibleRuns, specificDiagnosticMessage,
} from "../scripts/staging-ops/offbranch-probe.mjs";
import { createGitLeaseDeleter, main, runProbePhase, runStage, runDispatch, runCollect, runCancel, runCleanup } from "../scripts/staging-ops/offbranch-probe-operator.mjs";

const REPO = COMMISSIONING_REPOSITORY;
const API = `https://api.github.com/repos/${REPO}`;
const WEB = `https://github.com/${REPO}`;
const REPO_ID = 1268462466;
const RUN_ID = "900001";
const ATTEMPT = "1";
const ENV_IDS: Record<string, number> = { "staging-release": 4401, "staging-emergency": 4402 };
const JOHN = { id: OWNER_USER_ID, login: OWNER_LOGIN, type: "User" };
const T0 = Date.parse("2026-09-21T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const isoSec = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const FIXTURE = path.join(__dirname, "fixtures", "pc06-historical-diagnostic");
const PROBE_YAML = readFileSync(path.join(__dirname, "..", PROBE_WORKFLOW_PATH));
const EXPECTED = { attempt_outcome: "refused" };

const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Run = { id: number; created: number; completes: number; status: string; conclusion: string | null; jobs: any[]; checks: Record<string, any>; annotations: Record<string, any[]>; attempt: number; actor: any; };

/**
 * The fake world: one repository, its protected environments, the original commissioning attempt and
 * — once dispatched — the probe run, shaped from the retained historical provider responses.
 */
class World {
  clock = T0;
  root: string;
  dir: string;
  bare: string;
  work: string;
  sha: string;
  otherSha: string;
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  originalRunStatus = "in_progress";
  originalDispatcher = "original-dispatcher";
  originalActor: any = { id: 22, login: "original-dispatcher", type: "User" };
  originalTrigger: any = { id: 23, login: "original-trigger", type: "User" };
  approvals: any[] = [];
  registrationCreatedAt = "2026-09-01T00:00:00Z";
  sourceBytes: Buffer = PROBE_YAML;
  branchPolicies: Record<string, any[]> = {
    "staging-release": [{ id: 71, node_id: "BP1", name: "staging", type: "branch" }],
    "staging-emergency": [{ id: 72, node_id: "BP2", name: "staging", type: "branch" }],
  };
  canAdminsBypass: Record<string, unknown> = { "staging-release": false, "staging-emergency": false };
  runs: Run[] = [];
  runsPerDispatch = 1;
  completeAfterMs = 2000;
  neverComplete = false;
  terminalOnCancel = true;
  admitted: string | null = null;
  lose: Record<string, "lost-applied" | "lost-unapplied"> = {};
  afterDispatchPolicyChange: (() => void) | null = null;
  annotationOverride: ((env: string, rows: any[]) => any[]) | null = null;

  constructor() {
    this.root = mkdtempSync(path.join(tmpdir(), "pc06-probe-"));
    this.dir = path.join(this.root, "evidence");
    execFileSync("mkdir", ["-m", "700", this.dir]);
    this.bare = path.join(this.root, "remote.git");
    this.work = path.join(this.root, "work");
    git(["init", "-q", "--bare", this.bare]);
    git(["init", "-q", this.work]);
    git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "source"], this.work);
    this.sha = git(["rev-parse", "HEAD"], this.work);
    git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "other"], this.work);
    this.otherSha = git(["rev-parse", "HEAD"], this.work);
    git(["push", "-q", this.bare, `${this.otherSha}:refs/heads/staging-other`, `${this.sha}:refs/heads/staging`], this.work);
  }

  now = () => { this.clock += 1; return new Date(this.clock); };
  sleep = async (ms: number) => { this.clock += ms; };

  refSha(): string | null {
    try { return git(["--git-dir", this.bare, "rev-parse", "--verify", "-q", PROBE_REF]); } catch { return null; }
  }
  setRef(sha: string | null) {
    if (sha) git(["--git-dir", this.bare, "update-ref", PROBE_REF, sha]);
    else git(["--git-dir", this.bare, "update-ref", "-d", PROBE_REF]);
  }

  settings(env: string) {
    return {
      id: ENV_IDS[env], node_id: `EN_${env}`, name: env, url: `${API}/environments/${env}`, html_url: `${WEB}/deployments/activity_log?environments_filter=${env}`,
      created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z", can_admins_bypass: this.canAdminsBypass[env],
      protection_rules: [
        { id: 101 + ENV_IDS[env], node_id: "PR1", type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { ...JOHN, node_id: "U1" } }] },
        { id: 201 + ENV_IDS[env], node_id: "PR2", type: "branch_policy" },
      ],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    };
  }

  createRuns() {
    for (let index = 0; index < this.runsPerDispatch; index += 1) {
      const id = 34100000001 + this.runs.length;
      const created = Math.ceil(this.clock / 1000) * 1000 + 1000;
      const jobs = PROBE_JOBS.map((spec: any, ordinal: number) => ({
        id: 7000 + this.runs.length * 10 + ordinal, check: 8000 + this.runs.length * 10 + ordinal, spec,
      }));
      this.runs.push({
        id, created, completes: created + this.completeAfterMs, status: "queued", conclusion: null, attempt: 1, actor: { ...JOHN },
        jobs, checks: {}, annotations: {},
      });
    }
    this.afterDispatchPolicyChange?.();
  }

  runState(run: Run) {
    if (run.status === "cancelled") return { status: "completed", conclusion: "cancelled" };
    if (!this.neverComplete && this.clock >= run.completes) return { status: "completed", conclusion: this.admitted ? "success" : "failure" };
    return { status: "queued", conclusion: null };
  }

  runBody(run: Run) {
    const state = this.runState(run);
    return {
      id: run.id, name: "release-environment-negative-probe", node_id: "WFR_x", head_branch: PROBE_BRANCH, head_sha: this.sha,
      path: PROBE_WORKFLOW_PATH, display_title: "release-environment-negative-probe", run_number: 1, event: "workflow_dispatch",
      status: state.status, conclusion: state.conclusion, workflow_id: 555, check_suite_id: 92000000000 + run.id % 1000,
      url: `${API}/actions/runs/${run.id}`, html_url: `${WEB}/actions/runs/${run.id}`, created_at: isoSec(run.created), updated_at: isoSec(run.completes + 1000),
      actor: { ...run.actor, node_id: "U1" }, run_attempt: run.attempt, triggering_actor: { ...run.actor, node_id: "U1" },
      repository: { id: REPO_ID, full_name: REPO }, head_repository: { id: REPO_ID, full_name: REPO },
    };
  }

  jobBody(run: Run, job: any) {
    const admitted = this.admitted === job.spec.job_key;
    return {
      id: job.id, run_id: run.id, workflow_name: "release-environment-negative-probe", head_branch: PROBE_BRANCH,
      run_url: `${API}/actions/runs/${run.id}`, run_attempt: run.attempt, node_id: `CR_${job.check}`, head_sha: this.sha,
      url: `${API}/actions/jobs/${job.id}`, html_url: `${WEB}/actions/runs/${run.id}/job/${job.id}`,
      status: "completed", conclusion: admitted ? "success" : "failure",
      created_at: isoSec(run.created), started_at: isoSec(run.created), completed_at: isoSec(run.created + 2000),
      name: job.spec.job_key, steps: admitted ? [{ name: "Run :", status: "completed", conclusion: "success", number: 1 }] : [],
      check_run_url: `${API}/check-runs/${job.check}`, labels: ["ubuntu-latest"], runner_id: admitted ? 12 : 0, runner_name: "", runner_group_id: 0, runner_group_name: "",
    };
  }

  checkBody(run: Run, job: any) {
    const historical = JSON.parse(readFileSync(path.join(FIXTURE, "check.json"), "utf8"));
    return {
      ...historical, id: job.check, name: job.spec.job_key, node_id: `CR_${job.check}`, head_sha: this.sha, external_id: "x",
      url: `${API}/check-runs/${job.check}`, html_url: `${WEB}/actions/runs/${run.id}/job/${job.id}`, details_url: `${WEB}/actions/runs/${run.id}/job/${job.id}`,
      status: "completed", conclusion: "failure", started_at: isoSec(run.created), completed_at: isoSec(run.created + 2000),
      output: { ...historical.output, annotations_url: `${API}/check-runs/${job.check}/annotations` },
      check_suite: { id: 92000000000 + run.id % 1000 },
      deployment: { ...historical.deployment, id: 6300000000 + job.id, url: `${API}/deployments/${6300000000 + job.id}`, environment: job.spec.environment, original_environment: job.spec.environment },
    };
  }

  annotationRows(job: any) {
    const blob = `${WEB}/blob/${this.sha}/.github`;
    const rows = [
      { path: ".github", blob_href: blob, start_line: 1, start_column: null, end_line: 1, end_column: null, annotation_level: "failure", title: ".github#L1", message: specificDiagnosticMessage(PROBE_BRANCH, job.spec.environment), raw_details: null },
      { path: ".github", blob_href: blob, start_line: 1, start_column: null, end_line: 1, end_column: null, annotation_level: "failure", title: "", message: GENERIC_DIAGNOSTIC_MESSAGE, raw_details: "" },
    ];
    return this.annotationOverride ? this.annotationOverride(job.spec.environment, rows) : rows;
  }

  respond(method: string, requestPath: string, body?: any): { status: number; body?: unknown } {
    const [pathname, query = ""] = requestPath.split("?");
    const page = Number(/(?:^|&)page=(\d+)/.exec(query)?.[1] ?? "1");
    const p = pathname.replace(`/repos/${REPO}`, "");
    if (pathname === "/user") return { status: 200, body: { ...JOHN, node_id: "U1" } };
    if (p === `/collaborators/${OWNER_LOGIN}/permission`) return { status: 200, body: { permission: "admin" } };
    if (p === "" ) return { status: 200, body: { id: REPO_ID, full_name: REPO, default_branch: "staging" } };
    if (p === "/git/ref/heads/staging") return { status: 200, body: { ref: "refs/heads/staging", object: { sha: this.sha, type: "commit" } } };
    if (p === `/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`) {
      return { status: 200, body: { id: Number(RUN_ID), run_attempt: Number(ATTEMPT), repository: { id: REPO_ID, full_name: REPO }, head_repository: { id: REPO_ID, full_name: REPO }, actor: { ...this.originalActor }, triggering_actor: { ...this.originalTrigger }, head_sha: this.sha, path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch", head_branch: "staging", status: this.originalRunStatus } };
    }
    if (p === `/actions/runs/${RUN_ID}/approvals`) return { status: 200, body: this.approvals };
    if (p === `/actions/runs/${RUN_ID}/attempts/${ATTEMPT}/jobs`) return { status: 200, body: { total_count: 1, jobs: [{ name: PROTECTED_JOBS[1].name, status: "waiting" }] } };
    if (p === `/actions/workflows/${PROBE_WORKFLOW_FILE}`) return { status: 200, body: { id: 555, node_id: "W", name: "release-environment-negative-probe", path: PROBE_WORKFLOW_PATH, state: "active", created_at: this.registrationCreatedAt, updated_at: this.registrationCreatedAt } };
    if (p === `/contents/${PROBE_WORKFLOW_PATH}`) return { status: 200, body: { type: "file", encoding: "base64", size: this.sourceBytes.length, name: PROBE_WORKFLOW_FILE, path: PROBE_WORKFLOW_PATH, content: this.sourceBytes.toString("base64"), sha: "b".repeat(40) } };
    const environment = /^\/environments\/(staging-release|staging-emergency)(\/deployment-branch-policies)?$/.exec(p);
    if (environment) {
      if (environment[2]) {
        const rows = this.branchPolicies[environment[1]];
        return { status: 200, body: { total_count: rows.length, branch_policies: rows.slice((page - 1) * 100, page * 100) } };
      }
      return { status: 200, body: this.settings(environment[1]) };
    }
    if (p === `/git/ref/heads/${PROBE_BRANCH}`) {
      const sha = this.refSha();
      return sha ? { status: 200, body: { ref: PROBE_REF, object: { sha, type: "commit" } } } : { status: 404, body: { message: "Not Found" } };
    }
    if (method === "POST" && p === "/git/refs") {
      if (this.refSha()) return { status: 422, body: { message: "Reference already exists" } };
      this.setRef(body.sha);
      return { status: 201, body: { ref: PROBE_REF, object: { sha: body.sha, type: "commit" } } };
    }
    if (method === "POST" && p === `/actions/workflows/${PROBE_WORKFLOW_FILE}/dispatches`) { this.createRuns(); return { status: 204 }; }
    if (p === `/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`) {
      const rows = this.runs.map((run) => this.runBody(run));
      return { status: 200, body: { total_count: rows.length, workflow_runs: rows.slice((page - 1) * 100, page * 100) } };
    }
    const run = /^\/actions\/runs\/(\d+)(\/jobs|\/cancel)?$/.exec(p);
    if (run) {
      const found = this.runs.find((entry) => String(entry.id) === run[1]);
      if (!found) return { status: 404, body: { message: "Not Found" } };
      if (run[2] === "/cancel") { if (this.terminalOnCancel) found.status = "cancelled"; return { status: 202, body: {} }; }
      if (run[2] === "/jobs") return { status: 200, body: { total_count: found.jobs.length, jobs: found.jobs.map((job) => this.jobBody(found, job)) } };
      return { status: 200, body: this.runBody(found) };
    }
    const check = /^\/check-runs\/(\d+)(\/annotations)?$/.exec(p);
    if (check) {
      for (const entry of this.runs) {
        const job = entry.jobs.find((candidate) => String(candidate.check) === check[1]);
        if (job) return { status: 200, body: check[2] ? this.annotationRows(job) : this.checkBody(entry, job) };
      }
      return { status: 404, body: { message: "Not Found" } };
    }
    throw new Error(`the fake provider has no route for ${method} ${requestPath}`);
  }

  transport = async (method: string, requestPath: string, body?: unknown) => {
    this.calls.push({ method, path: requestPath, body });
    const key = `${method} ${requestPath.split("?")[0]}`;
    const lost = this.lose[key];
    if (lost === "lost-unapplied") { delete this.lose[key]; return incompleteResponse("transport-timeout"); }
    const answer = this.respond(method, requestPath, body);
    if (lost === "lost-applied") { delete this.lose[key]; return incompleteResponse("body-read-failed", answer.status); }
    const bytes = answer.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(answer.body, null, 2), "utf8");
    return completedJsonResponse(answer.status, bytes, createRedactor(), { retainRaw: true });
  };

  deps(extra: Record<string, unknown> = {}) {
    return {
      transport: this.transport, now: this.now, sleep: this.sleep,
      readWorkflowTree: async (sha: string) => {
        expect(sha).toBe(this.sha);
        const dir = path.join(__dirname, "..", ".github", "workflows");
        return Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [`.github/workflows/${f}`, readFileSync(path.join(dir, f), "utf8")]));
      },
      deleteRef: createGitLeaseDeleter({ cwd: this.work, remote: this.bare }),
      ...extra,
    };
  }

  phase(phase: string, extra: Record<string, unknown> = {}) {
    return runProbePhase({ phase, runId: RUN_ID, attempt: ATTEMPT, evidenceDir: this.dir, env: {}, deps: this.deps(extra) as any });
  }

  /** The original attempt as setup leaves it: intent evidence plus a journal with its baseline. */
  seedOriginal() {
    writeEvidenceFile(this.dir, evidenceSlug(RUN_ID, ATTEMPT, "intent"), {
      schema_version: 1, issue: "AIO-1124", phase: "intent", repository: REPO, repository_id: REPO_ID, run_id: RUN_ID, attempt: ATTEMPT,
      workflow_path: COMMISSIONING_WORKFLOW_PATH, workflow_sha: this.sha, dispatch_ref: "refs/heads/staging", event: "workflow_dispatch",
      provider_measured: false, dispatcher: this.originalDispatcher,
      // The rest of the closed intent manifest; values irrelevant to the probe, present so the intent binds.
      derived_refs: {}, derived_contexts: [], graph_plan: [], normal_app_id: 1, emergency_app_id: 2, producer_ids_hash: "0".repeat(64),
      normal_installation_id: "11", emergency_installation_id: "12",
    });
    const lock = acquireJournalLock({ dir: this.dir, runId: RUN_ID, attempt: ATTEMPT, now: this.now });
    const journal = openJournal({ dir: this.dir, runId: RUN_ID, attempt: ATTEMPT, source: this.sha, lock, now: this.now });
    journal.append("run-opened", { phase: "setup" });
    journal.append("baseline-measured", { staging: this.sha });
    lock.release();
    this.clock += 60_000;
  }

  async fullProbe() {
    this.seedOriginal();
    await this.phase("stage");
    await this.phase("dispatch");
    const collected: any = await this.phase("collect");
    await this.phase("cleanup");
    return collected;
  }

  trusted(extra: Record<string, unknown> = {}) {
    const intent = readEvidenceFile(this.dir, evidenceSlug(RUN_ID, ATTEMPT, "intent"));
    const resourceJournal = readJournal({ dir: this.dir, runId: RUN_ID, attempt: ATTEMPT });
    return {
      commissioning: commissioningIdentity({ intent, runId: RUN_ID, attempt: ATTEMPT, repository: REPO, workflowPath: COMMISSIONING_WORKFLOW_PATH }),
      resourceJournal, window: { start: resourceJournal[0].ts, end: iso(this.clock + 1000) }, approvals: null, ...extra,
    };
  }

  validate(record: any, environment: string, trusted: any = this.trusted(), key: string = OFFBRANCH_CONTROL) {
    return validateEnvironmentControl(record, { dir: this.dir, key, environment, runId: RUN_ID, attempt: ATTEMPT, window: trusted.window, offbranch: trusted });
  }

  probeRecords() { return readJournal({ dir: this.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe" }); }
  count(method: string, fragment: string) { return this.calls.filter((call) => call.method === method && call.path.includes(fragment)).length; }

  /** Rewrite a retained observation (and its wrapper digest) — a forged packet, for refusal tests. */
  forgeObservation(record: any, mutate: (observation: any) => void) {
    const file = path.join(this.dir, record.artifact);
    const observation = JSON.parse(readFileSync(file, "utf8"));
    mutate(observation);
    const text = `${JSON.stringify(observation, null, 2)}\n`;
    rmSync(file);
    writeFileSync(file, text, { mode: 0o600 });
    return { ...record, artifact_sha256: sha256(text) };
  }
}

/** Rewrite a synthetic probe chain while preserving its sequence and hash linkage. */
const rewriteProbeJournal = (target: World, mutate: (records: any[]) => void) => {
  const records = target.probeRecords();
  mutate(records);
  let previous = records[0].prev;
  const lines = records.map((record: any) => {
    const line = JSON.stringify({ ...record, prev: previous });
    previous = sha256(line);
    return line;
  });
  writeFileSync(journalPath(target.dir, RUN_ID, ATTEMPT, "probe"), `${lines.join("\n")}\n`);
};

let world: World;
beforeEach(() => { world = new World(); });
afterEach(() => { rmSync(world.root, { recursive: true, force: true }); });

// ──────────────────────────────────────────────────────────────────────────────
// A. The complete lifecycle, and the accepted packet it produces.
// ──────────────────────────────────────────────────────────────────────────────

describe("the staged probe lifecycle (mock provider — not live proof)", () => {
  it("stages, dispatches once, collects raw evidence, cleans up by lease and yields two independently valid observations", async () => {
    const collected = await world.fullProbe();
    expect(collected.status).toBe("measured");
    expect(world.count("POST", "/git/refs")).toBe(1);
    expect(world.count("POST", "/dispatches")).toBe(1);
    expect(world.count("POST", "/cancel")).toBe(0);
    expect(world.refSha()).toBeNull();
    const events = world.probeRecords().map((record: any) => record.type);
    expect(events[0]).toBe("probe-opened");
    expect(events[events.length - 1]).toBe("probe-closed");
    for (const environment of Object.keys(ENV_IDS)) {
      expect(world.validate(collected.records[environment], environment)).toBeNull();
    }
    // The original journal carries exactly one forward link to the staged intent.
    const links = readJournal({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT }).filter((record: any) => record.type === "probe-staged");
    expect(links).toHaveLength(1);
    expect(links[0].data.intent_artifact).toBe(probeIntentName(RUN_ID, ATTEMPT));
  });

  it("accepts a complete-201 creation after its first readback times out and a bounded pre-dispatch read proves continuous ownership", async () => {
    world.seedOriginal();
    await world.phase("stage");
    let loseFirstCreatedRead = true;
    const interruptedReadback = async (method: string, requestPath: string, body?: unknown) => {
      if (method === "GET" && loseFirstCreatedRead && world.refSha() === world.sha
        && requestPath === `/repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`) {
        loseFirstCreatedRead = false;
        world.calls.push({ method, path: requestPath, body });
        return incompleteResponse("transport-timeout");
      }
      return world.transport(method, requestPath, body);
    };
    await expect(world.phase("dispatch", { transport: interruptedReadback })).rejects.toThrow(/could not be read back/);
    expect([world.count("POST", "/git/refs"), world.count("POST", "/dispatches")]).toEqual([1, 0]);

    await world.phase("dispatch");
    const collected: any = await world.phase("collect");
    let deletions = 0;
    const cleaned: any = await world.phase("cleanup", { deleteRef: async () => {
      deletions += 1;
      world.setRef(null);
      return { outcome: "deleted", exit_code: 0 };
    } });
    const records = world.probeRecords();
    const created = records.find((record: any) => record.type === "ref-create-result");
    const dispatch = records.find((record: any) => record.type === "dispatch-intent");
    const readbacks = records.filter((record: any) => record.type === "ref-readback" && record.seq > created.seq && record.seq < dispatch.seq);
    expect(readbacks.map((record: any) => [record.data.response_complete, record.data.http_status, record.data.object_sha]))
      .toEqual([[false, 0, null], [true, 200, world.sha]]);
    expect([collected.status, cleaned.outcome, world.count("POST", "/git/refs"), world.count("POST", "/dispatches"), deletions])
      .toEqual(["measured", "measured", 1, 1, 1]);
    expect(world.refSha()).toBeNull();
    for (const environment of Object.keys(ENV_IDS)) expect(world.validate(collected.records[environment], environment)).toBeNull();

    writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
      schema_version: 1, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT,
      controls: { [OFFBRANCH_CONTROL]: collected.records },
    });
    const blockers = assessEvidence({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, now: () => new Date(world.clock + 1000) }).blockers;
    expect(blockers.filter((entry: any) => entry.detail.includes(OFFBRANCH_CONTROL))).toEqual([]);
  });

  for (const fault of ["postdispatch-only", "missing-201", "foreign-ref", "404-then-restored", "changed-sha-then-restored"] as const) {
    it(`refuses ${fault} lifecycle evidence through both offline validators`, async () => {
      const collected: any = await world.fullProbe();
      rewriteProbeJournal(world, (records) => {
        const dispatch = records.find((record: any) => record.type === "dispatch-intent");
        const created = records.find((record: any) => record.type === "ref-create-result");
        const initial = records.find((record: any) => record.type === "ref-readback" && record.seq > created.seq && record.seq < dispatch.seq);
        if (fault === "missing-201") {
          Object.assign(created.data, { http_status: 0, response_complete: false, response_incomplete: "transport-timeout", measured_status: null, object_sha: null });
        } else if (fault === "foreign-ref") {
          initial.data.ref = "refs/heads/foreign-probe";
        } else if (fault === "404-then-restored") {
          Object.assign(initial.data, { http_status: 404, response_complete: true, response_incomplete: null, measured_status: 404, object_sha: null });
        } else if (fault === "changed-sha-then-restored") {
          initial.data.object_sha = world.otherSha;
        } else {
          Object.assign(initial.data, { http_status: 0, response_complete: false, response_incomplete: "transport-timeout", measured_status: null, object_sha: null });
        }
        if (fault !== "missing-201") {
          const laterMatch = records.find((record: any) => record.type === "ref-readback" && record.seq > dispatch.seq
            && record.data.response_complete === true && record.data.http_status === 200 && record.data.object_sha === world.sha);
          expect(laterMatch).toBeDefined();
        }
      });

      for (const environment of Object.keys(ENV_IDS)) expect(world.validate(collected.records[environment], environment)).toMatch(
        fault === "missing-201" ? /no result or reconciliation|creation is not a complete 201/ : /authenticated readback.*before dispatch|accumulated lifecycle/,
      );
      writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
        schema_version: 1, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT,
        controls: { [OFFBRANCH_CONTROL]: collected.records },
      });
      const blockers = assessEvidence({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, now: () => new Date(world.clock + 1000) }).blockers
        .filter((entry: any) => entry.detail.includes(OFFBRANCH_CONTROL));
      expect(blockers).toHaveLength(2);
    });
  }

  it("retains the provider's exact bytes, create-once at mode 0600", async () => {
    await world.fullProbe();
    const raw = readdirSync(world.dir).filter((name) => name.includes("-offbranch-raw-"));
    expect(raw.length).toBeGreaterThan(10);
    for (const name of raw) {
      // Node's own mode bits, masked to the permission triplet: `stat -f %Lp` is a BSD/macOS
      // spelling that GNU coreutils on the CI runner does not accept, and this assertion has to
      // hold on both.
      expect((statSync(path.join(world.dir, name)).mode & 0o777).toString(8).padStart(3, "0")).toBe("600");
    }
    // Create-once, and readable back: a second exclusive create of a retained name is refused, and
    // the bytes already there are untouched by that refusal.
    const first = path.join(world.dir, raw[0]);
    const retained = readFileSync(first);
    expect(retained.length).toBeGreaterThan(0);
    expect(() => writeFileSync(first, "overwritten", { flag: "wx", mode: 0o600 })).toThrow(/EEXIST/);
    expect(readFileSync(first)).toEqual(retained);
  });

  it("wires into assessEvidence: an accepted pair raises no off-branch blocker; a forged one does", async () => {
    const collected = await world.fullProbe();
    const writeControls = (records: any) => writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
      schema_version: 1, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT, controls: { [OFFBRANCH_CONTROL]: records },
    });
    writeControls(collected.records);
    const offBranch = (blockers: any[]) => blockers.filter((entry) => entry.detail.includes(OFFBRANCH_CONTROL));
    expect(offBranch(assessEvidence({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, now: () => new Date(world.clock + 1000) }).blockers)).toEqual([]);
    writeControls({ ...collected.records, "staging-emergency": { ...collected.records["staging-emergency"], attempt: "2" } });
    expect(offBranch(assessEvidence({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, now: () => new Date(world.clock + 1000) }).blockers).length).toBeGreaterThan(0);
  });

  it("normal commissioning without a staged probe still reports the control unverified", () => {
    world.seedOriginal();
    writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), { schema_version: 1, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT, controls: {} });
    const blockers = assessEvidence({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT }).blockers.filter((entry: any) => entry.detail.includes(OFFBRANCH_CONTROL));
    expect(blockers).toHaveLength(1);
    expect(blockers[0].kind).toBe("unverified");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// B. Selection, identity and provenance of the cross-run record.
// ──────────────────────────────────────────────────────────────────────────────

describe("the cross-run variant is selected only explicitly, and cannot be relabelled or replayed", () => {
  let records: any;
  beforeEach(async () => { records = (await world.fullProbe()).records; });
  const release = () => records["staging-release"];

  it("refuses the marker under any other control, including both same-run negative controls", () => {
    for (const key of ["self_review_refused", "unauthorized_reviewer_refused", "prevent_self_review_enabled", "administrators_cannot_bypass"]) {
      expect(world.validate(release(), "staging-release", world.trusted(), key)).toMatch(/only off_branch_environment_reference_refused may use/);
    }
  });

  it("refuses an unknown or non-integer version, and never infers a link from an absent marker", () => {
    expect(world.validate({ ...release(), offbranch_schema_version: 2 }, "staging-release")).toMatch(/does not know/);
    expect(world.validate({ ...release(), offbranch_schema_version: "1" }, "staging-release")).toMatch(/does not know/);
    const { offbranch_schema_version: _drop, commissioning: _c, ...legacy } = release();
    // Legacy same-run validation applies, and the probe run is not the commissioning run.
    expect(world.validate(legacy, "staging-release")).not.toBeNull();
  });

  it("refuses unknown wrapper fields and wrapper/observation disagreement, including fresh timestamps", () => {
    expect(world.validate({ ...release(), note: "x" }, "staging-release")).toMatch(/outside its closed schema/);
    expect(world.validate({ ...release(), measured_at: iso(world.clock) }, "staging-release")).toMatch(/measured_at/);
    expect(world.validate({ ...release(), environment_id: "4402" }, "staging-release")).toMatch(/environment_id/);
    expect(world.validate({ ...release(), source: "provider-ui" }, "staging-release")).toMatch(/UI denial evidence stays unverified/);
  });

  it("refuses the probe relabelled as the commissioning run, a changed attempt and a probe rerun attempt", () => {
    expect(world.validate({ ...release(), run_id: RUN_ID }, "staging-release")).toMatch(/distinct run/);
    expect(world.validate({ ...release(), attempt: "2" }, "staging-release")).toMatch(/attempt/);
    const forged = world.forgeObservation(release(), (o) => { o.attempt = "2"; });
    expect(world.validate({ ...forged, attempt: "2" }, "staging-release")).toMatch(/attempt/);
  });

  it("refuses attachment to another commissioning attempt or a different original intent", () => {
    const trusted = world.trusted();
    expect(world.validate(release(), "staging-release", { ...trusted, commissioning: { ...trusted.commissioning, run_id: "900002" } })).toMatch(/commissioning identity/);
    expect(world.validate(release(), "staging-release", { ...trusted, commissioning: { ...trusted.commissioning, intent_sha256: "0".repeat(64) } })).toMatch(/commissioning identity/);
    expect(world.validate(release(), "staging-release", { ...trusted, commissioning: { ...trusted.commissioning, workflow_sha: world.otherSha } })).not.toBeNull();
  });

  it("refuses a probe intent linked after the ref was created, a missing link and a duplicated link", () => {
    const trusted = world.trusted();
    const lateLink = trusted.resourceJournal.map((record: any) => (record.type === "probe-staged" ? { ...record, ts: iso(world.clock) } : record));
    expect(world.validate(release(), "staging-release", { ...trusted, resourceJournal: lateLink })).toMatch(/before|after|impossible/);
    const noLink = trusted.resourceJournal.filter((record: any) => record.type !== "probe-staged");
    expect(world.validate(release(), "staging-release", { ...trusted, resourceJournal: noLink })).toMatch(/0 staged probe link/);
    const twice = [...trusted.resourceJournal, trusted.resourceJournal.find((record: any) => record.type === "probe-staged")];
    expect(world.validate(release(), "staging-release", { ...trusted, resourceJournal: twice })).toMatch(/2 staged probe link/);
  });

  it("refuses a replay: an old observation re-wrapped into a later window", () => {
    const trusted = world.trusted();
    expect(world.validate(release(), "staging-release", { ...trusted, window: { start: iso(world.clock), end: iso(world.clock + 5000) } })).toMatch(/precedes|impossible|predates/);
  });

  it("refuses unknown observation fields, source/path/ref/event/actor/job mutations and a stale job identity", () => {
    const cases: Array<[(o: any) => void, RegExp]> = [
      [(o) => { o.extra = 1; }, /outside its closed schema/],
      [(o) => { o.probe.workflow_path = ".github/workflows/ci.yml"; }, /probe identity/],
      [(o) => { o.probe.ref = "refs/heads/staging"; }, /probe identity/],
      [(o) => { o.probe.event = "push"; }, /probe identity/],
      [(o) => { o.probe.actor = { id: 1, login: "other", type: "User" }; }, /probe identity/],
      [(o) => { o.probe.job_id = "1"; }, /probe identity/],
      [(o) => { o.probe.job_key = "probe-emergency"; }, /probe identity/],
      [(o) => { o.probe.terminal_at = "2026-09-21T12:59:59Z"; }, /probe identity/],
      [(o) => { o.probe_intent.sha256 = "0".repeat(64); }, /probe intent/],
      [(o) => { delete o.provider_evidence.environment_after; }, /closed field/],
    ];
    const file = path.join(world.dir, release().artifact);
    const original = readFileSync(file);
    for (const [mutate, pattern] of cases) {
      expect(world.validate(world.forgeObservation(release(), mutate), "staging-release"), String(pattern)).toMatch(pattern);
      rmSync(file);
      writeFileSync(file, original, { mode: 0o600 });
    }
    expect(world.validate(release(), "staging-release")).toBeNull();
  });
});

describe("retained artifacts are basenames, regular, bounded and digest-bound", () => {
  let records: any;
  beforeEach(async () => { records = (await world.fullProbe()).records; });
  it("refuses traversal, a symlink, an oversized file and a digest mismatch", () => {
    const record = records["staging-release"];
    expect(world.validate({ ...record, artifact: "../x.json" }, "staging-release")).toMatch(/plain retained artifact/);
    symlinkSync(path.join(world.dir, record.artifact), path.join(world.dir, "link.json"));
    expect(world.validate({ ...record, artifact: "link.json" }, "staging-release")).toMatch(/symlink/);
    writeFileSync(path.join(world.dir, "big.json"), "x".repeat(70 * 1024));
    expect(world.validate({ ...record, artifact: "big.json", artifact_sha256: sha256("x".repeat(70 * 1024)) }, "staging-release")).toMatch(/bound/);
    expect(world.validate({ ...record, artifact_sha256: "a".repeat(64) }, "staging-release")).toMatch(/digest/);
  });

  it("refuses reusing one observation for both environments", async () => {
    const release = records["staging-release"];
    expect(world.validate({ ...release, environment_name: "staging-emergency" }, "staging-emergency")).not.toBeNull();
    writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
      schema_version: 1, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT,
      controls: { [OFFBRANCH_CONTROL]: { "staging-release": release, "staging-emergency": { ...release, environment_name: "staging-emergency" } } },
    });
    const details = assessEvidence({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, now: () => new Date(world.clock + 1000) }).blockers.map((b: any) => b.detail).join("\n");
    expect(details).toMatch(/reuse one off-branch observation/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// C. Provider shapes: every join, and the exact diagnostic.
// ──────────────────────────────────────────────────────────────────────────────

describe("provider shape parsers (real-shaped synthetic captures)", () => {
  let run: any; let jobs: any; let checks: Record<string, any>; let annotations: Record<string, any[]>;
  beforeEach(() => {
    world.seedOriginal();
    world.createRuns();
    world.clock += 10_000;
    const probe = world.runs[0];
    run = world.runBody(probe);
    jobs = { total_count: 2, jobs: probe.jobs.map((job) => world.jobBody(probe, job)) };
    checks = Object.fromEntries(probe.jobs.map((job) => [job.spec.environment, world.checkBody(probe, job)]));
    annotations = Object.fromEntries(probe.jobs.map((job) => [job.spec.environment, world.annotationRows(job)]));
  });
  const expectRun = () => ({ runId: String(run.id), repositoryId: String(REPO_ID), workflowSha: world.sha });
  const parsed = () => {
    const r = parseProbeRun(run, expectRun());
    const j = parseProbeJobs([{ page: 1, body: jobs }], { runId: String(run.id), workflowSha: world.sha });
    return { r, j };
  };
  const checkOf = (environment: string, body = checks[environment]) => {
    const { r, j } = parsed();
    const job = Object.values(j).find((entry: any) => entry.environment === environment) as any;
    return parseProbeCheck(body, { checkId: job.check_id, job, run: r, environment, workflowSha: world.sha });
  };

  it("accepts the untouched synthetic shape", () => {
    expect(() => parsed()).not.toThrow();
    for (const environment of Object.keys(ENV_IDS)) {
      expect(checkOf(environment).deployment_environment).toBe(environment);
      expect(parseDiagnosticAnnotations([{ page: 1, body: annotations[environment] }], { branch: PROBE_BRANCH, environment, sha: world.sha })).toEqual({ specific: 1, generic: 1, count: 2 });
    }
  });

  it("refuses each single run mutation", () => {
    const mutations: Array<[string, (r: any) => void]> = [
      ["id", (r) => { r.id += 1; }], ["rerun", (r) => { r.run_attempt = 2; }], ["repository", (r) => { r.repository.id = 1; }],
      ["head repository", (r) => { r.head_repository.full_name = "fork/aios-team-brain"; }], ["source", (r) => { r.head_sha = world.otherSha; }],
      ["path", (r) => { r.path = ".github/workflows/scan-on-merge.yml"; }], ["event", (r) => { r.event = "push"; }],
      ["branch", (r) => { r.head_branch = "staging"; }], ["actor", (r) => { r.actor.id = 3173623; }], ["triggering actor", (r) => { r.triggering_actor.login = "x"; }],
      ["in progress", (r) => { r.status = "in_progress"; }], ["success", (r) => { r.conclusion = "success"; }], ["cancelled", (r) => { r.conclusion = "cancelled"; }],
      ["url", (r) => { r.url += "?x=1"; }],
    ];
    for (const [label, mutate] of mutations) {
      const copy = JSON.parse(JSON.stringify(run));
      mutate(copy);
      expect(() => parseProbeRun(copy, expectRun()), label).toThrow();
    }
  });

  it("refuses each single job mutation, including skip, admission, runner allocation and duplicates", () => {
    const mutations: Array<[string, (j: any) => void]> = [
      ["skipped", (j) => { j.jobs[0].conclusion = "skipped"; }], ["success", (j) => { j.jobs[0].conclusion = "success"; }],
      ["cancelled", (j) => { j.jobs[0].conclusion = "cancelled"; }], ["steps", (j) => { j.jobs[0].steps = [{ name: "x" }]; }],
      ["runner", (j) => { j.jobs[0].runner_id = 5; }], ["name", (j) => { j.jobs[0].name = "Probe Release"; }],
      ["duplicate", (j) => { j.jobs[1] = { ...j.jobs[0] }; }], ["missing", (j) => { j.jobs.pop(); j.total_count = 1; }],
      ["extra", (j) => { j.jobs.push({ ...j.jobs[0], id: 9, name: "probe-release" }); j.total_count = 3; }],
      ["incomplete count", (j) => { j.total_count = 3; }], ["rerun attempt", (j) => { j.jobs[0].run_attempt = 2; }],
      ["other run", (j) => { j.jobs[0].run_id = 1; }], ["source", (j) => { j.jobs[0].head_sha = world.otherSha; }],
      ["check url query", (j) => { j.jobs[0].check_run_url += "?x=1"; }], ["check url port", (j) => { j.jobs[0].check_run_url = j.jobs[0].check_run_url.replace("api.github.com", "api.github.com:443"); }],
      ["check url encoded", (j) => { j.jobs[0].check_run_url = j.jobs[0].check_run_url.replace("check-runs", "check%2Druns"); }],
      ["check url userinfo", (j) => { j.jobs[0].check_run_url = j.jobs[0].check_run_url.replace("https://", "https://u@"); }],
      ["job web url", (j) => { j.jobs[0].html_url = `${WEB}/actions/runs/1/job/1`; }],
    ];
    for (const [label, mutate] of mutations) {
      const copy = JSON.parse(JSON.stringify(jobs));
      mutate(copy);
      expect(() => parseProbeJobs([{ page: 1, body: copy }], { runId: String(run.id), workflowSha: world.sha }), label).toThrow();
    }
  });

  it("joins the job to ITS check: a different check with the same SHA and message cannot be substituted", () => {
    const other = { ...checks["staging-emergency"] };
    expect(() => checkOf("staging-release", other)).toThrow();
    expect(parseCheckRunUrl(`${API}/check-runs/8000`)).toBe("8000");
  });

  it("refuses each single check mutation (node, name, suite, producer, deployment, counts)", () => {
    const mutations: Array<[string, (c: any) => void]> = [
      ["node", (c) => { c.node_id = "CR_other"; }], ["name", (c) => { c.name = "probe-emergency"; }],
      ["suite", (c) => { c.check_suite.id += 1; }], ["producer", (c) => { c.app.id = 1; }], ["producer slug", (c) => { c.app.slug = "other"; }],
      ["producer owner", (c) => { c.app.owner.id = 1; }], ["deployment env", (c) => { c.deployment.environment = "staging-emergency"; }],
      ["original env", (c) => { c.deployment.original_environment = "trusted-automation"; }], ["no deployment", (c) => { delete c.deployment; }],
      ["deployment url", (c) => { c.deployment.url = `${API}/deployments/1`; }], ["count", (c) => { c.output.annotations_count = 3; }],
      ["annotations url", (c) => { c.output.annotations_url += "?page=2"; }], ["times", (c) => { c.completed_at = "2026-09-21T13:00:00Z"; }],
      ["source", (c) => { c.head_sha = world.otherSha; }], ["details", (c) => { c.details_url = `${WEB}/actions/runs/1/job/1`; }],
    ];
    for (const [label, mutate] of mutations) {
      const copy = JSON.parse(JSON.stringify(checks["staging-release"]));
      mutate(copy);
      expect(() => checkOf("staging-release", copy), label).toThrow();
    }
  });

  it("does not let a check or deployment ID stand in for the numeric environment identity", () => {
    const policy = parseEnvironmentPolicy({ settings: world.settings("staging-release"), branchPages: [{ page: 1, body: { total_count: 1, branch_policies: world.branchPolicies["staging-release"] } }] }, { environment: "staging-release" });
    expect(policy.environment_id).toBe("4401");
    expect(String(checkOf("staging-release").deployment_id)).not.toBe(policy.environment_id);
  });

  it("accepts the two exact annotations in either order and refuses every lookalike", () => {
    const env = "staging-release";
    const ok = (rows: any[]) => parseDiagnosticAnnotations([{ page: 1, body: rows }], { branch: PROBE_BRANCH, environment: env, sha: world.sha });
    const rows = annotations[env];
    expect(ok([rows[1], rows[0]])).toEqual({ specific: 1, generic: 1, count: 2 });
    const bad: Array<[string, any[]]> = [
      ["generic only", [rows[1]]], ["specific only", [rows[0]]], ["duplicate specific", [rows[0], rows[0]]], ["duplicate generic", [rows[1], rows[1]]],
      ["extra unknown", [...rows, { ...rows[1], message: "Something else failed." }]],
      ["other environment", [{ ...rows[0], message: specificDiagnosticMessage(PROBE_BRANCH, "staging-emergency") }, rows[1]]],
      ["other branch", [{ ...rows[0], message: specificDiagnosticMessage("staging", env) }, rows[1]]],
      ["trailing space", [{ ...rows[0], message: `${rows[0].message} ` }, rows[1]]],
      ["nbsp", [{ ...rows[0], message: rows[0].message.replace(" is not", " is not") }, rows[1]]],
      ["curly quotes", [{ ...rows[0], message: rows[0].message.replace(/"/g, "“") }, rows[1]]],
      ["embedded", [{ ...rows[0], message: `Note: ${rows[0].message}` }, rows[1]]],
      ["case", [{ ...rows[0], message: rows[0].message.toLowerCase() }, rows[1]]],
      ["wrong blob", [{ ...rows[0], blob_href: `${WEB}/blob/${world.otherSha}/.github` }, rows[1]]],
      ["wrong level", [{ ...rows[0], annotation_level: "warning" }, rows[1]]],
      ["wrong title", [{ ...rows[0], title: "" }, rows[1]]],
      ["extra field", [{ ...rows[0], extra: 1 }, rows[1]]],
      ["raw details", [{ ...rows[0], raw_details: "details" }, rows[1]]],
    ];
    for (const [label, candidate] of bad) expect(() => ok(candidate), label).toThrow();
    expect(() => parseDiagnosticAnnotations([{ page: 1, body: Array(100).fill(rows[0]) }], { branch: PROBE_BRANCH, environment: env, sha: world.sha })).toThrow(/not read to its end|full page/);
  });

  it("refuses tag-rule substitution, an extra branch, incomplete pagination, unmeasured bypass and another protection rule", () => {
    const env = "staging-release";
    const policy = (settings: any, rows: any[], total = rows.length) => assertPolicyAgreesWithCommissioning(parseEnvironmentPolicy({ settings, branchPages: [{ page: 1, body: { total_count: total, branch_policies: rows } }] }, { environment: env }), env);
    const rows = world.branchPolicies[env];
    expect(() => policy(world.settings(env), rows)).not.toThrow();
    expect(() => policy(world.settings(env), [{ ...rows[0], type: "tag" }])).toThrow();
    expect(() => policy(world.settings(env), [...rows, { id: 99, node_id: "x", name: "main", type: "branch" }])).toThrow();
    expect(() => policy(world.settings(env), rows, 2)).toThrow(/incomplete/);
    expect(() => policy({ ...world.settings(env), can_admins_bypass: undefined }, rows)).toThrow(/unmeasured/);
    expect(() => policy({ ...world.settings(env), can_admins_bypass: true }, rows)).toThrow();
    expect(() => policy({ ...world.settings(env), protection_rules: [...world.settings(env).protection_rules, { id: 5, type: "wait_timer", wait_timer: 5 }] }, rows)).toThrow(/wait_timer/);
    expect(() => policy({ ...world.settings(env), deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, rows)).toThrow();
  });

  it("selects exactly the runs created inside [dispatch intent, deadline] from a complete listing", () => {
    const body = { total_count: 1, workflow_runs: [run] };
    const created = Date.parse(run.created_at);
    const identity = { repositoryId: String(REPO_ID), workflowSha: world.sha };
    expect(selectEligibleRuns([{ page: 1, body }], { dispatchIntentMs: created - 500, deadlineMs: created + 600_000, identity })).toEqual([String(run.id)]);
    expect(selectEligibleRuns([{ page: 1, body }], { dispatchIntentMs: created + 1500, deadlineMs: created + 600_000, identity })).toEqual([]);
    expect(() => selectEligibleRuns([{ page: 1, body: { total_count: 2, workflow_runs: [run] } }], { dispatchIntentMs: 0, deadlineMs: Infinity, identity })).toThrow(/incomplete/);
  });

  it("needs the trusted identity, and refuses an in-window candidate that fails it rather than picking another", () => {
    const created = Date.parse(run.created_at);
    const bounds = { dispatchIntentMs: created - 500, deadlineMs: created + 600_000 };
    const identity = { repositoryId: String(REPO_ID), workflowSha: world.sha };
    // No trusted identity at all: selection refuses rather than matching on the coarse selector.
    expect(() => selectEligibleRuns([{ page: 1, body: { total_count: 1, workflow_runs: [run] } }], bounds as any)).toThrow(/trusted commissioning repository/);
    // One of ours and one foreign, both matching workflow/ref/event/window: nothing is selected.
    for (const foreign of [
      { ...run, id: run.id + 1, actor: { id: 12345, login: "someone-else", type: "User" } },
      { ...run, id: run.id + 1, triggering_actor: { id: 12345, login: "someone-else", type: "User" } },
      { ...run, id: run.id + 1, run_attempt: 2 },
      { ...run, id: run.id + 1, repository: { id: 999, full_name: REPO } },
    ]) {
      const listing = [{ page: 1, body: { total_count: 2, workflow_runs: [run, { ...foreign, url: `${API}/actions/runs/${foreign.id}`, html_url: `${WEB}/actions/runs/${foreign.id}` }] } }];
      expect(() => selectEligibleRuns(listing, { ...bounds, identity })).toThrow(/not this probe's own run/);
    }
  });
});

describe("the historical September 6 fixture: shape coverage only, never current acceptance", () => {
  const load = (name: string) => readFileSync(path.join(FIXTURE, name));
  it("is the retained bytes, with only the two documented removals", () => {
    expect(sha256(load("jobs.json"))).toBe("4723f398b0f0698f63684217232c47e337ae882df75f376182d0d3095d1283c7");
    expect(sha256(load("annotations.json"))).toBe("3a591de07bfbeeb38eb5167bc159070798f6a0d984eb187563e06c5a66395bad");
    // `check.json` is the retained response minus `app.client_id` — see the fixture README. The
    // retained original (`59089a79…5bc2e7b`) is unchanged in private evidence; this asserts the
    // published, sanitized bytes, so a further edit to the public copy fails here.
    expect(sha256(load("check.json"))).toBe("3dc715b029c18ddf19306399db1f1ecfdfb01fb8594c60e53618db5cc57f4a4a");
    const check = JSON.parse(load("check.json").toString("utf8"));
    expect(Object.hasOwn(check.app, "client_id")).toBe(false);
    expect([check.app.id, check.app.slug, check.app.owner.id]).toEqual([15368, "github-actions", 9919]);
  });

  it("passes the isolated shape parser with its true historical subject", () => {
    const annotations = JSON.parse(load("annotations.json").toString("utf8"));
    expect(parseDiagnosticAnnotations([{ page: 1, body: annotations }], {
      branch: "staging", environment: "trusted-automation", sha: "f8c099f646cd13448e6f1b15e41ce2a0e68d5bcb",
    })).toEqual({ specific: 1, generic: 1, count: 2 });
    expect(parseCheckRunUrl(JSON.parse(load("jobs.json").toString("utf8")).jobs[0].check_run_url)).toBe("101401894241");
  });

  it("fails every live join: the fixed probe subject, the probe run, the probe jobs and a packet built from it", async () => {
    const annotations = JSON.parse(load("annotations.json").toString("utf8"));
    for (const environment of Object.keys(ENV_IDS)) {
      expect(() => parseDiagnosticAnnotations([{ page: 1, body: annotations }], { branch: PROBE_BRANCH, environment, sha: "f8c099f646cd13448e6f1b15e41ce2a0e68d5bcb" })).toThrow();
    }
    const run = JSON.parse(load("run.json").toString("utf8"));
    expect(() => parseProbeRun(run, { runId: String(run.id), repositoryId: String(REPO_ID), workflowSha: run.head_sha })).toThrow(/workflow|event|branch/);
    const jobs = JSON.parse(load("jobs.json").toString("utf8"));
    expect(() => parseProbeJobs([{ page: 1, body: jobs }], { runId: String(run.id), workflowSha: run.head_sha })).toThrow();
    // Substitute the historical responses into an otherwise complete packet: refused.
    const records = (await world.fullProbe()).records;
    const observation = JSON.parse(readFileSync(path.join(world.dir, records["staging-release"].artifact), "utf8"));
    const runDescriptor = JSON.parse(readFileSync(path.join(world.dir, observation.provider_evidence.run.artifact), "utf8"));
    const target = path.join(world.dir, runDescriptor.initial.artifact);
    rmSync(target);
    writeFileSync(target, load("run.json"), { mode: 0o600 });
    expect(world.validate(records["staging-release"], "staging-release")).toMatch(/digest/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// D. Lifecycle adversarial cases: ownership, no retries, deadline, lease.
// ──────────────────────────────────────────────────────────────────────────────

describe("lifecycle ownership: create once, dispatch once, never adopt, never retry an ambiguous write", () => {
  it("rejects inherited object names at the direct phase API before opening a provider session", async () => {
    let requests = 0;
    for (const phase of ["toString", "constructor", "__proto__"]) {
      await expect(runProbePhase({
        phase: phase as any, runId: RUN_ID, attempt: ATTEMPT, evidenceDir: world.dir, env: {},
        deps: { transport: async () => { requests += 1; throw new Error("provider request escaped phase admission"); } },
      })).rejects.toThrow(/unsupported probe phase/);
    }
    expect(requests).toBe(0);
  });

  it("refuses a preexisting probe ref at stage — even at the desired SHA — and writes nothing", async () => {
    world.seedOriginal();
    world.setRef(world.sha);
    await expect(world.phase("stage")).rejects.toThrow(/never adopted/);
    expect(readdirSync(world.dir).some((name) => name === probeIntentName(RUN_ID, ATTEMPT))).toBe(false);
    expect(readJournal({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT }).some((r: any) => r.type === "probe-staged")).toBe(false);
  });

  it("refuses to stage before the original baseline, after an approval, or once the attempt completed", async () => {
    writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "intent"), { schema_version: 1, repository: REPO, repository_id: REPO_ID, run_id: RUN_ID, attempt: ATTEMPT, workflow_path: COMMISSIONING_WORKFLOW_PATH, workflow_sha: world.sha, dispatcher: "original-dispatcher" });
    await expect(world.phase("stage")).rejects.toThrow(/journal|baseline/);
    world.seedOriginal();
    world.approvals = [{ state: "approved", user: JOHN, environments: [{ name: "staging-emergency" }], updated_at: iso(world.clock) }];
    await expect(world.phase("stage")).rejects.toThrow(/approved/);
    world.approvals = [];
    world.originalRunStatus = "completed";
    await expect(world.phase("stage")).rejects.toThrow(/completed/);
  });

  it("refuses an unregistered, late-registered or byte-different workflow before anything exists", async () => {
    world.seedOriginal();
    world.registrationCreatedAt = iso(world.clock);
    await expect(world.phase("stage")).rejects.toThrow(/registered before/);
    world.registrationCreatedAt = "2026-09-01T00:00:00Z";
    world.sourceBytes = Buffer.concat([PROBE_YAML, Buffer.from("# edit\n")]);
    await expect(world.phase("stage")).rejects.toThrow(/reviewed bytes/);
    expect(world.count("POST", "/git/refs")).toBe(0);
  });

  it("stages once per attempt: an unchanged staged intent is idempotent", async () => {
    world.seedOriginal();
    await world.phase("stage");
    expect((await world.phase("stage")).status).toBe("already-staged");
  });

  it("reconciles a lost create answer (applied) by readback, marks ownership uncertain, and never dispatches or deletes", async () => {
    world.seedOriginal();
    await world.phase("stage");
    world.lose[`POST /repos/${REPO}/git/refs`] = "lost-applied";
    await expect(world.phase("dispatch")).rejects.toThrow(/ownership is uncertain/);
    expect(world.count("POST", "/git/refs")).toBe(1);
    await expect(world.phase("dispatch")).rejects.toThrow(/never re-issued/);
    await expect(world.phase("cleanup")).rejects.toThrow(/ownership is uncertain/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.count("POST", "/dispatches")).toBe(0);
  });

  it("reconciles a lost create answer (unapplied) as absent, without re-creating", async () => {
    world.seedOriginal();
    await world.phase("stage");
    world.lose[`POST /repos/${REPO}/git/refs`] = "lost-unapplied";
    await expect(world.phase("dispatch")).rejects.toThrow(/not re-created/);
    await expect(world.phase("dispatch")).rejects.toThrow(/never re-issued/);
    expect(world.count("POST", "/git/refs")).toBe(1);
    const cleaned: any = await world.phase("cleanup");
    expect(cleaned.status).toBe("nothing-owned");
  });

  it("keeps a complete-error applied create permanently uncertain across restored absence and repeated cleanup", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await expect(world.phase("dispatch", { transport: async (method: string, requestPath: string, body?: unknown) => {
      const answer = await world.transport(method, requestPath, body);
      return method === "POST" && requestPath.endsWith("/git/refs")
        ? completedJsonResponse(500, Buffer.from('{"message":"server failure"}'), createRedactor(), { retainRaw: true }) : answer;
    } })).rejects.toThrow(/ownership is uncertain/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.probeRecords().some((record: any) => record.type === "reconciliation"
      && record.data.of === "ref-create-intent" && record.data.outcome === "present-ownership-uncertain")).toBe(true);
    world.setRef(null); // A later 404 cannot erase the already observed unknown presence.
    await expect(world.phase("cleanup")).rejects.toThrow(/ownership is uncertain/);
    await expect(world.phase("cleanup")).rejects.toThrow(/ownership is uncertain/);
    expect(world.probeRecords().some((record: any) => record.type === "probe-closed")).toBe(false);
    expect(world.count("POST", "/dispatches")).toBe(0);
  });

  it("reconciles a complete-error unapplied create only to absent, without re-creation or positive measurement", async () => {
    world.seedOriginal();
    await world.phase("stage");
    const transport = async (method: string, requestPath: string, body?: unknown) => {
      if (method === "POST" && requestPath.endsWith("/git/refs")) {
        world.calls.push({ method, path: requestPath, body });
        return completedJsonResponse(500, Buffer.from('{"message":"server failure"}'), createRedactor(), { retainRaw: true });
      }
      return world.transport(method, requestPath, body);
    };
    await expect(world.phase("dispatch", { transport })).rejects.toThrow(/ref is absent.*not re-created/);
    await expect(world.phase("dispatch", { transport })).rejects.toThrow(/never re-issued/);
    const cleaned: any = await world.phase("cleanup", { transport });
    expect(cleaned.status).toBe("nothing-owned");
    expect((await world.phase("cleanup", { transport }) as any).status).toBe("already-closed");
    expect([world.count("POST", "/git/refs"), world.count("POST", "/dispatches"), world.refSha()]).toEqual([1, 0, null]);
  });

  it("does not re-dispatch after a lost dispatch answer; collect reconciles the one run", async () => {
    world.seedOriginal();
    await world.phase("stage");
    world.lose[`POST /repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/dispatches`] = "lost-applied";
    const dispatched: any = await world.phase("dispatch");
    expect(dispatched.status).toBe("dispatch-ambiguous");
    const collected: any = await world.phase("collect");
    expect(collected.status).toBe("measured");
    expect(world.count("POST", "/dispatches")).toBe(1);
  });

  it("refuses duplicate eligible runs instead of selecting one, and journals that", async () => {
    world.seedOriginal();
    world.runsPerDispatch = 2;
    await world.phase("stage");
    await world.phase("dispatch");
    await expect(world.phase("collect")).rejects.toThrow(/2 eligible probe runs/);
    const rejected = world.probeRecords().find((record: any) => record.type === "run-selection-observed" && record.data.boundary === "peek");
    expect(rejected).toBeTruthy();
    expect(JSON.parse(readFileSync(path.join(world.dir, rejected.data.capture.artifact), "utf8")).workflow_runs).toHaveLength(2);
    expect(world.count("POST", "/dispatches")).toBe(1);
    // WAS: cleanup closed this as inconclusive. Two candidate runs may BOTH be live, and deleting
    // the ref out from under them while filing the probe is a closure over a question nobody
    // answered (R06). It is blocked, and the evidence is kept for root reconciliation.
    await expect(world.phase("cleanup")).rejects.toThrow(/eligible probe runs/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.count("POST", "/cancel")).toBe(0);
    expect(world.probeRecords().some((record: any) => record.type === "cleanup-intent" || record.type === "probe-closed")).toBe(false);
  });

  for (const contradiction of ["attempt", "actor", "source"] as const) {
    it(`retains a rejected ${contradiction} in the initial selection peek across restoration and restart`, async () => {
      world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch");
      const original = world.runBody.bind(world);
      if (contradiction === "attempt") world.runs[0].attempt = 2;
      if (contradiction === "actor") world.runs[0].actor = { id: 3, login: "foreign", type: "User" };
      if (contradiction === "source") world.runBody = ((run: Run) => ({ ...original(run), head_sha: world.otherSha })) as any;
      await expect(world.phase("collect")).rejects.toThrow(/not this probe's own run/);
      const observed = world.probeRecords().filter((record: any) => record.type === "run-selection-observed");
      expect(observed.some((record: any) => record.data.boundary === "peek")).toBe(true);
      const listingReads = world.count("GET", `/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`);
      world.runs[0].attempt = 1; world.runs[0].actor = { ...JOHN }; world.runBody = original as any;
      await expect(world.phase("collect")).rejects.toThrow(/not this probe's own run/);
      expect(world.count("GET", `/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`)).toBe(listingReads);
      expect(world.probeRecords().some((record: any) => record.type === "observation-recorded")).toBe(false);
    });
  }

  for (const contradiction of ["duplicate", "foreign"] as const) {
    it(`retains a rejected ${contradiction} candidate set across restoration and restart`, async () => {
      world.seedOriginal(); world.runsPerDispatch = 2; await world.phase("stage"); await world.phase("dispatch");
      if (contradiction === "foreign") world.runs[1].actor = { id: 3, login: "foreign", type: "User" };
      await expect(world.phase("collect")).rejects.toThrow(/eligible probe runs were observed|not this probe's own run/);
      const listingReads = world.count("GET", `/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`);
      world.runs.splice(1, 1);
      await expect(world.phase("collect")).rejects.toThrow(/eligible probe runs were observed|not this probe's own run/);
      expect(world.count("GET", `/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`)).toBe(listingReads);
      expect(world.probeRecords().some((record: any) => record.type === "probe-closed")).toBe(false);
    });
  }

  it("retains a rejected page-2 candidate before interpretation and binds it after the listing is restored", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch");
    const valid = world.runBody(world.runs[0]);
    const filler = Array.from({ length: 100 }, (_, index) => ({ ...valid, id: valid.id + 100 + index, head_branch: "outside-window" }));
    const foreignId = valid.id + 1000;
    const foreign = { ...valid, id: foreignId, run_attempt: 2, url: `${API}/actions/runs/${foreignId}`, html_url: `${WEB}/actions/runs/${foreignId}` };
    let reads = 0;
    const transport = async (method: string, requestPath: string, body?: unknown) => {
      if (method === "GET" && requestPath.includes(`/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`)) {
        reads += 1;
        if (reads === 1) return world.transport(method, requestPath, body); // retained peek sees one valid run
        world.calls.push({ method, path: requestPath, body });
        const page = Number(/(?:^|&)page=(\d+)/.exec(requestPath.split("?")[1] ?? "")?.[1] ?? "1");
        const response = page === 1 ? { total_count: 101, workflow_runs: filler } : { total_count: 101, workflow_runs: [foreign] };
        return completedJsonResponse(200, Buffer.from(JSON.stringify(response)), createRedactor(), { retainRaw: true });
      }
      return world.transport(method, requestPath, body);
    };
    await expect(world.phase("collect", { transport })).rejects.toThrow(/not this probe's own run/);
    const listing = world.probeRecords().filter((record: any) => record.type === "run-selection-observed" && record.data.boundary === "listing");
    expect(listing.map((record: any) => record.data.page)).toEqual([1, 2]);
    const listingReads = world.count("GET", `/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`);
    await expect(world.phase("collect")).rejects.toThrow(/not this probe's own run/);
    expect(world.count("GET", `/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`)).toBe(listingReads);
  });

  it("does not let a later eligible run replace a different candidate retained from an earlier selection group", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch");
    let listingReads = 0;
    const interruptedListing = async (method: string, requestPath: string, body?: unknown) => {
      if (method === "GET" && requestPath.includes(`/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`)) {
        listingReads += 1;
        if (listingReads === 2) return incompleteResponse("transport-timeout");
      }
      return world.transport(method, requestPath, body);
    };
    await expect(world.phase("collect", { transport: interruptedListing })).rejects.toThrow(/could not be captured/);
    const firstRunId = world.runs[0].id;
    world.createRuns();
    world.runs.shift();
    expect(world.runs[0].id).not.toBe(firstRunId);
    await expect(world.phase("collect")).rejects.toThrow(/different eligible probe runs were observed/);
    expect(world.probeRecords().filter((record: any) => record.type === "run-selection-observed" && record.data.boundary === "peek")).toHaveLength(2);
    expect(world.probeRecords().some((record: any) => record.type === "run-identified")).toBe(false);
  });

  it("cancels only the exact probe run at the ten-minute deadline; cancellation is inconclusive, never success", async () => {
    world.seedOriginal();
    world.neverComplete = true;
    await world.phase("stage");
    const dispatched: any = await world.phase("dispatch");
    await expect(world.phase("collect")).rejects.toThrow(/cancelled/);
    const cancels = world.calls.filter((call) => call.method === "POST" && call.path.endsWith("/cancel"));
    expect(cancels.map((call) => call.path)).toEqual([`/repos/${REPO}/actions/runs/${world.runs[0].id}/cancel`]);
    expect(world.clock).toBeGreaterThanOrEqual(Date.parse(dispatched.deadline_at));
    const cleaned: any = await world.phase("cleanup");
    expect(cleaned.outcome).toBe("inconclusive");
    expect(world.refSha()).toBeNull();
  });

  it("blocks cleanup while a cancelled run stays nonterminal past two minutes", async () => {
    world.seedOriginal();
    world.neverComplete = true;
    world.terminalOnCancel = false;
    await world.phase("stage");
    await world.phase("dispatch");
    await expect(world.phase("collect")).rejects.toThrow(/cleanup is BLOCKED/);
    await expect(world.phase("cleanup")).rejects.toThrow(/not terminal/);
    expect(world.refSha()).toBe(world.sha);
    // The explicit cancel re-confirms without a second cancellation request.
    await expect(world.phase("cancel")).rejects.toThrow(/BLOCKED/);
    expect(world.count("POST", "/cancel")).toBe(1);
  });

  it("records an admitted job as a FAILED control (exit 1), with no observation written", async () => {
    world.seedOriginal();
    world.admitted = "probe-release";
    await world.phase("stage");
    await world.phase("dispatch");
    const out: string[] = [];
    const code = await main(["collect", "--run-id", RUN_ID, "--attempt", ATTEMPT, "--evidence-dir", world.dir], {}, { ...world.deps(), write: (text: string) => out.push(text) });
    expect(code).toBe(1);
    expect(out.join("")).toMatch(/FAILED/);
    expect(readdirSync(world.dir).includes(probeObservationName(RUN_ID, ATTEMPT, "staging-release"))).toBe(false);
  });

  it("leaves the control unverified when the policy drifts across the probe", async () => {
    world.seedOriginal();
    world.afterDispatchPolicyChange = () => { world.branchPolicies["staging-emergency"] = [{ id: 73, node_id: "BP3", name: "staging", type: "branch" }]; };
    await world.phase("stage");
    await world.phase("dispatch");
    await expect(world.phase("collect")).rejects.toThrow(/unverified/);
    expect(world.probeRecords().filter((record: any) => record.type === "observation-recorded").map((r: any) => r.data.outcome)).toContain("unverified");
  });

  it("leaves the control unverified for an unknown diagnostic shape", async () => {
    world.seedOriginal();
    world.annotationOverride = (_env, rows) => [rows[1]];
    await world.phase("stage");
    await world.phase("dispatch");
    await expect(world.phase("collect")).rejects.toThrow(/unverified/);
  });

  it("refuses to delete a changed ref, and a changed ref is left untouched", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    await world.phase("collect");
    world.setRef(world.otherSha);
    await expect(world.phase("cleanup")).rejects.toThrow(/did not create/);
    expect(world.refSha()).toBe(world.otherSha);
  });

  /**
   * WAS: "present requires a fresh explicit lease" — a POSITIVE expectation, and an INVALID ORACLE
   * (R06). It asserted that an ambiguous deletion followed by the ref still sitting at the reviewed
   * SHA proved the deletion had not applied, so one fresh lease deletion could be issued. The only
   * thing that made that reading true was the MOCK's private knowledge that its `deleteRef` had
   * done nothing — knowledge the operator does not have. An applied deletion followed by another
   * creation at the same bytes produces byte-for-byte the same observations, and the retry then
   * deletes a ref this probe never created. The scenario is kept; its expectation is now refusal.
   */
  it("refuses a second deletion after an ambiguous one, however often cleanup is run", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    await world.phase("collect");
    let deletions = 0;
    const ambiguous = async () => { deletions += 1; return { outcome: "ambiguous", exit_code: 128 }; };
    await expect(world.phase("cleanup", { deleteRef: ambiguous })).rejects.toThrow(/NO second deletion is issued/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.probeRecords().some((r: any) => r.type === "reconciliation" && r.data.outcome === "present-unchanged")).toBe(true);
    // Re-running cleanup — a fresh process, re-deriving from the journal — reaches the same answer,
    // and the ref is still there. The undecided deletion is never decided by equal bytes.
    await expect(world.phase("cleanup", { deleteRef: ambiguous })).rejects.toThrow(/NO second deletion is issued/);
    await expect(world.phase("cleanup", { deleteRef: ambiguous })).rejects.toThrow(/NO second deletion is issued/);
    expect([deletions, world.refSha()]).toEqual([1, world.sha]);
    expect(assessRefOwnership(world.probeRecords(), { workflowSha: world.sha }).may_delete).toBe(false);
  });

  /**
   * The counterexample the retry could not survive: the deletion DID apply, and another creation put
   * a ref back at the same SHA before the readback. Observationally identical to the case above.
   */
  it("refuses just the same when the ambiguous deletion applied and the ref was recreated at the same SHA", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    await world.phase("collect");
    let deletions = 0;
    const applied = async () => {
      deletions += 1;
      world.setRef(null);        // the deletion really did apply …
      world.setRef(world.sha);   // … and somebody else's creation is now at the same bytes.
      return { outcome: "ambiguous", exit_code: 128 };
    };
    await expect(world.phase("cleanup", { deleteRef: applied })).rejects.toThrow(/NO second deletion is issued/);
    await expect(world.phase("cleanup", { deleteRef: applied })).rejects.toThrow(/NO second deletion is issued/);
    // The replacement ref is untouched, and the probe never closes over it.
    expect([deletions, world.refSha()]).toEqual([1, world.sha]);
    expect(world.probeRecords().some((record: any) => record.type === "probe-closed")).toBe(false);
  });

  it("closes an ambiguous deletion that did take effect as absent after reconciliation", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    const collected: any = await world.phase("collect");
    const cleaned: any = await world.phase("cleanup", { deleteRef: async () => { world.setRef(null); return { outcome: "ambiguous", exit_code: null }; } });
    expect(cleaned.outcome).toBe("measured");
    expect(world.validate(collected.records["staging-release"], "staging-release")).toBeNull();
  });

  it("refuses cleanup before the terminal run has been collected", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    // Cleanup reconciles the dispatched run itself (R06-F2) and then refuses on what it found: the
    // run is live, so the ref stays. The refusal names a phase that can actually act on it.
    await expect(world.phase("cleanup")).rejects.toThrow(/not terminal; cancel \(or collect\)/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.probeRecords().some((record: any) => record.type === "probe-closed")).toBe(false);
  });

  it("refuses the acceptance when an original protected job was approved before the probe was cleaned", async () => {
    const records = (await world.fullProbe()).records;
    const staged = world.probeRecords().find((record: any) => record.type === "ref-create-intent");
    const approvals = { environments: { "staging-release": { reviewers: [{ ...JOHN, approved_at: staged.ts }] } } };
    expect(world.validate(records["staging-release"], "staging-release", world.trusted({ approvals }))).toMatch(/approved before the probe/);
    const later = { environments: { "staging-release": { reviewers: [{ ...JOHN, approved_at: iso(world.clock + 500) }] } } };
    expect(world.validate(records["staging-release"], "staging-release", world.trusted({ approvals: later }))).toBeNull();
  });
});

describe("the exact-SHA lease deletion through local git (bare-repository fixture)", () => {
  it("deletes only at the expected SHA; a changed ref is refused and left untouched", async () => {
    const deleter = createGitLeaseDeleter({ cwd: world.work, remote: world.bare });
    world.setRef(world.otherSha);
    expect(await deleter({ ref: PROBE_REF, expectedSha: world.sha })).toEqual({ outcome: "lease-refused", exit_code: 1 });
    expect(world.refSha()).toBe(world.otherSha);
    world.setRef(world.sha);
    expect(await deleter({ ref: PROBE_REF, expectedSha: world.sha })).toEqual({ outcome: "deleted", exit_code: 0 });
    expect(world.refSha()).toBeNull();
  });

  it("refuses any other ref and reports an unreachable remote as ambiguous", async () => {
    const deleter = createGitLeaseDeleter({ cwd: world.work, remote: world.bare });
    await expect(deleter({ ref: "refs/heads/staging", expectedSha: world.sha })).rejects.toThrow(/fixed probe ref/);
    const unreachable = createGitLeaseDeleter({ cwd: world.work, remote: path.join(world.root, "missing.git") });
    expect((await unreachable({ ref: PROBE_REF, expectedSha: world.sha })).outcome).toBe("ambiguous");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// E. The request boundary and the closed journal.
// ──────────────────────────────────────────────────────────────────────────────

describe("the probe role at the one request boundary", () => {
  const sha = "a".repeat(40);
  const ctx = { role: "probe", runId: RUN_ID, attempt: ATTEMPT, probeSha: sha, probeRunId: "34100000001", probeCheckIds: new Set(["8000"]) };
  const allowed = (method: string, p: string, body?: unknown, c: any = ctx) => assertAllowedRequest({ method, path: p, body }, c);

  it("admits exactly the fixed probe targets", () => {
    expect(allowed("POST", `/repos/${REPO}/git/refs`, { ref: PROBE_REF, sha })).toBe("create-probe-ref");
    expect(allowed("POST", `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/dispatches`, { ref: PROBE_BRANCH })).toBe("dispatch-probe-workflow");
    expect(allowed("GET", `/repos/${REPO}/actions/runs/34100000001`)).toBe("read-probe-run");
    expect(allowed("GET", `/repos/${REPO}/actions/runs/34100000001/jobs?filter=all&per_page=100&page=2`)).toBe("read-probe-run-jobs");
    expect(allowed("GET", `/repos/${REPO}/check-runs/8000/annotations?per_page=100&page=1`)).toBe("read-probe-check-annotations");
    expect(allowed("GET", `/repos/${REPO}/environments/staging-release/deployment-branch-policies?per_page=100&page=1`)).toBe("list-environment-branch-policies");
    expect(allowed("GET", `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/runs?branch=${PROBE_BRANCH}&event=workflow_dispatch&per_page=100&page=1`)).toBe("list-probe-runs");
    expect(allowed("GET", `/repos/${REPO}/contents/${PROBE_WORKFLOW_PATH}?ref=${sha}`)).toBe("read-probe-workflow-source");
  });

  it("refuses any other ref, SHA, input, run, check, environment, query or role", () => {
    const refusals: Array<[string, string, unknown?, any?]> = [
      ["POST", `/repos/${REPO}/git/refs`, { ref: "refs/heads/staging", sha }],
      ["POST", `/repos/${REPO}/git/refs`, { ref: PROBE_REF, sha: "b".repeat(40) }],
      ["POST", `/repos/${REPO}/git/refs`, { ref: PROBE_REF, sha, force: true }],
      ["POST", `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/dispatches`, { ref: PROBE_BRANCH, inputs: {} }],
      ["POST", `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/dispatches`, { ref: "staging" }],
      ["POST", `/repos/${REPO}/actions/workflows/release-policy-commissioning.yml/dispatches`, { ref: PROBE_BRANCH }],
      ["GET", `/repos/${REPO}/actions/runs/34100000002`],
      ["POST", `/repos/${REPO}/actions/runs/${RUN_ID}/cancel`],
      ["GET", `/repos/${REPO}/check-runs/8001`],
      ["GET", `/repos/${REPO}/environments/production`],
      ["GET", `/repos/${REPO}/actions/runs/34100000001/jobs?per_page=100&page=1`],
      ["GET", `/repos/${REPO}/actions/runs/34100000001/jobs?filter=all&per_page=100&page=11`],
      ["GET", `/repos/${REPO}/actions/workflows/${PROBE_WORKFLOW_FILE}/runs?branch=staging&event=workflow_dispatch&per_page=100&page=1`],
      ["GET", `/repos/${REPO}/contents/${PROBE_WORKFLOW_PATH}?ref=main`],
      ["DELETE", `/repos/${REPO}/git/refs/heads/${PROBE_BRANCH}`],
      ["POST", `/repos/${REPO}/git/refs`, { ref: PROBE_REF, sha }, { ...ctx, role: "local" }],
      ["GET", `/repos/${REPO}/actions/runs/34100000001`, undefined, { ...ctx, role: "normal" }],
    ];
    for (const [method, p, body, c] of refusals) expect(() => allowed(method, p, body, c ?? ctx), `${method} ${p}`).toThrow();
  });

  it("retains raw bytes only when asked, and never retains redactable text", () => {
    const bytes = Buffer.from('{"a": 1}', "utf8");
    expect((completedJsonResponse(200, bytes) as any).raw_text).toBeUndefined();
    expect((completedJsonResponse(200, bytes, createRedactor(), { retainRaw: true }) as any).raw_text).toBe('{"a": 1}');
    const secret = Buffer.from(JSON.stringify({ a: `ghp_${"x".repeat(36)}` }), "utf8");
    expect((completedJsonResponse(200, secret, createRedactor(), { retainRaw: true }) as any).raw_text).toBeNull();
  });

  it("keeps the completion contract: an incomplete answer is status 0 through the guard", async () => {
    const request = createGuardedRequest(async () => incompleteResponse("body-read-failed", 201), ctx);
    const response: any = await request("POST", `/repos/${REPO}/git/refs`, { ref: PROBE_REF, sha });
    expect(response.status).toBe(0);
    expect(response.complete).toBe(false);
  });
});

describe("the probe role's allowlist has no dead surface", () => {
  it("every probe-only operation is issued by some probe lifecycle, and matched role-aware", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const scenario = async (setup: (w: World) => void, phases: string[]) => {
      const local = new World();
      try {
        setup(local);
        local.seedOriginal();
        for (const phase of phases) await local.phase(phase).catch(() => {});
        calls.push(...local.calls);
      } finally { rmSync(local.root, { recursive: true, force: true }); }
    };
    await scenario(() => {}, ["stage", "dispatch", "collect", "cleanup"]);
    await scenario((w) => { w.neverComplete = true; }, ["stage", "dispatch", "collect", "cleanup"]);
    const probeOnly = ALLOWED_OPERATIONS.filter((operation: any) => operation.roles.length === 1 && operation.roles[0] === "probe");
    const exercised = new Set<string>();
    for (const call of calls) {
      const matched = ALLOWED_OPERATIONS.find((operation: any) => operation.roles.includes("probe") && operation.method === call.method
        && (operation.path ? operation.path === call.path.split("?")[0] : operation.pattern.test(call.path.split("?")[0])));
      if (matched) exercised.add(matched.id);
    }
    expect(probeOnly.map((operation: any) => operation.id).filter((id: string) => !exercised.has(id))).toEqual([]);
    expect(probeOnly.length).toBe(13);
  });
});

describe("the probe journal is closed per event", () => {
  it("every event has a fixed payload field list, and the journal refuses anything else", async () => {
    world.seedOriginal();
    await world.phase("stage");
    for (const record of world.probeRecords()) {
      expect(Object.keys(record.data).sort()).toEqual([...(PROBE_JOURNAL_EVENTS as any)[record.type]].sort());
    }
    expect(ENVIRONMENT_CONTROL_SCHEMAS[OFFBRANCH_CONTROL].expected).toEqual(EXPECTED);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// F. R04: durable cuts, run identity, registration evidence and delete recovery.
//
// Each case here reproduces one accepted PC06-R04 finding through the ACTUAL operator entry
// points and the actual offline validator — never a helper called directly. The shared failure
// they cover: lifecycle consumers inferring ownership from a matching partial listing, or from
// the presence/absence of a later event, instead of from durable intent plus verified identity.
// ──────────────────────────────────────────────────────────────────────────────

describe("R04-F1: a run is owned only once its full immutable identity is established", () => {
  it("never selects or cancels a run on the fixed ref that a different dispatcher started", async () => {
    world.seedOriginal();
    world.neverComplete = true;
    await world.phase("stage");
    await world.phase("dispatch");
    // Same workflow, same fixed ref, same event, inside the window — different dispatcher.
    world.runs[0].actor = { id: 12345, login: "someone-else", type: "User" };
    await expect(world.phase("collect")).rejects.toThrow(/not this probe's own run/);
    expect(world.count("POST", "/cancel")).toBe(0);
    expect(world.probeRecords().some((record: any) => record.type === "run-identified")).toBe(false);
  });

  it("never adopts a candidate whose attempt or source moved", async () => {
    for (const [mutate, pattern] of [
      [(w: World) => { w.runs[0].attempt = 2; }, /attempt/],
      // Only the PROBE run's source moves; the original commissioning attempt is untouched, so the
      // refusal has to come from the probe run's own identity rather than from the session opening.
      [(w: World) => {
        const body = w.runBody.bind(w);
        w.runBody = ((entry: any) => ({ ...body(entry), head_sha: w.otherSha })) as any;
      }, /source SHA/],
    ] as Array<[(w: World) => void, RegExp]>) {
      const local = new World();
      try {
        local.seedOriginal();
        local.neverComplete = true;
        await local.phase("stage");
        await local.phase("dispatch");
        mutate(local);
        await expect(local.phase("collect")).rejects.toThrow(pattern);
        expect(local.calls.filter((call) => call.method === "POST" && call.path.endsWith("/cancel"))).toEqual([]);
      } finally { rmSync(local.root, { recursive: true, force: true }); }
    }
  });

  it("re-establishes identity immediately before the deadline cancellation, and refuses if it moved", async () => {
    world.seedOriginal();
    world.neverComplete = true;
    await world.phase("stage");
    await world.phase("dispatch");
    // Ours at selection; somebody else's by the time the deadline wants to cancel it.
    let selected = false;
    const transport = async (method: string, requestPath: string, body?: unknown) => {
      const answer = await world.transport(method, requestPath, body);
      if (method === "GET" && requestPath.includes(`/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`)) selected = true;
      else if (selected) world.runs[0].actor = { id: 12345, login: "someone-else", type: "User" };
      return answer;
    };
    await expect(world.phase("collect", { transport })).rejects.toThrow(/not this probe's own run/);
    expect(world.count("POST", "/cancel")).toBe(0);
  });
});

describe("R04-F2: the durable dispatch intent owns recovery, with or without its result", () => {
  it("blocks cleanup after an interrupted dispatch, then reconciles the live run without re-dispatching", async () => {
    world.seedOriginal();
    await world.phase("stage");
    // The provider applied the dispatch; this process died before it could append the result.
    const transport = async (method: string, requestPath: string, body?: unknown) => {
      const answer = await world.transport(method, requestPath, body);
      if (method === "POST" && requestPath.endsWith("/dispatches")) throw new Error("simulated process interruption after the provider applied the dispatch");
      return answer;
    };
    await expect(world.phase("dispatch", { transport })).rejects.toThrow(/simulated process interruption/);
    const events = world.probeRecords().map((record: any) => record.type);
    expect(events).toContain("dispatch-intent");
    expect(events).not.toContain("dispatch-result");
    expect(world.runs).toHaveLength(1);

    // Cleanup may NOT close over a live run, and must not delete the ref. It reconciles the run
    // from the durable intent itself (R06-F2) rather than deferring to a collection.
    await expect(world.phase("cleanup")).rejects.toThrow(/not terminal; cancel \(or collect\)/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.probeRecords().some((record: any) => record.type === "probe-closed")).toBe(false);
    expect(world.runState(world.runs[0]).status).toBe("queued");

    // Collect reconciles the intent from the run itself. One dispatch, ever.
    const collected: any = await world.phase("collect");
    expect(collected.status).toBe("measured");
    expect(world.count("POST", "/dispatches")).toBe(1);
    const reconciled = world.probeRecords().filter((record: any) => record.type === "reconciliation" && record.data.of === "dispatch-intent");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].data.outcome).toBe("present-unchanged");
    const cleaned: any = await world.phase("cleanup");
    expect(cleaned.outcome).toBe("measured");
    expect(world.refSha()).toBeNull();
    expect(world.validate(collected.records["staging-release"], "staging-release")).toBeNull();
  });

  it("keeps an interrupted dispatch unresolved when the listing cannot prove nonapplication", async () => {
    world.seedOriginal();
    await world.phase("stage");
    const transport = async (method: string, requestPath: string, body?: unknown) => {
      if (method === "POST" && requestPath.endsWith("/dispatches")) { world.calls.push({ method, path: requestPath }); throw new Error("simulated interruption before the provider applied anything"); }
      return world.transport(method, requestPath, body);
    };
    await expect(world.phase("dispatch", { transport })).rejects.toThrow(/simulated interruption/);
    expect(world.runs).toHaveLength(0);
    await expect(world.phase("collect")).rejects.toThrow(/no eligible probe run/);
    const reconciled = world.probeRecords().filter((record: any) => record.type === "reconciliation" && record.data.of === "dispatch-intent");
    expect(reconciled).toHaveLength(0);
    await expect(world.phase("cleanup")).rejects.toThrow(/NOT deleted and the journal is NOT closed/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.count("POST", "/dispatches")).toBe(1);
  });
});

describe("R04-F3: registration is traversed evidence, never a journal assertion", () => {
  it("refuses when the registration descriptor is gone", async () => {
    const collected: any = await world.fullProbe();
    const record = collected.records["staging-release"];
    expect(world.validate(record, "staging-release")).toBeNull();
    const registration = world.probeRecords().find((entry: any) => entry.type === "registration-verified");
    rmSync(path.join(world.dir, registration.data.descriptor.artifact));
    expect(world.validate(record, "staging-release")).toMatch(/registration/);
  });

  it("refuses when the retained registered workflow or source bytes were altered", async () => {
    for (const member of ["workflow", "source"]) {
      const local = new World();
      try {
        const collected: any = await local.fullProbe();
        const registration = local.probeRecords().find((entry: any) => entry.type === "registration-verified");
        const descriptor = JSON.parse(readFileSync(path.join(local.dir, registration.data.descriptor.artifact), "utf8"));
        const target = path.join(local.dir, descriptor[member].artifact);
        const body = JSON.parse(readFileSync(target, "utf8"));
        if (member === "source") body.content = Buffer.from("name: not the reviewed probe workflow\n").toString("base64");
        else body.state = "disabled_manually";
        rmSync(target);
        writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
        expect(local.validate(collected.records["staging-release"], "staging-release")).toMatch(/digest|registered|registration/);
      } finally { rmSync(local.root, { recursive: true, force: true }); }
    }
  });
});

describe("R04-F4: a successful deletion owns the recovery of its own missing readback", () => {
  it("recovers a confirmed-absent ref after a lost absence readback, without a second deletion", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    const collected: any = await world.phase("collect");
    let deleted = false;
    let deletions = 0;
    const deleteRef = async () => { deletions += 1; world.setRef(null); deleted = true; return { outcome: "deleted", exit_code: 0 }; };
    const transport = async (method: string, requestPath: string, body?: unknown) =>
      (deleted && requestPath.startsWith(`/repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`)
        ? incompleteResponse("transport-timeout")
        : world.transport(method, requestPath, body));
    await expect(world.phase("cleanup", { transport, deleteRef })).rejects.toThrow(/absence could not be confirmed/);
    expect(deletions).toBe(1);
    expect(world.refSha()).toBeNull();

    const cleaned: any = await world.phase("cleanup", { deleteRef });
    expect(cleaned.status).toBe("cleaned-after-reconciliation");
    expect(cleaned.outcome).toBe("measured");
    expect(deletions).toBe(1);
    expect(world.probeRecords().some((record: any) => record.type === "probe-closed")).toBe(true);
    expect(world.validate(collected.records["staging-release"], "staging-release")).toBeNull();
  });

  it("still refuses an unowned disappearance and a ref that moved under a recorded deletion", async () => {
    // No deletion this probe recorded: an absent owned ref is a broken ownership history.
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    await world.phase("collect");
    world.setRef(null);
    await expect(world.phase("cleanup")).rejects.toThrow(/disappeared without this probe deleting it/);

    // A recorded deletion whose readback was lost, and the ref now sits at another SHA: refused.
    const local = new World();
    try {
      local.seedOriginal();
      await local.phase("stage");
      await local.phase("dispatch");
      await local.phase("collect");
      let deleted = false;
      const deleteRef = async () => { deleted = true; return { outcome: "deleted", exit_code: 0 }; };
      const transport = async (method: string, requestPath: string, body?: unknown) =>
        (deleted && requestPath.startsWith(`/repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`)
          ? incompleteResponse("transport-timeout")
          : local.transport(method, requestPath, body));
      await expect(local.phase("cleanup", { transport, deleteRef })).rejects.toThrow(/absence could not be confirmed/);
      local.setRef(local.otherSha);
      await expect(local.phase("cleanup")).rejects.toThrow(/never deleted/);
      expect(local.refSha()).toBe(local.otherSha);
    } finally { rmSync(local.root, { recursive: true, force: true }); }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// R05. Authority and acceptance derive from the ACCUMULATED history, never the newest record.
// ──────────────────────────────────────────────────────────────────────────────

/** A cleanup deletion that succeeds locally but whose absence readback is then lost. */
const losingDeleter = (target: World, deletions: { count: number }) => async () => {
  deletions.count += 1;
  target.setRef(null);
  target.lose[`GET /repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`] = "lost-unapplied";
  return { outcome: "deleted", exit_code: 0 };
};

describe("R05-F1: a successful deletion ends that creation's ownership irreversibly", () => {
  it("never issues a second deletion against a same-SHA ref recreated after a confirmed deletion, however often cleanup is retried", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    const collected: any = await world.phase("collect");
    const deletions = { count: 0 };
    await expect(world.phase("cleanup", { deleteRef: losingDeleter(world, deletions) })).rejects.toThrow(/absence could not be confirmed/);
    expect(deletions.count).toBe(1);

    // Another creator now owns a ref at the same bytes. Equal bytes are not a continuous resource.
    world.setRef(world.sha);
    await expect(world.phase("cleanup")).rejects.toThrow(/no second deletion/);
    // ...and the reconciliation that refusal recorded is a FACT, never a later permission: every
    // further invocation, in this process or a fresh one, derives the same refusal.
    for (let retry = 0; retry < 3; retry += 1) {
      await expect(world.phase("cleanup", { deleteRef: losingDeleter(world, deletions) })).rejects.toThrow(/no second deletion/);
    }
    expect(deletions.count).toBe(1);
    expect(world.refSha()).toBe(world.sha);
    expect(world.probeRecords().some((record: any) => record.type === "probe-closed")).toBe(false);
    // And the measurement that lifecycle produced is not accepted offline.
    expect(world.validate(collected.records["staging-release"], "staging-release")).toMatch(/does not support acceptance \(a deletion this probe recorded as successful/);
  });

  it("does not revive a changed ref that is put back at the reviewed SHA", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    const collected: any = await world.phase("collect");
    world.setRef(world.otherSha);
    await expect(world.phase("cleanup")).rejects.toThrow(/did not create/);

    // Restored to the exact bytes this probe created — and still not this probe's ref.
    world.setRef(world.sha);
    let deletions = 0;
    await expect(world.phase("cleanup", { deleteRef: async () => { deletions += 1; world.setRef(null); return { outcome: "deleted", exit_code: 0 }; } }))
      .rejects.toThrow(/points at a SHA this probe did not create/);
    expect(deletions).toBe(0);
    expect(world.refSha()).toBe(world.sha);
    expect(world.validate(collected.records["staging-release"], "staging-release")).toMatch(/does not support acceptance \(the owned probe ref points at a SHA/);
  });

  it("refuses a ref that comes back after an absence this probe never explained", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    await world.phase("collect");
    world.setRef(null);
    await expect(world.phase("cleanup")).rejects.toThrow(/disappeared without this probe deleting it/);
    world.setRef(world.sha);
    let deletions = 0;
    await expect(world.phase("cleanup", { deleteRef: async () => { deletions += 1; return { outcome: "deleted", exit_code: 0 }; } }))
      .rejects.toThrow(/disappeared without this probe deleting it|does not authorise/);
    expect(deletions).toBe(0);
    expect(world.refSha()).toBe(world.sha);
  });

  it("derives the same states from the journal alone, so a fresh process reaches the same answer", () => {
    const sha = "a".repeat(40);
    const facts = (status: number) => ({ http_status: status, response_complete: true, response_incomplete: null, measured_status: status });
    const record = (seq: number, type: string, data: unknown) => ({ seq, type, data });
    const created = [record(1, "ref-create-result", { ref: PROBE_REF, sha, ...facts(201), object_sha: sha })];
    expect(assessRefOwnership(created, { workflowSha: sha }).may_delete).toBe(true);
    const deleted = [...created,
      record(2, "cleanup-intent", { ref: PROBE_REF, expected_sha: sha }),
      record(3, "cleanup-result", { ref: PROBE_REF, expected_sha: sha, outcome: "deleted", exit_code: 0 })];
    // A successful deletion plus a confirmed absence: accepted, and never deletable again.
    const confirmed = assessRefOwnership([...deleted, record(4, "absence-verified", { ref: PROBE_REF, ...facts(404), measured_at: "2026-09-21T12:00:00Z" })], { workflowSha: sha });
    expect([confirmed.state, confirmed.may_accept, confirmed.may_delete]).toEqual(["ended", true, false]);
    // The same deletion plus a later presence at the same bytes: terminal, and never acceptable.
    const contradicted = assessRefOwnership([...deleted, record(4, "reconciliation", { of: "cleanup-intent", outcome: "present-unchanged", object_sha: sha, measured_at: "2026-09-21T12:00:00Z" })], { workflowSha: sha });
    expect([contradicted.state, contradicted.may_accept, contradicted.may_delete]).toEqual(["uncertain", false, false]);
    // ...and no later record walks that back.
    const restored = assessRefOwnership([
      ...deleted,
      record(4, "reconciliation", { of: "cleanup-intent", outcome: "present-unchanged", object_sha: sha, measured_at: "2026-09-21T12:00:00Z" }),
      record(5, "absence-verified", { ref: PROBE_REF, ...facts(404), measured_at: "2026-09-21T12:01:00Z" }),
    ], { workflowSha: sha });
    expect([restored.state, restored.may_accept]).toEqual(["uncertain", false]);
  });

  it("still recovers the legitimate lost-absence and explicitly-unapplied paths (positive controls)", async () => {
    // A confirmed absence after a lost readback closes measured, with no second deletion.
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    const collected: any = await world.phase("collect");
    let deletions = 0;
    const deleteRef = async () => { deletions += 1; world.setRef(null); return { outcome: "deleted", exit_code: 0 }; };
    let deleted = false;
    const transport = async (method: string, requestPath: string, body?: unknown) => {
      if (deleted && requestPath.startsWith(`/repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`)) return incompleteResponse("transport-timeout");
      return world.transport(method, requestPath, body);
    };
    await expect(world.phase("cleanup", { transport, deleteRef: async () => { deleted = true; return deleteRef(); } })).rejects.toThrow(/absence could not be confirmed/);
    const cleaned: any = await world.phase("cleanup", { deleteRef });
    expect([cleaned.status, cleaned.outcome, deletions]).toEqual(["cleaned-after-reconciliation", "measured", 1]);
    expect(world.validate(collected.records["staging-release"], "staging-release")).toBeNull();

    // An ambiguous deletion that the ref itself LATER shows to be absent is still a positive
    // recovery: that absence is an observation about this very ref, and it decides the deletion
    // applied. (What is NOT a positive recovery — and used to be asserted here as one — is an
    // ambiguous deletion plus a ref still present at the same SHA: see the two refusal regressions
    // in the lifecycle-ownership suite. R06.)
    const local = new World();
    try {
      local.seedOriginal();
      await local.phase("stage");
      await local.phase("dispatch");
      const localCollected: any = await local.phase("collect");
      let localDeletions = 0;
      const lostAnswer = async () => { localDeletions += 1; local.setRef(null); return { outcome: "ambiguous", exit_code: null }; };
      const reconciled: any = await local.phase("cleanup", { deleteRef: lostAnswer });
      expect([reconciled.outcome, localDeletions, local.refSha()]).toEqual(["measured", 1, null]);
      expect(local.validate(localCollected.records["staging-emergency"], "staging-emergency")).toBeNull();
    } finally { rmSync(local.root, { recursive: true, force: true }); }
  });
});

describe("R05-F2: an observed staging move is kept, and interrupts measurement for good", () => {
  /** Only the source-continuity read reports the other commit; every other read is untouched. */
  const drifting = (target: World) => async (method: string, requestPath: string, body?: unknown) => {
    if (requestPath === `/repos/${REPO}/git/ref/heads/staging`) {
      return completedJsonResponse(200, Buffer.from(JSON.stringify({ ref: "refs/heads/staging", object: { sha: target.otherSha, type: "commit" } })), createRedactor(), { retainRaw: true });
    }
    return target.transport(method, requestPath, body);
  };

  it("refuses a collection that measured the source elsewhere, and keeps refusing once the head is restored", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    await expect(world.phase("collect", { transport: drifting(world) })).rejects.toThrow(/interrupted/);
    expect(world.probeRecords().some((record: any) => record.type === SOURCE_OBSERVED_EVENT && record.data.moved === true)).toBe(true);
    // Nothing was measured, and no observation was written.
    expect(world.probeRecords().some((record: any) => record.type === "observation-recorded")).toBe(false);
    expect(readdirSync(world.dir).includes(probeObservationName(RUN_ID, ATTEMPT, "staging-release"))).toBe(false);

    // Staging is back at the trusted source, and a fresh process still refuses: the interruption is
    // a durable fact of this attempt, not a condition of the moment.
    await expect(world.phase("collect")).rejects.toThrow(/interrupted/);
    expect(world.count("POST", "/dispatches")).toBe(1);
  });

  it("still cancels the owned run and still cleans up, closing inconclusive rather than measured", async () => {
    world.seedOriginal();
    world.neverComplete = true;
    await world.phase("stage");
    await world.phase("dispatch");
    await expect(world.phase("collect")).rejects.toThrow(/cancelled/);

    // The move is observed from here on. Cancelling this probe's own run is still allowed.
    const cancelled: any = await world.phase("cancel", { transport: drifting(world) });
    expect(cancelled.status).toBe("terminal-aborted");
    // ...and so is removing what this run created: the remedy is never the casualty.
    const cleaned: any = await world.phase("cleanup", { transport: drifting(world) });
    expect(cleaned.outcome).toBe("inconclusive");
    expect(world.refSha()).toBeNull();
    expect(world.probeRecords().filter((record: any) => record.type === SOURCE_OBSERVED_EVENT && record.data.moved === true).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses to launder a clean collection into acceptance when cleanup measured the move", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    const collected: any = await world.phase("collect");
    expect(collected.status).toBe("measured");

    // The move is first measured at cleanup. The owned ref still goes — and the close does not
    // claim a measurement taken across a source this attempt is no longer bound to.
    const cleaned: any = await world.phase("cleanup", { transport: drifting(world) });
    expect(cleaned.outcome).toBe("inconclusive");
    expect(world.refSha()).toBeNull();
    expect(world.validate(collected.records["staging-release"], "staging-release")).toMatch(/interrupted|not closed as a measured probe/);
    expect(world.validate(collected.records["staging-emergency"], "staging-emergency")).not.toBeNull();
  });

  it("records the measured source in every phase, and offline acceptance needs the collection's own observation", async () => {
    const collected: any = await world.fullProbe();
    const observed = world.probeRecords().filter((record: any) => record.type === SOURCE_OBSERVED_EVENT);
    expect(observed.map((record: any) => record.data.phase)).toEqual(["stage", "dispatch", "collect", "cleanup"]);
    for (const record of observed) {
      expect(record.data).toEqual({
        phase: record.data.phase, mode: record.data.phase === "collect" || record.data.phase === "cleanup" ? "observe" : "enforce",
        moved: false, staging_sha: world.sha, trusted_source_sha: world.sha, measured_at: record.data.measured_at,
      });
    }
    expect(world.validate(collected.records["staging-release"], "staging-release")).toBeNull();
  });
});

/**
 * ── R06: QUALIFICATION, RUN AUTHORITY AND REF AUTHORITY ARE THREE SEPARATE THINGS ───────────────
 *
 * Every case here runs through the public `runProbePhase`, the real hash-chained journals and the
 * real offline validator, against the fake provider and a throwaway local bare repository.
 *
 *  - Q (qualification) is permanently lost by a measured source move, at ANY phase, and restoring
 *    staging or starting a fresh process never gives it back.
 *  - U (run authority) survives that loss: the exact run this probe's own dispatch created can
 *    still be authenticated, cancelled and confirmed terminal — under its ORIGINAL bounds.
 *  - R (ref authority) is its own chain: a measured disappearance ends it whatever event carried
 *    the observation, and an undecided deletion is never decided by a ref sitting at equal bytes.
 */
describe("R06: separated qualification, run authority and ref authority", () => {
  /** Only the source-continuity read reports the other commit; every other read is untouched. */
  const drifting = (target: World) => async (method: string, requestPath: string, body?: unknown) => {
    if (requestPath === `/repos/${REPO}/git/ref/heads/staging`) {
      return completedJsonResponse(200, Buffer.from(JSON.stringify({ ref: "refs/heads/staging", object: { sha: target.otherSha, type: "commit" } })), createRedactor(), { retainRaw: true });
    }
    return target.transport(method, requestPath, body);
  };

  describe("R06-F1: every COMPLETE ref observation ends ownership, whatever the event is called", () => {
    it("refuses to delete a same-SHA recreation after the post-create readback measured a complete 404", async () => {
      world.seedOriginal();
      await world.phase("stage");
      let created = false;
      const transport = async (method: string, requestPath: string, body?: unknown) => {
        if (method === "GET" && created && requestPath === `/repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`) {
          world.setRef(null); // it disappeared between the create and its readback, and we SAW that.
          created = false;
        }
        const answer = await world.transport(method, requestPath, body);
        if (method === "POST" && requestPath.endsWith("/git/refs")) created = true;
        return answer;
      };
      await expect(world.phase("dispatch", { transport })).rejects.toThrow(/could not be read back/);
      const readback = world.probeRecords().filter((record: any) => record.type === "ref-readback");
      expect(readback.map((record: any) => [record.data.response_complete, record.data.http_status])).toEqual([[true, 404]]);
      expect(world.count("POST", "/dispatches")).toBe(0);

      // Somebody else puts a ref back at exactly the reviewed bytes. It is NOT this probe's ref.
      world.setRef(world.sha);
      let deletions = 0;
      const deleteRef = async () => { deletions += 1; world.setRef(null); return { outcome: "deleted", exit_code: 0 }; };
      await expect(world.phase("cleanup", { deleteRef })).rejects.toThrow(/disappeared without this probe deleting it/);
      await expect(world.phase("cleanup", { deleteRef })).rejects.toThrow(/disappeared without this probe deleting it/);
      expect([deletions, world.refSha()]).toEqual([0, world.sha]);
      const ownership = assessRefOwnership(world.probeRecords(), { workflowSha: world.sha });
      expect([ownership.state, ownership.may_delete, ownership.may_accept]).toEqual(["uncertain", false, false]);
    });

    it("keeps recoverable ownership when the same readback is merely INCOMPLETE", async () => {
      world.seedOriginal();
      await world.phase("stage");
      let created = false;
      const transport = async (method: string, requestPath: string, body?: unknown) => {
        if (method === "GET" && created && requestPath === `/repos/${REPO}/git/ref/heads/${PROBE_BRANCH}`) {
          created = false;
          return incompleteResponse("transport-timeout");
        }
        const answer = await world.transport(method, requestPath, body);
        if (method === "POST" && requestPath.endsWith("/git/refs")) created = true;
        return answer;
      };
      await expect(world.phase("dispatch", { transport })).rejects.toThrow(/could not be read back/);
      // An unanswered read is not an observation of absence: the created ref is still ours to remove.
      expect(assessRefOwnership(world.probeRecords(), { workflowSha: world.sha }).may_delete).toBe(true);
      let deletions = 0;
      const cleaned: any = await world.phase("cleanup", { deleteRef: async () => { deletions += 1; world.setRef(null); return { outcome: "deleted", exit_code: 0 }; } });
      expect([cleaned.outcome, deletions, world.refSha()]).toEqual(["inconclusive", 1, null]);
    });

    it("derives R06's ref rules from the journal alone, so a fresh process agrees", () => {
      const sha = "a".repeat(40);
      const facts = (status: number) => ({ http_status: status, response_complete: true, response_incomplete: null, measured_status: status });
      const record = (seq: number, type: string, data: unknown) => ({ seq, type, data });
      const created = [record(1, "ref-create-result", { ref: PROBE_REF, sha, ...facts(201), object_sha: sha })];
      // A complete 404 under `ref-readback` is the same disappearance as one under `absence-verified`.
      const vanished = assessRefOwnership([...created, record(2, "ref-readback", { ref: PROBE_REF, ...facts(404), object_sha: null, measured_at: "2026-09-21T12:00:00Z" })], { workflowSha: sha });
      expect([vanished.state, vanished.may_delete, vanished.may_accept]).toEqual(["uncertain", false, false]);
      // An INCOMPLETE read of the same thing decides nothing at all.
      const unread = assessRefOwnership([...created, record(2, "ref-readback", { ref: PROBE_REF, http_status: 0, response_complete: false, response_incomplete: "transport-timeout", measured_status: null, object_sha: null, measured_at: "2026-09-21T12:00:00Z" })], { workflowSha: sha });
      expect([unread.state, unread.may_delete]).toEqual(["owned", true]);
      // An ambiguous deletion plus the ref still at the reviewed bytes: undecided, and NOT deletable.
      const undecided = [...created,
        record(2, "cleanup-intent", { ref: PROBE_REF, expected_sha: sha }),
        record(3, "cleanup-result", { ref: PROBE_REF, expected_sha: sha, outcome: "ambiguous", exit_code: 128 }),
        record(4, "reconciliation", { of: "cleanup-intent", outcome: "present-unchanged", object_sha: sha, measured_at: "2026-09-21T12:00:00Z" })];
      const stillUndecided = assessRefOwnership(undecided, { workflowSha: sha });
      expect([stillUndecided.state, stillUndecided.may_delete, stillUndecided.may_accept]).toEqual(["owned", false, false]);
      // Repeating the observation does not wear the refusal down.
      const repeated = assessRefOwnership([...undecided, record(5, "reconciliation", { of: "cleanup-intent", outcome: "present-unchanged", object_sha: sha, measured_at: "2026-09-21T12:05:00Z" })], { workflowSha: sha });
      expect(repeated.may_delete).toBe(false);
      // An EXACT ABSENCE is an observation about this ref, and it does decide it — applied.
      const settled = assessRefOwnership([...undecided, record(5, "absence-verified", { ref: PROBE_REF, ...facts(404), measured_at: "2026-09-21T12:05:00Z" })], { workflowSha: sha });
      expect([settled.state, settled.may_accept, settled.may_delete]).toEqual(["ended", true, false]);
    });
  });

  describe("R06-F2: an interrupted attempt can still be recovered from, under its original bounds", () => {
    it("identifies, cancels and confirms the exact owned run after the FIRST collection was interrupted", async () => {
      world.seedOriginal();
      world.neverComplete = true;
      await world.phase("stage");
      await world.phase("dispatch");

      // The move is measured at the first collection boundary, before any run was ever identified.
      await expect(world.phase("collect", { transport: drifting(world) })).rejects.toThrow(/interrupted/);
      expect(world.probeRecords().some((record: any) => record.type === "run-identified")).toBe(false);
      expect(world.runState(world.runs[0]).status).toBe("queued");

      // Staging is back, and the attempt is still disqualified — but its own run is still its own.
      const cancelled: any = await world.phase("cancel");
      expect(cancelled.status).toBe("cancelled");
      const events = world.probeRecords().map((record: any) => record.type);
      expect(events).toContain("run-identified");
      expect(events).toContain("run-terminal");
      expect([world.count("POST", "/cancel"), world.count("POST", "/dispatches")]).toEqual([1, 1]);

      // And the ref this run created goes, with the close honestly inconclusive.
      const cleaned: any = await world.phase("cleanup");
      expect([cleaned.outcome, world.refSha()]).toEqual(["inconclusive", null]);
      expect(assessSourceContinuity(world.probeRecords() as any).interrupted).toBe(true);
      // A later collection is still refused: cleaning up is not qualifying.
      await expect(world.phase("collect")).rejects.toThrow(/already-closed|interrupted|closed/);
    });

    it("cleans up after an interruption even when the owned run reached a terminal state by itself", async () => {
      world.seedOriginal();
      await world.phase("stage");
      await world.phase("dispatch");
      await expect(world.phase("collect", { transport: drifting(world) })).rejects.toThrow(/interrupted/);
      world.clock += 60_000; // the run finishes on its own while the attempt is interrupted
      // No cancellation is aimed at a run that has already finished: it is reconciled as terminal.
      const cancelled: any = await world.phase("cancel");
      expect(cancelled.status).toBe("terminal-aborted");
      expect(world.count("POST", "/cancel")).toBe(0);
      const terminal = world.probeRecords().find((record: any) => record.type === "run-terminal");
      expect(terminal.data.status).toBe("completed");
      const cleaned: any = await world.phase("cleanup");
      expect([cleaned.outcome, world.refSha()]).toEqual(["inconclusive", null]);
    });

    /**
     * ZERO, DUPLICATE AND FOREIGN CANDIDATES ARE BLOCKED THROUGH **BOTH** RECOVERY PHASES.
     *
     * The recovery primitive cannot pick one of an unresolved set — but refusing only the selection
     * is not enough. If cleanup then went ahead, it would delete the ref out from under a run that
     * may still be live and file the probe as though the question had been settled. So a run set
     * nobody resolved blocks the deletion AND the close, and the evidence stays for root
     * reconciliation. No cancellation is issued in any of these shapes.
     */
    const blockedCandidates: Array<{ shape: string; arrange: (w: World) => void; cancel: RegExp; cleanup: RegExp; unidentified: boolean }> = [
      {
        shape: "duplicate", arrange: (w) => { w.runsPerDispatch = 2; },
        cancel: /eligible probe runs/, cleanup: /eligible probe runs/, unidentified: false,
      },
      {
        shape: "zero", arrange: (w) => { w.runsPerDispatch = 0; },
        cancel: /no eligible probe run appeared by the deadline/, cleanup: /NOT deleted and the journal is NOT closed/, unidentified: true,
      },
      // Foreign: a run on the fixed ref that some other dispatcher started. Selection refuses ON the
      // foreign identity itself — it does not quietly become "no eligible run" — so this one never
      // even reaches the unresolved-set rule, and every phase keeps refusing for the same reason.
      {
        shape: "foreign",
        arrange: (w) => {
          const body = w.runBody.bind(w);
          w.runBody = ((entry: any) => ({ ...body(entry), triggering_actor: { id: 999, login: "someone-else", type: "User" } })) as any;
        },
        cancel: /is not this probe's own run .*nothing is selected and nothing is cancelled/s,
        cleanup: /is not this probe's own run .*nothing is selected and nothing is cancelled/s,
        unidentified: false,
      },
    ];

    for (const { shape, arrange, cancel: cancelRefusal, cleanup: cleanupRefusal, unidentified } of blockedCandidates) {
      it(`blocks ${shape} candidates through cancel AND cleanup, deleting nothing and closing nothing`, async () => {
        const local = new World();
        try {
          local.seedOriginal();
          local.neverComplete = true;
          arrange(local);
          await local.phase("stage");
          await local.phase("dispatch");
          await expect(local.phase("collect", { transport: drifting(local) })).rejects.toThrow(/interrupted/);
          local.clock += 11 * 60_000; // past the ORIGINAL deadline, which no new invocation extends

          // CANCEL: no exact ownership, so no cancellation — the ambiguity is preserved, not resolved.
          await expect(local.phase("cancel")).rejects.toThrow(cancelRefusal);
          expect(local.count("POST", "/cancel")).toBe(0);

          // CLEANUP: no closure over a run nobody resolved, and the owned ref is left in place.
          let deletions = 0;
          const deleteRef = async () => { deletions += 1; local.setRef(null); return { outcome: "deleted", exit_code: 0 }; };
          await expect(local.phase("cleanup", { deleteRef })).rejects.toThrow(cleanupRefusal);
          expect([deletions, local.refSha()]).toEqual([0, local.sha]);
          expect(local.probeRecords().some((record: any) => record.type === "probe-closed")).toBe(false);
          expect(local.probeRecords().some((record: any) => record.type === "cleanup-intent")).toBe(false);

          // A second attempt re-derives the same refusal; repetition is not a way through.
          await expect(local.phase("cleanup", { deleteRef })).rejects.toThrow(cleanupRefusal);
          expect([deletions, local.count("POST", "/cancel"), local.refSha()]).toEqual([0, 0, local.sha]);
          // Whatever the candidate set was, it stays on the record for root reconciliation.
          expect(local.probeRecords().some((record: any) => record.type === "run-unidentified")).toBe(unidentified);
        } finally { rmSync(local.root, { recursive: true, force: true }); }
      });
    }


    it("does not hand a restarted process a fresh cancellation-confirmation budget", async () => {
      world.seedOriginal();
      world.neverComplete = true;
      world.terminalOnCancel = false;
      await world.phase("stage");
      await world.phase("dispatch");
      await expect(world.phase("collect")).rejects.toThrow(/cleanup is BLOCKED/);
      const afterFirst = world.clock;
      // A second explicit cancel re-confirms against the FIRST cancellation's own two minutes, which
      // have already run out — it does not wait another two, and it issues no second request.
      await expect(world.phase("cancel")).rejects.toThrow(/BLOCKED/);
      expect(world.count("POST", "/cancel")).toBe(1);
      expect(world.clock - afterFirst).toBeLessThan(120_000);
      expect(world.refSha()).toBe(world.sha);
    });
  });

  describe("R06-F3: a measured move is written down before the phase refuses", () => {
    it("keeps a dispatch-time move, and the restored head never revives the attempt", async () => {
      world.seedOriginal();
      await world.phase("stage");
      await expect(world.phase("dispatch", { transport: drifting(world) })).rejects.toThrow(/interrupted/);
      const moved = world.probeRecords().filter((record: any) => record.type === SOURCE_OBSERVED_EVENT && record.data.moved === true);
      expect(moved.map((record: any) => [record.data.phase, record.data.mode])).toEqual([["dispatch", "enforce"]]);
      // Nothing was created and nothing was dispatched at the moved source.
      expect([world.count("POST", "/git/refs"), world.count("POST", "/dispatches"), world.refSha()]).toEqual([0, 0, null]);

      // Staging is back. The attempt is still interrupted, because it is the HISTORY that refuses.
      await expect(world.phase("dispatch")).rejects.toThrow(/interrupted/);
      await expect(world.phase("collect")).rejects.toThrow(/interrupted/);
      expect([world.count("POST", "/git/refs"), world.count("POST", "/dispatches")]).toEqual([0, 0]);
      // No observation exists to be accepted, and the probe closes owning nothing.
      expect(world.probeRecords().some((record: any) => record.type === "observation-recorded")).toBe(false);
      const cleaned: any = await world.phase("cleanup");
      expect(cleaned.status).toBe("nothing-owned");
      const closed = world.probeRecords().find((record: any) => record.type === "probe-closed");
      expect(closed.data.outcome).toBe("inconclusive");
    });

    it("keeps a stage-time move in the original attempt's own journal, and staging again refuses", async () => {
      world.seedOriginal();
      await expect(world.phase("stage", { transport: drifting(world) })).rejects.toThrow(/interrupted/);
      const resource = readJournal({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT });
      const moved = resource.filter((record: any) => record.type === SOURCE_OBSERVED_EVENT && record.data.moved === true);
      expect(moved.map((record: any) => record.data.phase)).toEqual(["stage"]);
      // Nothing was staged: no probe intent, no link into the original journal, no probe journal.
      expect(resource.some((record: any) => record.type === "probe-staged")).toBe(false);
      expect(readdirSync(world.dir).includes(probeIntentName(RUN_ID, ATTEMPT))).toBe(false);
      expect(world.probeRecords()).toHaveLength(0);

      // Restored staging, fresh process — the recorded move is what answers.
      await expect(world.phase("stage")).rejects.toThrow(/interrupted/);
      expect(readdirSync(world.dir).includes(probeIntentName(RUN_ID, ATTEMPT))).toBe(false);
    });

    it("refuses a later non-moved observation appended to launder an interrupted history", async () => {
      world.seedOriginal();
      await world.phase("stage");
      await world.phase("dispatch");
      const collected: any = await world.phase("collect");
      const cleaned: any = await world.phase("cleanup", { transport: drifting(world) });
      expect(cleaned.outcome).toBe("inconclusive");
      // The valid paired observation is a real one — what it lacks is a qualifying attempt.
      expect(world.validate(collected.records["staging-release"], "staging-release")).toMatch(/interrupted|not closed as a measured probe/);
    });

    it("accepts the complete normal paired lifecycle unchanged", async () => {
      const collected: any = await world.fullProbe();
      for (const spec of PROBE_JOBS) expect(world.validate(collected.records[spec.environment], spec.environment)).toBeNull();
      const observed = world.probeRecords().filter((record: any) => record.type === SOURCE_OBSERVED_EVENT);
      expect(observed.map((record: any) => record.data.phase)).toEqual(["stage", "dispatch", "collect", "cleanup"]);
    });
  });
});


describe("R07: observable mutation uncertainty and current cleanup authority", () => {
  for (const applied of [false, true]) for (const response of ["missing", "500"]) {
    it(`keeps ${response} dispatch unknown with empty listing in hidden applied=${applied} world`, async () => {
      world.seedOriginal(); world.neverComplete = true;
      await world.phase("stage");
      const transport = async (method: string, requestPath: string, body?: unknown) => {
        if (method === "POST" && requestPath.endsWith("/dispatches")) {
          if (applied) await world.transport(method, requestPath, body);
          else world.calls.push({ method, path: requestPath });
          if (response === "missing") throw new Error("simulated dispatch interruption");
          return completedJsonResponse(500, Buffer.from('{"message":"server error"}'), createRedactor(), { retainRaw: true });
        }
        if (method === "GET" && requestPath.includes(`/actions/workflows/${PROBE_WORKFLOW_FILE}/runs`)) {
          return completedJsonResponse(200, Buffer.from('{"total_count":0,"workflow_runs":[]}'), createRedactor(), { retainRaw: true });
        }
        return world.transport(method, requestPath, body);
      };
      await expect(world.phase("dispatch", { transport })).rejects.toThrow(/interruption|effect is unknown/);
      const deadline = world.probeRecords().find((r: any) => r.type === "dispatch-intent").data.deadline_at;
      let deletes = 0;
      const deleteRef = async () => { deletes++; return { outcome: "deleted", exit_code: 0 }; };
      await expect(world.phase("cancel", { transport })).rejects.toThrow(/no eligible probe run/);
      await expect(world.phase("cleanup", { transport, deleteRef })).rejects.toThrow(/NOT deleted and the journal is NOT closed/);
      await expect(world.phase("cancel", { transport })).rejects.toThrow(/unidentifiable/);
      await expect(world.phase("dispatch", { transport })).rejects.toThrow(/never re-issued/);
      expect([deletes, world.count("POST", "/cancel"), world.count("POST", "/dispatches")]).toEqual([0, 0, 1]);
      expect(world.refSha()).toBe(world.sha);
      expect(world.probeRecords().some((r: any) => r.type === "probe-closed")).toBe(false);
      expect(world.probeRecords().find((r: any) => r.type === "dispatch-intent").data.deadline_at).toBe(deadline);
      expect(world.runs.length).toBe(applied ? 1 : 0);
    });
  }

  for (const changed of [false, true]) {
    it(`retains immediate post-delete presence (changed=${changed}) permanently through later absence`, async () => {
      world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch");
      const collected: any = await world.phase("collect");
      let deletes = 0;
      const deleteRef = async () => { deletes++; world.setRef(null); world.setRef(changed ? world.otherSha : world.sha); return { outcome: "deleted", exit_code: 0 }; };
      await expect(world.phase("cleanup", { deleteRef })).rejects.toThrow(/inconsistent|points elsewhere|SHA this probe did not create/);
      expect(world.probeRecords().some((r: any) => r.type === "ref-readback" && r.data.http_status === 200
        && r.seq > world.probeRecords().find((e: any) => e.type === "cleanup-result").seq)).toBe(true);
      world.setRef(null);
      await expect(world.phase("cleanup", { deleteRef })).rejects.toThrow(/inconsistent|points elsewhere|SHA this probe did not create/);
      expect(deletes).toBe(1);
      for (const environment of ["staging-release", "staging-emergency"]) expect(world.validate(collected.records[environment], environment)).not.toBeNull();
    });
  }

  for (const boundary of ["cancel", "cleanup"]) for (const change of ["attempt", "state", "actor"]) {
    it(`retains ${change} contradiction at cached-terminal ${boundary}, even after restoration`, async () => {
      world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch");
      const collected: any = await world.phase("collect");
      if (change === "attempt") world.runs[0].attempt = 2;
      if (change === "state") world.neverComplete = true;
      if (change === "actor") world.runs[0].actor = { id: 3, login: "foreign", type: "User" };
      let deletes = 0;
      const deleteRef = async () => { deletes++; return { outcome: "deleted", exit_code: 0 }; };
      await expect(world.phase(boundary, { deleteRef })).rejects.toThrow(/attempt|contradicts|not this probe's own run/);
      world.runs[0].attempt = 1; world.neverComplete = false; world.runs[0].actor = { ...JOHN };
      await expect(world.phase("cleanup", { deleteRef })).rejects.toThrow(/attempt|contradicts|actor/);
      expect([deletes, world.count("POST", "/cancel")]).toEqual([0, 0]);
      expect(world.refSha()).toBe(world.sha);
      for (const environment of ["staging-release", "staging-emergency"]) expect(world.validate(collected.records[environment], environment)).not.toBeNull();
    });
  }

  it("refreshes run identity after the ref GET, before deletion, and again before final closure", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch"); await world.phase("collect");
    let deletes = 0;
    const transport = async (method: string, requestPath: string, body?: unknown) => {
      const result = await world.transport(method, requestPath, body);
      if (method === "GET" && requestPath.includes(`/git/ref/heads/${PROBE_BRANCH}`)) world.runs[0].attempt = 2;
      return result;
    };
    await expect(world.phase("cleanup", { transport, deleteRef: async () => { deletes++; } })).rejects.toThrow(/attempt/);
    expect(deletes).toBe(0);
  });

  it("blocks closure when the provider reruns during the owned deletion", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch"); const collected: any = await world.phase("collect");
    await expect(world.phase("cleanup", { deleteRef: async () => {
      world.setRef(null); world.runs[0].attempt = 2; return { outcome: "deleted", exit_code: 0 };
    } })).rejects.toThrow(/attempt/);
    expect(world.probeRecords().some((r: any) => r.type === "probe-closed")).toBe(false);
    expect(world.validate(collected.records["staging-release"], "staging-release")).toMatch(/attempt/);
  });
});

describe("R07: explicit public probe lock recovery", () => {
  const recover = (extra: any = {}) => recoverJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", ownerGone: true, now: world.now, reconcile: async () => ({ reconciled: true }), ...extra });
  const abandoned = () => {
    // A real child owns the lock, then exits without release. Its synchronous exit verifies the
    // owner is gone; no elapsed-time heuristic or manual lock deletion participates in recovery.
    const modulePath = path.join(__dirname, "../scripts/staging-ops/commissioning-journal.mjs");
    const script = `import { acquireJournalLock } from ${JSON.stringify(modulePath)};
      const lock = acquireJournalLock(${JSON.stringify({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe" })});
      process.stdout.write(JSON.stringify(lock)); process.exit(0);`;
    const owner = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
    expect(() => process.kill(owner.pid, 0)).toThrow();
    return owner;
  };

  it("recovers stage→cleanup and repeated recovery without adopting resources", async () => {
    world.seedOriginal(); await world.phase("stage");
    for (let i = 0; i < 2; i++) {
      abandoned(); const restored = await recover();
      expect(restored.journal.read().at(-1).type).toBe("lock-recovered"); restored.lock.release();
    }
    expect((await world.phase("cleanup") as any).status).toBe("nothing-owned");
  });

  it("reconciles create, dispatch and cancel across recovery before public cancel→cleanup", async () => {
    world.seedOriginal(); world.neverComplete = true;
    await world.phase("stage"); await world.phase("dispatch");
    const transport = async (method: string, requestPath: string, body?: unknown) => {
      const response = await world.transport(method, requestPath, body);
      if (method === "POST" && requestPath.endsWith("/cancel")) throw new Error("interrupted cancel result");
      return response;
    };
    await expect(world.phase("cancel", { transport })).rejects.toThrow(/interrupted cancel/);
    abandoned(); const seen: any[] = [];
    const restored = await recover({ reconcile: async (intent: any) => { seen.push(intent); return { reconciled: true }; } });
    expect(seen.map((i) => i.kind_of_intent)).toEqual(["ref-create-intent", "dispatch-intent", "cancel-intent"]);
    restored.lock.release();
    await world.phase("cancel");
    // Terminal confirmation resolves the interrupted cancel; no second cancellation is permitted.
    await world.phase("cleanup");
    expect(world.count("POST", "/cancel")).toBe(1); expect(world.refSha()).toBeNull();
  });

  it("keeps the original lock on callback failure and permits a later explicit recovery", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch");
    const owner = abandoned();
    await expect(recover({ reconcile: async () => { throw new Error("readback failed"); } })).rejects.toThrow(/readback failed/);
    expect(readLockOwner(world.dir, RUN_ID, ATTEMPT, "probe").nonce).toBe(owner.nonce);
    await expect(recover({ ownerGone: false })).rejects.toThrow(/owner is gone/);
    const restored = await recover(); restored.lock.release();
  });

  it("does not strand an unreadable lock when acquisition fails before its first bytes", async () => {
    world.seedOriginal(); await world.phase("stage");
    // Serialization fails after exclusive creation but before any nonce is readable from disk.
    expect(() => acquireJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", pid: 1n as any, now: world.now })).toThrow(/BigInt/);
    expect(readLockOwner(world.dir, RUN_ID, ATTEMPT, "probe")).toBeNull();
    expect((await world.phase("cleanup") as any).status).toBe("nothing-owned");
  });

  it("releases the replacement when its recovery append fails", async () => {
    world.seedOriginal(); await world.phase("stage"); abandoned();
    let reads = 0;
    await expect(recover({ now: () => { if (++reads === 3) throw new Error("append clock failure"); return world.now(); } })).rejects.toThrow(/append clock failure/);
    expect(readLockOwner(world.dir, RUN_ID, ATTEMPT, "probe")).toBeNull();
    expect((await world.phase("cleanup") as any).status).toBe("nothing-owned");
  });
});


describe("R07: remaining dispatch/recovery boundaries", () => {
  for (const response of ["missing", "500"]) for (const candidate of ["duplicate", "foreign"]) {
    it(`refuses ${candidate} candidates after ${response} dispatch through cancel and cleanup`, async () => {
      world.seedOriginal(); world.neverComplete = true;
      world.runsPerDispatch = candidate === "duplicate" ? 2 : 1;
      await world.phase("stage");
      await expect(world.phase("dispatch", { transport: async (method: string, p: string, body?: unknown) => {
        const answer = await world.transport(method, p, body);
        if (method === "POST" && p.endsWith("/dispatches")) {
          if (candidate === "foreign") world.runs[0].actor = { id: 3, login: "foreign", type: "User" };
          if (response === "missing") throw new Error("interrupted dispatch");
          return completedJsonResponse(500, Buffer.from('{}'), createRedactor(), { retainRaw: true });
        }
        return answer;
      } })).rejects.toThrow(/interrupted dispatch|effect is unknown/);
      await expect(world.phase("cancel")).rejects.toThrow(/eligible probe runs|not this probe's own run/);
      let deletions = 0;
      await expect(world.phase("cleanup", { deleteRef: async () => { deletions++; } })).rejects.toThrow(/NOT deleted|not this probe's own run|eligible probe runs/);
      expect([deletions, world.count("POST", "/cancel"), world.count("POST", "/dispatches")]).toEqual([0, 0, 1]);
      expect(world.refSha()).toBe(world.sha);
      expect(world.probeRecords().some((r: any) => r.type === "probe-closed")).toBe(false);
    });
  }

  it("can identify a real applied run after complete 500, without redispatching", async () => {
    world.seedOriginal(); await world.phase("stage");
    await expect(world.phase("dispatch", { transport: async (method: string, p: string, body?: unknown) => {
      const answer = await world.transport(method, p, body);
      return method === "POST" && p.endsWith("/dispatches")
        ? completedJsonResponse(500, Buffer.from('{}'), createRedactor(), { retainRaw: true }) : answer;
    } })).rejects.toThrow(/effect is unknown/);
    const measured: any = await world.phase("collect");
    await world.phase("cleanup");
    expect(world.count("POST", "/dispatches")).toBe(1);
    for (const environment of ["staging-release", "staging-emergency"]) expect(world.validate(measured.records[environment], environment)).toBeNull();
  });

  it("recovering a missing create result does not adopt the unknown ref", async () => {
    world.seedOriginal(); await world.phase("stage");
    await expect(world.phase("dispatch", { transport: async (method: string, p: string, body?: unknown) => {
      const result = await world.transport(method, p, body);
      if (method === "POST" && p.endsWith("/git/refs")) throw new Error("interrupted create result");
      return result;
    } })).rejects.toThrow(/interrupted create/);
    acquireJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", pid: 2147483647, now: world.now });
    const seen: any[] = [];
    const recovered = await recoverJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", ownerGone: true, now: world.now,
      reconcile: async (intent: any) => { seen.push(intent); return { reconciled: true, readback: { present: true } }; } });
    expect(seen.map((i) => i.kind_of_intent)).toEqual(["ref-create-intent"]);
    expect(recovered.unresolvedIntentType).toBe("ref-create-intent"); recovered.lock.release();
    await expect(world.phase("cleanup")).rejects.toThrow(/ownership is uncertain/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.count("POST", "/dispatches")).toBe(0);
  });

  it("recovers an interrupted deletion by exact absence without a second deletion", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch"); const measured: any = await world.phase("collect");
    let deletions = 0;
    await expect(world.phase("cleanup", { deleteRef: async () => { deletions++; world.setRef(null); throw new Error("interrupted deletion result"); } })).rejects.toThrow(/interrupted deletion/);
    acquireJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", pid: 2147483647, now: world.now });
    const seen: any[] = [];
    const recovered = await recoverJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", ownerGone: true, now: world.now,
      reconcile: async (intent: any) => { seen.push(intent); return { reconciled: true }; } });
    expect(seen.map((i) => i.kind_of_intent)).toEqual(["ref-create-intent", "dispatch-intent", "cleanup-intent"]);
    expect(recovered.unresolvedIntentType).toBe("cleanup-intent"); recovered.lock.release();
    expect((await world.phase("cleanup", { deleteRef: async () => { deletions++; } }) as any).outcome).toBe("measured");
    expect(deletions).toBe(1);
    expect(world.validate(measured.records["staging-release"], "staging-release")).toBeNull();
  });

  it("does not replace a lock when a later mutation readback stays unresolved", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch");
    const owner = acquireJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", pid: 2147483647, now: world.now });
    const seen: string[] = [];
    await expect(recoverJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", ownerGone: true, now: world.now,
      reconcile: async (intent: any) => { seen.push(intent.kind_of_intent); return { reconciled: intent.kind_of_intent !== "dispatch-intent" }; } })).rejects.toThrow(/could not be reconciled/);
    expect(seen).toEqual(["ref-create-intent", "dispatch-intent"]);
    expect(readLockOwner(world.dir, RUN_ID, ATTEMPT, "probe").nonce).toBe(owner.nonce);
  });
});


describe("phase admission and terminal recovery", () => {
  const direct: Record<string, any> = { stage: runStage, dispatch: runDispatch, collect: runCollect, cancel: runCancel, cleanup: runCleanup };
  const invoke = (phase: string, extra: any = {}) => direct[phase]({ runId: RUN_ID, attempt: ATTEMPT, evidenceDir: world.dir, env: {}, deps: world.deps(extra) });
  const unavailable = (method: string, route: string, body: any) => route.includes("/check-runs/") ? Promise.resolve(incompleteResponse("transport-timeout")) : world.transport(method, route, body);
  for (const closure of ["inconclusive", "measured", "failed"]) for (const phase of Object.keys(direct)) {
    it(`${closure} closed history admits ${phase} only as read-only terminal reporting`, async () => {
      world.seedOriginal(); await invoke("stage");
      if (closure !== "inconclusive") {
        if (closure === "failed") world.admitted = "probe-release";
        await invoke("dispatch");
        if (closure === "failed") { await expect(invoke("collect", { transport: unavailable })).rejects.toThrow(); await invoke("cancel"); }
        else await invoke("collect");
      }
      await invoke("cleanup");
      const before = JSON.stringify(world.probeRecords());
      const mutations = world.calls.filter((call) => call.method !== "GET").length;
      if (["cancel", "cleanup"].includes(phase)) expect((await invoke(phase)).status).toBe("already-closed");
      else await expect(invoke(phase)).rejects.toThrow(/closed/);
      expect(JSON.stringify(world.probeRecords())).toBe(before);
      expect(world.calls.filter((call) => call.method !== "GET").length).toBe(mutations);
      expect(world.refSha()).toBeNull();
    });
  }
  for (const phase of ["dispatch", "collect", "cancel", "cleanup"]) {
    it(`direct ${phase} cannot invent an unstaged probe`, async () => {
      world.seedOriginal(); await expect(invoke(phase)).rejects.toThrow(/staged/);
      expect(world.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
      expect(world.probeRecords()).toHaveLength(0);
    });
  }
  for (const apply of [false, true]) for (const changed of [false, true]) {
    it(`missing create result reconciles without retry (applied=${apply}, changed=${changed})`, async () => {
      world.seedOriginal(); await invoke("stage");
      await expect(invoke("dispatch", { transport: async (method: string, route: string, body: any) => {
        if (method === "POST" && route.endsWith("/git/refs")) {
          world.calls.push({ method, path: route, body });
          if (apply) world.setRef(changed ? world.otherSha : world.sha);
          throw new Error("cut before result append");
        }
        return world.transport(method, route, body);
      } })).rejects.toThrow(/cut/);
      if (apply) {
        await expect(invoke("cleanup")).rejects.toThrow(/uncertain/);
        world.setRef(null); await expect(invoke("cleanup")).rejects.toThrow(/uncertain/);
      } else { expect((await invoke("cleanup")).status).toBe("nothing-owned"); expect((await invoke("cleanup")).status).toBe("already-closed"); }
      expect(world.count("POST", "/git/refs")).toBe(1);
      expect(world.count("POST", "/dispatches")).toBe(0);
    });
  }
  for (const job of ["probe-release", "probe-emergency", null]) {
    it(`terminal incomplete capture explicitly aborts, preserving ${job ?? "unverified"} qualification`, async () => {
      world.seedOriginal(); await invoke("stage"); world.admitted = job; await invoke("dispatch");
      await expect(invoke("collect", { transport: unavailable })).rejects.toThrow();
      expect(world.probeRecords().some((row: any) => row.type === "capture-failed")).toBe(true);
      expect(world.probeRecords().filter((row: any) => row.type === "admission-observed")).toHaveLength(job ? 1 : 0);
      await expect(invoke("cleanup")).rejects.toThrow(/collect before cleanup/);
      expect((await invoke("cancel", { transport: unavailable })).status).toBe("terminal-aborted");
      await expect(invoke("collect")).rejects.toThrow(/qualification/);
      expect((await invoke("cleanup")).outcome).toBe(job ? "failed" : "inconclusive");
      expect(world.count("POST", "/cancel")).toBe(0); expect(world.refSha()).toBeNull();
    });
  }
  it("complete paired collection followed by terminal cancel preserves observation bytes and acceptance", async () => {
    world.seedOriginal(); await invoke("stage"); await invoke("dispatch"); const collected = await invoke("collect");
    const observations = world.probeRecords().filter((row: any) => row.type === "observation-recorded");
    expect((await invoke("cancel")).status).toBe("already-terminal");
    expect(world.probeRecords().filter((row: any) => row.type === "observation-recorded")).toEqual(observations);
    expect(world.probeRecords().some((row: any) => ["cancel-intent", "cancel-result", "qualification-ended"].includes(row.type))).toBe(false);
    expect((await invoke("cleanup")).outcome).toBe("measured");
    for (const [environment, record] of Object.entries(collected.records)) expect(world.validate(record, environment)).toBeNull();
  });
  for (const interruption of ["original-completed", "original-unavailable", "source-unavailable", "expired"]) {
    it(`independent recovery survives ${interruption} qualification`, async () => {
      world.seedOriginal(); await invoke("stage"); await invoke("dispatch");
      if (interruption === "original-completed") world.originalRunStatus = "completed";
      if (interruption === "expired") world.clock += 11 * 60_000;
      const transport = (method: string, route: string, body: any) => {
        if ((interruption === "original-unavailable" && route.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`))
          || (interruption === "source-unavailable" && route.endsWith("/git/ref/heads/staging"))) return Promise.resolve(incompleteResponse("transport-timeout"));
        return world.transport(method, route, body);
      };
      await expect(invoke("collect", { transport })).rejects.toThrow();
      await invoke("cancel", { transport }); await invoke("cleanup", { transport });
      expect(world.refSha()).toBeNull();
      expect(world.probeRecords().at(-1)?.data.outcome).toBe("inconclusive");
    });
  }
  const substitutions: Record<string, (body: any) => void> = {
    id: (b) => { b.id++; }, attempt: (b) => { b.run_attempt++; },
    repository_id: (b) => { b.repository.id++; }, repository_name: (b) => { b.repository.full_name = "other/repo"; },
    head_repository_id: (b) => { b.head_repository.id++; }, head_repository_name: (b) => { b.head_repository.full_name = "other/repo"; },
    actor_login: (b) => { b.actor.login = "substitute"; }, actor_id_missing: (b) => { delete b.actor.id; },
    actor_type: (b) => { b.actor.type = ""; }, trigger_missing: (b) => { delete b.triggering_actor; },
    status_missing: (b) => { delete b.status; }, status_unknown: (b) => { b.status = "unknown"; },
    run_attempt_missing: (b) => { delete b.run_attempt; }, repository_missing: (b) => { delete b.repository; },
  };
  for (const [field, substitute] of Object.entries(substitutions)) it(`original ${field} substitution refuses before launch mutation`, async () => {
    world.seedOriginal();
    const transport = async (method: string, route: string, body: any) => {
      if (route.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) {
        const original = world.respond(method, route, body).body; substitute(original);
        return completedJsonResponse(200, Buffer.from(JSON.stringify(original)), createRedactor(), { retainRaw: true });
      }
      return world.transport(method, route, body);
    };
    await expect(invoke("stage", { transport })).rejects.toThrow();
    expect(world.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
  for (const field of ["actor", "triggering_actor"]) it(`original ${field} tuple cannot change after baseline`, async () => {
    world.seedOriginal(); await invoke("stage");
    const transport = async (method: string, route: string, body: any) => {
      if (route.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) {
        const original = world.respond(method, route, body).body; original[field].id++;
        return completedJsonResponse(200, Buffer.from(JSON.stringify(original)), createRedactor(), { retainRaw: true });
      }
      return world.transport(method, route, body);
    };
    await expect(invoke("dispatch", { transport })).rejects.toThrow(/actor identity/);
    expect(world.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  for (const role of ["actor", "triggering_actor"] as const) {
    it(`accepts a documented App slug[bot] as the distinct original ${role} through offline validation`, async () => {
      if (role === "actor") {
        world.originalDispatcher = "commissioning-dispatcher[bot]";
        world.originalActor = { id: 2201, login: "commissioning-dispatcher[bot]", type: "Bot" };
      } else {
        world.originalTrigger = { id: 2301, login: "commissioning-trigger[bot]", type: "Bot" };
      }
      const collected: any = await world.fullProbe();
      for (const environment of Object.keys(ENV_IDS)) expect(world.validate(collected.records[environment], environment)).toBeNull();
      writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
        schema_version: 1, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT,
        controls: { [OFFBRANCH_CONTROL]: collected.records },
      });
      const blockers = assessEvidence({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, now: () => new Date(world.clock + 1000) }).blockers;
      expect(blockers.filter((entry: any) => entry.detail.includes(OFFBRANCH_CONTROL))).toEqual([]);
    });
  }

  for (const [type, login] of [["User", "commissioning-dispatcher[bot]"], ["Bot", "commissioning-dispatcher"], ["Bot", "[bot]"], ["Bot", "dispatcher[bot]extra"]]) {
    it(`rejects type-inconsistent or malformed original identity ${type}/${login}`, async () => {
      world.originalDispatcher = login;
      world.originalActor = { id: 2201, login, type };
      world.seedOriginal();
      await expect(invoke("stage")).rejects.toThrow(/tuple is malformed/);
      expect(world.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    });
  }

  for (const shape of ["missing-total", "mismatched-total", "malformed-page", "invalid-json-page", "truncated-pages", "malformed-diagnostic"]) {
    it(`terminal ${shape} remains nonaccepting but explicit abort and repeated cleanup recover the exact owned ref`, async () => {
      world.seedOriginal(); await invoke("stage"); await invoke("dispatch");
      const transport = async (method: string, route: string, body: any) => {
        const response: any = world.respond(method, route, body);
        if (/\/actions\/runs\/\d+\/jobs\?/.test(route)) {
          if (shape === "invalid-json-page") return completedJsonResponse(response.status, Buffer.from("{"), createRedactor(), { retainRaw: true });
          if (shape === "missing-total") delete response.body.total_count;
          if (shape === "mismatched-total") response.body.total_count += 1;
          if (shape === "malformed-page") response.body.jobs = { malformed: true };
          if (shape === "truncated-pages") response.body = { total_count: 101, jobs: response.body.jobs };
        }
        if (shape === "malformed-diagnostic" && route.includes("/annotations")) response.body = { annotations: [] };
        return completedJsonResponse(response.status, Buffer.from(JSON.stringify(response.body)), createRedactor(), { retainRaw: true });
      };
      await expect(invoke("collect", { transport })).rejects.toThrow();
      expect((await invoke("cancel") as any).status).toBe("terminal-aborted");
      expect((await invoke("cancel") as any).status).toBe("terminal-aborted");
      expect((await invoke("cleanup") as any).outcome).toBe("inconclusive");
      expect((await invoke("cleanup") as any).status).toBe("already-closed");
      expect(world.refSha()).toBeNull();
      expect(world.count("POST", "/cancel")).toBe(0);
      expect(assessProbePhaseState(world.probeRecords(), { workflowSha: world.sha }).qualification).toBe("inconclusive");
      expect(validateEnvironmentControl(undefined, {
        dir: world.dir, key: OFFBRANCH_CONTROL, environment: "staging-release", runId: RUN_ID, attempt: ATTEMPT,
        window: world.trusted().window, offbranch: world.trusted(),
      })).toBe("is absent");
      writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "environment"), {
        schema_version: 1, phase: "environment-controls", run_id: RUN_ID, attempt: ATTEMPT, controls: {},
      });
      expect(assessEvidence({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, now: () => new Date(world.clock + 1000) }).blockers
        .some((entry: any) => entry.detail.includes(OFFBRANCH_CONTROL))).toBe(true);
    });
  }

  it("refuses corrupt supporting evidence for a previously proved admission instead of trusting the event", async () => {
    world.seedOriginal(); await invoke("stage"); world.admitted = "probe-release"; await invoke("dispatch");
    await expect(invoke("collect", { transport: unavailable })).rejects.toThrow(/admitted/);
    const admission = world.probeRecords().find((row: any) => row.type === "admission-observed");
    expect(admission?.data.environment).toBe("staging-release");
    writeFileSync(path.join(world.dir, admission.data.jobs_descriptor.artifact), "{}\n");
    await expect(invoke("cancel")).rejects.toThrow(/digest/);
    expect(world.probeRecords().some((row: any) => row.type === "qualification-ended")).toBe(false);
    expect(world.refSha()).toBe(world.sha);
  });

  it("rethrows a local jobs descriptor integrity failure and does not convert it to provider incompleteness", async () => {
    world.seedOriginal(); await invoke("stage"); await invoke("dispatch");
    await expect(invoke("collect", { transport: unavailable })).rejects.toThrow();
    const jobs = world.probeRecords().find((row: any) => row.type === "capture-recorded" && row.data.kind === "jobs");
    writeFileSync(path.join(world.dir, jobs.data.descriptor.artifact), "not the retained descriptor\n");
    await expect(invoke("cancel")).rejects.toThrow(/digest/);
    expect(world.probeRecords().some((row: any) => row.type === "qualification-ended")).toBe(false);
    expect(world.refSha()).toBe(world.sha);
  });
});


describe("durable close and capture process cuts", () => {
  const cutAfter = (predicate: (row: any) => boolean) => {
    const file = journalPath(world.dir, RUN_ID, ATTEMPT, "probe");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const index = lines.findIndex((line) => predicate(JSON.parse(line)));
    expect(index).toBeGreaterThanOrEqual(0);
    writeFileSync(file, `${lines.slice(0, index + 1).join("\n")}\n`, { mode: 0o600 });
  };
  for (const boundary of ["run-terminal", "capture-progress", "capture-recorded", "admission-observed", "capture-failed"]) {
    it(`explicit cancel recovers a process cut after ${boundary} without diagnostic reads`, async () => {
      world.seedOriginal(); await world.phase("stage"); world.admitted = "probe-emergency"; await world.phase("dispatch");
      const unavailable = (method: string, route: string, body: any) => route.includes("/check-runs/") ? Promise.resolve(incompleteResponse("transport-timeout")) : world.transport(method, route, body);
      await expect(world.phase("collect", { transport: unavailable })).rejects.toThrow();
      cutAfter((row) => row.type === boundary);
      const cancelled: any = await world.phase("cancel", { transport: unavailable });
      expect(cancelled.status).toBe("terminal-aborted");
      expect(cancelled.outcome).toBe(boundary === "run-terminal" ? "inconclusive" : "failed");
      const abort = world.probeRecords().filter((row: any) => row.type === "qualification-ended");
      await world.phase("cancel", { transport: unavailable });
      expect(world.probeRecords().filter((row: any) => row.type === "qualification-ended")).toEqual(abort);
      await world.phase("cleanup", { transport: unavailable });
      expect(world.refSha()).toBeNull(); expect(world.count("POST", "/cancel")).toBe(0);
    });
  }
  it("partial paired observation stays immutable and becomes permanently nonaccepting after abort", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch"); const collected: any = await world.phase("collect");
    cutAfter((row) => row.type === "observation-recorded");
    const observation = readFileSync(path.join(world.dir, collected.records["staging-release"].artifact));
    await expect(world.phase("cleanup")).rejects.toThrow(/collect before cleanup/);
    expect((await world.phase("cancel") as any).status).toBe("terminal-aborted");
    expect((await world.phase("cleanup") as any).outcome).toBe("inconclusive");
    expect(readFileSync(path.join(world.dir, collected.records["staging-release"].artifact))).toEqual(observation);
    expect(world.validate(collected.records["staging-release"], "staging-release")).not.toBeNull();
  });
  it("closed reporting leaves a stale writer lock intact and recovery never calls its callback", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("cleanup");
    const modulePath = path.join(__dirname, "../scripts/staging-ops/commissioning-journal.mjs");
    const script = `import { acquireJournalLock } from ${JSON.stringify(modulePath)}; process.stdout.write(JSON.stringify(acquireJournalLock(${JSON.stringify({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe" })})));`;
    const owner = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
    const before = JSON.stringify(world.probeRecords()); let callbacks = 0;
    for (const phase of ["cancel", "cleanup"]) expect((await world.phase(phase) as any).status).toBe("already-closed");
    await expect(recoverJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", ownerGone: true, now: world.now, reconcile: async () => { callbacks++; return { reconciled: true }; } })).rejects.toThrow(/open bound probe/);
    expect(callbacks).toBe(0); expect(readLockOwner(world.dir, RUN_ID, ATTEMPT, "probe").nonce).toBe(owner.nonce);
    expect(JSON.stringify(world.probeRecords())).toBe(before);
  });
  it("low-level append refuses after close and runtime/offline reject a valid-hash post-close record", async () => {
    const collected: any = await world.fullProbe();
    const lock = acquireJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", now: world.now });
    try {
      const journal = openJournal({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, kind: "probe", source: world.sha, lock, now: world.now });
      expect(() => journal.append("ref-create-intent", { ref: PROBE_REF, sha: world.sha })).toThrow(/closed/);
    } finally { lock.release(); }
    const file = journalPath(world.dir, RUN_ID, ATTEMPT, "probe");
    const bytes = readFileSync(file, "utf8"); const lastLine = bytes.trimEnd().split("\n").at(-1)!; const last = JSON.parse(lastLine);
    const forged = { ...last, seq: last.seq + 1, prev: sha256(lastLine), ts: world.now().toISOString(), type: "ref-create-intent", data: { ref: PROBE_REF, sha: world.sha } };
    writeFileSync(file, `${bytes}${JSON.stringify(forged)}\n`);
    await expect(world.phase("cleanup")).rejects.toThrow(/closed/);
    expect(world.validate(collected.records["staging-release"], "staging-release")).toMatch(/probe journal is invalid:.*closed/);
  });
  it("an original numeric identity contradiction remains disqualifying after the provider response restores", async () => {
    world.seedOriginal(); await world.phase("stage");
    await expect(world.phase("dispatch", { transport: async (method: string, route: string, body: any) => {
      if (route.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) {
        const response = world.respond(method, route, body).body; response.actor.id++;
        return completedJsonResponse(200, Buffer.from(JSON.stringify(response)), createRedactor(), { retainRaw: true });
      }
      return world.transport(method, route, body);
    } })).rejects.toThrow(/actor identity/);
    await expect(world.phase("dispatch")).rejects.toThrow(/actor identity/);
    expect(world.count("POST", "/git/refs")).toBe(0);
    expect((await world.phase("cleanup") as any).status).toBe("nothing-owned");
  });
});

/** Each prefix is a real fsynced public sequence; provider effects survive the process cut. */
describe("durable effect recovery matrix", () => {
  const cutAfter = (predicate: (row: any) => boolean) => {
    const file = journalPath(world.dir, RUN_ID, ATTEMPT, "probe");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const index = lines.findIndex((line) => predicate(JSON.parse(line)));
    expect(index).toBeGreaterThanOrEqual(0);
    writeFileSync(file, `${lines.slice(0, index + 1).join("\n")}\n`, { mode: 0o600 });
  };
  for (const boundary of ["ref-create-intent", "ref-readback", "reconciliation"]) {
    it(`create with missing result resumes after ${boundary} without another POST`, async () => {
      world.seedOriginal(); await world.phase("stage");
      await expect(world.phase("dispatch", { transport: async (method: string, route: string, body: any) => {
        if (method === "POST" && route.endsWith("/git/refs")) {
          world.calls.push({ method, path: route, body }); throw new Error("cut before create effect/result");
        }
        return world.transport(method, route, body);
      } })).rejects.toThrow(/cut before create/);
      await world.phase("cleanup");
      cutAfter((row) => row.type === boundary);
      expect((await world.phase("cleanup") as any).status).toBe("nothing-owned");
      expect((await world.phase("cleanup") as any).status).toBe("already-closed");
      expect(world.count("POST", "/git/refs")).toBe(1); expect(world.refSha()).toBeNull();
      expect(world.probeRecords().filter((row: any) => row.type === "reconciliation" && row.data.of === "ref-create-intent")).toHaveLength(1);
    });
  }
  for (const boundary of ["dispatch-intent", "run-selection-observed", "run-identified", "reconciliation"]) {
    it(`applied dispatch with missing result resumes after ${boundary} without another POST`, async () => {
      world.seedOriginal(); await world.phase("stage");
      await expect(world.phase("dispatch", { transport: async (method: string, route: string, body: any) => {
        const response = await world.transport(method, route, body);
        if (method === "POST" && route.endsWith("/dispatches")) throw new Error("cut after dispatch effect");
        return response;
      } })).rejects.toThrow(/cut after dispatch/);
      await world.phase("collect");
      cutAfter((row) => row.type === boundary && (boundary !== "reconciliation" || row.data.of === "dispatch-intent"));
      await world.phase("cancel");
      expect((await world.phase("cleanup") as any).outcome).toBe("inconclusive");
      expect((await world.phase("cleanup") as any).status).toBe("already-closed");
      expect(world.count("POST", "/dispatches")).toBe(1); expect(world.refSha()).toBeNull();
      expect(world.probeRecords().filter((row: any) => row.type === "reconciliation" && row.data.of === "dispatch-intent")).toHaveLength(1);
    });
  }
  for (const boundary of ["cancel-intent", "cancel-result", "run-observed", "run-terminal"]) {
    it(`cancel resumes after ${boundary} without a second cancellation`, async () => {
      world.seedOriginal(); await world.phase("stage"); world.neverComplete = true; await world.phase("dispatch");
      await world.phase("cancel");
      const intent = world.probeRecords().find((row: any) => row.type === "cancel-intent");
      cutAfter((row) => row.type === boundary && row.seq >= intent.seq);
      await world.phase("cancel");
      expect((await world.phase("cleanup") as any).outcome).toBe("inconclusive");
      expect(world.count("POST", "/cancel")).toBe(1); expect(world.refSha()).toBeNull();
      expect((await world.phase("cancel") as any).status).toBe("already-closed");
    });
  }
  for (const outcome of ["deleted", "ambiguous"]) for (const boundary of ["cleanup-intent", "cleanup-result", "ref-readback", ...(outcome === "ambiguous" ? ["reconciliation"] : []), "absence-verified"]) {
    it(`${outcome} deletion resumes after ${boundary} with one deletion and both offline controls`, async () => {
      world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch"); const collected: any = await world.phase("collect");
      let deletions = 0;
      const deleteRef = async () => { deletions++; world.setRef(null); return { outcome, exit_code: outcome === "deleted" ? 0 : 128 }; };
      await world.phase("cleanup", { deleteRef });
      const intent = world.probeRecords().find((row: any) => row.type === "cleanup-intent");
      cutAfter((row) => row.type === boundary && row.seq >= intent.seq);
      expect((await world.phase("cleanup", { deleteRef }) as any).outcome).toBe("measured");
      expect((await world.phase("cleanup", { deleteRef }) as any).status).toBe("already-closed");
      expect(deletions).toBe(1); expect(world.refSha()).toBeNull();
      for (const environment of Object.keys(ENV_IDS)) expect(world.validate(collected.records[environment], environment)).toBeNull();
    });
  }

  for (const capture of ["paired", "incomplete"]) for (const fault of ["repository-unavailable", "source-unavailable", "source-invalid", "repository-invalid", "original-unavailable", "original-invalid", "original-inactive", "source-http-error", "original-http-error", "original-unretained", "repository-policy-invalid"]) {
    for (const phase of ["cancel", "cleanup"]) it(`${capture} ${phase} retains ${fault} through restoration for both validators`, async () => {
      world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch"); const collected: any = await world.phase("collect");
      if (capture === "incomplete") cutAfter((row) => row.type === "capture-progress");
      const transport = async (method: string, route: string, body: any) => {
        const repository = route === `/repos/${REPO}`;
        const source = route.endsWith("/git/ref/heads/staging");
        const original = route.endsWith(`/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`);
        if ((fault === "repository-unavailable" && repository) || (fault === "source-unavailable" && source) || (fault === "original-unavailable" && original)) return incompleteResponse("transport-timeout");
        if ((fault === "source-http-error" && source) || (fault === "original-http-error" && original)) return completedJsonResponse(500, Buffer.from('{"message":"unavailable"}'), createRedactor(), { retainRaw: true });
        if (fault === "original-unretained" && original) return completedJsonResponse(200, Buffer.from(JSON.stringify(world.respond(method, route, body).body)), createRedactor());
        if (fault === "repository-policy-invalid" && repository) {
          const answer = world.respond(method, route, body); answer.body.default_branch = "main";
          return completedJsonResponse(200, Buffer.from(JSON.stringify(answer.body)), createRedactor(), { retainRaw: true });
        }
        if ((fault === "source-invalid" && source) || (fault === "repository-invalid" && repository) || (fault === "original-invalid" && original) || (fault === "original-inactive" && original)) {
          const answer = world.respond(method, route, body);
          if (source) answer.body.object.sha = "invalid";
          if (repository) answer.body.id++;
          if (original && fault === "original-invalid") answer.body.actor.id++;
          if (original && fault === "original-inactive") answer.body.status = "completed";
          return completedJsonResponse(answer.status, Buffer.from(JSON.stringify(answer.body)), createRedactor(), { retainRaw: true });
        }
        return world.transport(method, route, body);
      };
      if (capture === "incomplete" && phase === "cleanup") await expect(world.phase(phase, { transport })).rejects.toThrow(/collect before cleanup/);
      else await world.phase(phase, { transport });
      const gaps = world.probeRecords().filter((row: any) => row.type === "qualification-incomplete");
      expect(gaps.length).toBeGreaterThan(0);
      expect(world.probeRecords().some((row: any) => row.type === "source-observed" && row.data.moved === true)).toBe(false);
      if (!world.probeRecords().some((row: any) => row.type === "probe-closed")) {
        if (capture === "incomplete") await world.phase("cancel");
        expect((await world.phase("cleanup") as any).outcome).toBe("inconclusive");
      }
      expect(world.probeRecords().at(-1)?.data.outcome).toBe("inconclusive");
      expect(world.probeRecords().filter((row: any) => row.type === "qualification-incomplete")).toEqual(gaps);
      expect(world.refSha()).toBeNull(); expect(world.count("POST", "/cancel")).toBe(0);
      for (const environment of Object.keys(ENV_IDS)) expect(world.validate(collected.records[environment], environment)).toMatch(/qualification|original/);
    });
  }
  it("admitted failure takes precedence over a later qualification gap", async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch");
    const collected: any = await world.phase("collect");
    cutAfter((row) => row.type === "run-terminal"); world.admitted = "probe-emergency";
    // One admitted job and one denied job still give this retained run a failure conclusion.
    const state = world.runState.bind(world);
    world.runState = (run: Run) => ({ ...state(run), conclusion: state(run).status === "completed" ? "failure" : null });
    await expect(world.phase("collect")).rejects.toThrow(/admitted/);
    await world.phase("cancel");
    const transport = (method: string, route: string, body: any) => route.endsWith("/git/ref/heads/staging") ? Promise.resolve(incompleteResponse("transport-timeout")) : world.transport(method, route, body);
    expect((await world.phase("cleanup", { transport }) as any).outcome).toBe("failed");
    for (const environment of Object.keys(ENV_IDS)) expect(world.validate(collected.records[environment], environment)).toEqual(expect.any(String));
  });
});


describe("recovery gap schema and original closure", () => {
  for (const capture of ["paired", "incomplete"]) for (const phase of ["cancel", "cleanup"]) it(`${capture} ${phase} records original closure without reviving qualification`, async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch"); const collected: any = await world.phase("collect");
    if (capture === "incomplete") {
      const file = journalPath(world.dir, RUN_ID, ATTEMPT, "probe");
      const lines = readFileSync(file, "utf8").trimEnd().split("\n");
      const index = lines.findIndex((line) => JSON.parse(line).type === "capture-progress");
      expect(index).toBeGreaterThanOrEqual(0); writeFileSync(file, `${lines.slice(0, index + 1).join("\n")}\n`);
    }
    const lock = acquireJournalLock({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, now: world.now });
    try { openJournal({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT, source: world.sha, lock, now: world.now }).append("run-closed", { phase: "cleanup" }); } finally { lock.release(); }
    if (capture === "incomplete" && phase === "cleanup") await expect(world.phase(phase)).rejects.toThrow(/collect before cleanup/);
    else await world.phase(phase);
    if (!world.probeRecords().some((row: any) => row.type === "probe-closed")) { if (capture === "incomplete") await world.phase("cancel"); await world.phase("cleanup"); }
    expect(world.probeRecords().some((row: any) => row.type === "qualification-incomplete" && row.data.category === "original-closed")).toBe(true);
    expect(world.probeRecords().at(-1)?.data.outcome).toBe("inconclusive"); expect(world.refSha()).toBeNull();
    for (const environment of Object.keys(ENV_IDS)) expect(world.validate(collected.records[environment], environment)).toEqual(expect.any(String));
  });
  for (const read of ["source", "original"]) it(`unexpected ${read} programmer errors are not converted into recoverable gaps`, async () => {
    world.seedOriginal(); await world.phase("stage");
    await expect(world.phase("cleanup", { transport: async (method: string, route: string, body: any) => {
      if (route.endsWith(read === "source" ? "/git/ref/heads/staging" : `/actions/runs/${RUN_ID}/attempts/${ATTEMPT}`)) throw new TypeError("unexpected bug");
      return world.transport(method, route, body);
    } })).rejects.toThrow(/unexpected bug/);
    expect(world.probeRecords().some((row: any) => row.type === "qualification-incomplete")).toBe(false);
    expect(world.probeRecords().some((row: any) => row.type === "probe-closed")).toBe(false);
  });
});


describe("authenticated recovery facts", () => {
  for (const boundary of ["ref-create-result", "ref-readback"]) it(`successful creation cut after ${boundary} retains exact cleanup authority`, async () => {
    world.seedOriginal(); await world.phase("stage");
    await expect(world.phase("dispatch", { transport: async (method: string, route: string, body: any) => {
      const rows = world.probeRecords(); const intent = rows.find((row: any) => row.type === "ref-create-intent");
      if (intent && rows.some((row: any) => row.type === boundary && row.seq > intent.seq)) throw new Error("process cut after durable create fact");
      return world.transport(method, route, body);
    } })).rejects.toThrow(/process cut after durable create fact/);
    expect((await world.phase("cleanup") as any).outcome).toBe("inconclusive");
    expect(world.count("POST", "/git/refs")).toBe(1); expect(world.count("POST", "/dispatches")).toBe(0); expect(world.refSha()).toBeNull();
  });
  for (const mutation of ["category", "phase", "extra", "future"]) it(`rejects ${mutation} corruption of a retained qualification gap at runtime and both offline validators`, async () => {
    world.seedOriginal(); await world.phase("stage"); await world.phase("dispatch"); const collected: any = await world.phase("collect");
    await world.phase("cancel", { transport: (method: string, route: string, body: any) => route.endsWith("/git/ref/heads/staging") ? Promise.resolve(incompleteResponse("transport-timeout")) : world.transport(method, route, body) });
    const rows = world.probeRecords(); const gap = rows.find((row: any) => row.type === "qualification-incomplete");
    if (mutation === "category") gap.data.category = "convenient-assumption";
    if (mutation === "phase") gap.data.phase = "approve";
    if (mutation === "extra") gap.data.accept = true;
    if (mutation === "future") gap.data.observed_at = iso(world.clock + 60000);
    let previous = rows[0].prev;
    const lines = rows.map((row: any) => { const line = JSON.stringify({ ...row, prev: previous }); previous = sha256(line); return line; });
    writeFileSync(journalPath(world.dir, RUN_ID, ATTEMPT, "probe"), `${lines.join("\n")}\n`);
    await expect(world.phase("cleanup")).rejects.toThrow(/qualification|schema/);
    for (const environment of Object.keys(ENV_IDS)) expect(world.validate(collected.records[environment], environment)).toMatch(/qualification|schema/);
    expect(world.refSha()).toBe(world.sha);
  });
});
