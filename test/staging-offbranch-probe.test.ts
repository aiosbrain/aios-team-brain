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
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMISSIONING_REPOSITORY, COMMISSIONING_WORKFLOW_PATH, ENVIRONMENT_CONTROL_SCHEMAS, OWNER_LOGIN, OWNER_USER_ID,
  ALLOWED_OPERATIONS, PROTECTED_JOBS, assertAllowedRequest, assessEvidence, completedJsonResponse, createGuardedRequest, createRedactor,
  evidenceSlug, incompleteResponse, readEvidenceFile, validateEnvironmentControl, writeEvidenceFile,
} from "../scripts/staging-ops/policy-commissioning.mjs";
import { acquireJournalLock, openJournal, readJournal } from "../scripts/staging-ops/commissioning-journal.mjs";
import {
  GENERIC_DIAGNOSTIC_MESSAGE, OFFBRANCH_CONTROL, PROBE_BRANCH, PROBE_JOBS, PROBE_JOURNAL_EVENTS, PROBE_REF,
  PROBE_WORKFLOW_FILE, PROBE_WORKFLOW_PATH, assertPolicyAgreesWithCommissioning, commissioningIdentity,
  parseCheckRunUrl, parseDiagnosticAnnotations, parseEnvironmentPolicy, parseProbeCheck, parseProbeJobs, parseProbeRun,
  probeIntentName, probeObservationName, selectEligibleRuns, specificDiagnosticMessage, validateOffBranchRecord,
} from "../scripts/staging-ops/offbranch-probe.mjs";
import { createGitLeaseDeleter, main, runProbePhase } from "../scripts/staging-ops/offbranch-probe-operator.mjs";

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
      return { status: 200, body: { id: Number(RUN_ID), head_sha: this.sha, path: COMMISSIONING_WORKFLOW_PATH, event: "workflow_dispatch", head_branch: "staging", status: this.originalRunStatus } };
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
      provider_measured: false,
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

  it("retains the provider's exact bytes, create-once at mode 0600", async () => {
    await world.fullProbe();
    const raw = readdirSync(world.dir).filter((name) => name.includes("-offbranch-raw-"));
    expect(raw.length).toBeGreaterThan(10);
    for (const name of raw) {
      const stat = execFileSync("stat", ["-f", "%Lp", path.join(world.dir, name)], { encoding: "utf8" }).trim();
      expect(stat).toBe("600");
    }
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
    expect(selectEligibleRuns([{ page: 1, body }], { dispatchIntentMs: created - 500, deadlineMs: created + 600_000 })).toEqual([String(run.id)]);
    expect(selectEligibleRuns([{ page: 1, body }], { dispatchIntentMs: created + 1500, deadlineMs: created + 600_000 })).toEqual([]);
    expect(() => selectEligibleRuns([{ page: 1, body: { total_count: 2, workflow_runs: [run] } }], { dispatchIntentMs: 0, deadlineMs: Infinity })).toThrow(/incomplete/);
  });
});

describe("the historical September 6 fixture: shape coverage only, never current acceptance", () => {
  const load = (name: string) => readFileSync(path.join(FIXTURE, name));
  it("is the retained bytes", () => {
    expect(sha256(load("jobs.json"))).toBe("4723f398b0f0698f63684217232c47e337ae882df75f376182d0d3095d1283c7");
    expect(sha256(load("check.json"))).toBe("59089a7981d5f9f0016cb5ddfd46d8f2b87a87473a8f1a010e481dee05bc2e7b");
    expect(sha256(load("annotations.json"))).toBe("3a591de07bfbeeb38eb5167bc159070798f6a0d984eb187563e06c5a66395bad");
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
  it("refuses a preexisting probe ref at stage — even at the desired SHA — and writes nothing", async () => {
    world.seedOriginal();
    world.setRef(world.sha);
    await expect(world.phase("stage")).rejects.toThrow(/never adopted/);
    expect(readdirSync(world.dir).some((name) => name === probeIntentName(RUN_ID, ATTEMPT))).toBe(false);
    expect(readJournal({ dir: world.dir, runId: RUN_ID, attempt: ATTEMPT }).some((r: any) => r.type === "probe-staged")).toBe(false);
  });

  it("refuses to stage before the original baseline, after an approval, or once the attempt completed", async () => {
    writeEvidenceFile(world.dir, evidenceSlug(RUN_ID, ATTEMPT, "intent"), { schema_version: 1, repository: REPO, repository_id: REPO_ID, run_id: RUN_ID, attempt: ATTEMPT, workflow_path: COMMISSIONING_WORKFLOW_PATH, workflow_sha: world.sha });
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

  it("stages once per attempt: a second stage is refused", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await expect(world.phase("stage")).rejects.toThrow(/already staged/);
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
    expect(world.probeRecords().some((record: any) => record.type === "run-unidentified" && record.data.eligible === 2)).toBe(true);
    expect(world.count("POST", "/dispatches")).toBe(1);
    const cleaned: any = await world.phase("cleanup");
    expect(cleaned.outcome).toBe("inconclusive");
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

  it("reconciles an ambiguous deletion: absent closes it; present requires a fresh explicit lease", async () => {
    world.seedOriginal();
    await world.phase("stage");
    await world.phase("dispatch");
    await world.phase("collect");
    await expect(world.phase("cleanup", { deleteRef: async () => ({ outcome: "ambiguous", exit_code: 128 }) })).rejects.toThrow(/run cleanup again/);
    expect(world.refSha()).toBe(world.sha);
    expect(world.probeRecords().some((r: any) => r.type === "reconciliation" && r.data.outcome === "present-unchanged")).toBe(true);
    const cleaned: any = await world.phase("cleanup");
    expect(cleaned.status).toBe("cleaned");
    expect(world.refSha()).toBeNull();
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
    await expect(world.phase("cleanup")).rejects.toThrow(/collect before cleanup/);
    expect(world.refSha()).toBe(world.sha);
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
